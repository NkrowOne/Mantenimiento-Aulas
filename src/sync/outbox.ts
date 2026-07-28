/**
 * Motor de sincronización.
 *
 * Funciona **solo en primer plano**: iOS no soporta Background Sync ni Periodic
 * Background Sync, así que la app no depende de ellos en ningún punto. Se
 * dispara al arrancar, al recuperar la conexión, al volver a primer plano y con
 * un temporizador mientras queden pendientes.
 */

import { db, backoffMs, type OutboxEntry, type QueuedPhoto } from '@/db/dexie'
import { supabase } from '@/lib/supabase'

/** A qué tabla de PostgREST va cada tipo de entrada. */
const TABLE: Record<OutboxEntry['entity'], string> = {
  inspection: 'inspections',
  inspection_check: 'inspection_checks',
  incident: 'incidents',
  stock_movement: 'stock_movements',
  attachment: 'attachments',
  asset_event: 'asset_events',
}

/** Orden de subida: una revisión debe existir antes que sus checks. */
const ORDER: Record<OutboxEntry['entity'], number> = {
  inspection: 0,
  inspection_check: 1,
  incident: 2,
  asset_event: 3,
  stock_movement: 4,
  attachment: 5,
}

export type SyncState = 'inactivo' | 'sincronizando' | 'sin-conexion' | 'error'

type Listener = (state: SyncState) => void
const listeners = new Set<Listener>()
let current: SyncState = 'inactivo'
let running = false
let timer: ReturnType<typeof setInterval> | null = null

function setState(next: SyncState): void {
  if (next === current) return
  current = next
  listeners.forEach((l) => l(next))
}

export function onSyncState(listener: Listener): () => void {
  listeners.add(listener)
  listener(current)
  return () => listeners.delete(listener)
}

export function getSyncState(): SyncState {
  return current
}

/**
 * Un 4xx significa que el servidor rechazó el contenido: reintentar no lo va a
 * arreglar y repetirlo eternamente esconde el problema. Se marca como rechazado
 * y aparece en la pantalla de pendientes para que alguien lo mire.
 *
 * 408 y 429 son la excepción: son temporales y sí merecen reintento.
 */
function isPermanentFailure(status: number | undefined): boolean {
  if (status === undefined) return false
  if (status === 408 || status === 429) return false
  return status >= 400 && status < 500
}

async function pushEntry(entry: OutboxEntry): Promise<void> {
  await db.outbox.update(entry.id, { status: 'enviando' })

  const { error, status } = await supabase
    .from(TABLE[entry.entity])
    .upsert(entry.payload, { onConflict: 'id' })

  if (!error) {
    await db.outbox.delete(entry.id)
    return
  }

  const attempts = entry.attempts + 1
  if (isPermanentFailure(status)) {
    await db.outbox.update(entry.id, {
      status: 'rechazado',
      attempts,
      lastError: `${status}: ${error.message}`,
    })
    return
  }

  await db.outbox.update(entry.id, {
    status: 'pendiente',
    attempts,
    nextAttemptAt: Date.now() + backoffMs(attempts),
    lastError: error.message,
  })
}

async function pushPhoto(photo: QueuedPhoto): Promise<void> {
  await db.photos.update(photo.id, { status: 'subiendo' })

  const path = `${photo.entityType}/${photo.entityId}/${photo.id}.jpg`
  const { error } = await supabase.storage
    .from('fotos')
    .upload(path, photo.blob, { contentType: 'image/jpeg', upsert: true })

  if (error) {
    const attempts = photo.attempts + 1
    await db.photos.update(photo.id, {
      status: attempts > 8 ? 'rechazado' : 'pendiente',
      attempts,
      nextAttemptAt: Date.now() + backoffMs(attempts),
      lastError: error.message,
    })
    return
  }

  // La foto ya está arriba; ahora se enlaza con su revisión o incidencia.
  const { error: linkError } = await supabase.from('attachments').upsert(
    {
      id: photo.id,
      entity_type: photo.entityType,
      entity_id: photo.entityId,
      storage_path: path,
      taken_at: photo.takenAt,
      by_user: (await supabase.auth.getUser()).data.user?.id ?? null,
    },
    { onConflict: 'id' },
  )

  if (linkError) {
    const attempts = photo.attempts + 1
    await db.photos.update(photo.id, {
      status: 'pendiente',
      attempts,
      nextAttemptAt: Date.now() + backoffMs(attempts),
      lastError: linkError.message,
    })
    return
  }

  await db.photos.delete(photo.id)
}

/**
 * Vacía la cola. Es reentrante: si ya hay una pasada en curso, no arranca otra.
 */
export async function flush(): Promise<void> {
  if (running) return
  if (!navigator.onLine) {
    setState('sin-conexion')
    return
  }

  const { data } = await supabase.auth.getSession()
  if (!data.session) {
    // Sin sesión no se puede subir nada, pero tampoco es un error que mostrar:
    // el usuario simplemente aún no ha introducido su PIN.
    setState('inactivo')
    return
  }

  running = true
  setState('sincronizando')

  try {
    const now = Date.now()
    const due = (await db.outbox.toArray())
      .filter((e) => e.status === 'pendiente' && e.nextAttemptAt <= now)
      .sort((a, b) => ORDER[a.entity] - ORDER[b.entity] || a.createdAt - b.createdAt)

    for (const entry of due) {
      await pushEntry(entry)
    }

    const duePhotos = (await db.photos.toArray()).filter(
      (p) => p.status === 'pendiente' && p.nextAttemptAt <= now,
    )
    for (const photo of duePhotos) {
      await pushPhoto(photo)
    }

    const remaining = await db.outbox.where('status').equals('rechazado').count()
    setState(remaining > 0 ? 'error' : 'inactivo')
  } catch {
    setState('error')
  } finally {
    running = false
  }
}

/**
 * Arranca los disparadores. Todos son de primer plano a propósito.
 */
export function startSync(): () => void {
  const onOnline = (): void => {
    void flush()
  }
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void flush()
  }

  window.addEventListener('online', onOnline)
  window.addEventListener('offline', () => setState('sin-conexion'))
  document.addEventListener('visibilitychange', onVisible)

  // Mientras queden pendientes se reintenta cada minuto. Es la red de seguridad
  // que sustituye al Background Sync que iOS no tiene.
  timer = setInterval(() => {
    void (async () => {
      const pending = await db.outbox.where('status').equals('pendiente').count()
      const photos = await db.photos.where('status').equals('pendiente').count()
      if (pending + photos > 0) void flush()
    })()
  }, 60_000)

  void flush()

  return () => {
    window.removeEventListener('online', onOnline)
    document.removeEventListener('visibilitychange', onVisible)
    if (timer) clearInterval(timer)
  }
}

/** Reintenta a mano lo rechazado, desde la pantalla de pendientes. */
export async function retryRejected(): Promise<void> {
  await db.outbox.where('status').equals('rechazado').modify({
    status: 'pendiente',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
  })
  await db.photos.where('status').equals('rechazado').modify({
    status: 'pendiente',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
  })
  await flush()
}
