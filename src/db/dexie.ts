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
  Attachment,
  Building,
  Incident,
  Inspection,
  InspectionCheck,
  Room,
  StockItem,
  Zone,
} from '@/domain/types'

/** Una operación esperando a subir. El id es la clave de idempotencia. */
export interface OutboxEntry {
  /** uuid v7 del registro afectado. Reenviarlo dos veces no duplica nada. */
  id: string
  entity: 'inspection' | 'inspection_check' | 'incident' | 'stock_movement' | 'attachment' | 'asset_event'
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
  incidents!: EntityTable<Incident, 'id'>

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

      inspections: 'id, room_id, status, occurred_at',
      checks: 'id, inspection_id, [inspection_id+check_key]',
      attachments: 'id, [entity_type+entity_id]',

      outbox: 'id, status, nextAttemptAt, entity',
      photos: 'id, status, nextAttemptAt, [entityType+entityId]',
      meta: 'key',
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
}

export async function pendingSummary(): Promise<PendingSummary> {
  const [entries, photos] = await Promise.all([db.outbox.toArray(), db.photos.toArray()])
  const live = entries.filter((e) => e.status !== 'rechazado')
  const oldest = [...live, ...photos].reduce<number | null>((min, e) => {
    const t = 'createdAt' in e ? e.createdAt : Date.now()
    return min === null || t < min ? t : min
  }, null)

  return {
    total: live.length + photos.filter((p) => p.status !== 'rechazado').length,
    rejected: entries.filter((e) => e.status === 'rechazado').length +
      photos.filter((p) => p.status === 'rechazado').length,
    photos: photos.filter((p) => p.status !== 'rechazado').length,
    oldestAt: oldest,
  }
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
