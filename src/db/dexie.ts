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
  AssetRemoval,
  AssetType,
  Attachment,
  Building,
  Incident,
  Inspection,
  InspectionCheck,
  Persona,
  Room,
  StockItem,
  StockLevel,
  Zone,
} from '@/domain/types'

/** Una operación esperando a subir. El id es la clave de idempotencia. */
export interface OutboxEntry {
  /**
   * uuid v7 del registro afectado. Reenviarlo dos veces no duplica nada.
   *
   * En un `rpc` NO es el id de la fila: es el de la entrada, que lleva un
   * sufijo (`<uuid>#estado`). Sin él, encolar el cierre de una incidencia
   * recién abierta sin cobertura **reemplazaría el alta** —`enqueue` guarda por
   * clave primaria— y la incidencia no llegaría a existir en el servidor. Cuál
   * es la fila lo dice `targetId`.
   */
  id: string
  entity:
    | 'inspection'
    | 'inspection_check'
    | 'incident'
    | 'stock_movement'
    | 'attachment'
    | 'asset_event'
    | 'asset_type'
    | 'asset'
    | 'asset_removal'
    | 'room_inventory'
  /**
   * `upsert` es el camino de siempre: la fila nace en el dispositivo con su
   * identidad y se manda entera.
   *
   * `rpc` es para lo que **ya existe arriba** y solo cambia de estado —empezar o
   * cerrar una incidencia—. No se manda la fila: se llama a una función del
   * servidor, que es la única puerta por la que un técnico puede cerrar. Un
   * upsert no serviría de nada aquí: `incident` viaja en `IGNORE_DUPLICATES`, así
   * que el servidor lo ignoraría por estar la fila ya puesta, sin error y sin
   * efecto. Ver `pushEntry`.
   */
  op: 'upsert' | 'rpc'
  /** Qué función del servidor se llama. Solo en un `rpc`. */
  rpc?: string
  /** Sobre qué fila actúa un `rpc`, para poder esperar a que su alta suba. */
  targetId?: string
  payload: Record<string, unknown>
  createdAt: number
  attempts: number
  /** Epoch ms a partir del cual reintentar. Implementa el backoff exponencial. */
  nextAttemptAt: number
  status: 'pendiente' | 'enviando' | 'rechazado'
  lastError: string | null
}

/**
 * Una foto esperando a subir. Va en cola aparte porque pesa.
 *
 * **Sin los bytes dentro**, y esa ausencia es la corrección de un fallo que
 * dejaba la sincronización entera muerta en iOS.
 *
 * Dexie implementa `update()` y `modify()` como leer la fila, cambiarle un
 * campo y **volver a escribirla entera**. Si la fila lleva un `Blob`, eso
 * significa reescribir el Blob en cada cambio de estado —a «subiendo», a
 * «pendiente», a «rechazado»—, y WebKit falla al reescribir un Blob que salió
 * de IndexedDB: el fichero que lo respaldaba ya no está y contesta
 * `UnknownError: Error preparing Blob/File data to be stored in object store`.
 *
 * Con los bytes fuera, cambiar el estado de una foto es escribir cuatro campos
 * de texto y números. No hay Blob que preparar, así que no hay nada que pueda
 * fallar.
 */
export interface QueuedPhoto {
  id: string
  entityType: 'inspection' | 'incident'
  entityId: string
  takenAt: string
  attempts: number
  nextAttemptAt: number
  status: 'pendiente' | 'subiendo' | 'rechazado'
  lastError: string | null
  /**
   * Los bytes de las versiones anteriores, mientras no se hayan trasladado.
   * `migrarFotosASusBytes()` lo vacía en el arranque y nadie más lo escribe.
   */
  blob?: Blob
}

/**
 * Los bytes de una foto, en su propia tabla y como `ArrayBuffer`.
 *
 * `ArrayBuffer` y no `Blob` a propósito: un ArrayBuffer se clona como datos
 * planos y no arrastra el fichero de respaldo que WebKit pierde. Es lo que
 * evita de raíz la clase entera de fallo.
 *
 * Y en tabla aparte para que la cola pueda cambiar el estado de una foto sin
 * tocar sus megas: escribir la fila de estado ya no arrastra la imagen.
 */
export interface PhotoBytes {
  id: string
  bytes: ArrayBuffer
  type: string
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
  /* Los nombres del equipo. Sin esto, «asignada a Fulano» sería un uuid — y el
     aula, que es donde se lee, es donde no hay cobertura para preguntarlo. */
  personal!: EntityTable<Persona, 'id'>

  // El inventario es a la vez maestro y cosa que el técnico produce: lo lee de
  // aquí para revisar y escribe aquí al dar de alta un elemento en el aula.
  assets!: EntityTable<Asset, 'id'>

  /* Las retiradas por autorizar. Se espejan para que el aula pueda enseñar
     «retirada solicitada» junto al equipo sin preguntarle nada a la red: sin
     eso, el técnico que la firmó ayer no tiene forma de saber si llegó a
     firmarse, y la vuelve a pedir. */
  assetRemovals!: EntityTable<AssetRemoval, 'id'>

  // Lo que el técnico produce. La UI lee SIEMPRE de aquí, nunca espera a la red.
  inspections!: EntityTable<Inspection, 'id'>
  checks!: EntityTable<InspectionCheck, 'id'>
  attachments!: EntityTable<Attachment, 'id'>

  outbox!: EntityTable<OutboxEntry, 'id'>
  photos!: EntityTable<QueuedPhoto, 'id'>
  /** Los bytes de las fotos en cola, separados de su fila de estado. */
  photoBlobs!: EntityTable<PhotoBytes, 'id'>
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

    // Y las retiradas por autorizar, indexadas por equipo: la lista de la sala
    // pregunta «¿este tiene una solicitud viva?» una vez por fila.
    this.version(4).stores({
      assetRemovals: 'id, asset_id, state',
    })

    /*
     * Los bytes de las fotos, fuera de la fila que cambia de estado.
     *
     * El traslado de lo que ya hubiera guardado NO va en un `.upgrade()`: leer
     * un Blob es asíncrono y ajeno a Dexie, y esperar a algo así dentro de una
     * transacción de IndexedDB la deja cerrarse por debajo. Lo hace
     * `migrarFotosASusBytes()` al arrancar, foto a foto y sin transacción
     * larga, que además permite tratar por separado la que no se pueda leer.
     */
    this.version(5).stores({
      photoBlobs: 'id',
    })

    // Los nombres del equipo, para poner cara a quien lleva cada incidencia.
    this.version(6).stores({
      personal: 'id',
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

/**
 * Encola una llamada a una función del servidor sobre una fila que ya existe.
 *
 * Existe para una sola cosa hoy —empezar o cerrar una incidencia— y por eso no
 * intenta ser genérica. Va por función y no por escritura directa porque cerrar
 * una incidencia es lo único que un técnico puede hacerle a `incidents`: la
 * tabla sigue cerrada a UPDATE para quien no sea supervisor, y la función es la
 * puerta con nombre que valida lo que sí se permite.
 *
 * La clave de la entrada lleva sufijo para no chocar con el alta de esa misma
 * fila, que puede seguir en la cola. Y **se reemplaza** si ya había otra del
 * mismo sufijo: pulsar «Resolver» dos veces es una sola orden.
 */
export async function enqueueRpc<T extends object>(
  entity: OutboxEntry['entity'],
  fn: string,
  targetId: string,
  sufijo: string,
  args: T,
): Promise<void> {
  const id = `${targetId}#${sufijo}`
  const existing = await db.outbox.get(id)

  await db.outbox.put({
    id,
    entity,
    op: 'rpc',
    rpc: fn,
    targetId,
    payload: { ...args } as Record<string, unknown>,
    createdAt: existing?.createdAt ?? Date.now(),
    attempts: 0,
    nextAttemptAt: 0,
    status: 'pendiente',
    lastError: null,
  })
}

// -----------------------------------------------------------------------------
// Los bytes de las fotos
// -----------------------------------------------------------------------------

/** Guarda los bytes de una foto recién capturada. */
export async function guardarBytesDeFoto(id: string, blob: Blob): Promise<void> {
  await db.photoBlobs.put({ id, bytes: await blob.arrayBuffer(), type: blob.type || 'image/jpeg' })
}

/**
 * Devuelve los bytes de una foto como Blob **nuevo**, hecho en memoria.
 *
 * Nunca devuelve el Blob que salió de IndexedDB: es justamente el que WebKit no
 * sabe volver a guardar. Este se construye aquí y solo viaja a la red.
 */
export async function leerBytesDeFoto(id: string): Promise<Blob | null> {
  const fila = await db.photoBlobs.get(id)
  if (!fila) return null
  return new Blob([fila.bytes], { type: fila.type || 'image/jpeg' })
}

/** Borra una foto de la cola: su estado y sus bytes, que van juntos aunque vivan aparte. */
export async function borrarFotoDeLaCola(id: string): Promise<void> {
  await db.photos.delete(id)
  await db.photoBlobs.delete(id)
}

/**
 * Traslada a `photoBlobs` los bytes de las fotos guardadas por versiones
 * anteriores.
 *
 * Foto a foto y con su propio `try`: si WebKit ya ha perdido el fichero de
 * respaldo de una, esa foto es irrecuperable en este dispositivo —los bytes no
 * existen en ninguna parte— y lo que no puede pasar es que se lleve por delante
 * a las demás. Se marca como rechazada, que es un estado visible y con botón de
 * reintentar, en vez de dejarla bloqueando la cola en silencio.
 *
 * @returns cuántas se trasladaron y cuántas se perdieron por el camino.
 */
export async function migrarFotosASusBytes(): Promise<{ movidas: number; ilegibles: number }> {
  const pendientes = (await db.photos.toArray()).filter((p) => p.blob !== undefined)
  let movidas = 0
  let ilegibles = 0

  for (const foto of pendientes) {
    const { blob, ...sinBytes } = foto
    try {
      await db.photoBlobs.put({
        id: foto.id,
        bytes: await blob!.arrayBuffer(),
        type: blob!.type || 'image/jpeg',
      })
      await db.photos.put(sinBytes)
      movidas += 1
    } catch {
      // Los bytes no se pueden leer. Decirlo es mejor que reintentarlo eternamente.
      await db.photos.put({
        ...sinBytes,
        status: 'rechazado',
        lastError:
          'iOS ha descartado los datos de esta foto y ya no se pueden leer en este dispositivo. Hay que repetirla.',
      })
      ilegibles += 1
    }
  }

  return { movidas, ilegibles }
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
  /** Qué falló el último intento de lo más viejo que sigue esperando. */
  motivoPendiente: string | null
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

  /*
   * Solo se busca la más antigua si hay algo esperando: es una consulta más, y
   * con la cola vacía —el caso normal— no aporta nada.
   *
   * Y se saltan las rechazadas. Antes cogía la primera por fecha fuera cual
   * fuera su estado, así que una entrada rechazada —que ya se queja por su
   * cuenta y no se va a mover sola— se quedaba de por vida como «la más
   * antigua» y mantenía encendido el aviso de «N atascados» aunque todo lo que
   * de verdad estaba en cola acabara de encolarse.
   */
  const masViejo =
    colaViva > 0
      ? ((await db.outbox
          .orderBy('createdAt')
          .filter((e) => e.status !== 'rechazado')
          .first()) ?? null)
      : null
  const oldest = masViejo?.createdAt ?? null

  // Sale gratis: es la fila que ya se ha leído. Y contesta la pregunta que la
  // cifra sola no contesta —«¿por qué sigue ahí?»—, que es justo la que se hace
  // quien mira el panel porque el número no baja.
  const motivoPendiente = masViejo?.lastError ?? null

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
    motivoPendiente,
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

  /*
   * Y tampoco se borra la revisión de la que aún cuelga algo en la cola.
   *
   * La clave de la cola es el id de la fila, así que una comprobación pendiente
   * aparece en `enCola` con SU id, no con el de su revisión: mirando solo
   * `enCola.has(i.id)` se borraba el espejo de una revisión que todavía estaba
   * subiendo por partes. Y ese espejo es el que decide si una comprobación pisa o
   * no pisa (`ignorarDuplicados`, en outbox.ts), así que borrarlo antes de tiempo
   * dejaba sus filas chocando contra los permisos y rechazadas para siempre.
   *
   * Le pasa sobre todo a una corrección, y por su propia naturaleza: conserva la
   * fecha de la visita que corrige, así que el margen de dos días —que cuenta
   * desde `occurred_at`— no la protege ni un minuto.
   */
  const conHijosEnCola = new Set(
    (await db.outbox.where('entity').equals('inspection_check').toArray())
      .map((e) => e.payload['inspection_id'] as string | undefined)
      .filter((id): id is string => typeof id === 'string'),
  )
  // `db.photos` ya no lleva los bytes dentro —viven en `photoBlobs`—, así que
  // leerla entera aquí es leer cuatro campos de texto por foto pendiente.
  const conFotoEnCola = new Set(
    (await db.photos.toArray())
      .filter((p) => p.entityType === 'inspection')
      .map((p) => p.entityId),
  )

  const borrables = cerradas.filter(
    (i) =>
      !enCola.has(i.id) &&
      !conHijosEnCola.has(i.id) &&
      !conFotoEnCola.has(i.id) &&
      new Date(i.occurred_at).getTime() < margen,
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
