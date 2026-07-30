/**
 * Cómo se lee una revisión guardada.
 *
 * Una revisión cerrada era **material muerto**: la fila existía, sus nueve
 * comprobaciones existían, sus fotos estaban subidas, y lo único que se enseñaba
 * de todo eso era «Revisión con incidencias» en una línea del histórico. Ni qué
 * falló, ni con qué gravedad, ni lo que escribió quien estuvo delante.
 *
 * Y **corregirla**, que es la otra mitad de lo mismo: para poder corregir hay que
 * poder recuperar, y una vez recuperada lo natural es leerla entera. Una
 * corrección no reescribe la revisión anterior —nace apuntando a ella con
 * `corrects`— así que varias filas pueden ser versiones de UNA visita, y
 * agruparlas es trabajo de este fichero.
 *
 * Este fichero es la mitad que vive en el cliente y se puede probar sin base de
 * datos ni navegador: cómo se nombra una comprobación, cómo se agrupan las
 * versiones de una visita, cómo se resume lo que falló, qué se arrastra a una
 * corrección y cómo se cuenta el desfase entre hacer la revisión y subirla.
 *
 * Va en `domain` y no dentro de una pantalla porque lo usan cuatro —la ficha de la
 * revisión, el listado completo, la ficha del aula y el formulario cuando
 * corrige— y la peor versión de esto es que la misma comprobación se llame de dos
 * maneras según dónde se mire. Por lo mismo es UN fichero y no dos: nació como
 * `revision.ts` y `revisiones.ts` en dos ramas a la vez, y dos módulos que se
 * distinguen en una letra son dos vocabularios esperando a separarse.
 */

import { rangoDeTipo } from './inventory'
import {
  LEGACY_CHECK_LABELS,
  ROOM_CHECK_LABELS,
  assetIdFromCheckKey,
  type CheckKey,
  type CheckResult,
  type IncidentState,
  type InspectionCheck,
  type Severity,
} from './types'

/**
 * Una revisión tal y como la sirve `inspection_overview`.
 *
 * No es la tabla `inspections`: trae resuelto el nombre de la sala, del
 * edificio, quién la hizo y los recuentos, porque la lista los necesita todos y
 * el cliente no puede cruzar cinco tablas por fila.
 */
export interface RevisionRow {
  id: string
  room_id: string
  room_code: string
  room_name: string
  short_ref: string | null
  zone_id: string
  zone_name: string
  building_id: string
  building_code: string
  building_name: string
  /** Reloj del aula: cuándo se revisó de verdad. Es el orden de la lista. */
  occurred_at: string
  /** Reloj del servidor: cuándo llegó. La diferencia es «se hizo sin cobertura». */
  recorded_at: string | null
  status: string
  overall: string | null
  notes: string | null
  source: string
  by_user: string | null
  who: string | null
  total: number
  ok: number
  fallos: number
  na: number
  fotos: number
  incidencias: number
  sin_resolver: number
  /** Qué falló, con la clave y el nombre del aparato si lo tiene. */
  fallos_detalle: FalloResumen[]

  /** A qué revisión reemplaza esta, si es una corrección. */
  corrects: string | null
  /** Cuándo se corrigió. Nulo si no es una corrección. */
  corrected_at: string | null
  /** De qué día era la visita que corrige. */
  corrige_occurred_at: string | null
  /** Quién la reemplazó a ella, si alguien la corrigió después. */
  corregida_por: string | null
  corregida_at: string | null
  corregida_por_quien: string | null
  /** Es la última palabra sobre esa visita: nadie la ha corregido. */
  vigente: boolean
}

/** Una comprobación tal y como la sirve `inspection_check_detail`. */
export interface RevisionCheckRow {
  check_id: string
  inspection_id: string
  check_key: string
  result: CheckResult
  severity: Severity | null
  measure: number | null
  measure_unit: string | null
  note: string | null
  /** El mismo `check_id`, con el nombre que le puso la otra mitad de esto. */
  id: string
  asset_id: string | null
  /** Cómo se llama el aparato en esa sala. Lo resuelve el servidor. */
  asset_label: string | null
  type_name: string | null
  /** Gemelo de `type_name`: la vista sirve los dos nombres. */
  asset_type: string | null
  serial: string | null
  model: string | null
  asset_status: string | null
  incident_id: string | null
  incident_title: string | null
  incident_state: IncidentState | null
  incident_ref: string | null
  incident_resolved_at: string | null
  incident_resolution: string | null
  /** Cuántas veces había fallado esto mismo en esa sala antes de esta revisión. */
  fallos_previos: number
  fallo_previo_at: string | null
}

/**
 * Cómo se llama una comprobación.
 *
 * El reparto no es arbitrario. El nombre de un aparato lo resuelve el servidor
 * —`asset:<uuid>` solo se traduce con la tabla `assets`, y el dispositivo poda
 * los equipos retirados, así que una revisión del curso pasado enseñaría claves
 * en crudo—. Los nombres de lo que no es un aparato viven aquí, porque aquí está
 * el vocabulario: «Red», y los de antes del inventario («Pantallas»,
 * «Botonera»), que se conservan justamente para que el histórico se siga leyendo
 * con palabras.
 *
 * La última red es decir que no se sabe, en vez de escupir el uuid: un equipo
 * borrado del catálogo por una limpieza deja su comprobación huérfana, y
 * «Equipo no identificado» es información; `asset:1f2e…` no lo es.
 */
export function etiquetaDeCheck(key: string, label: string | null): string {
  if (label) return label
  const propia = ROOM_CHECK_LABELS[key as keyof typeof ROOM_CHECK_LABELS] ?? LEGACY_CHECK_LABELS[key]
  if (propia) return propia
  return assetIdFromCheckKey(key) ? 'Equipo no identificado' : key
}

/** Lo mínimo que hace falta para nombrar un fallo en una lista. */
export interface FalloResumen {
  key: string
  label: string | null
}

/**
 * Qué falló, en una línea.
 *
 * El listado de revisiones existe para no tener que abrir treinta fichas, así
 * que la fila tiene que decir el nombre de lo que falló y no solo cuántos. Se
 * cortan a dos y se cuenta el resto: tres nombres largos en una fila de móvil se
 * parten en cuatro líneas y la lista deja de escanearse.
 */
export function textoDeFallos(fallos: FalloResumen[], max = 2): string | null {
  if (fallos.length === 0) return null
  const nombres = fallos.map((f) => etiquetaDeCheck(f.key, f.label))
  if (nombres.length <= max) return nombres.join(' · ')
  return `${nombres.slice(0, max).join(' · ')} y ${nombres.length - max} más`
}

/**
 * Cómo se pinta cada resultado. Nunca solo el color: la palabra va siempre.
 *
 * Es el mismo tri-estado del formulario de revisión, con las mismas palabras.
 * Quien marcó «Falla» en el aula tiene que encontrar «Falla» al leer la ficha
 * tres meses después, no «Incidencia» ni «KO».
 */
export const RESULTADO: Record<
  CheckResult,
  { etiqueta: string; punto: string; tinte: string; chip: string }
> = {
  // Tres formas del mismo estado y ninguna sobra: el punto es para una lista con
  // raíl, el tinte para una palabra en una línea de texto y la píldora para la
  // tarjeta de una visita. `text-na` y no `text-muted` en el «no aplica»: es el
  // par que `npm run check:contrast` vigila en los dos temas.
  incidencia: { etiqueta: 'Falla', punto: 'bg-crit', tinte: 'text-crit', chip: 'bg-crit-tint text-crit' },
  ok: { etiqueta: 'Correcto', punto: 'bg-ok', tinte: 'text-ok', chip: 'bg-ok-tint text-ok' },
  na: { etiqueta: 'No aplica', punto: 'bg-na', tinte: 'text-muted', chip: 'bg-na-tint text-na' },
}

/**
 * Las tres gravedades, con las palabras que usa el aula.
 *
 * No son «baja/media/alta» en la interfaz y por un motivo: lo que decide la cola
 * de trabajo no es una escala abstracta, es si se puede dar la clase. Estaban
 * escritas dentro de la pantalla de revisión, donde se eligen; ahora también se
 * leen en la ficha, y con dos copias la de leer y la de escribir se separan.
 */
export const SEVERIDADES: Array<{ value: Severity; label: string }> = [
  { value: 'baja', label: 'Leve' },
  { value: 'media', label: 'Molesta' },
  { value: 'alta', label: 'Impide la clase' },
]

export const SEVERIDAD_ETIQUETA: Record<Severity, string> = SEVERIDADES.reduce(
  (acc, s) => {
    acc[s.value] = s.label
    return acc
  },
  {} as Record<Severity, string>,
)

/**
 * El orden en que se leen las comprobaciones de una ficha.
 *
 * Lo que falló primero, y no el orden en que se tocó: quien abre la ficha de una
 * revisión con incidencias viene a ver qué se rompió. Lo que está bien va
 * después, y lo que no aplica al final — es la información que menos dice y la
 * que más ocupa cuando una sala tiene ocho aparatos.
 */
export function ordenDeResultado(result: CheckResult): number {
  return result === 'incidencia' ? 0 : result === 'ok' ? 1 : 2
}

/**
 * El desfase entre hacer la revisión y que llegue al servidor.
 *
 * Los dos relojes se guardan por separado —`occurred_at` es el del aula,
 * `recorded_at` el del servidor— y hasta ahora ninguna pantalla enseñaba la
 * diferencia. Merece decirse porque explica lo que de otro modo parece un error:
 * una revisión de ayer que aparece esta mañana no es un fallo de nadie, es un
 * sótano sin cobertura.
 *
 * Por debajo de una hora no se dice nada: es el camino normal —se cierra la
 * revisión y sube en segundos— y anunciarlo en cada ficha sería ruido en todas
 * para informar de ninguna.
 */
export function retrasoDeSubida(occurredAt: string, recordedAt: string | null): string | null {
  if (!recordedAt) return null
  const desfase = new Date(recordedAt).getTime() - new Date(occurredAt).getTime()
  if (Number.isNaN(desfase) || desfase < 3_600_000) return null

  const horas = Math.round(desfase / 3_600_000)
  if (horas < 24) return `Se hizo sin cobertura: subió ${horas} h después`
  const dias = Math.round(horas / 24)
  return `Se hizo sin cobertura: subió ${dias} ${dias === 1 ? 'día' : 'días'} después`
}

/** El resultado global de la revisión, tal y como se titula. */
export function tituloDeResultado(
  status: string,
  overall: string | null,
): { etiqueta: string; clase: string } {
  if (status !== 'completa') {
    return { etiqueta: 'Sin cerrar', clase: 'bg-warn-tint text-warn' }
  }
  return overall === 'ok'
    ? { etiqueta: 'Sin incidencias', clase: 'bg-ok-tint text-ok' }
    : { etiqueta: 'Con incidencias', clase: 'bg-crit-tint text-crit' }
}

// -----------------------------------------------------------------------------
// Las versiones de una visita
//
// Una corrección es una fila nueva que apunta a la que reemplaza, así que lo que
// en la base son tres revisiones puede ser UNA visita contada tres veces. Pintar
// tres tarjetas sería trasladar a la pantalla el problema que corregir viene a
// resolver.
// -----------------------------------------------------------------------------

/** Una visita al aula, con todas sus versiones. */
export interface Visita {
  /** La versión que vale hoy. */
  vigente: RevisionRow
  /** Todas, de la más antigua a la más reciente. Con una sola versión, es ella. */
  versiones: RevisionRow[]
}

/**
 * Agrupa las revisiones de una sala en visitas.
 *
 * La cadena se sigue por `corrects`, que apunta hacia atrás. Se recorre al revés
 * —de la corrección a lo que corrige— porque es la dirección en la que el dato
 * está guardado, y porque así una cadena a la que le falta un eslabón (la
 * consulta pide las N últimas y la original se quedó fuera) no desaparece: se
 * queda como una visita con las versiones que sí han llegado.
 *
 * Las visitas salen ordenadas de la más reciente a la más antigua por la fecha de
 * la VISITA, no de la corrección: quien mira la ficha busca «la última vez que
 * alguien estuvo aquí».
 */
export function agruparEnVisitas(revisiones: RevisionRow[]): Visita[] {
  const porId = new Map(revisiones.map((r) => [r.id, r]))

  // A quién corrige alguien, para saber qué filas son cabeza de su cadena entre
  // lo que ha llegado. `vigente` lo dice el servidor y manda, pero puede haber
  // una corrección más nueva fuera de la ventana consultada.
  const corregidas = new Set(
    revisiones.map((r) => r.corrects).filter((id): id is string => Boolean(id)),
  )

  /** La cadena completa de una cabeza, de la más antigua a ella misma. */
  const cadenaDe = (cabeza: RevisionRow): RevisionRow[] => {
    const versiones = [cabeza]
    const vistas = new Set([cabeza.id])
    let actual = cabeza

    while (actual.corrects) {
      const anterior = porId.get(actual.corrects)
      // Sin la anterior descargada, o con un ciclo imposible que aun así no va a
      // colgar la pantalla, la cadena se corta aquí.
      if (!anterior || vistas.has(anterior.id)) break
      versiones.unshift(anterior)
      vistas.add(anterior.id)
      actual = anterior
    }

    return versiones
  }

  /** Cuándo se escribió esta versión: la corrección por su fecha, la original por la visita. */
  const cuando = (r: RevisionRow): number =>
    new Date(r.corrected_at ?? r.occurred_at).getTime()

  const visitas: Visita[] = []
  const porRaiz = new Map<string, Visita>()

  for (const cabeza of revisiones) {
    if (corregidas.has(cabeza.id)) continue

    const versiones = cadenaDe(cabeza)
    const raiz = versiones[0]!.id
    const previa = porRaiz.get(raiz)

    if (!previa) {
      const visita: Visita = { vigente: cabeza, versiones }
      porRaiz.set(raiz, visita)
      visitas.push(visita)
      continue
    }

    /*
     * Dos correcciones de la misma revisión: una visita, no dos.
     *
     * Pasa si dos personas corrigen lo mismo sin cobertura —la interfaz solo
     * ofrece corregir la versión vigente, así que hacen falta dos dispositivos a
     * la vez—. La base lo cuenta bien; aquí hay que evitar dos tarjetas con la
     * misma fecha diciendo cosas distintas. Manda la última corrección, y la
     * otra se queda dentro como una versión más: es información, y esconderla
     * sería justo lo que esta pantalla existe para no hacer.
     */
    const unidas = new Map(previa.versiones.map((r) => [r.id, r]))
    for (const r of versiones) unidas.set(r.id, r)
    previa.versiones = [...unidas.values()].sort((a, b) => cuando(a) - cuando(b))
    if (cuando(cabeza) >= cuando(previa.vigente)) previa.vigente = cabeza
  }

  return visitas.sort(
    (a, b) =>
      new Date(b.vigente.occurred_at).getTime() - new Date(a.vigente.occurred_at).getTime(),
  )
}

/**
 * Cómo se llama una comprobación, a partir de su fila del detalle.
 *
 * Es `etiquetaDeCheck` con la fila delante, que es como la llaman las pantallas
 * que ya la tienen entera. Una sola función debajo: el día que haga falta cambiar
 * cómo se nombra un equipo retirado, se cambia en un sitio.
 */
export function etiquetaDeComprobacion(c: RevisionCheckRow): string {
  return etiquetaDeCheck(c.check_key, c.asset_label ?? c.type_name ?? c.asset_type)
}

/** La letra pequeña de la fila: modelo, serie y si el equipo ya no está. */
export function detalleDeComprobacion(c: RevisionCheckRow): string | null {
  const partes = [
    c.model,
    c.serial,
    c.asset_status === 'retirado' ? 'retirado desde entonces' : null,
    c.asset_status === 'averiado' ? 'marcado averiado' : null,
  ].filter(Boolean)

  return partes.length > 0 ? partes.join(' · ') : null
}

/**
 * El mismo orden que tuvo el formulario: el recorrido del aula, y lo de la sala
 * al final.
 *
 * Sin esto, leer una revisión pasada y hacer la siguiente son dos listas con los
 * mismos elementos en órdenes distintos, y comparar «lo que decía» con «lo que
 * veo» obliga a buscar cada fila dos veces.
 */
export function ordenarComprobaciones(filas: RevisionCheckRow[]): RevisionCheckRow[] {
  return [...filas].sort((a, b) => {
    // Los aparatos primero; lo que se comprueba de la sala no es un objeto que
    // se pueda señalar con el dedo y va detrás, igual que en el formulario.
    const deSala = (c: RevisionCheckRow): number => (c.asset_id === null ? 1 : 0)
    if (deSala(a) !== deSala(b)) return deSala(a) - deSala(b)

    return (
      rangoDeTipo(a.type_name ?? a.asset_type) - rangoDeTipo(b.type_name ?? b.asset_type) ||
      etiquetaDeComprobacion(a).localeCompare(etiquetaDeComprobacion(b), 'es', { numeric: true })
    )
  })
}

/**
 * Las gravedades en minúscula, para cuando van dentro de una frase.
 *
 * Gemelas de `SEVERIDAD_ETIQUETA`, que es la forma con la que se ELIGEN en el
 * formulario y encabezan una píldora. «Falla · impide la clase» leído con
 * mayúscula en mitad de la línea se lee como dos etiquetas pegadas.
 */
export const GRAVEDAD_LEGIBLE: Record<Severity, string> = {
  baja: 'leve',
  media: 'molesta',
  alta: 'impide la clase',
}

/**
 * Cómo salió una revisión, en una frase corta.
 *
 * Se cuenta el número de fallos y no solo «con incidencias» porque es la
 * diferencia entre una sala que tuvo un problema y una que tuvo cinco, y ese
 * número ya viene contado en la vista.
 */
export function resultadoLegible(r: RevisionRow): string {
  if (r.fallos > 0) return `${r.fallos} ${r.fallos === 1 ? 'fallo' : 'fallos'}`
  if (r.overall === 'con_incidencias') return 'Con incidencias'
  return 'Sin incidencias'
}

// -----------------------------------------------------------------------------
// Sembrar una corrección
// -----------------------------------------------------------------------------

/** Lo que se arrastra de la revisión corregida al borrador de la corrección. */
export interface SemillaCheck {
  check_key: CheckKey
  result: CheckResult
  severity: Severity | null
  measure: number | null
  measure_unit: string | null
  note: string | null
}

export interface Semilla {
  /** Las respuestas que se pueden volver a tocar, listas para el borrador. */
  checks: SemillaCheck[]
  /**
   * Lo que aquella revisión contestó sobre algo que hoy no está en la sala.
   *
   * Se descarta y se dice: un equipo retirado desde entonces no tiene fila en el
   * formulario, así que su respuesta no se podría ni ver ni cambiar. Arrastrarla
   * a ciegas sería peor —la corrección afirmaría cosas de un aparato que ya no
   * existe, y podría abrir una incidencia sobre él—, y callarlo sería hacer
   * desaparecer parte de la revisión sin avisar. La original sigue guardada con
   * todo, que es lo que hace que esto sea aceptable.
   */
  descartadas: string[]
}

/**
 * Siembra el borrador de una corrección con lo que dijo la revisión original.
 *
 * Es la mitad del valor de corregir: si la corrección naciera vacía, arreglar una
 * errata obligaría a contestar otra vez las nueve filas, y a esa fricción la
 * gente responde haciendo lo de siempre —una revisión nueva—.
 *
 * `clavesVigentes` son las filas que el formulario tiene hoy delante. Todo lo
 * demás se queda fuera y se nombra.
 */
export function semillaDeCorreccion(
  comprobaciones: RevisionCheckRow[],
  clavesVigentes: Iterable<CheckKey>,
): Semilla {
  const vigentes = new Set(clavesVigentes)
  const checks: SemillaCheck[] = []
  const descartadas: string[] = []

  for (const c of comprobaciones) {
    if (!vigentes.has(c.check_key)) {
      descartadas.push(etiquetaDeComprobacion(c))
      continue
    }

    checks.push({
      check_key: c.check_key,
      result: c.result,
      // La gravedad solo tiene sentido en una falla, igual que en el formulario:
      // sembrar una gravedad huérfana dejaría el borrador en un estado que la
      // pantalla no sabe producir.
      severity: c.result === 'incidencia' ? (c.severity ?? 'media') : null,
      measure: c.measure,
      measure_unit: c.measure_unit,
      note: c.note,
    })
  }

  return { checks, descartadas }
}

/** Convierte la semilla en comprobaciones del borrador nuevo. */
export function checksDeSemilla(
  semilla: SemillaCheck[],
  inspectionId: string,
  nuevoId: () => string,
): InspectionCheck[] {
  return semilla.map((s) => ({
    id: nuevoId(),
    inspection_id: inspectionId,
    check_key: s.check_key,
    result: s.result,
    severity: s.severity,
    measure: s.measure,
    measure_unit: s.measure_unit,
    note: s.note,
  }))
}
