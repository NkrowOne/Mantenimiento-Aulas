/**
 * Leer una revisión pasada, y corregirla.
 *
 * Toda la aplicación estaba escrita para el momento de revisar: rellenar,
 * cerrar, siguiente aula. Lo que no existía era el momento de **preguntar hacia
 * atrás** —«qué se dijo de esta sala», «qué se comprobó aquel día», «hay
 * fotos»— ni el de **arreglar un error** sin fabricar una visita que no ocurrió.
 *
 * Los dos son la misma pieza, y por eso van juntos aquí: para poder corregir hay
 * que poder recuperar, y una vez recuperada lo natural es leerla entera.
 *
 * Este fichero es la mitad que se puede probar sin base de datos ni navegador:
 * cómo se agrupan las versiones de una misma visita, cómo se ordena y se nombra
 * lo que se comprobó, y qué se arrastra a una corrección. Las consultas viven en
 * las vistas `room_inspections` e `inspection_check_detail`.
 */

import { rangoDeTipo } from './inventory'
import {
  LEGACY_CHECK_LABELS,
  ROOM_CHECK_LABELS,
  type CheckKey,
  type CheckResult,
  type InspectionCheck,
  type RoomCheckKey,
  type Severity,
} from './types'

/**
 * Una revisión cerrada, tal y como la devuelve `room_inspections`.
 *
 * Trae contadores y no filas: la ficha enseña «3 fallos · 2 fotos» de doce
 * revisiones a la vez, y bajarse las comprobaciones y los adjuntos de las doce
 * para contar en el cliente sería descargar el histórico entero de la sala para
 * pintar doce líneas.
 */
export interface RevisionResumen {
  id: string
  room_id: string
  /** Cuándo se visitó el aula. Una corrección conserva la de la visita. */
  occurred_at: string
  recorded_at: string | null
  overall: 'ok' | 'con_incidencias' | null
  notes: string | null
  by_user: string | null
  who: string | null
  /** Qué revisión reemplaza esta, si es una corrección. */
  corrects: string | null
  /** Cuándo se corrigió. Nulo si no es una corrección. */
  corrected_at: string | null
  corrige_occurred_at: string | null
  /** Quién la reemplazó a ella, si alguien la corrigió después. */
  corregida_por: string | null
  corregida_at: string | null
  corregida_por_quien: string | null
  /** Es la última palabra sobre esa visita: nadie la ha corregido. */
  vigente: boolean
  comprobaciones: number
  fallos: number
  no_aplica: number
  fotos: number
  incidencias: number
}

/** Una fila de aquella revisión, con el aparato ya resuelto por el servidor. */
export interface ComprobacionDetalle {
  id: string
  inspection_id: string
  check_key: CheckKey
  asset_id: string | null
  asset_label: string | null
  asset_type: string | null
  model: string | null
  serial: string | null
  asset_status: string | null
  result: CheckResult
  severity: Severity | null
  measure: number | null
  measure_unit: string | null
  note: string | null
}

/**
 * Una visita al aula, con todas sus versiones.
 *
 * Es la unidad que hay que enseñar, y decirlo así es el punto de todo esto: una
 * revisión corregida tres veces sigue siendo **una visita**. Pintar cuatro filas
 * es exactamente el problema del que se venía huyendo, solo que ahora en la
 * pantalla en vez de en la base.
 */
export interface Visita {
  /** La versión que vale hoy. */
  vigente: RevisionResumen
  /** Todas, de la más antigua a la más reciente. Con una sola versión, es ella. */
  versiones: RevisionResumen[]
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
export function agruparEnVisitas(revisiones: RevisionResumen[]): Visita[] {
  const porId = new Map(revisiones.map((r) => [r.id, r]))

  // A quién corrige alguien, para saber qué filas son cabeza de su cadena entre
  // lo que ha llegado. `vigente` lo dice el servidor y manda, pero puede haber
  // una corrección más nueva fuera de la ventana consultada.
  const corregidas = new Set(
    revisiones.map((r) => r.corrects).filter((id): id is string => Boolean(id)),
  )

  /** La cadena completa de una cabeza, de la más antigua a ella misma. */
  const cadenaDe = (cabeza: RevisionResumen): RevisionResumen[] => {
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
  const cuando = (r: RevisionResumen): number =>
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
 * Cómo se llama una comprobación.
 *
 * El aparato lo resuelve el servidor —es lo único que el dispositivo no puede
 * saber de un equipo retirado— y el vocabulario fijo lo resuelve el cliente, que
 * ya lo tiene: «Red», y los nombres de las comprobaciones de antes del
 * inventario, para que una revisión de 2025 no se lea como `pantallas`.
 *
 * La última red es la propia clave: mejor `asset:018f…` que una fila sin nombre.
 */
export function etiquetaDeComprobacion(c: ComprobacionDetalle): string {
  if (c.asset_label) return c.asset_label
  if (c.asset_type) return c.asset_type

  const fija = ROOM_CHECK_LABELS[c.check_key as RoomCheckKey]
  if (fija) return fija

  return LEGACY_CHECK_LABELS[c.check_key] ?? c.check_key
}

/** La letra pequeña de la fila: modelo, serie y si el equipo ya no está. */
export function detalleDeComprobacion(c: ComprobacionDetalle): string | null {
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
export function ordenarComprobaciones(filas: ComprobacionDetalle[]): ComprobacionDetalle[] {
  return [...filas].sort((a, b) => {
    // Los aparatos primero; lo que se comprueba de la sala no es un objeto que
    // se pueda señalar con el dedo y va detrás, igual que en el formulario.
    const deSala = (c: ComprobacionDetalle): number => (c.asset_id === null ? 1 : 0)
    if (deSala(a) !== deSala(b)) return deSala(a) - deSala(b)

    return (
      rangoDeTipo(a.asset_type) - rangoDeTipo(b.asset_type) ||
      etiquetaDeComprobacion(a).localeCompare(etiquetaDeComprobacion(b), 'es', { numeric: true })
    )
  })
}

/** Cómo se pinta cada resultado. Nunca solo el color: la palabra va siempre. */
export const RESULTADO_ESTILO: Record<CheckResult, { etiqueta: string; clase: string }> = {
  ok: { etiqueta: 'Correcto', clase: 'bg-ok-tint text-ok' },
  incidencia: { etiqueta: 'Falla', clase: 'bg-crit-tint text-crit' },
  // `text-na` y no `text-muted`: es el par que `npm run check:contrast` vigila
  // en los dos temas, y es el mismo que usa el tri-estado del formulario.
  na: { etiqueta: 'No aplica', clase: 'bg-na-tint text-na' },
}

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
export function resultadoLegible(r: RevisionResumen): string {
  if (r.fallos > 0) return `${r.fallos} ${r.fallos === 1 ? 'fallo' : 'fallos'}`
  if (r.overall === 'con_incidencias') return 'Con incidencias'
  return 'Sin incidencias'
}

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
  comprobaciones: ComprobacionDetalle[],
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
