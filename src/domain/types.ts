/**
 * Modelo de dominio compartido entre la app, el importador y el worker de informes.
 *
 * Regla que atraviesa todo el fichero: casi nada se edita, todo se añade.
 * Las revisiones, los movimientos de stock y los eventos de equipo son inmutables,
 * y por eso la sincronización offline no tiene conflictos que resolver.
 */

export type Role = 'tecnico' | 'supervisor' | 'admin'

/** Resultado de una comprobación. El tri-estado unificado de todo el formulario. */
export type CheckResult = 'ok' | 'incidencia' | 'na'

/** Las cuatro comprobaciones fijas, más las que dependan del equipamiento de la sala. */
export type CheckKey = 'pantallas' | 'microfono' | 'red' | 'sonido' | 'proyector' | 'camara' | 'botonera'

export const CHECK_LABELS: Record<CheckKey, string> = {
  pantallas: 'Pantallas',
  proyector: 'Proyector',
  microfono: 'Micrófono',
  red: 'Red',
  sonido: 'Sonido',
  camara: 'Cámara',
  botonera: 'Botonera',
}

/**
 * Qué hay que mirar en cada comprobación.
 *
 * Idea tomada del prototipo aprobado: sin esto, «Sonido» es ambiguo y cada
 * técnico comprueba una cosa distinta. Con el subtítulo, la revisión es
 * repetible entre personas.
 */
export const CHECK_HINTS: Record<CheckKey, string> = {
  pantallas: 'Proyector · TV · monitor auxiliar',
  proyector: 'Horas y estado de lámpara',
  microfono: 'Captación y nivel',
  red: 'Conectividad del puesto',
  sonido: 'Altavoces y balance',
  camara: 'Encuadre y enfoque',
  botonera: 'Control de sala',
}

/**
 * Qué comprobación exige qué equipamiento. Si la sala no lo tiene, el check
 * nace en 'na' y plegado: el técnico solo toca lo que existe de verdad.
 */
export const CHECK_REQUIRES: Record<CheckKey, keyof RoomCapabilities | null> = {
  pantallas: null, // toda sala tiene algo donde proyectar o una TV
  proyector: 'proyector',
  microfono: 'microfono',
  red: null,
  sonido: 'altavoces',
  camara: 'camara',
  botonera: 'botonera',
}

/** Unidad de la medida numérica opcional de cada check, cuando aporta algo. */
export const CHECK_MEASURE: Partial<Record<CheckKey, { unit: string; label: string }>> = {
  red: { unit: 'Mbps', label: 'Velocidad medida' },
  proyector: { unit: 'h', label: 'Horas de lámpara' },
}

export type Severity = 'baja' | 'media' | 'alta'

export interface RoomCapabilities {
  proyector: boolean
  altavoces: boolean
  camara: boolean
  microfono: boolean
  botonera: boolean
  tv: boolean
}

export const EMPTY_CAPABILITIES: RoomCapabilities = {
  proyector: false,
  altavoces: false,
  camara: false,
  microfono: false,
  botonera: false,
  tv: false,
}

export interface Building {
  id: string
  code: string
  name: string
  sort_order: number
  /** El edificio BC entra así: existe en las incidencias pero no en la hoja de estado. */
  needs_review: boolean
}

export interface Zone {
  id: string
  building_id: string
  name: string
  sort_order: number
}

export type RoomKind = 'aula' | 'sala_reunion' | 'laboratorio' | 'otro'

export interface Room {
  id: string
  zone_id: string
  code: string
  name: string
  kind: RoomKind
  capabilities: RoomCapabilities
  /** Horas y % de lámpara vienen del Excel y alimentan la alerta predictiva. */
  projector_hours: number | null
  lamp_pct: number | null
  last_inspection_at: string | null
  active: boolean
}

export interface Inspection {
  /** uuid v7 generado en el cliente: es también la clave de idempotencia del outbox. */
  id: string
  room_id: string
  by_user: string | null
  /** Reloj del dispositivo: cuándo se hizo realmente la revisión en el aula. */
  occurred_at: string
  /** Reloj del servidor: cuándo llegó. Distinto de occurred_at si se hizo sin cobertura. */
  recorded_at: string | null
  status: 'borrador' | 'completa'
  overall: 'ok' | 'con_incidencias' | null
  notes: string | null
}

export interface InspectionCheck {
  id: string
  inspection_id: string
  check_key: CheckKey
  result: CheckResult
  severity: Severity | null
  measure: number | null
  measure_unit: string | null
  note: string | null
}

export type IncidentState = 'abierta' | 'en_curso' | 'resuelta'

export interface Incident {
  id: string
  room_id: string | null
  asset_id: string | null
  opened_from_inspection_id: string | null
  /** El `I260203_0051` que ya usáis hoy en el Excel y en ServiceNow. */
  external_ref: string | null
  title: string
  description: string | null
  severity: Severity
  state: IncidentState
  opened_at: string
  opened_by: string | null
  resolved_at: string | null
  resolved_by: string | null
  resolution: string | null
  source: 'app' | 'import' | 'system'
}

export interface StockItem {
  id: string
  name: string
  unit: string
  min_threshold: number
}

export type StockMovementKind = 'compra' | 'consumo' | 'ajuste' | 'devolucion'

export interface StockMovement {
  id: string
  stock_item_id: string
  /** Positivo entra, negativo sale. La cantidad actual es la suma, nunca un campo. */
  qty: number
  kind: StockMovementKind
  incident_id: string | null
  inspection_id: string | null
  occurred_at: string
  by_user: string | null
  note: string | null
}

export interface Attachment {
  id: string
  entity_type: 'inspection' | 'incident' | 'asset'
  entity_id: string
  storage_path: string
  taken_at: string
  by_user: string | null
}

/** Cuenta atrás de lámpara: por debajo de esto, la sala entra en la alerta predictiva. */
export const LAMP_ALERT_THRESHOLD = 0.2

/** Una incidencia por encima de estos días se considera estancada. */
export const STALE_INCIDENT_DAYS = 7

/** Una sala sin revisar por encima de estos días entra en la lista de pendientes. */
export const OVERDUE_INSPECTION_DAYS = 180
