/**
 * El expediente del informe, leído desde la aplicación.
 *
 * Antes esto era SQL contra Postgres con el rol de servicio, dentro de un
 * contenedor aparte. Ahora son consultas de la API con la sesión de quien pide
 * el informe: las mismas vistas que ya alimentan el panel, y RLS decidiendo qué
 * puede ver cada uno. Quien pide un informe es administrador —la pestaña es
 * suya—, así que lo ve todo.
 *
 * Dos reglas que ordenan todo este fichero, y que vienen del worker porque son
 * del informe y no de dónde se calcule:
 *
 *  1. **Lo del periodo se mide en el periodo.** El informe antiguo enseñaba el
 *     histórico acumulado por edificio en un documento titulado «semanal»: un
 *     gráfico que no se movía de una semana a la siguiente, porque contaba tres
 *     años de incidencias. Aquí cada cifra dice explícitamente si habla del
 *     periodo o de la situación a día de hoy.
 *  2. **Un número solo no informa.** Todo lo que se cuenta en el periodo se
 *     cuenta también en el tramo anterior de la misma duración, y el informe
 *     enseña las dos cifras. «18 revisiones» no es bueno ni malo hasta que se
 *     sabe que la semana pasada fueron 31.
 *
 * Los borradores no entran en ninguna cuenta. Todavía no se sabe qué son, y
 * contarlos como incidencias abiertas infla el número que más se mira.
 *
 * TRES CUIDADOS QUE NO SON OPCIONALES
 *
 *  · **Todo lo que puede crecer se pide por páginas.** PostgREST aplica su tope
 *    de filas en silencio: devuelve `200 OK` con las primeras mil y no dice que
 *    falten más. Un informe de un trimestre cruza ese tope con facilidad, y una
 *    cifra corta sin avisar es peor que ninguna cifra.
 *  · **Un error de lectura se lanza, no se traga.** Media consulta fallida
 *    produciría un informe con cifras bajas y ninguna señal de que lo son. Es
 *    exactamente el fallo que un documento firmado no se puede permitir.
 *  · **Los límites del periodo son medianoche de Madrid.** No de UTC y no del
 *    huso del aparato: una revisión de las 00:30 caía en el informe del día
 *    anterior.
 *
 * Las funciones que agregan lo leído se exportan aunque nadie de fuera las
 * llame. Son las reglas de recuento del informe —una visita se cuenta una vez,
 * el campus vivo es el de `room_overview`, la mediana va antes que la media— y
 * cada una viene de una cifra equivocada en un documento firmado. Mientras
 * vivían en SQL las probaba Postgres; aquí las prueba `datos.test.ts`, y para
 * eso tienen que ser alcanzables.
 */

import { supabase } from '@/lib/supabase'
import { descargaEntera, type Pagina } from '@/sync/paginada'
import { TOPE_CONSULTA_MS, esSilencio, señalConTope } from './espera'
import { diaEnMadrid, horaCorta, inicioDelDia } from '@/domain/fechas'
import {
  type Rango,
  diasDe,
  diasDelRango,
  nombreComparacion,
  nombrePeriodo,
  periodoAnterior,
  sumaDias,
} from '../periodos'
import type { Contadores, ReportData, Situacion } from './tipos'

/**
 * Tope de filas de las dos tablas largas.
 *
 * Una semana normal cabe entera. Un informe de un trimestre no, y ahí hay que
 * elegir entre cortar o imprimir cuarenta páginas de listado. Se corta, y se
 * dice cuántas se han quedado fuera: una tabla truncada en silencio se lee como
 * si eso fuera todo lo que pasó.
 */
const TOPE_FILAS = 150

const num = (v: unknown): number => Number(v ?? 0)

// ── Filas tal y como llegan de la API ────────────────────────────────────────

export interface FilaRevision {
  id: string
  corrects: string | null
  room_id: string | null
  occurred_at: string
  corrected_at: string | null
  by_user: string | null
  overall: string | null
}

/**
 * Un registro abierto dentro del periodo, y uno cerrado dentro del periodo. Son
 * dos tipos y no uno con la mitad de los campos nulos: se piden con columnas
 * distintas porque preguntan cosas distintas —lo que entró y lo que salió—, y un
 * `resolved_at` opcional en el mismo tipo invita a leerlo donde no lo hay.
 */
export interface FilaApertura {
  id: string
  kind: string
  severity: string | null
  state: string
  title: string | null
  description: string | null
  external_ref: string | null
  room_id: string | null
  opened_at: string
  opened_by: string | null
  opened_from_inspection_id: string | null
}

export interface FilaCierre {
  id: string
  kind: string
  title: string | null
  resolution: string | null
  external_ref: string | null
  room_id: string | null
  opened_at: string
  resolved_at: string | null
  resolved_by: string | null
}

export interface FilaMovimiento {
  id: string
  kind: string
  qty: number
  note: string | null
  occurred_at: string
  room_id: string | null
  by_user: string | null
  stock_item_id: string
  incident_id: string | null
}

interface FilaInventario {
  id: string
  occurred_at: string
  room_id: string | null
  by_user: string | null
  note: string | null
  asset_count: number | null
}

interface FilaEventoEquipo {
  id: string
  kind: string
  occurred_at: string
  room_id: string | null
  by_user: string | null
  meta: Record<string, unknown> | null
  asset_id: string
}

export interface FilaSala {
  room_id: string
  room_code: string
  room_name: string
  building_code: string
  building_name: string
  last_inspection_at: string | null
  open_incidents: number | null
}

/** Todo lo que pasó dentro de un periodo, sin agregar. */
export interface FilasDelPeriodo {
  revisiones: FilaRevision[]
  abiertas: FilaApertura[]
  cerradas: FilaCierre[]
  movimientos: FilaMovimiento[]
  inventarios: FilaInventario[]
  equipos: FilaEventoEquipo[]
}

// ── Utilidades de lectura ────────────────────────────────────────────────────

/**
 * El fallo de una lectura, dicho de forma que se pueda hacer algo con él.
 *
 * Distingue las dos cosas que se sienten igual desde la pantalla y piden
 * respuestas opuestas: «ha contestado que no» —un permiso, una tabla que no
 * está— se arregla con el rol o con la migración; «no ha contestado» se arregla
 * con la red o con el servidor. Y en los dos casos se dice QUÉ, porque «no se ha
 * podido leer» a secas deja a quien lo lee sin nada que mirar.
 */
function fallo(que: string, err: unknown): Error {
  if (esSilencio(err)) {
    return new Error(
      `${que}: el servidor no ha contestado en ${Math.round(TOPE_CONSULTA_MS / 1000)} s. ` +
        'Comprueba la conexión; si va bien, es la base la que no está respondiendo.',
    )
  }
  return new Error(`No se ha podido leer ${que}: ${err instanceof Error ? err.message : String(err)}`)
}

/**
 * Una tabla entera, por páginas, con plazo y sin tragarse el error.
 *
 * La señal se renueva en cada página a propósito: el plazo es por petición, no
 * por descarga, porque una tabla de veinte páginas legítimamente tarda veinte
 * veces más que una de una.
 */
async function todas<T>(
  que: string,
  porPagina: (desde: number, hasta: number, señal: AbortSignal) => PromiseLike<Pagina<T>>,
): Promise<T[]> {
  const r = await descargaEntera<T>((d, h) => porPagina(d, h, señalConTope(TOPE_CONSULTA_MS)))
  if (r.error) throw fallo(que, new Error(r.error.message))
  return r.data ?? []
}

/**
 * Una consulta suelta, con plazo.
 *
 * Existe para que las quince consultas de este fichero no repitan quince veces
 * el mismo `if (error) throw`, y sobre todo para que ninguna se quede esperando
 * sin final: el `catch` es lo que convierte un servidor mudo en una frase.
 */
async function pide<T>(
  que: string,
  construir: (
    señal: AbortSignal,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  try {
    const { data, error } = await construir(señalConTope(TOPE_CONSULTA_MS))
    if (error) throw new Error(error.message)
    return data ?? []
  } catch (err) {
    throw fallo(que, err)
  }
}

/** Un recuento del servidor, sin traerse las filas. */
async function cuantas(
  que: string,
  construir: (
    señal: AbortSignal,
  ) => PromiseLike<{ count: number | null; error: { message: string } | null }>,
): Promise<number> {
  try {
    const { count, error } = await construir(señalConTope(TOPE_CONSULTA_MS))
    if (error) throw new Error(error.message)
    return count ?? 0
  } catch (err) {
    throw fallo(que, err)
  }
}

/** Los dos extremos del periodo como instantes, a medianoche de Madrid. */
function limites(r: Rango): { desde: string; hasta: string } {
  return {
    desde: inicioDelDia(r.start).toISOString(),
    hasta: inicioDelDia(sumaDias(r.end, 1)).toISOString(),
  }
}

/*
 * Las revisiones se cuentan por VISITA, no por fila.
 *
 * Desde que una revisión se puede corregir, la misma visita al aula puede tener
 * varias filas: la original y las correcciones que la reemplazan.
 * `inspections_vigentes` ya deja fuera las corregidas, y agrupar por
 * `corrects ?? id` cierra el caso raro de dos correcciones simultáneas de la
 * misma revisión —las dos apuntan a ella, así que la visita se cuenta una vez—.
 *
 * Sin esto, el informe del viernes diría que el equipo hizo 42 revisiones la
 * semana en que hizo 38 y corrigió cuatro, y el número de un informe firmado no
 * se puede permitir eso.
 */
function claveDeVisita(r: FilaRevision): string {
  return r.corrects ?? r.id
}

/**
 * Una fila por visita: la corrección más reciente gana.
 *
 * Mismo desempate que `room_overview`: por `corrected_at` descendente y los
 * nulos al final, de modo que una versión sin corregir solo gana si es la única.
 */
export function porVisita(revisiones: FilaRevision[]): FilaRevision[] {
  const ultima = new Map<string, FilaRevision>()
  for (const r of revisiones) {
    const clave = claveDeVisita(r)
    const previa = ultima.get(clave)
    if (!previa || (r.corrected_at ?? '') > (previa.corrected_at ?? '')) ultima.set(clave, r)
  }
  return [...ultima.values()].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
}

// ── Lectura del periodo ──────────────────────────────────────────────────────

async function filasDelPeriodo(r: Rango, conDiario: boolean): Promise<FilasDelPeriodo> {
  const { desde, hasta } = limites(r)

  const revisiones = todas<FilaRevision>('las revisiones', (d, h, señal) =>
    supabase
      .from('inspections_vigentes')
      .select('id,corrects,room_id,occurred_at,corrected_at,by_user,overall')
      .gte('occurred_at', desde)
      .lt('occurred_at', hasta)
      .order('occurred_at')
      .order('id')
      .abortSignal(señal).range(d, h),
  )

  // Sin borradores en ninguna cuenta: una nota a medias no es trabajo abierto.
  const abiertas = todas<FilaApertura>('los registros abiertos', (d, h, señal) =>
    supabase
      .from('incidents')
      .select(
        'id,kind,severity,state,title,description,external_ref,room_id,opened_at,opened_by,opened_from_inspection_id',
      )
      .neq('state', 'borrador')
      .gte('opened_at', desde)
      .lt('opened_at', hasta)
      .order('opened_at')
      .order('id')
      .abortSignal(señal).range(d, h),
  )

  const cerradas = todas<FilaCierre>('los registros cerrados', (d, h, señal) =>
    supabase
      .from('incidents')
      .select('id,kind,title,resolution,external_ref,room_id,opened_at,resolved_at,resolved_by')
      .eq('state', 'resuelta')
      .gte('resolved_at', desde)
      .lt('resolved_at', hasta)
      .order('resolved_at')
      .order('id')
      .abortSignal(señal).range(d, h),
  )

  const movimientos = todas<FilaMovimiento>('los movimientos de almacén', (d, h, señal) =>
    supabase
      .from('stock_movements')
      .select('id,kind,qty,note,occurred_at,room_id,by_user,stock_item_id,incident_id')
      .gte('occurred_at', desde)
      .lt('occurred_at', hasta)
      .order('occurred_at')
      .order('id')
      .abortSignal(señal).range(d, h),
  )

  /*
   * Los inventarios y los eventos de equipo solo hacen falta para el diario y
   * para su recuento, y el diario solo se arma del periodo que se informa: el
   * tramo anterior está aquí para comparar cuatro cifras, no para contarlo. Dos
   * consultas menos por informe, y ninguna de ellas dice nada que se enseñe.
   */
  const inventarios = conDiario
    ? todas<FilaInventario>('los inventarios', (d, h, señal) =>
        supabase
          .from('room_inventories')
          .select('id,occurred_at,room_id,by_user,note,asset_count')
          .gte('occurred_at', desde)
          .lt('occurred_at', hasta)
          .order('occurred_at')
          .order('id')
          .abortSignal(señal).range(d, h),
      )
    : Promise.resolve([])

  const equipos = conDiario
    ? todas<FilaEventoEquipo>('los movimientos de equipos', (d, h, señal) =>
        supabase
          .from('asset_events')
          .select('id,kind,occurred_at,room_id,by_user,meta,asset_id')
          .gte('occurred_at', desde)
          .lt('occurred_at', hasta)
          .order('occurred_at')
          .order('id')
          .abortSignal(señal).range(d, h),
      )
    : Promise.resolve([])

  const [r1, r2, r3, r4, r5, r6] = await Promise.all([
    revisiones,
    abiertas,
    cerradas,
    movimientos,
    inventarios,
    equipos,
  ])

  return {
    revisiones: r1,
    abiertas: r2,
    cerradas: r3,
    movimientos: r4,
    inventarios: r5,
    equipos: r6,
  }
}

export function contadores(f: FilasDelPeriodo): Contadores {
  const visitas = new Set(f.revisiones.map(claveDeVisita))
  const salas = new Set(f.revisiones.map((r) => r.room_id).filter((x): x is string => Boolean(x)))
  const consumo = f.movimientos.filter((m) => m.kind === 'consumo')

  return {
    revisiones: visitas.size,
    salasRevisadas: salas.size,
    registros: f.abiertas.length,
    incidencias: f.abiertas.filter((i) => i.kind === 'incidencia').length,
    solicitudes: f.abiertas.filter((i) => i.kind === 'solicitud').length,
    observaciones: f.abiertas.filter((i) => i.kind === 'observacion').length,
    gravedadAlta: f.abiertas.filter((i) => i.severity === 'alta').length,
    resueltas: f.cerradas.length,
    materialConsumido: consumo.reduce((a, m) => a + -num(m.qty), 0),
  }
}

// ── La foto de hoy ───────────────────────────────────────────────────────────

async function situacion(salas: FilaSala[]): Promise<Situacion> {
  const hace7dias = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const hace180dias = new Date(Date.now() - 180 * 86_400_000).toISOString()
  const head = { count: 'exact' as const, head: true }

  /*
   * «Abierta» significa aquí lo mismo que en la pestaña de Incidencias y que en
   * el panel: ni borradores —una nota a medio escribir no es trabajo
   * pendiente— ni observaciones, que son notas de seguimiento y las importadas
   * del Excel llevan abiertas desde 2025 por definición. Contarlas convertía
   * cientos de notas en «incidencias abiertas» de un informe firmado.
   */
  const [abiertas, estancadas, lamparas, bajoMinimo] = await Promise.all([
    cuantas('las incidencias abiertas', (señal) =>
      supabase
        .from('incidents')
        .select('*', head)
        .abortSignal(señal)
        .neq('state', 'resuelta')
        .neq('state', 'borrador')
        .neq('kind', 'observacion'),
    ),
    cuantas('las incidencias estancadas', (señal) =>
      supabase
        .from('incidents')
        .select('*', head)
        .abortSignal(señal)
        .neq('state', 'resuelta')
        .neq('state', 'borrador')
        .neq('kind', 'observacion')
        .lt('opened_at', hace7dias),
    ),
    cuantas('las lámparas al límite', (señal) =>
      supabase.from('alerts_lamp_low').select('*', head).abortSignal(señal),
    ),
    cuantas('el almacén bajo mínimo', (señal) =>
      supabase
        .from('stock_levels')
        .select('*', head)
        .eq('below_threshold', true)
        .abortSignal(señal),
    ),
  ])

  return {
    /*
     * El total de salas sale de `room_overview` y no de `rooms`, y es la misma
     * cuenta que el numerador: desde que un edificio se puede archivar,
     * `rooms.active` ya no define el campus vivo. Archivar el edificio H deja
     * sus 39 salas con `active = true` a propósito —restaurar tiene que
     * devolver lo que había—, así que contarlas dejaba la cobertura del campus
     * infravalorada para siempre, con 39 aulas que ya nadie puede revisar
     * contando como capacidad pendiente y el 100 % inalcanzable. Y ese
     * porcentaje viaja al expediente de la IA y a la frase del informe firmado.
     */
    salasTotal: salas.length,
    incidenciasAbiertas: abiertas,
    estancadas,
    lamparasAlLimite: lamparas,
    salasSinRevisarHace6Meses: salas.filter(
      (s) => s.last_inspection_at !== null && s.last_inspection_at < hace180dias,
    ).length,
    salasNuncaRevisadas: salas.filter((s) => s.last_inspection_at === null).length,
    articulosBajoMinimo: bajoMinimo,
  }
}

// ── El expediente completo ───────────────────────────────────────────────────

/**
 * Cuántas lecturas se dejan volar a la vez.
 *
 * Un informe son unas veinticinco consultas, y lanzarlas todas de golpe contra
 * un PostgREST autoalojado —cuyo pool de conexiones es de diez de fábrica—
 * significa que la mitad se queda esperando turno. Desde la pantalla eso no se
 * distingue de un cuelgue: la línea de estado no se mueve y no hay error que
 * enseñar. Se piden en tandas, que además es lo amable con la red de un iPad.
 */
export async function cargarDatos(
  kind: string,
  rango: Rango,
  avisar: (leyendo: string) => void = () => undefined,
): Promise<ReportData> {
  const anterior = periodoAnterior(rango)

  avisar('las salas y lo que pasó en el periodo')
  const [salas, ahoraFilas] = await Promise.all([
    todas<FilaSala>('las salas', (d, h, señal) =>
      supabase
        .from('room_overview')
        .select(
          'room_id,room_code,room_name,building_code,building_name,last_inspection_at,open_incidents',
        )
        .order('room_id')
        .abortSignal(señal).range(d, h),
    ),
    filasDelPeriodo(rango, true),
  ])

  avisar('el periodo anterior, para comparar')
  const antesFilas = await filasDelPeriodo(anterior, false)

  const ahora = contadores(ahoraFilas)
  const antes = contadores(antesFilas)
  const deSala = new Map(salas.map((s) => [s.room_id, s]))

  avisar('la situación de hoy y las alertas')
  const [sit, porMes, reincidentes, lamparas, olvidadas, estancadas, articulos] = await Promise.all([
    situacion(salas),
    porMeses(),
    salasQueRepiten(deSala),
    lamparasAlLimite(),
    salasOlvidadas(),
    sinCerrarDesdeHaceUnaSemana(deSala),
    articulosDeAlmacen(),
  ])

  avisar('el detalle de cada revisión')
  const visitas = porVisita(ahoraFilas.revisiones)
  const [revisiones, quien] = await Promise.all([
    filasDeRevisiones(visitas, deSala),
    nombresDePersona([
      ...ahoraFilas.revisiones.map((r) => r.by_user),
      ...ahoraFilas.abiertas.map((i) => i.opened_by),
      ...ahoraFilas.cerradas.map((i) => i.resolved_by),
      ...ahoraFilas.movimientos.map((m) => m.by_user),
      ...ahoraFilas.inventarios.map((v) => v.by_user),
      ...ahoraFilas.equipos.map((e) => e.by_user),
    ]),
  ])

  avisar('el diario del periodo')
  const [eventos, topSalas] = await Promise.all([
    diarioDelPeriodo(ahoraFilas, deSala, quien, articulos),
    salasConMasIncidencias(ahoraFilas.abiertas, deSala),
  ])

  return {
    kind,
    period: rango,
    anterior,
    periodoTexto: nombrePeriodo(rango),
    comparacionTexto: nombreComparacion(rango),
    dias: diasDelRango(rango),
    ahora,
    antes,
    situacion: sit,
    serieDiaria: serieDiaria(rango, visitas, ahoraFilas),
    porEdificio: porEdificio(salas, visitas, ahoraFilas.abiertas, deSala),
    porTipo: agrupa(ahoraFilas.abiertas.map((i) => i.kind)).map(([tipo, total]) => ({ tipo, total })),
    porGravedad: agrupa(
      ahoraFilas.abiertas.filter((i) => i.kind === 'incidencia').map((i) => i.severity ?? 'baja'),
    ).map(([gravedad, total]) => ({ gravedad, total })),
    porMes,
    topSalas,
    resolucion: resolucion(ahoraFilas.cerradas),
    lamparas,
    estancadas,
    materiales: materiales(ahoraFilas.movimientos, articulos),
    reincidentes,
    olvidadas,
    equipo: repartoDelTrabajo(ahoraFilas, quien),
    revisiones: revisiones.map((r) => ({ ...r, quien: r.quien ? (quien.get(r.quien) ?? null) : null })),
    revisionesTotal: ahora.revisiones,
    eventos,
    eventosTotal:
      ahoraFilas.abiertas.length +
      ahoraFilas.cerradas.length +
      ahoraFilas.movimientos.length +
      ahoraFilas.inventarios.length +
      ahoraFilas.equipos.length,
    sinSala: ahoraFilas.abiertas.filter((i) => i.room_id === null).length,
  }
}

/** Cuenta repeticiones y las devuelve de más a menos. */
function agrupa(valores: string[]): Array<[string, number]> {
  const cuenta = new Map<string, number>()
  for (const v of valores) cuenta.set(v, (cuenta.get(v) ?? 0) + 1)
  return [...cuenta.entries()].sort((a, b) => b[1] - a[1])
}

/**
 * La serie diaria con TODOS los días del periodo, incluidos los vacíos.
 *
 * Sin los días sin actividad, una semana con dos jornadas de trabajo se dibuja
 * igual que una semana entera y el hueco no se ve.
 */
export function serieDiaria(
  rango: Rango,
  visitas: FilaRevision[],
  f: FilasDelPeriodo,
): ReportData['serieDiaria'] {
  const rev = new Map<string, number>()
  for (const v of visitas) {
    const dia = diaEnMadrid(new Date(v.occurred_at))
    rev.set(dia, (rev.get(dia) ?? 0) + 1)
  }
  const abre = new Map<string, number>()
  for (const i of f.abiertas) {
    const dia = diaEnMadrid(new Date(i.opened_at))
    abre.set(dia, (abre.get(dia) ?? 0) + 1)
  }
  const cierra = new Map<string, number>()
  for (const i of f.cerradas) {
    if (!i.resolved_at) continue
    const dia = diaEnMadrid(new Date(i.resolved_at))
    cierra.set(dia, (cierra.get(dia) ?? 0) + 1)
  }

  return diasDe(rango).map((dia) => ({
    dia,
    revisiones: rev.get(dia) ?? 0,
    abiertas: abre.get(dia) ?? 0,
    resueltas: cierra.get(dia) ?? 0,
  }))
}

export function porEdificio(
  salas: FilaSala[],
  visitas: FilaRevision[],
  abiertas: FilaApertura[],
  deSala: Map<string, FilaSala>,
): ReportData['porEdificio'] {
  interface Acumulado {
    code: string
    name: string
    salas: number
    revisadas: number
    abiertas: number
    pendientes: number
  }
  const por = new Map<string, Acumulado>()
  const entrada = (code: string, name: string): Acumulado => {
    const previo = por.get(code)
    if (previo) return previo
    const nueva: Acumulado = { code, name, salas: 0, revisadas: 0, abiertas: 0, pendientes: 0 }
    por.set(code, nueva)
    return nueva
  }

  for (const s of salas) {
    const e = entrada(s.building_code, s.building_name)
    e.salas += 1
    // «Pendientes hoy» es la cola viva del edificio, y `open_incidents` de
    // `room_overview` ya la cuenta con el mismo criterio que la pestaña: sin
    // borradores y sin observaciones.
    e.pendientes += num(s.open_incidents)
  }

  const revisadas = new Set<string>()
  for (const v of visitas) {
    if (!v.room_id || revisadas.has(v.room_id)) continue
    revisadas.add(v.room_id)
    const s = deSala.get(v.room_id)
    if (s) entrada(s.building_code, s.building_name).revisadas += 1
  }

  for (const i of abiertas) {
    const s = i.room_id ? deSala.get(i.room_id) : undefined
    if (s) entrada(s.building_code, s.building_name).abiertas += 1
  }

  return [...por.values()].sort((a, b) => b.abiertas - a.abiertas || b.salas - a.salas)
}

async function porMeses(): Promise<ReportData['porMes']> {
  const filas = await pide<{ month: string; total: number }>('la tendencia de doce meses', (señal) =>
    supabase
      .from('incidents_by_month')
      .select('month,total')
      .order('month', { ascending: false })
      .limit(12)
      .abortSignal(señal),
  )
  return [...filas].reverse().map((m) => ({ month: m.month, total: num(m.total) }))
}

async function salasConMasIncidencias(
  abiertas: FilaApertura[],
  deSala: Map<string, FilaSala>,
): Promise<ReportData['topSalas']> {
  const cuenta = new Map<string, number>()
  for (const i of abiertas) {
    if (i.kind !== 'incidencia' || !i.room_id || !deSala.has(i.room_id)) continue
    cuenta.set(i.room_id, (cuenta.get(i.room_id) ?? 0) + 1)
  }

  const top = [...cuenta.entries()]
    .map(([roomId, total]) => ({ sala: deSala.get(roomId)!, roomId, total }))
    .sort(
      (a, b) =>
        b.total - a.total ||
        a.sala.building_code.localeCompare(b.sala.building_code) ||
        a.sala.room_code.localeCompare(b.sala.room_code),
    )
    .slice(0, 8)

  if (top.length === 0) return []

  /*
   * La fiabilidad solo de las ocho que salen. Traerse la vista entera para
   * quedarse con ocho filas es pedirle a la base el índice de 276 aulas cada
   * vez que alguien genera un informe.
   */
  const filas = await pide<{ room_id: string; score: number | null; hay_datos: boolean | null }>(
    'la fiabilidad de las salas',
    (señal) =>
      supabase
        .from('room_reliability')
        .select('room_id,score,hay_datos')
        .in(
          'room_id',
          top.map((t) => t.roomId),
        )
        .abortSignal(señal),
  )
  const fiabilidad = new Map(filas.map((f) => [f.room_id, f]))

  return top.map((t) => {
    const f = fiabilidad.get(t.roomId)
    return {
      building: t.sala.building_code,
      room: t.sala.room_code,
      name: t.sala.room_name,
      total: t.total,
      fiabilidad: f?.score === null || f?.score === undefined ? null : num(f.score),
      hayDatos: Boolean(f?.hay_datos),
    }
  })
}

/**
 * Cuánto se tarda en cerrar.
 *
 * La mediana y no solo la media: dos incidencias del histórico abiertas hace un
 * año arrastran la media a semanas y esconden que el trabajo del día se cierra
 * en horas. Van las dos, y la mediana primero.
 */
export function resolucion(cerradas: FilaCierre[]): ReportData['resolucion'] {
  const dias = cerradas
    .filter((i) => i.resolved_at)
    .map((i) => (new Date(i.resolved_at!).getTime() - new Date(i.opened_at).getTime()) / 86_400_000)
    .sort((a, b) => a - b)

  const redondea = (v: number | null): number | null =>
    v === null ? null : Math.round(v * 10) / 10

  return {
    resueltas: cerradas.length,
    medianaDias: redondea(mediana(dias)),
    mediaDias: redondea(dias.length ? dias.reduce((a, b) => a + b, 0) / dias.length : null),
    enMenosDe48h: dias.filter((d) => d <= 2).length,
  }
}

/** `percentile_cont(0.5)`: con un número par de valores, la media de los dos centrales. */
function mediana(ordenados: number[]): number | null {
  if (ordenados.length === 0) return null
  const medio = Math.floor(ordenados.length / 2)
  return ordenados.length % 2 === 1
    ? ordenados[medio]!
    : (ordenados[medio - 1]! + ordenados[medio]!) / 2
}

async function lamparasAlLimite(): Promise<ReportData['lamparas']> {
  const filas = await pide<{
    building_code: string
    room_code: string
    lamp_pct: number
    projector_hours: number | null
  }>('las lámparas al límite', (señal) =>
    supabase
      .from('alerts_lamp_low')
      .select('building_code,room_code,lamp_pct,projector_hours')
      .order('lamp_pct', { ascending: true })
      .limit(12)
      .abortSignal(señal),
  )
  return filas.map((l) => ({
    building: l.building_code,
    room: l.room_code,
    horas: l.projector_hours === null ? null : num(l.projector_hours),
    pct: num(l.lamp_pct),
  }))
}

async function salasOlvidadas(): Promise<ReportData['olvidadas']> {
  const filas = await pide<{ building_code: string; room_code: string; days_since: number | null }>(
    'las salas sin revisar',
    (señal) =>
      supabase
        .from('alerts_overdue_rooms')
        .select('building_code,room_code,days_since')
        .order('days_since', { ascending: false, nullsFirst: true })
        .limit(10)
        .abortSignal(señal),
  )
  return filas.map((o) => ({
    building: o.building_code,
    room: o.room_code,
    dias: o.days_since === null ? null : num(o.days_since),
  }))
}

/**
 * Las estancadas, con las tres exclusiones y no solo dos.
 *
 * Fuera los borradores —una nota a medias listada como «47 días abierta» es una
 * acusación falsa— y fuera también las observaciones: las importadas del Excel
 * llevan abiertas desde 2025 por definición, porque una nota de seguimiento no
 * la cierra nadie, y encabezaban esta tabla en todos los informes con pinta de
 * avería eterna.
 */
async function sinCerrarDesdeHaceUnaSemana(
  deSala: Map<string, FilaSala>,
): Promise<ReportData['estancadas']> {
  const hace7dias = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const filas = await pide<{
    external_ref: string | null
    title: string | null
    room_id: string | null
    opened_at: string
    severity: string | null
  }>('las incidencias estancadas', (señal) =>
    supabase
      .from('incidents')
      .select('external_ref,title,room_id,opened_at,severity')
      .neq('state', 'resuelta')
      .neq('state', 'borrador')
      .neq('kind', 'observacion')
      .lt('opened_at', hace7dias)
      .order('opened_at', { ascending: true })
      .limit(12)
      .abortSignal(señal),
  )

  const ahora = Date.now()
  return filas.map((i) => {
    const sala = i.room_id ? deSala.get(i.room_id) : undefined
    return {
      ref: i.external_ref,
      titulo: i.title ?? '(sin describir)',
      building: sala?.building_code ?? '—',
      room: sala?.room_code ?? '',
      dias: Math.floor((ahora - new Date(i.opened_at).getTime()) / 86_400_000),
      gravedad: i.severity ?? 'baja',
    }
  })
}

/** El catálogo de almacén, para poner nombre a cada movimiento. */
async function articulosDeAlmacen(): Promise<Map<string, { name: string; unit: string }>> {
  const filas = await todas<{ id: string; name: string; unit: string }>(
    'el catálogo de almacén',
    (d, h, señal) => supabase.from('stock_items').select('id,name,unit').order('id').abortSignal(señal).range(d, h),
  )
  return new Map(filas.map((a) => [a.id, { name: a.name, unit: a.unit }]))
}

export function materiales(
  movimientos: FilaMovimiento[],
  articulos: Map<string, { name: string; unit: string }>,
): ReportData['materiales'] {
  interface Acumulado {
    name: string
    unidad: string
    consumido: number
    incidencias: Set<string>
  }
  const por = new Map<string, Acumulado>()

  for (const m of movimientos) {
    if (m.kind !== 'consumo') continue
    const art = articulos.get(m.stock_item_id)
    if (!art) continue
    const clave = `${art.name} ${art.unit}`
    const acc = por.get(clave) ?? {
      name: art.name,
      unidad: art.unit,
      consumido: 0,
      incidencias: new Set<string>(),
    }
    acc.consumido += -num(m.qty)
    // `count(distinct incident_id)` no cuenta los nulos: un consumo sin
    // incidencia asociada no es «una incidencia más» de ese material.
    if (m.incident_id) acc.incidencias.add(m.incident_id)
    por.set(clave, acc)
  }

  return [...por.values()]
    .sort((a, b) => b.consumido - a.consumido)
    .slice(0, 10)
    .map((a) => ({
      name: a.name,
      unidad: a.unidad,
      consumido: a.consumido,
      incidencias: a.incidencias.size,
    }))
}

async function salasQueRepiten(
  deSala: Map<string, FilaSala>,
): Promise<ReportData['reincidentes']> {
  const filas = await pide<{ room_id: string; item: string; veces: number }>(
    'las salas que repiten el mismo repuesto',
    (señal) =>
      supabase
        .from('room_repeat_offenders')
        .select('room_id,item,veces')
        .order('veces', { ascending: false })
        .limit(12)
        .abortSignal(señal),
  )

  return filas
    .filter((r) => deSala.has(r.room_id))
    .slice(0, 6)
    .map((r) => ({
      building: deSala.get(r.room_id)!.building_code,
      room: deSala.get(r.room_id)!.room_code,
      item: r.item,
      veces: num(r.veces),
    }))
}

/**
 * Los nombres de quienes aparecen en el informe.
 *
 * Se piden de golpe y solo los que salen: `profiles` se puede leer entera desde
 * aquí, pero traerse el personal completo para poner cuatro nombres en una tabla
 * es trabajo que no hace falta.
 */
async function nombresDePersona(ids: Array<string | null>): Promise<Map<string, string>> {
  const unicos = [...new Set(ids.filter((x): x is string => Boolean(x)))]
  if (unicos.length === 0) return new Map()

  const filas = await pide<{ id: string; full_name: string | null }>(
    'los nombres del personal',
    (señal) => supabase.from('profiles').select('id,full_name').in('id', unicos).abortSignal(señal),
  )
  return new Map(filas.map((p) => [p.id, p.full_name ?? '']))
}

/**
 * Actividad del equipo. Va con nombre porque el informe es interno y quien lo
 * lee ya sabe quién está de turno; lo que NO sale de aquí es hacia la IA, que
 * recibe estas filas sin nombres (ver `ia.ts`). No es un ranking: un técnico
 * con seis revisiones y otro con dos pueden haber trabajado lo mismo si el
 * segundo ha estado desmontando una botonera toda la tarde.
 *
 * Una visita corregida se le apunta a quien firmó la versión que vale. Si la
 * corrigió un compañero, la visita cuenta para él y no para quien la hizo; es
 * una distorsión pequeña y consciente, y contarla dos veces —una por versión—
 * mentiría en el total, que es el número que sí se lee como una medida.
 */
export function repartoDelTrabajo(
  f: FilasDelPeriodo,
  quien: Map<string, string>,
): ReportData['equipo'] {
  const cuenta = new Map<string, { revisiones: number; registros: number }>()
  const entrada = (id: string): { revisiones: number; registros: number } => {
    const previa = cuenta.get(id)
    if (previa) return previa
    const nueva = { revisiones: 0, registros: 0 }
    cuenta.set(id, nueva)
    return nueva
  }

  for (const v of porVisita(f.revisiones)) {
    if (v.by_user) entrada(v.by_user).revisiones += 1
  }
  for (const i of f.abiertas) {
    if (i.opened_by) entrada(i.opened_by).registros += 1
  }

  return [...cuenta.entries()]
    .map(([id, n]) => ({ nombre: quien.get(id) ?? '', ...n }))
    .filter((p) => p.nombre && p.revisiones + p.registros > 0)
    .sort((a, b) => b.revisiones + b.registros - (a.revisiones + a.registros))
    .slice(0, 12)
}

/**
 * LAS REVISIONES, UNA A UNA.
 *
 * `fallos` son las comprobaciones que salieron mal dentro de la revisión y
 * `aperturas` los registros que nacieron de ella. No son lo mismo y la
 * diferencia importa: tres comprobaciones malas que se arreglaron ahí mismo
 * dejan la sala en «con incidencias» sin abrir nada, y eso es trabajo hecho,
 * no trabajo pendiente.
 *
 * Devuelve `quien` como identificador; el nombre lo pone quien llama, que ya ha
 * pedido todos los de una vez.
 */
async function filasDeRevisiones(
  visitas: FilaRevision[],
  deSala: Map<string, FilaSala>,
): Promise<ReportData['revisiones']> {
  // Solo las que tienen sala viva: una revisión de un aula archivada se cuenta
  // en el total pero no tiene fila que enseñar, porque no tiene ni código.
  const conSala = visitas.filter((v) => v.room_id && deSala.has(v.room_id)).slice(0, TOPE_FILAS)
  if (conSala.length === 0) return []

  const ids = conSala.map((v) => v.id)
  const [checks, aperturas] = await Promise.all([
    pide<{ inspection_id: string }>('las comprobaciones de cada revisión', (señal) =>
      supabase
        .from('inspection_checks')
        .select('inspection_id')
        .in('inspection_id', ids)
        .eq('result', 'incidencia')
        .abortSignal(señal),
    ),
    pide<{ opened_from_inspection_id: string }>(
      'los registros que nacieron de cada revisión',
      (señal) =>
        supabase
          .from('incidents')
          .select('opened_from_inspection_id')
          .in('opened_from_inspection_id', ids)
          .neq('state', 'borrador')
          .abortSignal(señal),
    ),
  ])

  const fallos = new Map<string, number>()
  for (const c of checks) {
    fallos.set(c.inspection_id, (fallos.get(c.inspection_id) ?? 0) + 1)
  }
  const nacidas = new Map<string, number>()
  for (const i of aperturas) {
    const id = i.opened_from_inspection_id
    nacidas.set(id, (nacidas.get(id) ?? 0) + 1)
  }

  return conSala.map((v) => {
    const sala = deSala.get(v.room_id!)!
    return {
      dia: diaEnMadrid(new Date(v.occurred_at)),
      hora: horaCorta(v.occurred_at),
      building: sala.building_code,
      room: sala.room_code,
      name: sala.room_name,
      quien: v.by_user,
      resultado: v.overall ?? 'ok',
      fallos: fallos.get(v.id) ?? 0,
      aperturas: nacidas.get(v.id) ?? 0,
    }
  })
}

/** Cómo se llama cada tipo de movimiento de equipo cuando no hay etiqueta. */
async function etiquetasDeEquipo(
  eventos: FilaEventoEquipo[],
): Promise<Map<string, { titulo: string; serial: string | null; roomId: string | null }>> {
  const ids = [...new Set(eventos.map((e) => e.asset_id))]
  if (ids.length === 0) return new Map()

  const [equipos, tipos] = await Promise.all([
    pide<{
      id: string
      label: string | null
      serial: string | null
      room_id: string | null
      asset_type_id: string | null
    }>('los equipos del diario', (señal) =>
      supabase
        .from('assets')
        .select('id,label,serial,room_id,asset_type_id')
        .in('id', ids)
        .abortSignal(señal),
    ),
    pide<{ id: string; name: string }>('los tipos de equipo', (señal) =>
      supabase.from('asset_types').select('id,name').abortSignal(señal),
    ),
  ])

  const nombreTipo = new Map(tipos.map((t) => [t.id, t.name]))

  return new Map(
    equipos.map((a) => [
      a.id,
      {
        titulo:
          a.label ?? (a.asset_type_id ? (nombreTipo.get(a.asset_type_id) ?? 'Equipo') : 'Equipo'),
        serial: a.serial,
        roomId: a.room_id,
      },
    ]),
  )
}

/**
 * EL DIARIO.
 *
 * Se arma aquí y no se lee de `room_timeline`, que ya une casi lo mismo, por
 * dos motivos. El primero es que esa vista exige sala y deja fuera
 * precisamente los registros huérfanos del histórico, que también pasaron. El
 * segundo es que en ella una apertura y un cierre solo se distinguen por si el
 * título empieza por «Resuelta:», y de una cadena de texto no se cuelga la
 * lectura de un informe.
 *
 * Las revisiones no entran: tienen su propia tabla y su recuento en la cabecera
 * de cada día. Repetirlas aquí llenaría el diario de una sola cosa.
 */
async function diarioDelPeriodo(
  f: FilasDelPeriodo,
  deSala: Map<string, FilaSala>,
  quien: Map<string, string>,
  articulos: Map<string, { name: string; unit: string }>,
): Promise<ReportData['eventos']> {
  const equipos = await etiquetasDeEquipo(f.equipos)

  interface Crudo {
    at: string
    tipo: string
    subtipo: string
    titulo: string
    detalle: string | null
    cantidad: number | null
    ref: string | null
    roomId: string | null
    byUser: string | null
  }
  const todos: Crudo[] = []

  for (const i of f.abiertas) {
    todos.push({
      at: i.opened_at,
      tipo: 'apertura',
      subtipo: i.kind,
      titulo: i.title ?? '(sin describir)',
      detalle: i.description || null,
      cantidad: null,
      ref: i.external_ref,
      roomId: i.room_id,
      byUser: i.opened_by,
    })
  }

  for (const i of f.cerradas) {
    if (!i.resolved_at) continue
    todos.push({
      at: i.resolved_at,
      tipo: 'cierre',
      subtipo: i.kind,
      titulo: i.title ?? '(sin describir)',
      detalle: i.resolution || null,
      cantidad: null,
      ref: i.external_ref,
      roomId: i.room_id,
      byUser: i.resolved_by,
    })
  }

  for (const m of f.movimientos) {
    todos.push({
      at: m.occurred_at,
      tipo: 'material',
      subtipo: m.kind,
      titulo: articulos.get(m.stock_item_id)?.name ?? 'Material',
      detalle: m.note || null,
      cantidad: num(m.qty),
      ref: null,
      roomId: m.room_id,
      byUser: m.by_user,
    })
  }

  for (const v of f.inventarios) {
    todos.push({
      at: v.occurred_at,
      tipo: 'inventario',
      subtipo: 'levantamiento',
      titulo: 'Inventario confirmado',
      detalle: v.note || `${num(v.asset_count)} equipos en la sala`,
      cantidad: null,
      ref: null,
      roomId: v.room_id,
      byUser: v.by_user,
    })
  }

  for (const e of f.equipos) {
    const equipo = equipos.get(e.asset_id)
    const notaCruda = e.meta?.['nota']
    const nota = typeof notaCruda === 'string' ? notaCruda : ''
    todos.push({
      at: e.occurred_at,
      tipo: 'equipo',
      subtipo: e.kind,
      titulo: equipo?.titulo ?? 'Equipo',
      detalle: nota || null,
      cantidad: null,
      ref: equipo?.serial ?? null,
      roomId: e.room_id ?? equipo?.roomId ?? null,
      byUser: e.by_user,
    })
  }

  return todos
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, TOPE_FILAS)
    .map((e) => {
      const sala = e.roomId ? deSala.get(e.roomId) : undefined
      return {
        dia: diaEnMadrid(new Date(e.at)),
        hora: horaCorta(e.at),
        tipo: e.tipo,
        subtipo: e.subtipo,
        titulo: e.titulo,
        detalle: e.detalle,
        cantidad: e.cantidad,
        ref: e.ref,
        building: sala?.building_code ?? '—',
        room: sala?.room_code ?? '',
        quien: e.byUser ? (quien.get(e.byUser) ?? null) : null,
      }
    })
}
