/**
 * Cómo se lee una revisión guardada.
 *
 * Una revisión cerrada era **material muerto**: la fila existía, sus nueve
 * comprobaciones existían, sus fotos estaban subidas, y lo único que se enseñaba
 * de todo eso era «Revisión con incidencias» en una línea del histórico. Ni qué
 * falló, ni con qué gravedad, ni lo que escribió quien estuvo delante.
 *
 * Este fichero es la mitad que vive en el cliente: cómo se nombra una
 * comprobación, cómo se resume lo que falló y cómo se cuenta el desfase entre
 * hacer la revisión y subirla. Va en `domain` y no dentro de una pantalla porque
 * lo usan tres —la ficha de la revisión, el listado completo y la ficha del
 * aula— y la peor versión de esto es que la misma comprobación se llame de dos
 * maneras según dónde se mire.
 */

import {
  LEGACY_CHECK_LABELS,
  ROOM_CHECK_LABELS,
  assetIdFromCheckKey,
  type CheckResult,
  type IncidentState,
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
  zone_name: string
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
}

/** Una comprobación tal y como la sirve `inspection_check_detail`. */
export interface RevisionCheckRow {
  check_id: string
  check_key: string
  result: CheckResult
  severity: Severity | null
  measure: number | null
  measure_unit: string | null
  note: string | null
  asset_id: string | null
  /** Cómo se llama el aparato en esa sala. Lo resuelve el servidor. */
  asset_label: string | null
  type_name: string | null
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
export const RESULTADO: Record<CheckResult, { etiqueta: string; punto: string; tinte: string }> = {
  incidencia: { etiqueta: 'Falla', punto: 'bg-crit', tinte: 'text-crit' },
  ok: { etiqueta: 'Correcto', punto: 'bg-ok', tinte: 'text-ok' },
  na: { etiqueta: 'No aplica', punto: 'bg-na', tinte: 'text-muted' },
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
