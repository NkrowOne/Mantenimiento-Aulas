/**
 * Motor de sincronización.
 *
 * Funciona **solo en primer plano**: iOS no soporta Background Sync ni Periodic
 * Background Sync, así que la app no depende de ellos en ningún punto. Se
 * dispara al arrancar, al recuperar la conexión, al volver a primer plano y con
 * un temporizador mientras queden pendientes.
 */

import { db, backoffMs, pendingSummary, type OutboxEntry, type QueuedPhoto } from '@/db/dexie'
import { supabase } from '@/lib/supabase'

/** A qué tabla de PostgREST va cada tipo de entrada. */
const TABLE: Record<OutboxEntry['entity'], string> = {
  inspection: 'inspections',
  inspection_check: 'inspection_checks',
  incident: 'incidents',
  stock_movement: 'stock_movements',
  attachment: 'attachments',
  asset_event: 'asset_events',
  asset_type: 'asset_types',
  asset_model: 'asset_models',
  asset: 'assets',
  asset_removal: 'asset_removals',
  room_inventory: 'room_inventories',
}

/** Orden de subida: una revisión debe existir antes que sus checks. */
const ORDER: Record<OutboxEntry['entity'], number> = {
  // Un tipo tiene que existir antes que el elemento que lo usa, y el elemento
  // antes que la comprobación que lo nombra.
  //
  // El modelo se cuela entre los dos, y no es cosmético: `assets.asset_model_id`
  // es una clave ajena, así que un equipo con modelo nuevo que suba antes que su
  // modelo se rechaza con un 4xx —permanente, según `isPermanentFailure`— y se
  // queda en la cola como error. Con este orden, el modelo siempre llega antes.
  asset_type: 0,
  asset_model: 1,
  asset: 2,
  inspection: 3,
  inspection_check: 4,
  incident: 5,
  asset_event: 6,
  stock_movement: 7,
  room_inventory: 8,
  // Detrás del equipo al que apunta: pedir la retirada de un aparato que
  // todavía no ha subido chocaría contra su clave ajena.
  asset_removal: 9,
  attachment: 10,
}

export type SyncState = 'inactivo' | 'sincronizando' | 'sin-conexion' | 'error'

/** Lo último que hizo reventar a `flush()`, para poder enseñarlo. */
let ultimoErrorSync: string | null = null

export function getUltimoErrorSync(): string | null {
  return ultimoErrorSync
}

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

/**
 * Entidades que al chocar no se pisan, se ignoran.
 *
 * Un tipo de equipo lo puede crear cualquiera desde un aula, y su id sale del
 * nombre, así que dos técnicos sin cobertura que registren «Cañón corto» envían
 * exactamente la misma fila. Con un upsert normal la segunda se convierte en un
 * UPDATE, que el técnico no tiene permiso para hacer: acabaría rechazada y
 * apareciendo como un error que no lo es.
 *
 * Y protege lo importante: que un alta repetida no pueda devolver a «sin
 * confirmar» un tipo que el coordinador ya validó.
 */
/*
 * Y un movimiento de almacén, por dos motivos que apuntan al mismo sitio.
 *
 * El id se genera al pulsar y no al enviar, así que un reintento —el mismo
 * consumo que ya llegó pero cuya respuesta se perdió— trae la fila idéntica.
 * Con un upsert normal eso sería un UPDATE, y `stock_movements` ya no lo
 * acepta: es un libro de asientos, y un asiento no se reescribe.
 */
/*
 * Y un evento de equipo, por lo mismo: `asset_events` es un registro de cosas
 * que pasaron y solo acepta altas. Un reenvío que se convirtiera en UPDATE
 * chocaría contra una política que no existe y volvería como un error que no lo
 * es.
 */
/*
 * Y un modelo de equipo, por exactamente lo mismo que un tipo: su id sale de
 * (tipo, marca, modelo), así que dos técnicos sin cobertura que registren el
 * mismo «Epson EB-992F» envían la misma fila. Con un upsert normal la segunda
 * sería un UPDATE, que el técnico no puede hacer —la política de `asset_models`
 * reserva la escritura al coordinador—, y volvería como un error que no lo es.
 *
 * Y protege lo mismo: que un alta repetida no devuelva a «sin validar» un modelo
 * que el coordinador ya validó.
 */
/*
 * Y una solicitud de retirada, por lo mismo que el levantamiento: la firma el
 * técnico y la decide otro. Un reenvío que se convirtiera en UPDATE chocaría
 * contra una política que no existe —decidir se hace por RPC— y, peor, podría
 * devolver a «pendiente» una retirada que un coordinador ya autorizó.
 */
const IGNORE_DUPLICATES = new Set<OutboxEntry['entity']>([
  'asset_type',
  'asset_model',
  'stock_movement',
  'asset_event',
  'asset_removal',
  'room_inventory',
])

interface FalloDeRed {
  message: string
  status?: number
}

/**
 * Ejecuta una llamada al servidor y devuelve su fallo, **lo devuelva o lo
 * lance**.
 *
 * Esta distinción costó una cola atascada. El cliente de Supabase contesta
 * `{ error }` cuando el servidor responde algo, pero **lanza** cuando no hay
 * respuesta: se cae la cobertura a mitad de la subida, el túnel devuelve un
 * cuerpo que no es JSON, iOS congela la petición al bloquear la pantalla. Ese
 * `throw` no lo recogía nadie aquí, subía hasta el `catch` de `flush()` y se
 * llevaba por delante dos cosas a la vez: el resto de la cola —que ni se
 * intentaba— y, mucho peor, la entrada en curso, que se quedaba marcada como
 * «enviando» para siempre.
 *
 * Y «enviando» era una trampa sin salida: `flush()` solo recoge lo que está
 * «pendiente», así que esa entrada no se volvía a intentar jamás; no contaba
 * como rechazada, así que no salía en rojo ni ofrecía «Reintentar»; pero sí
 * contaba como pendiente en la lámpara. El resultado exacto que se ve desde
 * fuera: «3 pendientes» que no bajan de tres por mucho que se pulse
 * Sincronizar, sin un solo mensaje de error que explique por qué.
 */
async function intentar(
  llamada: () => PromiseLike<{ error: { message: string } | null; status?: number }>,
): Promise<FalloDeRed | null> {
  try {
    const { error, status } = await llamada()
    return error ? { message: error.message, status } : null
  } catch (err) {
    // Sin respuesta no hay código: se trata como temporal, que es lo que es.
    return { message: err instanceof Error ? err.message : String(err) }
  }
}

/** @returns si la entrada llegó a subir. */
async function pushEntry(entry: OutboxEntry): Promise<boolean> {
  await db.outbox.update(entry.id, { status: 'enviando' })

  const fallo = await intentar(() =>
    supabase.from(TABLE[entry.entity]).upsert(entry.payload, {
      onConflict: 'id',
      ignoreDuplicates: IGNORE_DUPLICATES.has(entry.entity),
    }),
  )

  if (!fallo) {
    await db.outbox.delete(entry.id)
    return true
  }

  const attempts = entry.attempts + 1
  if (isPermanentFailure(fallo.status)) {
    await db.outbox.update(entry.id, {
      status: 'rechazado',
      attempts,
      lastError: `${fallo.status}: ${fallo.message}`,
    })
    return false
  }

  await db.outbox.update(entry.id, {
    status: 'pendiente',
    attempts,
    nextAttemptAt: Date.now() + backoffMs(attempts),
    lastError: fallo.message,
  })
  return false
}

/** @returns si la foto llegó a subir y a enlazarse. */
async function pushPhoto(photo: QueuedPhoto): Promise<boolean> {
  await db.photos.update(photo.id, { status: 'subiendo' })

  const path = `${photo.entityType}/${photo.entityId}/${photo.id}.jpg`
  const subida = await intentar(() =>
    supabase.storage
      .from('fotos')
      .upload(path, photo.blob, { contentType: 'image/jpeg', upsert: true }),
  )

  if (subida) {
    const attempts = photo.attempts + 1
    await db.photos.update(photo.id, {
      status: attempts > 8 ? 'rechazado' : 'pendiente',
      attempts,
      nextAttemptAt: Date.now() + backoffMs(attempts),
      lastError: subida.message,
    })
    return false
  }

  // La foto ya está arriba; ahora se enlaza con su revisión o incidencia.
  const enlace = await intentar(async () => {
    // `getUser()` también es red, y también lanza: iba fuera del `intentar`, así
    // que una foto subida podía dejar su fila en «subiendo» por no poder
    // preguntar quién la hizo.
    const autor = (await supabase.auth.getUser()).data.user?.id ?? null
    return supabase.from('attachments').upsert(
      {
        id: photo.id,
        entity_type: photo.entityType,
        entity_id: photo.entityId,
        storage_path: path,
        taken_at: photo.takenAt,
        by_user: autor,
      },
      { onConflict: 'id' },
    )
  })

  if (enlace) {
    const attempts = photo.attempts + 1
    await db.photos.update(photo.id, {
      status: 'pendiente',
      attempts,
      nextAttemptAt: Date.now() + backoffMs(attempts),
      lastError: enlace.message,
    })
    return false
  }

  await db.photos.delete(photo.id)
  return true
}

/**
 * Devuelve a la cola lo que se quedó «en vuelo».
 *
 * `flush()` no es reentrante, así que cuando arranca una pasada no hay ninguna
 * subida en curso: **todo lo que esté en «enviando» o «subiendo» en este
 * momento es un huérfano**, de una pasada anterior que no llegó a terminar
 * —la app cerrada de un barrido, iOS matando la pestaña, una recarga a mitad—.
 * Nadie lo devolvía a «pendiente», así que se quedaba fuera de la sincronización
 * para siempre mientras seguía contando en la lámpara.
 *
 * Reenviarlo es seguro aunque la fila hubiera llegado al servidor: el id se
 * genera al pulsar, no al enviar, y es la clave de idempotencia del upsert.
 *
 * Los intentos no se tocan: no se sabe si el envío llegó, así que no es un
 * intento fallido. Y no puede degenerar en un bucle porque, con los `throw` ya
 * recogidos arriba, la única forma de dejar un huérfano es que muera la app.
 */
async function recuperarEnVuelo(): Promise<number> {
  const motivo = 'Se interrumpió a mitad de subida; se reintenta.'
  const [entradas, fotos] = await Promise.all([
    db.outbox
      .where('status')
      .equals('enviando')
      .modify({ status: 'pendiente', nextAttemptAt: 0, lastError: motivo }),
    db.photos
      .where('status')
      .equals('subiendo')
      .modify({ status: 'pendiente', nextAttemptAt: 0, lastError: motivo }),
  ])
  return entradas + fotos
}

export interface ResultadoFlush {
  /** Cuántas cosas han llegado al servidor en esta pasada. */
  subidos: number
  /** Cuántas siguen esperando al terminar. */
  pendientes: number
  /** Cuántas ha rechazado el servidor y necesitan que alguien las mire. */
  rechazados: number
}

/**
 * Vacía la cola. No es reentrante: si ya hay una pasada en curso, no arranca
 * otra.
 *
 * `forzar` es lo que hace el botón «Sincronizar» de la lámpara. Sin él, una
 * pasada solo mira lo que ya ha cumplido su espera de backoff, y eso convertía
 * al botón en un adorno justo cuando más falta hace: tres intentos fallidos
 * seguidos ponen la siguiente ventana a cinco minutos, así que el técnico que
 * acaba de encontrar cobertura y pulsa el botón obtenía una pasada que no
 * intentaba absolutamente nada — y encima terminaba anunciando «Al día», porque
 * la bajada sí funcionaba. Pulsar el botón *es* la señal de que ahora hay red;
 * el backoff protege del reintento automático, no de una orden explícita.
 */
export async function flush(opciones: { forzar?: boolean } = {}): Promise<ResultadoFlush> {
  const parte = async (subidos: number): Promise<ResultadoFlush> => {
    const resumen = await pendingSummary()
    return { subidos, pendientes: resumen.total, rechazados: resumen.rejected }
  }

  if (running) return parte(0)
  if (!navigator.onLine) {
    setState('sin-conexion')
    return parte(0)
  }

  running = true
  setState('sincronizando')
  let subidos = 0

  try {
    // `getSession()` va DENTRO del try: puede rechazar —renovar el token es una
    // petición de red— y a `flush()` se la llama con `void` y sin `.catch()`
    // desde cuatro sitios, así que ese rechazo se convertía en un unhandled
    // rejection y dejaba `running` en true para siempre: la sincronización no
    // volvía a arrancar en toda la sesión.
    const { data } = await supabase.auth.getSession()
    if (!data.session) {
      // Sin sesión no se puede subir nada, pero tampoco es un error que mostrar:
      // el usuario simplemente aún no ha introducido su PIN.
      setState('inactivo')
      return parte(0)
    }

    // Antes que nada, rescatar lo que se quedó a medias en una pasada anterior.
    await recuperarEnVuelo()

    const now = Date.now()
    const toca = (nextAttemptAt: number): boolean => opciones.forzar || nextAttemptAt <= now

    const due = (await db.outbox.toArray())
      .filter((e) => e.status === 'pendiente' && toca(e.nextAttemptAt))
      .sort((a, b) => ORDER[a.entity] - ORDER[b.entity] || a.createdAt - b.createdAt)

    for (const entry of due) {
      if (await pushEntry(entry)) subidos += 1
    }

    const duePhotos = (await db.photos.toArray()).filter(
      (p) => p.status === 'pendiente' && toca(p.nextAttemptAt),
    )
    for (const photo of duePhotos) {
      if (await pushPhoto(photo)) subidos += 1
    }

    const remaining = await db.outbox.where('status').equals('rechazado').count()
    setState(remaining > 0 ? 'error' : 'inactivo')
    // Una pasada que termina entera limpia el motivo anterior: si no, el panel
    // seguía enseñando en rojo el error de hace media hora, ya resuelto.
    ultimoErrorSync = null
  } catch (err) {
    // El `catch` no ligaba la variable, así que el motivo se evaporaba: quedaba
    // un estado 'error' que la lámpara ni siquiera sabía pintar, sin una sola
    // pista de qué había fallado ni dónde mirarla.
    ultimoErrorSync = err instanceof Error ? err.message : String(err)
    console.error('flush', err)
    setState('error')
  } finally {
    running = false
  }

  return parte(subidos)
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
  //
  // Cuenta con `pendingSummary()`, que incluye lo que está «en vuelo», y no con
  // los dos `count()` de «pendiente» que había aquí. Con aquellos, un móvil cuya
  // única cosa por subir fuera un huérfano de una pasada muerta nunca volvía a
  // llamar a `flush()`: el rescate está dentro de `flush()`, y quien decidía si
  // llamarlo contaba justamente el estado que el huérfano ya no tenía.
  timer = setInterval(() => {
    void (async () => {
      const { total } = await pendingSummary()
      if (total > 0) void flush()
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
export async function retryRejected(): Promise<ResultadoFlush> {
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
  // Forzado: reintentar a mano es una orden, no un turno de la cola.
  return flush({ forzar: true })
}
