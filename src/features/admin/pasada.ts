/**
 * La pasada, de principio a fin: subir el libro, ver qué pasaría, y que pase.
 *
 * Es el único sitio donde se juntan las tres cosas —el fichero, la base y el
 * motor— y por eso es el único donde hay un orden que **no** se puede cambiar:
 *
 *   1. leer el libro y la base
 *   2. leer la instantánea de la última pasada
 *   3. decidir, sin escribir nada, y enseñarlo
 *   4. aplicar a la base **en una transacción**
 *   5. y solo entonces, escribir el libro
 *
 * El 4 va antes que el 5 a propósito. Si el libro se escribiera primero y la
 * base fallara, el fichero diría cosas que la base no sabe y la pasada
 * siguiente las leería como «lo cambió el Excel» y las volvería a meter — o
 * peor, las daría por conflicto contra la app. Al revés, si la base entra y el
 * navegador se cierra antes de descargar, no se ha perdido nada: la pasada
 * siguiente vuelve a escribir el libro, porque la instantánea ya dice cuál es
 * el valor bueno.
 *
 * Y el 3 no es un adorno de la pantalla. Contra un libro de 295 filas que lleva
 * años de manos distintas, la primera pasada mueve cientos de celdas: poder
 * mirarlas antes es la diferencia entre revisar y creer.
 *
 * **El fichero no sale de este ordenador.** Se abre, se cruza y se parchea en el
 * navegador; lo único que viaja al servidor es el plan —qué celdas ganó el
 * Excel— y las filas leídas, que es lo que hace falta para poder contestar «¿de
 * dónde salió este dato?» seis meses después.
 */

import { supabase } from '@/lib/supabase'
import { señalConTope } from '@/features/reports/informe/espera'
import { construirIndice } from '@/domain/cruce'
import type { Catalogo, Indice } from '@/domain/cruce'
import { corteDeAnyo } from '@/domain/anyo'
import { pendientes } from '@/domain/dudas'
import type { Duda, Respuestas } from '@/domain/dudas'
import {
  hojaDeInventario,
  hojaDeLeeme,
  hojaDeMovimientos,
  hojaDeRevisiones,
  hojaDeUnidades,
  hojaDelParte,
} from '@/domain/hojasNuevas'
import type { LineaDelParte } from '@/domain/hojasNuevas'
import { escribirLibro } from '@/domain/libro'
import type { Acabado, EdicionDeHoja, HojaNueva } from '@/domain/libro'
import {
  BOLSA_2025,
  BOLSA_2026,
  ESTADO,
  HOJAS,
  MATERIAL_2025,
  MATERIAL_2026,
  PCS_2026,
  TITULO_DE_SITUACION,
  hojaPorNombre,
  hojasDelAnyo,
} from '@/domain/mapa'
import type { Hoja } from '@/domain/mapa'
import { columnaParaLaRef } from '@/domain/preparar'
import { movimientosPrevistos } from '@/domain/movimientos'
import type { MovimientoPrevisto } from '@/domain/movimientos'
import {
  resumir,
  sincronizarBolsa,
  sincronizarEstado,
  sincronizarPartes,
  sincronizarUnidades,
} from '@/domain/sincronizar'
import type { Alta, Instantanea, Plan, Referencia, Resumen } from '@/domain/sincronizar'
import { leerMaterial } from '@/domain/valores'
import type { Valor } from '@/domain/valores'
import { abrirLibro, celdasCombinadas, leerHoja, numeroAColumna } from '@/domain/xlsx'
import type { Cambio, FilaLeida, Libro } from '@/domain/xlsx'
import { datosDeLaPasada } from './datosDeLaPasada'
import type { DatosDeLaPasada } from './datosDeLaPasada'
import { catalogoDelMaestro } from './catalogoDelMaestro'

export const ORIGEN = 'material_aulas'

export interface Analisis {
  libro: Libro
  nombre: string
  bytes: Uint8Array
  sha256: string
  anyo: number
  datos: DatosDeLaPasada
  planes: Plan[]
  resumenes: Resumen[]
  hojasNuevas: HojaNueva[]
  columnaRef: string
  /** Lo que la pasada pregunta antes de aplicar, de todas las hojas. */
  dudas: Duda[]
  /** Lo que la persona ha contestado. Se vuelve a planificar con cada respuesta. */
  respuestas: Respuestas
  /**
   * Quién manda donde la fusión no sabe decidir: el Excel, la aplicación, o
   * nadie —se pregunta—. Se elige al cargar y se puede cambiar; cambiarlo es
   * volver a planificar, como contestar una duda.
   */
  referencia: Referencia | null
  /**
   * El corte: desde este día manda la aplicación en lo que ella cambió, se
   * haya elegido lo que se haya elegido. `null` es sin corte. Ver `Celda.corte`.
   */
  corte: string | null
  /**
   * Si esta pasada va a crear las aulas que el libro trae bien escritas.
   *
   * Apagado por defecto: dar de alta una sala es lo único de esta pantalla que
   * no se deshace solo. Se enciende desde la pantalla y es volver a
   * planificar, como contestar una duda, así que la lista de lo que se va a
   * crear se ve antes de aplicar nada.
   */
  crearAulas: boolean
  /**
   * Si esta pasada va a crear los equipos que el libro trae y la sala no tiene.
   *
   * Hermana de `crearAulas` y por el mismo motivo: contestar de uno en uno a
   * setenta y cinco monitores no los iba a crear nunca. Apagada de salida.
   */
  crearEquipos: boolean
  /** Lo que el almacén va a apuntar si la pasada se aplica. Ver `movimientos.ts`. */
  movimientos: MovimientoPrevisto[]
  /** El maestro, para que la pantalla ofrezca salas en las dudas. */
  catalogo: Catalogo
  /**
   * Lo que hizo falta leer para planificar, guardado para volver a planificar
   * con otras respuestas sin volver a bajar el libro ni la base.
   */
  entrada: EntradaDeLaPasada
  /** Si alguna hoja no tiene la forma declarada, la pasada no puede empezar. */
  bloqueada: boolean
  /**
   * `true` si este fichero **no es** el que salió de la última pasada. No
   * prohíbe nada —puede haber un motivo— pero hay que decirlo antes de aplicar:
   * un libro viejo se parece a un lado que cambió, y la fusión revertiría en la
   * base el trabajo hecho desde entonces sin dar un solo error.
   */
  libroDesconocido: boolean
  /** Cuándo se produjo el libro que la aplicación esperaba, si lo hubo. */
  ultimaSalida: string | null
  /**
   * Qué contestó el servidor sobre la última salida: `ninguna`, `conocida` o
   * `no se sabe`. Lo mira «Hacer el libro de hoy»: sin saber si hay una salida
   * posterior no se aplica una copia guardada, que es justo la que revertiría
   * el trabajo de otro aparato sin dar un solo error.
   */
  ultimaSalidaEstado: UltimaSalida['estado']
}

// -----------------------------------------------------------------------------
// 1 a 3 — Analizar
// -----------------------------------------------------------------------------

/** Lo leído del libro y de la base, que no cambia entre dos planificaciones. */
export interface EntradaDeLaPasada {
  filas: Map<string, FilaLeida[]>
  combinadas: string[]
  instantaneas: Map<string, Instantanea>
  indice: Indice
}

export async function analizar(
  fichero: File,
  hoy = new Date(),
  respuestas: Respuestas = {},
  referencia: Referencia | null = null,
  corte: string | null = null,
  crearAulas = false,
  crearEquipos = false,
): Promise<Analisis> {
  const bytes = new Uint8Array(await fichero.arrayBuffer())
  const libro = await abrirLibro(bytes)
  const anyo = hoy.getFullYear()

  const faltan = [ESTADO, MATERIAL_2026, BOLSA_2026].filter(
    (h) => !libro.hojas.some((x) => x.nombre === h.nombre),
  )
  if (faltan.length > 0) {
    throw new Error(
      `Este libro no tiene ${faltan.map((h) => `«${h.nombre}»`).join(', ')}. Sus hojas son: ${libro.hojas
        .map((h) => h.nombre)
        .join(', ')}`,
    )
  }

  const [catalogo, datos, salida] = await Promise.all([
    catalogoDelMaestro(),
    datosDeLaPasada(anyo),
    ultimaSalida(),
  ])
  const sha256 = await sha256De(bytes)
  const indice = construirIndice(catalogo as Catalogo)

  // Todo lo que hay que leer se lee una vez. Contestar una duda vuelve a
  // planificar, y volver a planificar no puede costar otra bajada de la base.
  const filas = new Map<string, FilaLeida[]>()
  for (const hoja of [ESTADO, MATERIAL_2026, MATERIAL_2025, BOLSA_2026, BOLSA_2025, PCS_2026]) {
    if (!libro.hojas.some((h) => h.nombre === hoja.nombre)) continue
    filas.set(hoja.nombre, await leerHoja(libro, hoja.nombre))
  }
  const instantaneas = new Map<string, Instantanea>()
  for (const nombre of filas.keys()) instantaneas.set(nombre, await instantaneaDe(nombre))

  const entrada: EntradaDeLaPasada = {
    filas,
    combinadas: await celdasCombinadas(libro, ESTADO.nombre),
    instantaneas,
    indice,
  }
  const columnaRef = columnaParaLaRef(filas.get(ESTADO.nombre)!, ESTADO.cabecera, 'Ref')
  const planes = planificar(entrada, datos, columnaRef, respuestas, referencia, corte, crearAulas, crearEquipos)

  // Las hojas de detalle se rehacen enteras cada pasada. No son un historial que
  // haya que ir completando: son la foto de lo que la base sabe hoy, y
  // reconstruirlas cuesta menos que decidir qué fila cambió.
  const hojasNuevas: HojaNueva[] = []
  const cierre = corteDeAnyo({
    anyo,
    hojasExistentes: libro.hojas.map((h) => h.nombre),
    // Solo los vivos: un artículo retirado no estrena bolsa en enero.
    articulos: [...datos.saldos.keys()].map((id) => ({
      nombre: datos.articulos.find((a) => a.id === id && a.activo !== false)?.nombre ?? '',
      nombreAlternativo: datos.nombresAlternativos.get(id) ?? null,
      saldo: datos.saldos.get(id) ?? 0,
    })).filter((a) => a.nombre !== ''),
  })
  hojasNuevas.push(...cierre.hojas)

  // La hoja de PCs de repuesto, si el libro no la trae: se estrena con lo que
  // la aplicación sabe. A partir de ahí es una hoja normal, con sus dos caras.
  if (!datos.sinUnidades && !libro.hojas.some((h) => h.nombre === PCS_2026.nombre)) {
    hojasNuevas.push(hojaDeUnidades(PCS_2026, datos.unidades))
  }

  return {
    libro,
    nombre: fichero.name,
    bytes,
    sha256,
    anyo,
    datos,
    planes,
    resumenes: planes.map(resumir),
    hojasNuevas,
    columnaRef,
    dudas: planes.flatMap((p) => p.dudas),
    respuestas,
    referencia,
    corte,
    crearAulas,
    crearEquipos,
    movimientos: movimientosDe(planes, datos),
    catalogo,
    entrada,
    bloqueada: planes.some((p) => p.desajustes.length > 0),
    libroDesconocido: salida.estado === 'conocida' && salida.sha256 !== sha256,
    ultimaSalida: salida.estado === 'conocida' ? salida.cuando : null,
    ultimaSalidaEstado: salida.estado,
  }
}

/**
 * Volver a planificar con otras respuestas, o con otra referencia. No lee
 * nada: todo lo que hace falta está en `entrada`, y por eso contestar una duda
 * —o cambiar quién manda— es instantáneo.
 */
export function replanificar(
  a: Analisis,
  respuestas: Respuestas,
  referencia: Referencia | null = a.referencia,
  corte: string | null = a.corte,
  crearAulas: boolean = a.crearAulas,
  crearEquipos: boolean = a.crearEquipos,
): Analisis {
  const planes = planificar(
    a.entrada, a.datos, a.columnaRef, respuestas, referencia, corte, crearAulas, crearEquipos,
  )
  return {
    ...a,
    planes,
    resumenes: planes.map(resumir),
    dudas: planes.flatMap((p) => p.dudas),
    respuestas,
    referencia,
    corte,
    crearAulas,
    crearEquipos,
    movimientos: movimientosDe(planes, a.datos),
    bloqueada: planes.some((p) => p.desajustes.length > 0),
  }
}

function movimientosDe(planes: Plan[], datos: DatosDeLaPasada): MovimientoPrevisto[] {
  return movimientosPrevistos({
    planes,
    incidencias: datos.incidencias,
    articulos: datos.articulos,
    resolver: datos.resolverArticulo,
    // Desde cuándo lleva la aplicación el almacén: lo declara la hoja del año.
    // Las hojas de una pasada son del mismo año, así que vale la primera que
    // lo diga.
    arranque: planes.map((p) => hojaPorNombre(p.hoja)?.arranque).find((a): a is string => a !== undefined),
  })
}

/** Las dudas que siguen sin contestar. Con alguna, la pasada no se aplica. */
export function dudasPendientes(a: Analisis): Duda[] {
  return pendientes(a.dudas, a.respuestas)
}

function planificar(
  e: EntradaDeLaPasada,
  datos: DatosDeLaPasada,
  columnaRef: string,
  respuestas: Respuestas,
  referenciaElegida: Referencia | null,
  corteElegido: string | null,
  crearAulas: boolean,
  crearEquipos: boolean,
): Plan[] {
  const planes: Plan[] = []
  const inst = (hoja: string): Instantanea => e.instantaneas.get(hoja) ?? (() => undefined)
  const referencia = referenciaElegida ?? undefined
  const corte = corteElegido ?? undefined

  planes.push(
    sincronizarEstado({
      hoja: ESTADO,
      filas: e.filas.get(ESTADO.nombre)!,
      salas: datos.salas,
      indice: e.indice,
      columnaRef,
      combinadas: e.combinadas,
      instantanea: inst(ESTADO.nombre),
      respuestas,
      referencia,
      corte,
      crearAulas,
      crearEquipos,
    }),
  )

  for (const hoja of [MATERIAL_2026, MATERIAL_2025] as Hoja[]) {
    const filas = e.filas.get(hoja.nombre)
    if (!filas) continue
    planes.push(
      sincronizarPartes({
        hoja,
        filas,
        incidencias: datos.incidencias,
        instantanea: inst(hoja.nombre),
        indice: e.indice,
        respuestas,
        referencia,
        corte,
      }),
    )
  }

  for (const hoja of [BOLSA_2026, BOLSA_2025] as Hoja[]) {
    const filas = e.filas.get(hoja.nombre)
    if (!filas) continue
    planes.push(
      sincronizarBolsa({
        hoja,
        filas,
        articulos: datos.articulos,
        resolver: datos.resolverArticulo,
        instantanea: inst(hoja.nombre),
        respuestas,
        referencia,
        corte,
      }),
    )
  }

  // Sin la tabla en el servidor la hoja de PCs no se toca: aceptar un alta
  // llamaría a una función que no existe, y la pasada lo dice en su cabecera.
  const filasPcs = datos.sinUnidades ? undefined : e.filas.get(PCS_2026.nombre)
  if (filasPcs) {
    planes.push(
      sincronizarUnidades({
        hoja: PCS_2026,
        filas: filasPcs,
        unidades: datos.unidades,
        instantanea: inst(PCS_2026.nombre),
        respuestas,
        referencia,
        corte,
      }),
    )
  }

  return planes
}

/**
 * El libro que salió de la última pasada, para saber si es éste el que se sube.
 *
 * Tres respuestas, no dos, y la tercera es la que faltaba: «no lo sé». Un
 * servidor al que le falta `sync_ultima_salida` —o que no contesta— devolvía
 * `null`, lo mismo que «nunca se ha sincronizado», y quien leía eso concluía
 * que el libro guardado en el aparato era el bueno. Sobre la base del 22/09,
 * con migraciones anotadas y sin ejecutar, eso habría dicho «súbelo» de un
 * fichero de hace tres semanas.
 */
export type UltimaSalida =
  | { estado: 'ninguna' }
  | { estado: 'conocida'; sha256: string; cuando: string }
  | { estado: 'no se sabe'; porQue: string }

export async function ultimaSalida(): Promise<UltimaSalida> {
  // Con plazo, como todo lo que la pasada pide: ver `datosDeLaPasada.ts`.
  const { data, error } = await supabase.rpc('sync_ultima_salida').abortSignal(señalConTope(25_000))
  if (error) return { estado: 'no se sabe', porQue: error.message }
  if (!Array.isArray(data) || data.length === 0) return { estado: 'ninguna' }
  const fila = data[0] as { sha256: string | null; cuando: string }
  return fila.sha256
    ? { estado: 'conocida', sha256: fila.sha256, cuando: fila.cuando }
    : { estado: 'ninguna' }
}

/** El antepasado de cada celda de una hoja, de golpe. */
async function instantaneaDe(hoja: string): Promise<Instantanea> {
  // Miles de celdas en la hoja de estado: un minuto, y si no llega, se dice.
  const { data, error } = await supabase.rpc('sync_instantanea', { p_hoja: hoja }).abortSignal(señalConTope(60_000))
  // Sin instantánea la fusión sigue funcionando: es la primera pasada, y manda
  // la app. Parar aquí convertiría un servidor viejo en una pantalla rota.
  if (error || !data) return () => undefined

  const mapa = new Map<string, string | null>()
  for (const c of data as Array<{ ref: string; columna: string; valor_base: string | null }>) {
    mapa.set(`${c.ref}!${c.columna}`, c.valor_base)
  }
  return (clave, letra) => {
    const k = `${clave}!${letra}`
    return mapa.has(k) ? mapa.get(k)! : undefined
  }
}

// -----------------------------------------------------------------------------
// 4 — Aplicar a la base
// -----------------------------------------------------------------------------

export interface Aplicado {
  parteId: number
  aplicadas: number
  rechazadas: number
  /** Las filas nuevas que entraron, con la clave que la base les puso. */
  altas: AltaAplicada[]
}

export interface AltaAplicada {
  hoja: string
  fila: number
  tipo: string
  clave: string
  /** El número del parte, cuando es un parte: hay que escribirlo en su fila. */
  numero: string | null
}

/**
 * Las filas del libro tal y como venían, para `sync_filas`.
 *
 * Se saca aparte de `aplicar` para poder probarla: es la única parte de la carga
 * que agrupa, y agrupar mal aquí no da un dato raro, tira la pasada entera —el
 * RPC es una transacción, así que una fila mala se lleva por delante las otras
 * mil setecientas.
 *
 * **Las celdas de filas nuevas no entran.** `anotarCeldaNueva` las marca con
 * `fila: 0` a propósito, porque describen filas que todavía no existen en el
 * libro: valen para la instantánea, que se indexa por (hoja, ref, columna), y no
 * valen aquí, donde `fila` es el número de una fila que se leyó. Colarlas hacía
 * dos daños a la vez:
 *
 *  - `sync_filas` declara `check (fila > 0)` y rechazaba la fila, y con ella la
 *    pasada entera: «new row for relation "sync_filas" violates check constraint
 *    "sync_filas_fila_check"», sin decir de qué hoja ni de qué fila hablaba;
 *  - y antes de eso, la agrupación las fundía TODAS en una sola «fila 0»,
 *    quedándose con el `ref` de la primera y mezclando en un mismo `contenido`
 *    las celdas de salas, incidencias y artículos distintos. O sea que si la
 *    restricción no hubiera estado, el registro de procedencia habría guardado
 *    una fila que no existe con los datos de doscientas sesenta y cinco.
 *
 * No se pierde nada al dejarlas fuera: una fila nueva no estaba en el libro que
 * se leyó, así que no tiene procedencia que registrar. La tendrá en la pasada
 * siguiente, cuando ya sea una fila de verdad con su número.
 */
export function filasDeLaPasada(
  planes: Analisis['planes'],
): Array<{ hoja: string; fila: number; ref: string; contenido: Record<string, unknown> }> {
  const out: Array<{ hoja: string; fila: number; ref: string; contenido: Record<string, unknown> }> = []
  for (const p of planes) {
    // Por `Map` y no buscando dentro de un `reduce`: con las dos mil y pico
    // celdas de una pasada de verdad, el `some` dentro del bucle es cuadrático y
    // esto lo hace un iPad.
    const porFila = new Map<number, { hoja: string; fila: number; ref: string; contenido: Record<string, unknown> }>()
    for (const c of p.instantanea) {
      if (c.fila <= 0) continue
      const f = porFila.get(c.fila)
      if (f) f.contenido[c.letra] = c.valor
      else porFila.set(c.fila, { hoja: p.hoja, fila: c.fila, ref: c.clave, contenido: { [c.letra]: c.valor } })
    }
    out.push(...porFila.values())
  }
  return out
}

export async function aplicar(a: Analisis): Promise<Aplicado> {
  if (a.bloqueada) throw new Error('Hay hojas con la forma cambiada: la pasada no puede empezar')
  const sinContestar = dudasPendientes(a)
  if (sinContestar.length > 0) {
    throw new Error(
      `Quedan ${sinContestar.length} dudas sin contestar: la pasada no se aplica hasta que se contesten o se dejen como están`,
    )
  }

  const { data: ficheroId, error: eF } = await supabase.rpc('sync_registrar_fichero', {
    p_origen: ORIGEN,
    p_nombre: a.nombre,
    p_sha256: a.sha256,
    p_bytes: a.bytes.length,
  })
  if (eF) throw new Error(`No se pudo registrar el fichero: ${eF.message}`)

  const plan = {
    fichero_id: ficheroId,
    origen: ORIGEN,
    disparo: 'manual',
    filas: filasDeLaPasada(a.planes),
    altas: a.planes.flatMap((p) => p.altas.map((alta) => altaParaLaBase(p.hoja, alta, a))),
    hacia_la_base: ordenarParaElAlmacen(a.planes.flatMap((p) =>
      p.haciaLaBase.map((h) => ({
        hoja: p.hoja,
        fila: h.fila,
        // De qué habla la fila. Sin esto, la base tiene que adivinarlo por el
        // nombre del campo, y `sala.code` significa dos cosas distintas según la
        // hoja: el código del aula en la de estado y el aula de un parte en la
        // de material. Adivinándolo, las correcciones de los partes se
        // rechazaban con un motivo falso —«la matrícula no existe»— y no entraba
        // ni una.
        entidad: entidadDe(p.hoja),
        clave: claveDe(p, h.fila),
        // La letra de la columna, para que la base pueda emparejar esta
        // corrección con su celda de la instantánea: la que se rechaza no debe
        // dejar antepasado, o la pasada siguiente creerá que la app la cambió y
        // borrará del libro lo que alguien escribió a mano.
        columna: h.letra,
        campo: h.campo,
        valor: h.valor === null ? null : String(h.valor),
        motivo: h.motivo,
        // De qué año habla la hoja. `Comprado` no es «lo comprado»: es lo
        // comprado **en 2026**, y sin el año la base lo cuadra contra la compra
        // de todos los tiempos y mete la diferencia con 2025 como una compra de
        // hoy —negativa, además, que el signo no la deja pasar.
        ...(hojaPorNombre(p.hoja)?.anyo ? { anyo: hojaPorNombre(p.hoja)!.anyo } : {}),
        // Y desde cuándo lleva la aplicación el almacén de ese año: el material
        // de un parte anterior no mueve stock, y lo comprado se cuenta desde ahí.
        ...(hojaPorNombre(p.hoja)?.arranque ? { arranque: hojaPorNombre(p.hoja)!.arranque } : {}),
        // El material de un parte va ya partido y resuelto: el catálogo de alias
        // vive aquí, y partir «1Pantalla 240X240» en un 1 y una pantalla es
        // exactamente el tipo de cosa que en SQL sale mal.
        ...(h.campo === 'incidencia.material'
          ? { detalle: detalleDelMaterial(String(h.valor ?? ''), a.datos.resolverArticulo) }
          : {}),
      })),
    )),
    // Solo las que hablan del libro que ya está. Las que describen el que va a
    // salir esperan a que salga: ver `instantaneaDeLaSalida`.
    instantanea: celdasDeLaInstantanea(a, false),
    cuarentena: a.planes.flatMap((p) =>
      p.cuarentena.map((q) => ({
        hoja: p.hoja,
        fila: q.fila,
        clave: claveDe(p, q.fila) ?? q.destino,
        campo: q.campo,
        crudo: q.crudo === null ? null : String(q.crudo),
        motivo: q.motivo,
      })),
    ),
    resumen: {
      filas_leidas: a.resumenes.reduce((n, r) => n + r.filas, 0),
      sin_cambios: a.resumenes.reduce((n, r) => n + r.filas, 0),
      hacia_el_excel: a.resumenes.reduce((n, r) => n + r.celdasAlExcel, 0),
      conflictos: a.resumenes.reduce((n, r) => n + r.conflictos, 0),
      descuadres: a.planes.reduce((n, p) => n + p.avisos.filter((x) => x.includes('descuadre')).length, 0),
      altas: a.resumenes.reduce((n, r) => n + r.filasNuevas, 0),
      // Quién mandó donde la fusión no supo decidir. La base no lo usa; queda
      // en el plan por si algún día hay que explicar una pasada.
      referencia: a.referencia ?? 'preguntar',
      corte: a.corte,
    },
  }

  // Aplicar es una transacción con cientos de celdas: tres minutos, no infinito.
  const { data, error } = await supabase.rpc('sync_aplicar', { p_plan: plan }).abortSignal(señalConTope(180_000))
  if (error) throw new Error(`La pasada no se pudo aplicar: ${error.message}`)

  const r = data as {
    parte_id: number
    aplicadas: number
    rechazadas: number
    altas?: Array<{ hoja: string; fila: number; tipo: string; clave: string; numero: string | null }>
  }
  return {
    parteId: r.parte_id,
    aplicadas: r.aplicadas,
    rechazadas: r.rechazadas,
    altas: (r.altas ?? []).map((x) => ({
      hoja: x.hoja,
      fila: Number(x.fila),
      tipo: x.tipo,
      clave: x.clave,
      numero: x.numero ?? null,
    })),
  }
}

/**
 * Un alta tal y como la entiende `sync_alta`.
 *
 * El material de un parte va partido y resuelto, como en las correcciones: el
 * catálogo de alias vive en el navegador. Y las celdas van como texto, que es
 * como la instantánea las guarda y las compara.
 */
function altaParaLaBase(hoja: string, alta: Alta, a: Analisis): Record<string, unknown> {
  const celdas = Object.fromEntries(
    Object.entries(alta.celdas).map(([letra, valor]) => [letra, paraLaInstantanea(valor)]),
  )
  const base = { hoja, fila: alta.fila, tipo: alta.tipo, celdas }
  switch (alta.tipo) {
    case 'incidencia': {
      const h = hojaPorNombre(hoja)
      return {
        ...base,
        sala_id: alta.salaId,
        // Sin sala a propósito no es lo mismo que sin sala por no saberlo: la
        // base no apunta en la cuarentena lo que no tiene nada que resolver.
        sin_sala: alta.sinSala ?? false,
        aula: alta.aula,
        numero: alta.numero,
        abierta: alta.abierta,
        resuelta: alta.resuelta,
        problema: alta.problema,
        observacion: alta.observacion,
        resolucion: alta.resolucion,
        detalle: alta.material ? detalleDelMaterial(alta.material, a.datos.resolverArticulo) : [],
        // Un parte de antes del arranque del recuento entra con su material
        // apuntado y sin mover el almacén.
        arranque: h?.arranque ?? null,
        columna_numero: h?.identidad.tipo === 'incidencia' ? h.identidad.columna : 'D',
      }
    }
    case 'sala':
      return {
        ...base,
        edificio: alta.edificio,
        zona: alta.zona,
        code: alta.code,
        // El aula tal y como la escribió el libro, que puede no ser el código
        // —`2.6 S` crea la `2.6`—: queda de alias y es lo que hace que la fila
        // cruce sola en la pasada siguiente sin tocar el libro.
        aula: alta.aula,
      }
    case 'articulo':
      return {
        ...base,
        nombre: alta.nombre,
        nombre_alternativo: alta.nombreAlternativo,
        comprado: alta.comprado,
        // El año de la bolsa: lo comprado es lo comprado ESE año, y la compra
        // con la que entra el artículo tiene que fecharse dentro de él, igual
        // que el cuadre de una celda. Sin el año la base la fechaba hoy.
        anyo: hojaPorNombre(hoja)?.anyo ?? null,
        arranque: hojaPorNombre(hoja)?.arranque ?? null,
      }
    case 'unidad':
      return {
        ...base,
        articulo: alta.articulo,
        marca: alta.marca,
        modelo: alta.modelo,
        serial: alta.serial,
        observaciones: alta.observaciones,
      }
  }
}

/**
 * Las compras antes que los consumos.
 *
 * La base tiene un disparador que se niega a dejar el almacén en negativo, y
 * hace bien. Pero el orden natural de las hojas pone los partes —que consumen—
 * antes que la bolsa —que compra—, así que el material de un parte que la
 * aplicación no conocía se rechazaba por no haber existencias que en la misma
 * pasada, cuatro celdas más abajo, se iban a registrar. Con las compras delante,
 * el saldo ya está cuando llega el consumo.
 */
function ordenarParaElAlmacen<T extends { campo: string }>(celdas: T[]): T[] {
  const peso = (campo: string): number => {
    if (campo === 'articulo.comprado') return 0
    // El número de serie de un aparato antes que su modelo: el número es lo
    // que reconoce el equipo en la base (y lo reclasifica si tiene otro nombre
    // de tipo); el modelo detrás encuentra ese mismo equipo. Al revés, en una
    // base sin fusionar, el modelo no encontraba «Ordenador» —el Tiny seguía
    // siendo «Ordenador Tiny»— y daba de alta un equipo fantasma con modelo y
    // sin número, y el número reclasificaba después el de verdad: dos.
    if (/^equipo:.+:serial$/.test(campo)) return 1
    if (campo === 'incidencia.material') return 3
    // El cuadre con «Stock Disponible» va el último de todos: es la diferencia
    // entre lo que la hoja dice que queda y lo que queda DESPUÉS de las compras
    // y los consumos de esta misma pasada. Antes de ellos ajustaría un saldo
    // que la pasada va a mover cuatro celdas más abajo.
    if (campo === 'articulo.disponible') return 4
    return 2
  }
  return [...celdas].sort((a, b) => peso(a.campo) - peso(b.campo))
}

/** El material de un parte, partido y con cada artículo resuelto al catálogo. */
function detalleDelMaterial(
  texto: string,
  resolver: (nombre: string) => string | null,
): Array<{ articulo_id: string | null; cantidad: number; texto: string }> {
  return leerMaterial(texto).map((m) => ({
    articulo_id: resolver(m.articulo),
    cantidad: m.cantidad,
    texto: m.crudo,
  }))
}

/** De qué habla cada fila de una hoja: una sala, un parte o un artículo. */
function entidadDe(hoja: string): string {
  const h = hojaPorNombre(hoja)
  if (!h) return 'sala'
  return h.identidad.tipo === 'sala' ? 'sala' : h.identidad.tipo
}

/**
 * Cómo se guarda un valor en la instantánea.
 *
 * `sync_celdas.valor_base` es `text`, así que todo pasa por una cadena. Y lo
 * que vuelva de ahí se compara con `canonizar`, que de un booleano saca «SI»:
 * guardar `String(true)` —«true»— hacía que el antepasado no coincidiera jamás
 * con la celda, y entonces toda columna de sí/no donde la app y la hoja
 * discreparan quedaba en **choque permanente**, porque los dos lados «habían
 * cambiado» respecto a un antepasado que no era ninguno de los dos.
 *
 * Lo demás se guarda tal cual, sin canonizar: la bandeja de choques enseña este
 * valor, y «CAMARA AVER» se lee peor que «Cámara Aver».
 */
export function paraLaInstantanea(valor: Valor): string | null {
  if (valor === null) return null
  if (typeof valor === 'boolean') return valor ? 'SI' : 'NO'
  return String(valor)
}

/**
 * Las celdas de la instantánea de una pasada, de un lado o del otro.
 *
 * `trasEscribir` separa dos cosas que no valen lo mismo: lo que el libro **dice**
 * —un hecho, se puede guardar ya— y lo que el libro **va a decir** cuando alguien
 * suba el fichero que sale de aquí. Guardar lo segundo antes de tiempo es lo que
 * hacía que una pasada que no llega a terminar dejara la base creyendo que el
 * Excel vale A cuando vale V, y la siguiente metiera la V en la base deshaciendo
 * el trabajo de la aplicación.
 */
function celdasDeLaInstantanea(a: Analisis, trasEscribir: boolean): unknown[] {
  return a.planes.flatMap((p) =>
    p.instantanea
      .filter((c) => (c.trasEscribir === true) === trasEscribir)
      .map((c) => ({
        hoja: p.hoja,
        clave: c.clave,
        columna: c.letra,
        entidad: entidadDe(p.hoja),
        valor: paraLaInstantanea(c.valor),
      })),
  )
}

/** La clave estable de una fila, buscada por su número dentro de un plan. */
function claveDe(p: Plan, fila: number): string {
  return p.instantanea.find((c) => c.fila === fila)?.clave ?? ''
}

// -----------------------------------------------------------------------------
// 5 — Escribir el libro
// -----------------------------------------------------------------------------

export async function escribir(
  a: Analisis,
  cuando: string,
  parteId?: number,
  altas: AltaAplicada[] = [],
): Promise<Uint8Array> {
  const ediciones: EdicionDeHoja[] = a.planes
    .map((p) => ({ plan: p, numeros: numerosDeLasAltas(p, altas) }))
    .filter(({ plan: p, numeros }) => p.celdas.length > 0 || p.insertar.length > 0 || p.borrar.length > 0 || numeros.length > 0)
    .map(({ plan: p, numeros }) => ({
      hoja: p.hoja,
      celdas: [...p.celdas, ...numeros],
      filas: { insertar: p.insertar, borrar: p.borrar },
    }))

  // Las hojas de la aplicación se rehacen enteras cada pasada, cabecera
  // incluida. No son un historial que haya que ir completando: son la foto de
  // lo que la base sabe hoy, y reconstruirlas cuesta menos que decidir qué fila
  // cambió. Antes se vaciaban de la fila 2 para abajo y se volvían a llenar, y
  // eso dejaba la cabecera vieja encima de los datos nuevos el día que a una
  // hoja le cambiaba una columna: «Incidencia» sobre lo que ya era «Solicitud».
  // Las pruebas del libro real traen un `datos` a medias —solo lo de las tres
  // hojas— y por eso lo que falte se toma como vacío.
  const datos = (a.datos ?? {}) as Partial<DatosDeLaPasada>
  const anyo = a.anyo ?? new Date().getFullYear()
  const rehacer: HojaNueva[] = [
    hojaDeRevisiones(datos.revisiones ?? []),
    hojaDeMovimientos(datos.movimientos ?? []),
    hojaDeInventario(datos.equipos ?? []),
    hojaDelParte(lineasDelParte(a.planes), cuando),
    hojaDeLeeme({ cuando, anyo }),
  ]

  const bytes = await escribirLibro(a.libro, ediciones, a.hojasNuevas ?? [], acabadoDe(a, rehacer))

  // Se apunta qué libro salió de aquí. Es lo único que permite avisar la vez
  // siguiente de que se está subiendo otro.
  if (parteId !== undefined) {
    const { error } = await supabase.rpc('sync_apuntar_salida', {
      p_parte_id: parteId,
      p_sha256: await sha256De(bytes),
      // Y aquí, y no antes, los antepasados de las celdas que se han escrito: el
      // fichero ya existe, así que la promesa se puede guardar. Si esto falla,
      // lo que se pierde es que la pasada siguiente vuelva a proponer las mismas
      // escrituras, que es lo seguro.
      p_instantanea: celdasDeLaInstantanea(a, true),
    })
    // Que no se pueda apuntar no invalida la pasada: el libro ya está bien y la
    // base también. Se pierde el aviso de la vez siguiente, y nada más.
    if (error) console.warn('No se pudo apuntar el libro de salida:', error.message)
  }

  return bytes
}

/** Las hojas que van al final, con la pestaña en gris: consulta, no datos. */
const DISCRETAS = ['Sincronización', 'Léeme', 'Cambios*']

/**
 * Cómo se ve el libro que sale, decidido aquí y no a mano.
 *
 * Lo hacía una persona con openpyxl —cabeceras azules, bandas, un Léeme— y se
 * perdía en cuanto la aplicación rehacía una hoja. Ahora lo dice la pasada en
 * cada escritura: las cabeceras de las hojas de la gente se pintan según quién
 * escribe cada columna —lo sabe el mapa—, todas llevan bandas, las pestañas van
 * en orden, las de consulta al final en gris, y el libro se abre en la hoja de
 * estado. Escribirlo dos veces seguidas deja el mismo libro: `libro.ts` no
 * añade un estilo, una tabla ni una regla que ya estén.
 */
export function acabadoDe(
  a: Pick<Analisis, 'libro'> & Partial<Pick<Analisis, 'columnaRef' | 'anyo' | 'hojasNuevas' | 'entrada'>>,
  rehacer: HojaNueva[],
): Acabado {
  const presentes = new Set([
    ...a.libro.hojas.map((h) => h.nombre),
    ...(a.hojasNuevas ?? []).map((h) => h.nombre),
  ])
  const delMapa = HOJAS.filter((h) => presentes.has(h.nombre))

  const cabeceras: NonNullable<Acabado['cabeceras']> = delMapa.map((h) => {
    const columnas: Record<string, 'cabecera' | 'cabeceraApp'> = {}
    for (const c of h.columnas) {
      // Una hoja congelada es de la gente entera: nadie la escribe ya, pero es
      // su cierre, no un dato de la aplicación.
      columnas[c.letra] =
        !h.congelada && (c.dueno === 'solo_app' || c.dueno === 'formula') ? 'cabeceraApp' : 'cabecera'
    }
    // La matrícula la escribe la aplicación, y lo dice con el color.
    if (h.identidad.tipo === 'sala' && a.columnaRef) columnas[a.columnaRef] = 'cabeceraApp'
    if (h.identidad.tipo === 'unidad') {
      // «Situación» la añade la aplicación al final de la hoja de PCs: está
      // donde la pasada la leyó y, si es la primera vez, detrás de la última.
      const cabecera = a.entrada?.filas.get(h.nombre)?.find((f) => f.fila === h.cabecera)
      const letra = Object.entries(cabecera?.celdas ?? {}).find(
        ([, v]) => String(v ?? '').trim().toLowerCase() === TITULO_DE_SITUACION.toLowerCase(),
      )?.[0]
      columnas[letra ?? numeroAColumna(h.columnas.length + 1)] = 'cabeceraApp'
    }
    return { hoja: h.nombre, fila: h.cabecera, columnas }
  })

  // Las del año en curso justo detrás de la de estado: en enero, las recién
  // creadas van antes que las del año que se cierra.
  const delAnyo = hojasDelAnyo(a.anyo ?? new Date().getFullYear())
  const orden = [
    ESTADO.nombre,
    delAnyo.material,
    delAnyo.bolsa,
    delAnyo.pcs,
    MATERIAL_2026.nombre,
    BOLSA_2026.nombre,
    PCS_2026.nombre,
    MATERIAL_2025.nombre,
    BOLSA_2025.nombre,
    ...rehacer.map((h) => h.nombre).filter((n) => !DISCRETAS.includes(n)),
  ].filter((n, i, l) => l.indexOf(n) === i)

  return {
    rehacer,
    cabeceras,
    bandas: delMapa.map((h) => h.nombre),
    // Las filas de totales de la bolsa cerrada quedan fuera del filtro y de
    // las bandas: ordenar por una columna no puede mover la suma del IVA.
    totales: Object.fromEntries(delMapa.filter((h) => h.filasDeTotales).map((h) => [h.nombre, h.filasDeTotales!])),
    orden,
    discretas: DISCRETAS,
    activa: ESTADO.nombre,
  }
}

/**
 * El número que la base puso a cada parte nuevo, en la celda de su fila.
 *
 * Es la única celda que la pasada no sabe al planificar: el número lo pone la
 * base al aplicar, y por eso llega aquí aparte y no en el plan. Sin esto, la
 * pasada siguiente encontraría la fila sin número y la daría de alta otra vez.
 */
function numerosDeLasAltas(p: Plan, altas: AltaAplicada[]): Cambio[] {
  const h = hojaPorNombre(p.hoja)
  if (!h || h.identidad.tipo !== 'incidencia') return []
  const columna = h.identidad.columna
  return altas
    .filter((x) => x.hoja === p.hoja && x.tipo === 'incidencia' && x.numero)
    .map((x) => ({ celda: `${columna}${x.fila}`, valor: x.numero! }))
}

/** Lo que la pasada no pudo decidir, para la hoja `Sincronización`. */
export function lineasDelParte(planes: Plan[]): LineaDelParte[] {
  const out: LineaDelParte[] = []
  for (const p of planes) {
    for (const c of p.conflictos) {
      out.push({
        hoja: p.hoja,
        celda: `${c.letra}${c.fila}`,
        que: 'Choque',
        detalle: `${c.destino}: la aplicación dice «${c.base ?? ''}» y la hoja «${c.excel ?? ''}». No se ha tocado ninguno de los dos.`,
      })
    }
    for (const q of p.cuarentena) {
      out.push({
        hoja: p.hoja,
        celda: `${q.letra}${q.fila}`,
        que: 'No se puede leer',
        detalle: `${q.destino}: ${q.motivo}`,
      })
    }
    for (const s of p.sinCruzar) {
      out.push({ hoja: p.hoja, celda: `${s.fila}`, que: 'Sin cruzar', detalle: s.motivo })
    }
    for (const d of p.dudas) {
      out.push({
        hoja: p.hoja,
        celda: `${d.fila}`,
        que: 'Pendiente de decidir',
        detalle: d.tipo === 'sala' ? `${d.texto} — ${d.motivo}` : `${d.texto} — ${d.detalle}`,
      })
    }
    // Y lo que la pasada HIZO por su cuenta: mudanzas, altas, bajas, filas que
    // cruzaron por número de serie, fórmulas devueltas. No está pendiente, pero
    // es lo primero que quiere saber quien abre el libro y ve que una sala ya no
    // está donde estaba. La celda va delante del texto cuando el aviso la trae
    // («Fila 2: …», «N5 (…): …»).
    for (const a of p.avisos) {
      const m = /^(?:Fila (\d+)|([A-Z]+\d+))\s*(?:\([^)]*\))?:\s*/.exec(a)
      out.push({
        hoja: p.hoja,
        celda: m ? (m[1] ?? m[2] ?? '') : '',
        que: 'Aviso',
        detalle: m ? a.slice(m[0].length) : a,
      })
    }
  }
  return out
}

// -----------------------------------------------------------------------------

/** El hash del fichero, que es lo que hace idempotente registrar el mismo libro. */
export async function sha256De(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Las hojas que la pasada va a crear porque cambió el año. */
export function hojasDelCorte(anyo: number): { material: string; bolsa: string; pcs: string } {
  return hojasDelAnyo(anyo)
}
