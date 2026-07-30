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

/**
 * Clave de una comprobación dentro de una revisión.
 *
 * Dos formas:
 *  - `red` — una comprobación **de la sala**, que no es ningún aparato.
 *  - `asset:<uuid>` — una comprobación **de un elemento** del inventario.
 *
 * La segunda es el cambio de fondo. Antes había una casilla «Pantallas» que
 * tapaba tres objetos distintos: si fallaba, el parte decía que algo de las
 * pantallas iba mal, pero no cuál. Ahora la revisión pregunta por el Proyector,
 * por la Pantalla y por la Pantalla 2 por separado, y una incidencia apunta a un
 * aparato con su número de serie.
 */
export type CheckKey = string

/** Lo que se comprueba en la sala y no en un aparato concreto. */
export type RoomCheckKey = 'red'

export const ROOM_CHECKS: RoomCheckKey[] = ['red']

export const ROOM_CHECK_LABELS: Record<RoomCheckKey, string> = {
  red: 'Red',
}

/**
 * Qué hay que mirar en cada comprobación.
 *
 * Idea tomada del prototipo aprobado: sin esto, «Red» es ambiguo y cada técnico
 * comprueba una cosa distinta. Con el subtítulo, la revisión es repetible entre
 * personas.
 */
export const ROOM_CHECK_HINTS: Record<RoomCheckKey, string> = {
  red: 'Conectividad del puesto',
}

export const ROOM_CHECK_MEASURE: Partial<Record<RoomCheckKey, { unit: string; label: string }>> = {
  red: { unit: 'Mbps', label: 'Velocidad medida' },
}

/** La medida que se le pide a un elemento, si su tipo la lleva. */
export const LAMP_MEASURE = { unit: 'h', label: 'Horas de lámpara' } as const

const ASSET_PREFIX = 'asset:'

export function assetCheckKey(assetId: string): CheckKey {
  return `${ASSET_PREFIX}${assetId}`
}

export function assetIdFromCheckKey(key: CheckKey): string | null {
  return key.startsWith(ASSET_PREFIX) ? key.slice(ASSET_PREFIX.length) : null
}

/**
 * Nombres de las comprobaciones fijas que existieron antes del inventario.
 *
 * No se usan para revisar: están para que una revisión guardada entonces se
 * siga leyendo con palabras y no con claves. Borrarlas convertiría el histórico
 * en `pantallas: ok`.
 */
export const LEGACY_CHECK_LABELS: Record<string, string> = {
  pantallas: 'Pantallas',
  proyector: 'Proyector',
  microfono: 'Micrófono',
  red: 'Red',
  sonido: 'Sonido',
  camara: 'Cámara',
  botonera: 'Botonera',
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
  /**
   * Cuándo confirmó alguien por última vez que el inventario de la sala está
   * completo. `null` = nadie ha ido nunca a mirar, que no es lo mismo que «la
   * sala está vacía»: son 41 aulas y la aplicación no puede distinguirlas.
   */
  last_inventory_at: string | null
  active: boolean
  /**
   * `SALA-000087`: la referencia corta y **estable**.
   *
   * El nombre cambia y el código de sala también —los dos son etiquetas—, así
   * que ninguno sirve para dictar por teléfono ni para grabar en una placa. Esta
   * no cambia nunca. Anulable porque un dispositivo con el espejo de antes de la
   * migración todavía no la tiene.
   */
  short_ref: string | null
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

// -----------------------------------------------------------------------------
// Inventario instalado
// -----------------------------------------------------------------------------

/**
 * Un tipo del catálogo: «Proyector», «Pantalla», «Micrófono Jabra».
 *
 * `confirmed: false` es un tipo que creó un técnico desde un aula. Se usa igual
 * que cualquier otro —la revisión no se puede quedar bloqueada esperando a
 * nadie— pero sale marcado hasta que un coordinador lo valida, lo corrige o lo
 * fusiona con uno que ya existía.
 */
export interface AssetType {
  id: string
  name: string
  category: string
  tracks_serial: boolean
  tracks_lamp_hours: boolean
  confirmed: boolean
  /** Lo que la gente escribe de verdad: `jab`, `cañón`, `tv`. */
  aliases: string[]
  /** Lápida de una fusión: este tipo se absorbió en otro. */
  merged_into: string | null
}

export type AssetStatus = 'instalado' | 'retirado' | 'averiado'

/** Un aparato concreto instalado en una sala. */
export interface Asset {
  id: string
  asset_type_id: string
  room_id: string | null
  /** Cómo se llama en ESTA sala: «Pantalla 2», o «Pantalla atril» si se corrige. */
  label: string | null
  serial: string | null
  model: string | null
  status: AssetStatus
  created_at: string | null
}

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  instalado: 'Instalado',
  averiado: 'Averiado',
  retirado: 'Retirado',
}

export type IncidentState = 'borrador' | 'abierta' | 'en_curso' | 'resuelta'

/**
 * Qué se está registrando.
 *
 * Los tres no pesan igual, y esa es toda la razón de que existan por separado:
 * una **solicitud** («instalar cámara y micrófono») es trabajo pedido, no un
 * fallo de la sala, y una **observación** («pizarra abombada») es una nota de
 * seguimiento. Meterlas en el mismo saco que una avería haría que las salas
 * mejor atendidas salieran como las peores solo por estar bien atendidas.
 *
 * La observación es además la pieza que hoy falta del todo: en el Excel vive en
 * una columna de texto libre y no se le sigue la pista a ninguna.
 */
export type IncidentKind = 'incidencia' | 'solicitud' | 'observacion'

export const INCIDENT_KIND_LABELS: Record<IncidentKind, string> = {
  incidencia: 'Incidencia',
  solicitud: 'Solicitud',
  observacion: 'Observación',
}

export interface Incident {
  id: string
  room_id: string | null
  asset_id: string | null
  opened_from_inspection_id: string | null
  /** El `I260203_0051` que ya usáis hoy en el Excel y en ServiceNow. */
  external_ref: string | null
  /** Nulo mientras sea borrador: para guardar basta la sala. */
  title: string | null
  description: string | null
  severity: Severity
  state: IncidentState
  kind: IncidentKind
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
  /**
   * Qué tipo de equipo es este artículo, si es que es uno.
   *
   * NULL en los consumibles —un cable no es nada del inventario de la sala— y
   * puesto en los catorce que sí lo son. Es lo que permite que al añadir un
   * proyector a un aula la aplicación sepa qué caja del almacén descontar.
   */
  asset_type_id: string | null
}

/**
 * Las existencias de un artículo, tal y como se espejan en el dispositivo.
 *
 * Es una foto, no la verdad: el saldo vive en el servidor y se calcula sumando
 * movimientos. Se copia aquí para poder enseñar «quedan 12» dentro del aula,
 * sin cobertura, cuando alguien va a instalar un proyector. Si la foto está
 * vieja, el servidor rechaza el consumo al sincronizar; enseñar una cifra
 * aproximada es mucho mejor que no enseñar ninguna.
 */
export interface StockLevel {
  stock_item_id: string
  name: string
  unit: string
  min_threshold: number
  on_hand: number
  below_threshold: boolean
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
  /** Dónde se gastó. Sin esto el almacén sabe cuánto queda y no dónde fue. */
  room_id: string | null
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
