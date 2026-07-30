/**
 * Espejo local en IndexedDB.
 *
 * Regla de oro del proyecto: **nada pendiente vive solo en el móvil**. Esto es
 * un búfer para los minutos sin cobertura, no el sitio donde se guardan las
 * cosas. En cuanto hay red, la cola de salida lo sube todo — incluidos los
 * borradores a medias.
 *
 * Por eso la app puede funcionar en Safari sin instalarse en la pantalla de
 * inicio: si iOS limpiara el almacenamiento, lo pendiente ya está en el servidor.
 */

import Dexie, { type EntityTable } from 'dexie'
import type {
  Asset,
  AssetModel,
  AssetType,
  Attachment,
  Building,
  Incident,
  Inspection,
  InspectionCheck,
  Room,
  StockItem,
  StockLevel,
  Zone,
} from '@/domain/types'

/** Una operación esperando a subir. El id es la clave de idempotencia. */
export interface OutboxEntry {
  /** uuid v7 del registro afectado. Reenviarlo dos veces no duplica nada. */
  id: string
  entity:
    | 'inspection'
    | 'inspection_check'
    | 'incident'
    | 'stock_movement'
    | 'attachment'
    | 'asset_event'
    | 'asset_type'
    | 'asset_model'
    | 'asset'
    | 'room_inventory'
  op: 'upsert'
  payload: Record<string, unknown>
  createdAt: number
  attempts: number
  /** Epoch ms a partir del cual reintentar. Implementa el backoff exponencial. */
  nextAttemptAt: number
  status: 'pendiente' | 'enviando' | 'rechazado'
  lastError: string | null
}

/** Una foto esperando a subir. Va en cola aparte porque pesa. */
export interface QueuedPhoto {
  id: string
  entityType: 'inspection' | 'incident'
  entityId: string
  blob: Blob
  takenAt: string
  attempts: number
  nextAttemptAt: number
  status: 'pendiente' | 'subiendo' | 'rechazado'
  lastError: string | null
}

/** Clave-valor para estado de la app: última sincronización, sesión cifrada… */
export interface MetaEntry {
  key: string
  value: unknown
}

export class AulasDB extends Dexie {
  // Espejo de solo lectura del maestro. Se refresca al sincronizar.
  buildings!: EntityTable<Building, 'id'>
  zones!: EntityTable<Zone, 'id'>
  rooms!: EntityTable<Room, 'id'>
  stockItems!: EntityTable<StockItem, 'id'>
  /* Cuánto queda de cada artículo. Se espeja para poder decidir dentro del
     aula si un proyector sale del almacén o de otra sala. */
  stockLevels!: EntityTable<StockLevel, 'stock_item_id'>
  incidents!: EntityTable<Incident, 'id'>
  assetTypes!: EntityTable<AssetType, 'id'>
  /* El catálogo de marcas y modelos. Se espeja entero —son decenas de filas— y
     tiene que estar en el dispositivo: elegir el modelo de un proyector ocurre
     delante del proyector, que es donde no hay cobertura. */
  assetModels!: EntityTable<AssetModel, 'id'>

  // El inventario es a la vez maestro y cosa que el técnico produce: lo lee de
  // aquí para revisar y escribe aquí al dar de alta un elemento en el aula.
  assets!: EntityTable<Asset, 'id'>

  // Lo que el técnico produce. La UI lee SIEMPRE de aquí, nunca espera a la red.
  inspections!: EntityTable<Inspection, 'id'>
  checks!: EntityTable<InspectionCheck, 'id'>
  attachments!: EntityTable<Attachment, 'id'>

  outbox!: EntityTable<OutboxEntry, 'id'>
  photos!: EntityTable<QueuedPhoto, 'id'>
  meta!: EntityTable<MetaEntry, 'key'>

  constructor() {
    super('mantenimiento-aulas')

    this.version(1).stores({
      buildings: 'id, code, sort_order',
      zones: 'id, building_id',
      rooms: 'id, zone_id, code, last_inspection_at',
      stockItems: 'id, name',
      incidents: 'id, room_id, state, opened_at',
      assetTypes: 'id, name, confirmed',
      assets: 'id, room_id, asset_type_id, status',

      inspections: 'id, room_id, status, occurred_at',
      checks: 'id, inspection_id, [inspection_id+check_key]',
      attachments: 'id, [entity_type+entity_id]',

      outbox: 'id, status, nextAttemptAt, entity',
      photos: 'id, status, nextAttemptAt, [entityType+entityId]',
      meta: 'key',
    })

    // `createdAt` entra en el índice para poder responder «¿cuánto lleva
    // esperando lo más viejo?» con un `orderBy(...).first()` en vez de leyendo
    // la tabla entera —con los Blob de las fotos dentro— en cada escritura.
    this.version(2).stores({
      outbox: 'id, status, nextAttemptAt, entity, createdAt',
    })

    // Las existencias entran en el espejo para que el alta de equipo pueda
    // ofrecer «sale del almacén» con la cifra delante, también sin cobertura.
    this.version(3).stores({
      stockLevels: 'stock_item_id, name',
    })

    /*
     * El catálogo de modelos, y el índice que lo une al equipo.
     *
     * Va en su propia versión y no dentro de la primera porque Dexie no reevalúa
     * los almacenes de una versión ya aplicada: en un iPad que ya tiene la base
     * creada, añadir la línea arriba no crea nada y el catálogo saldría vacío
     * sin un solo error.
     *
     * `assets` se redeclara entera —Dexie exige la lista completa de índices al
     * tocar un almacén— para añadir `asset_model_id`, que es por lo que pregunta
     * la gestión desde el ordenador al filtrar por modelo.
     */
    this.version(4).stores({
      assetModels: 'id, asset_type_id, confirmed',
      assets: 'id, room_id, asset_type_id, status, asset_model_id, serial',
    })
  }
}

export const db = new AulasDB()

// -----------------------------------------------------------------------------
// Cola de salida
// -----------------------------------------------------------------------------

/**
 * Encola una escritura. Si ya había una entrada para el mismo registro se
 * reemplaza: solo interesa el estado final, no cada pulsación intermedia.
 * Sin esto, escribir 40 caracteres en el campo de observaciones generaría
 * 40 peticiones para la misma fila.
 */
export async function enqueue<T extends object>(
  entity: OutboxEntry['entity'],
  id: string,
  payload: T,
): Promise<void> {
  const existing = await db.outbox.get(id)

  await db.outbox.put({
    id,
    entity,
    op: 'upsert',
    payload: { ...payload } as Record<string, unknown>,
    createdAt: existing?.createdAt ?? Date.now(),
    attempts: 0,
    // Un reintento pendiente se reinicia: el contenido cambió, merece un
    // intento inmediato en vez de arrastrar el backoff del intento anterior.
    nextAttemptAt: 0,
    status: 'pendiente',
    lastError: null,
  })
}

/** Backoff exponencial: 1s, 2s, 4s… con techo de 5 minutos. */
export function backoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** attempts, 5 * 60 * 1000)
}

export interface PendingSummary {
  total: number
  rejected: number
  photos: number
  oldestAt: number | null
  /** Por qué se rechazó lo último que se rechazó. */
  ultimoMotivo: string | null
}

/**
 * Resumen de lo pendiente, resuelto con índices.
 *
 * Antes leía `db.outbox.toArray()` y `db.photos.toArray()` enteras —los Blob de
 * las fotos incluidos— y filtraba en JavaScript. Y esto lo observa la lámpara de
 * la cabecera, que está montada siempre: cada escritura en la cola reejecutaba
 * la consulta. Guardar una revisión de nueve filas disparaba del orden de veinte
 * relecturas completas de dos tablas, con las fotos dentro, mientras el técnico
 * seguía pulsando.
 *
 * Ahora son conteos sobre índices que ya existían, y la fecha del más antiguo
 * solo se busca si hay algo pendiente.
 */
export async function pendingSummary(): Promise<PendingSummary> {
  const [pendientes, enviando, rechazadosCola, fotosPend, fotosSubiendo, fotosRech] =
    await Promise.all([
      db.outbox.where('status').equals('pendiente').count(),
      db.outbox.where('status').equals('enviando').count(),
      db.outbox.where('status').equals('rechazado').count(),
      db.photos.where('status').equals('pendiente').count(),
      db.photos.where('status').equals('subiendo').count(),
      db.photos.where('status').equals('rechazado').count(),
    ])

  const colaViva = pendientes + enviando
  const fotosVivas = fotosPend + fotosSubiendo

  // Solo se busca la más antigua si hay algo esperando: es una consulta más, y
  // con la cola vacía —el caso normal— no aporta nada.
  const oldest =
    colaViva > 0 ? ((await db.outbox.orderBy('createdAt').first())?.createdAt ?? null) : null

  // Igual que la fecha del más antiguo: solo se busca si hay algo rechazado,
  // que es la excepción. «N rechazados. Avisa a administración» sin decir de qué
  // obliga a administración a adivinarlo, y el motivo ya estaba guardado.
  const ultimoMotivo =
    rechazadosCola > 0
      ? ((await db.outbox.where('status').equals('rechazado').last())?.lastError ?? null)
      : null

  return {
    total: colaViva + fotosVivas,
    rejected: rechazadosCola + fotosRech,
    photos: fotosVivas,
    oldestAt: oldest,
    ultimoMotivo,
  }
}

/**
 * Borra de local las revisiones ya cerradas y confirmadas.
 *
 * `inspections` no la purgaba nadie: crecía una fila por revisión para siempre,
 * y con 276 salas por ronda eso son miles de filas al año que se leen y se
 * filtran en cada consulta de borradores. El servidor es el archivo; el
 * dispositivo solo necesita lo que aún no ha subido.
 *
 * Se conserva un margen de dos días por si hiciera falta mirar atrás sin red.
 */
export async function purgeSyncedInspections(): Promise<number> {
  const margen = Date.now() - 2 * 86_400_000
  const cerradas = await db.inspections.where('status').equals('completa').toArray()

  const enCola = new Set((await db.outbox.toCollection().primaryKeys()) as string[])
  const borrables = cerradas.filter(
    (i) => !enCola.has(i.id) && new Date(i.occurred_at).getTime() < margen,
  )
  if (borrables.length === 0) return 0

  const ids = borrables.map((i) => i.id)
  await db.transaction('rw', db.inspections, db.checks, async () => {
    await db.checks.where('inspection_id').anyOf(ids).delete()
    await db.inspections.bulkDelete(ids)
  })
  return ids.length
}

// -----------------------------------------------------------------------------
// Almacenamiento persistente
// -----------------------------------------------------------------------------

/**
 * Pide al navegador que no desaloje nuestros datos.
 *
 * Safari 17+ lo soporta y lo concede por heurística, sin preguntar al usuario.
 * No construimos nada encima: es un refuerzo, y la defensa real sigue siendo
 * que lo pendiente esté respaldado en el servidor.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  try {
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate()
    return { usage, quota }
  } catch {
    return null
  }
}
