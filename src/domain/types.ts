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
  /**
   * A qué revisión reemplaza esta, si es una corrección.
   *
   * Es la pieza que evita que arreglar un error cueste una revisión nueva. La
   * corregida no se toca —sigue congelada, con su fecha y su firma— y esta pasa
   * a ser la que cuenta: la que sale en el histórico, en la fiabilidad de la
   * sala y en el informe. Las dos se pueden leer.
   *
   * `occurred_at` se conserva a propósito: el aula se visitó el día que se
   * visitó, y corregir la errata el jueves no puede hacer que parezca revisada
   * el jueves. Cuándo se corrigió va en `corrected_at`.
   *
   * Anulable, y en un borrador guardado antes de esta versión llega `undefined`:
   * es una revisión normal, que es exactamente lo que significa el nulo.
   */
  corrects: string | null
  corrected_at: string | null
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
  /**
   * La marca, **aparte del modelo**: «Epson», «NEC», «Logitech».
   *
   * Va en su propia columna porque la hoja de inventario la pide en la suya, y
   * porque son dos datos con vidas distintas: hay ocho marcas en todo el parque
   * —se repiten hasta el agotamiento y se pueden ofrecer— y decenas de modelos.
   * Metidas en la misma cadena, agrupar por marca obliga a adivinar dónde acaba
   * la primera palabra, que es justo lo que no se puede hacer.
   *
   * Los 1.094 equipos importados la tienen a `null` y **no se reparte a
   * posteriori**. En ellos la marca vino pegada dentro de `model` («Epson
   * EB-1485Fi»), y partir esa cadena por la primera palabra falla con las marcas
   * de dos palabras, con los modelos que empiezan por número y con las filas
   * donde lo que hay escrito no es un modelo sino una descripción. Una regla que
   * acierta en la mayoría deja un par de cientos de equipos con la marca
   * equivocada y sin manera de saber cuáles, que es peor que la casilla vacía:
   * la vacía se ve, se pregunta y se rellena. Se rellena al corregir el equipo
   * desde el aula, que es el único momento en que alguien tiene el aparato
   * delante y puede leerle el rótulo.
   */
  brand: string | null
  model: string | null
  status: AssetStatus
  created_at: string | null
  /**
   * ¿Lo ha mirado alguien que no sea quien lo apuntó?
   *
   * El tipo ya se validaba; el aparato concreto no. Y son dos preguntas
   * distintas: «Micrófono Jabra» puede ser un tipo perfectamente validado y aun
   * así ser mentira que haya uno en el aula 2.4. Se usa igual mientras tanto
   * —la revisión no espera a nadie— y sale en la bandeja del panel hasta que un
   * coordinador lo confirma.
   *
   * Lo que carga una máquina —el importador, el equipamiento por defecto— nace
   * confirmado: no es la propuesta de nadie que haya estado en el aula.
   */
  confirmed: boolean
}

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  instalado: 'Instalado',
  averiado: 'Averiado',
  retirado: 'Retirado',
}

/**
 * A dónde va un equipo que sale de una sala.
 *
 * Los dos destinos no son la misma cosa, y esa es toda la razón de que exista
 * la pregunta: el aparato que **se ha muerto** desaparece, y el que está bien y
 * vuelve a la estantería **suma una unidad al almacén**. Con un solo botón de
 * «retirar», cada equipo que volvía al almacén era una unidad que el sistema
 * perdía — el aula dejaba de tenerla y el almacén no la ingresaba nunca.
 */
export type RemovalDestino = 'baja' | 'almacen'

export const REMOVAL_DESTINO_LABELS: Record<RemovalDestino, string> = {
  baja: 'Dar de baja',
  almacen: 'Devolver al almacén',
}

export const REMOVAL_DESTINO_HINTS: Record<RemovalDestino, string> = {
  baja: 'Está roto o ya no sirve. Sale del inventario y no vuelve.',
  almacen: 'Funciona y se lleva a la estantería. Suma una unidad al almacén.',
}

export type RemovalState = 'pendiente' | 'aprobada' | 'rechazada'

/**
 * La petición de sacar un equipo de una sala.
 *
 * Es una solicitud y no un acto porque quitar inventario no puede ser un toque
 * sin vuelta atrás: el equipo sigue en la sala —marcado— hasta que un
 * coordinador la autoriza. Se firma en el aula, sin cobertura, y sube por la
 * cola de salida como todo lo demás.
 */
export interface AssetRemoval {
  id: string
  asset_id: string
  room_id: string | null
  destino: RemovalDestino
  reason: string | null
  state: RemovalState
  requested_at: string
  requested_by: string | null
}

/**
 * Lo que una sala lleva por defecto.
 *
 * `building_id: null` es el ámbito global —vale para todas las salas— y con
 * edificio vale solo para el suyo Y MANDA sobre el global. Esa jerarquía es
 * toda la pieza: permite decir «en todas partes un proyector; en el EPS, dos»
 * sin repetir la lista entera edificio por edificio, que es como se convierte en
 * veintitrés listas que nadie mantiene.
 */
export interface AssetDefault {
  id: string
  asset_type_id: string
  building_id: string | null
  qty: number
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
 * Dónde nace cada una, que es lo que se aprendió usándolo:
 *
 *  - `incidencia` — un equipo marcado «Falla» en la revisión la abre sola, y esa
 *    es la vía principal. También se puede abrir a mano desde la ficha de la
 *    sala, para la avería que se ve de paso sin estar revisando.
 *  - `solicitud` — a mano, desde la ficha.
 *  - `observacion` — **ya no se crea**. Se escribe en la revisión, debajo de las
 *    fotos, y vive en `inspections.notes`; se lee en la ficha del aula. El valor
 *    se queda en el vocabulario porque hay cientos importadas del Excel, y
 *    quitarlo dejaría esas filas sin nombre en el histórico.
 *
 * La frontera importa porque decide qué entra en la pestaña de Incidencias: eso
 * es la lista de lo que hay que arreglar, y una nota de seguimiento no lo es.
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
  /**
   * De qué comprobación de la revisión salió: `asset:<uuid>` o `red`.
   *
   * `opened_from_inspection_id` dice de qué revisión nació, pero no de qué fila,
   * y esa es justo la pregunta que evita apuntar la misma avería en cada ronda:
   * «¿este proyector ya tiene una incidencia abierta?». Nulo en lo que se
   * registra a mano desde la ficha de la sala y en todo lo importado.
   */
  check_key: string | null
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

/**
 * El cierre de una incidencia: qué se hizo, quién y cuándo.
 *
 * Una fila y no tres columnas de `incidents` porque cerrar se firma en el aula,
 * muchas veces sin cobertura, y la cola de salida solo sabe hacer bien una cosa:
 * insertar algo que ya nació con su identidad. Un UPDATE reintentado obliga a
 * preguntarse si el primero llegó; una fila con id de cliente se reenvía las
 * veces que haga falta y la segunda no hace nada.
 *
 * La incidencia sí termina resuelta: de eso se encarga un disparador del
 * servidor, que copia la explicación a `incidents.resolution` y la cierra. Aquí
 * queda el asiento, que es lo que se puede leer después aunque la incidencia se
 * vuelva a abrir.
 */
export interface IncidentResolution {
  id: string
  incident_id: string
  /** Qué se hizo. Obligatoria: es la razón de ser de esta fila. */
  resolution: string
  /** Reloj del dispositivo: cuándo se arregló, aunque suba el lunes. */
  resolved_at: string
  resolved_by: string | null
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
