/**
 * Motor de sincronización.
 *
 * Funciona **solo en primer plano**: iOS no soporta Background Sync ni Periodic
 * Background Sync, así que la app no depende de ellos en ningún punto. Se
 * dispara al arrancar, al recuperar la conexión, al volver a primer plano y con
 * un temporizador mientras queden pendientes.
 */

import {
  db,
  backoffMs,
  borrarFotoDeLaCola,
  leerBytesDeFoto,
  migrarFotosASusBytes,
  pendingSummary,
  type OutboxEntry,
  type QueuedPhoto,
} from '@/db/dexie'
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
  asset: 'assets',
  asset_removal: 'asset_removals',
  room_inventory: 'room_inventories',
}

/** Orden de subida: una revisión debe existir antes que sus checks. */
const ORDER: Record<OutboxEntry['entity'], number> = {
  // Un tipo tiene que existir antes que el elemento que lo usa, y el elemento
  // antes que la comprobación que lo nombra.
  asset_type: 0,
  asset: 1,
  inspection: 2,
  inspection_check: 3,
  incident: 4,
  asset_event: 5,
  stock_movement: 6,
  room_inventory: 7,
  // Detrás del equipo al que apunta: pedir la retirada de un aparato que
  // todavía no ha subido chocaría contra su clave ajena.
  asset_removal: 8,
  attachment: 9,
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
 *
 * Y el 401 también, y costó una cola entera atascada entenderlo: no habla del
 * contenido, habla de la sesión. Un iPad que pasa la noche dormido puede llegar
 * a la mañana con el token caducado y la renovación aún a medias; cada envío de
 * esa ventana volvía con 401 y se marcaba rechazado PARA SIEMPRE, así que el
 * trabajo se acumulaba en rojo hasta que alguien pulsaba «Reintentar» — con la
 * sesión ya renovada y la red perfectamente bien. Renovarse y reintentar es
 * exactamente lo que la cola sabe hacer sola; `flush()` ya refresca la sesión
 * al arrancar cada pasada.
 */
function isPermanentFailure(status: number | undefined): boolean {
  if (status === undefined) return false
  if (status === 401 || status === 408 || status === 429) return false
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
 * Y una solicitud de retirada, por lo mismo que el levantamiento: la firma el
 * técnico y la decide otro. Un reenvío que se convirtiera en UPDATE chocaría
 * contra una política que no existe —decidir se hace por RPC— y, peor, podría
 * devolver a «pendiente» una retirada que un coordinador ya autorizó.
 */
/*
 * Y una incidencia, y un adjunto. Los dos por el mismo motivo que los de arriba,
 * y los dos costaron trabajo de campo antes de estar en esta lista.
 *
 * El modelo de escritura del servidor es **de una sola vez**: `incidents` deja
 * abrir a cualquiera del equipo pero solo un supervisor puede actualizar, y
 * `attachments` solo tiene política de INSERT. La cola, en cambio, hacía upsert
 * siempre. Y un upsert sobre una fila que ya está no es un alta: es un UPDATE.
 *
 * O sea que el primer envío entraba y **cualquier reenvío quedaba prohibido**.
 * Los reenvíos no son la excepción aquí, son el día a día: se sube sin
 * cobertura, se pierde la respuesta, se reintenta. Un 403 es permanente, así
 * que esas filas se marcaban rechazadas para siempre y se quedaban en la cola
 * enseñando un error de permisos que no era tal — la fila ya estaba arriba.
 */
const IGNORE_DUPLICATES = new Set<OutboxEntry['entity']>([
  'asset_type',
  'stock_movement',
  'asset_event',
  'asset_removal',
  'room_inventory',
  'incident',
  'attachment',
])

/**
 * ¿Este envío debe ignorar la fila que ya esté, en vez de pisarla?
 *
 * Para casi todo lo decide la entidad. Las **comprobaciones** no: depende de en
 * qué momento de su vida esté la revisión de la que cuelgan.
 *
 * Mientras la revisión es un borrador hay que poder pisar lo que haya —el
 * técnico cambia una comprobación y ese cambio tiene que llegar—, y el servidor
 * lo permite. En cuanto se cierra, la revisión queda congelada: ahí ya no hay
 * nada legítimo que actualizar, y cualquier reenvío es un reintento de algo que
 * quizá ya llegó. Pisar deja de estar permitido y deja de hacer falta a la vez.
 *
 * Sin esto, cerrar una revisión dejaba sus nueve comprobaciones rechazadas por
 * permisos en cuanto se reintentaba una sola vez.
 *
 * LA FILA DE LA REVISIÓN NO ENTRA AQUÍ, y es lo contrario de un descuido.
 *
 * Su segundo envío no es un reintento: es **el cierre**. La cola la sube dos
 * veces a propósito —como borrador mientras se rellena y como `completa` al
 * terminar— y esa segunda vez tiene que pisar la de antes. Con la regla de las
 * comprobaciones aplicada también a ella, el envío del cierre se convertía en un
 * `on conflict do nothing` sobre la fila que ya estaba: la revisión se quedaba
 * **en borrador en el servidor para siempre**. Y en borrador no existe para nadie
 * —ni en el histórico de la sala, ni en la fiabilidad, ni en el informe del
 * viernes, ni en la lista de revisiones de la ficha—, así que el técnico veía su
 * trabajo guardado en el iPad y en el servidor no había nada. Solo se salvaba la
 * revisión hecha entera sin cobertura, la única que llega ya cerrada de primeras.
 *
 * Del reintento del cierre —el que llega a una fila que ya está cerrada y vuelve
 * un 42501— se encarga `yaEstabaCerrada()`, unas líneas más abajo: pregunta si
 * está cerrada arriba y, si lo está, da la entrada por subida. Ahí y no en la
 * política, para no dejar una revisión cerrada al alcance de un UPDATE.
 */
async function ignorarDuplicados(entry: OutboxEntry): Promise<boolean> {
  if (IGNORE_DUPLICATES.has(entry.entity)) return true
  if (entry.entity !== 'inspection_check') return false

  const inspectionId = entry.payload['inspection_id'] as string | undefined
  if (!inspectionId) return false

  /*
   * La pregunta es si está cerrada ARRIBA, no aquí.
   *
   * El espejo local se cierra en el momento en que el técnico pulsa Guardar, y el
   * servidor no: la cola tarda lo que tarde. Preguntándoselo solo al espejo, las
   * comprobaciones que suben en esa ventana —justamente las que el técnico acaba
   * de cambiar— se mandaban con «no pises lo que ya está» y el servidor se quedaba
   * con el valor viejo. Sin un solo error: la cola vaciándose, la lámpara al día,
   * y el arreglo del técnico solo en su iPad.
   *
   * Le duele especialmente a una corrección, cuyas filas están arriba desde antes
   * de empezar a corregir: el «no pises» las dejaba tal cual y la corrección se
   * cerraba sin corregir nada.
   *
   * Mientras su revisión siga en la cola, el cierre no ha subido —`pushEntry` lo
   * retiene a propósito hasta que sus comprobaciones estén dentro—, así que arriba
   * sigue siendo un borrador y pisar es lo correcto y está permitido.
   */
  if (await db.outbox.get(inspectionId)) return false

  return (await db.inspections.get(inspectionId))?.status === 'completa'
}

/**
 * ¿Le queda a esta revisión alguna comprobación por subir?
 *
 * Las rechazadas no cuentan: no van a moverse solas, y esperarlas dejaría la
 * revisión sin cerrar para siempre.
 */
async function checksPendientes(inspectionId: string): Promise<number> {
  return await db.outbox
    .where('entity')
    .equals('inspection_check')
    .filter(
      (e) => e.payload['inspection_id'] === inspectionId && e.status !== 'rechazado',
    )
    .count()
}

/**
 * Un 23503 no es «este contenido está mal»: es «esto ha llegado antes que su
 * padre».
 *
 * El caso real, y el que explica incidencias que no aparecen nunca en su pestaña:
 * revisión hecha sin cobertura, el técnico sale del edificio y arranca la subida;
 * el POST de la revisión se corta a mitad —wifi que se cae, 502 de Kong, iOS
 * congelando la petición— y vuelve a la cola con su espera, que es lo correcto.
 * Pero la pasada continúa, y sus nueve comprobaciones y su incidencia chocan
 * contra la clave ajena de una revisión que todavía no está arriba. PostgREST
 * devuelve el 23503 como 4xx, y un 4xx se marca rechazado para siempre: la
 * revisión sube sola un minuto después y sus hijos ya no, porque `flush()` solo
 * recoge lo pendiente. En el servidor queda una revisión cerrada y vacía, y en la
 * pestaña de Incidencias no aparece la avería. Con la incidencia rechazada
 * viviendo en el espejo, además, las rondas siguientes tampoco la vuelven a
 * abrir: para el iPad ya está reportada.
 *
 * Así que se trata como temporal, como el 408 y el 429: vuelve a la cola con
 * espera y entra sola en la pasada siguiente, cuando el padre ya está.
 */
function faltaSuPadre(fallo: FalloDeRed): boolean {
  return /violates foreign key constraint/i.test(fallo.message)
}

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
    if (!error) return null

    // El código puede venir en la respuesta (PostgREST) o dentro del propio
    // error (el cliente de Storage lo trae como `status` o `statusCode`). Sin
    // esto, un rechazo real del almacén de fotos llegaba sin código y se leía
    // como temporal para siempre.
    const e = error as { message: string; status?: number; statusCode?: number | string }
    const codigo =
      status ??
      (typeof e.status === 'number' ? e.status : undefined) ??
      (e.statusCode !== undefined ? Number(e.statusCode) || undefined : undefined)

    return { message: error.message, status: codigo }
  } catch (err) {
    // Sin respuesta no hay código: se trata como temporal, que es lo que es.
    return { message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Una revisión que ya está cerrada arriba no es un fallo.
 *
 * Es el gemelo de `yaEstabaSubida()` para las fotos, y por el mismo motivo: el
 * reintento de algo que quizá llegó no puede leerse como un error de permisos.
 *
 * El cierre de una revisión es un UPDATE de verdad —la fila pasa de `borrador` a
 * `completa`— y el servidor solo lo permite mientras siga siendo borrador, que es
 * lo que hace que un registro cerrado no se pueda reescribir. Las dos cosas son
 * correctas y chocan en un sitio: cuando la respuesta del cierre se pierde por el
 * camino, el reintento llega a una fila que ya está cerrada y vuelve un 42501. Un
 * 4xx es permanente, así que esa entrada se quedaba rechazada para siempre
 * enseñando «sin enviar» por una revisión que sí estaba guardada.
 *
 * Aquí se pregunta lo único que resuelve la duda: ¿está cerrada en el servidor?
 * Si lo está, el trabajo llegó y la entrada se puede tirar. Y se pregunta solo en
 * este caso —una revisión que se subía como `completa` y volvió rechazada—, así
 * que no añade una consulta al camino normal.
 *
 * La alternativa era ampliar la política para que el autor pudiera reenviar su
 * revisión cerrada. Se probó y se descartó: dejaba la fila cerrada al alcance de
 * un UPDATE del técnico y la inmutabilidad pasaba a depender solo del trigger.
 * Son dos capas a propósito, y la prueba 3 de `rls-test.sql` está ahí para que
 * quitar una se note.
 */
async function yaEstabaCerrada(entry: OutboxEntry): Promise<boolean> {
  if (entry.entity !== 'inspection') return false
  if (entry.payload['status'] !== 'completa') return false

  const { data } = await supabase
    .from('inspections')
    .select('status')
    .eq('id', entry.id)
    .maybeSingle()

  return data?.['status'] === 'completa'
}

/**
 * Deja la entrada como toque, **solo si sigue siendo la que se envió**.
 *
 * Mientras una entrada está en vuelo, el técnico puede volver a tocar esa misma
 * fila: `enqueue()` la reescribe con el contenido nuevo y la devuelve a
 * «pendiente». Si al terminar la subida se borra por id a secas, ese toque
 * desaparece con ella —se subió el contenido viejo y el nuevo se tira—. Es una
 * ventana estrecha y real: la corrección la abre de par en par, porque nace
 * subiendo y el técnico ya está tocando.
 */
async function cerrarEntrada(
  id: string,
  cambios: Partial<OutboxEntry> | null,
): Promise<void> {
  const enVuelo = db.outbox.where('id').equals(id).and((e) => e.status === 'enviando')
  if (cambios === null) await enVuelo.delete()
  else await enVuelo.modify(cambios)
}

/**
 * Un cambio sobre una fila que ya está arriba: cerrar o empezar una incidencia.
 *
 * Es la única entrada de la cola que no es un alta, y por eso va por su cuenta.
 * Tres cosas la separan del camino normal:
 *
 *  - Es un `update` y no un `upsert`. Un upsert de `incident` no haría nada:
 *    viaja en `IGNORE_DUPLICATES` —lo que evita que un reenvío del alta choque
 *    contra el permiso de supervisor— así que el servidor lo ignoraría por estar
 *    la fila ya puesta, sin error y sin efecto. Exactamente el fallo que este
 *    fichero lleva media docena de comentarios intentando no repetir.
 *  - Se pide la fila de vuelta, y **cero filas es un fallo**. Un UPDATE que no
 *    alcanza ninguna fila no es un error para PostgREST: contesta 204 con
 *    `error` a null. Y a un técnico no le alcanza ninguna —cerrar incidencias es
 *    de supervisor—, así que sin esto la cola daría por subido un cierre que el
 *    servidor rechazó, y la incidencia seguiría abierta sin que nada lo dijera.
 *  - Y ese fallo es permanente a propósito: no se arregla reintentando. Sale en
 *    la pantalla de pendientes con su motivo, que es donde se puede leer.
 */
async function pushUpdate(entry: OutboxEntry): Promise<boolean> {
  const fila = entry.targetId ?? entry.id

  /*
   * Nunca antes que el alta de su propia fila.
   *
   * Pasa con la incidencia que se abre y se cierra en la misma sala sin
   * cobertura: si el alta se queda esperando —un corte a mitad de subida— el
   * cierre llegaría a una fila que todavía no existe, no alcanzaría ninguna y se
   * marcaría rechazado para siempre por «hace falta ser supervisor», que además
   * es mentira. En la pasada normal el alta va delante (misma familia, más
   * antigua), así que esto solo actúa cuando algo ha ido mal; el alta rechazada
   * sí lo deja pasar, porque si no el cierre esperaría eternamente a algo que no
   * se va a mover solo.
   */
  const alta = await db.outbox.get(fila)
  if (alta && alta.status !== 'rechazado') {
    await cerrarEntrada(entry.id, {
      status: 'pendiente',
      nextAttemptAt: 0,
      lastError: null,
    })
    return false
  }

  let alcanzadas = 0

  const fallo = await intentar(async () => {
    const res = await supabase
      .from(TABLE[entry.entity])
      .update(entry.payload)
      .eq('id', fila)
      .select('id')
    alcanzadas = res.data?.length ?? 0
    return res
  })

  if (!fallo && alcanzadas === 0) {
    await cerrarEntrada(entry.id, {
      status: 'rechazado',
      attempts: entry.attempts + 1,
      lastError:
        'El servidor no ha aplicado el cambio: cerrar y empezar incidencias es cosa de un supervisor.',
    })
    return false
  }

  if (!fallo) {
    await cerrarEntrada(entry.id, null)
    return true
  }

  const attempts = entry.attempts + 1
  if (isPermanentFailure(fallo.status)) {
    await cerrarEntrada(entry.id, {
      status: 'rechazado',
      attempts,
      lastError: `${fallo.status}: ${fallo.message}`,
    })
    return false
  }

  await cerrarEntrada(entry.id, {
    status: 'pendiente',
    attempts,
    nextAttemptAt: Date.now() + backoffMs(attempts),
    lastError: fallo.message,
  })
  return false
}

/** @returns si la entrada llegó a subir. */
async function pushEntry(entry: OutboxEntry): Promise<boolean> {
  await db.outbox.update(entry.id, { status: 'enviando' })

  if (entry.op === 'update') return pushUpdate(entry)

  /*
   * El cierre de una revisión es lo ÚLTIMO que sube de ella.
   *
   * El servidor solo acepta cambiar las comprobaciones mientras la revisión sea un
   * borrador —y hace bien: un registro cerrado no se reescribe—, así que si el
   * cierre se adelanta a sus filas, las que lleguen después se quedan fuera en
   * silencio. Pero la fila de la revisión tampoco puede esperar del todo: sus
   * comprobaciones cuelgan de ella por clave ajena y sin la fila no entran.
   *
   * Así que sube, y sube **como borrador**: crea o mantiene la fila —que es lo
   * único que hace falta para que sus comprobaciones puedan entrar—, y el paso a
   * `completa` se queda para la pasada siguiente, cuando ya no le quede nada
   * dentro. Una vuelta más de la cola, y el parte llega entero.
   */
  const esCierre = entry.entity === 'inspection' && entry.payload['status'] === 'completa'
  const esperandoSusChecks = esCierre && (await checksPendientes(entry.id)) > 0
  const payload = esperandoSusChecks
    ? { ...entry.payload, status: 'borrador', overall: null }
    : entry.payload

  const ignorar = await ignorarDuplicados(entry)
  const fallo = await intentar(() =>
    supabase.from(TABLE[entry.entity]).upsert(payload, {
      onConflict: 'id',
      ignoreDuplicates: ignorar,
    }),
  )

  if (!fallo) {
    if (esperandoSusChecks) {
      // La fila ya está arriba; lo que queda por mandar es el cierre. Sin espera:
      // en cuanto sus comprobaciones estén dentro, la pasada siguiente lo cierra.
      await cerrarEntrada(entry.id, { status: 'pendiente', nextAttemptAt: 0, lastError: null })
      return false
    }
    await cerrarEntrada(entry.id, null)
    return true
  }

  const attempts = entry.attempts + 1
  if (isPermanentFailure(fallo.status) && !faltaSuPadre(fallo)) {
    // Antes de darla por rechazada: puede que lo que se estaba subiendo ya
    // estuviera arriba y el «permiso denegado» sea de la fila que lo demuestra.
    if (await yaEstabaCerrada(entry)) {
      await cerrarEntrada(entry.id, null)
      return true
    }
    await cerrarEntrada(entry.id, {
      status: 'rechazado',
      attempts,
      lastError: `${fallo.status}: ${fallo.message}`,
    })
    return false
  }

  await cerrarEntrada(entry.id, {
    status: 'pendiente',
    attempts,
    nextAttemptAt: Date.now() + backoffMs(attempts),
    lastError: fallo.message,
  })
  return false
}

/**
 * Un objeto que ya está en el almacén no es un fallo.
 *
 * El bucket `fotos` tiene política de INSERT y de SELECT, y **ninguna de
 * UPDATE**, a propósito: una foto subida no se reescribe. Pero la subida iba
 * con `upsert: true`, que sobre un objeto existente pide justamente UPDATE. O
 * sea que el primer intento entraba y el segundo —el reintento de una respuesta
 * que se perdió— chocaba contra una política que no existe y se rechazaba para
 * siempre.
 *
 * Ahora se sube sin `upsert` y el «ya existe» se lee como lo que es: la foto
 * está arriba. El nombre del objeto sale del id de la foto, que se genera al
 * capturarla, así que el que ya está y el que se iba a subir son el mismo.
 */
function yaEstabaSubida(fallo: FalloDeRed): boolean {
  return fallo.status === 409 || /already exists|duplicate|resource already/i.test(fallo.message)
}

/** @returns si la foto llegó a subir y a enlazarse. */
async function pushPhoto(photo: QueuedPhoto): Promise<boolean> {
  /*
   * Una foto solo se rechaza por un motivo PERMANENTE, nunca por cansancio.
   *
   * Antes se rechazaba sola al noveno intento, fuera cual fuera el fallo. Y ocho
   * intentos se gastan en nada con una wifi que va y viene: la foto quedaba en
   * rojo pidiendo un «Reintentar» manual por un problema que era de cobertura,
   * no de la foto. Eso es exactamente «se acumula hasta que alguien sincroniza
   * a mano», que es lo que la cola existe para que no pase. Un fallo temporal
   * reintenta para siempre con su espera —el backoff ya tiene techo—; el que no
   * va a arreglarse solo (un rechazo 4xx de verdad, unos bytes que ya no están)
   * se marca a la primera, que es cuando se sabe.
   */
  const fallar = async (mensaje: string, permanente = false): Promise<false> => {
    const attempts = photo.attempts + 1
    await db.photos.update(photo.id, {
      status: permanente ? 'rechazado' : 'pendiente',
      attempts,
      nextAttemptAt: Date.now() + backoffMs(attempts),
      lastError: mensaje,
    })
    return false
  }

  await db.photos.update(photo.id, { status: 'subiendo' })

  // Los bytes viven aparte y se leen como un Blob nuevo, hecho en memoria: el
  // que sale de IndexedDB es el que WebKit no sabe manejar.
  const bytes = await leerBytesDeFoto(photo.id)
  if (!bytes) {
    await db.photos.update(photo.id, {
      status: 'rechazado',
      lastError: 'No están los datos de esta foto en el dispositivo. Hay que repetirla.',
    })
    return false
  }

  const path = `${photo.entityType}/${photo.entityId}/${photo.id}.jpg`
  const subida = await intentar(() =>
    supabase.storage.from('fotos').upload(path, bytes, { contentType: 'image/jpeg' }),
  )

  if (subida && !yaEstabaSubida(subida)) {
    return fallar(subida.message, isPermanentFailure(subida.status))
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
      // `attachments` solo tiene política de INSERT: un reenvío que se
      // convirtiera en UPDATE se rechazaría por permisos aunque la fila ya
      // estuviera puesta, que es exactamente lo que pasaba.
      { onConflict: 'id', ignoreDuplicates: true },
    )
  })

  if (enlace) return fallar(enlace.message, isPermanentFailure(enlace.status))

  await borrarFotoDeLaCola(photo.id)
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
  const cambios = { status: 'pendiente' as const, nextAttemptAt: 0, lastError: motivo }

  /*
   * Cada tabla por su lado, y con su propio `try`.
   *
   * Iban en un `Promise.all` y compartían suerte: cuando el rescate de fotos
   * reventaba —y reventaba, porque `modify()` reescribía el Blob y WebKit no
   * sabe volver a guardarlo— se llevaba por delante el de la cola Y la pasada
   * entera, que ni siquiera llegaba a intentar subir nada. Un rescate que
   * falla tiene que dejar las cosas como estaban, no peor.
   */
  let recuperados = 0
  for (const rescatar of [
    () => db.outbox.where('status').equals('enviando').modify(cambios),
    () => db.photos.where('status').equals('subiendo').modify(cambios),
  ]) {
    try {
      recuperados += await rescatar()
    } catch (err) {
      console.warn('recuperarEnVuelo', err)
    }
  }
  return recuperados
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
  /*
   * El parte final no puede ser lo que haga fallar a `flush()`.
   *
   * Va fuera del `try`, y a `flush()` la llaman doce sitios con `void` y sin
   * `.catch()`. Si el resumen reventara —lee la base local, que es justo lo que
   * falla en los dispositivos con problemas— `flush()` rechazaría y eso sería un
   * unhandled rejection en cada uno de esos doce sitios, por un número que solo
   * sirve para enseñarlo.
   */
  const parte = async (subidos: number): Promise<ResultadoFlush> => {
    try {
      const resumen = await pendingSummary()
      return { subidos, pendientes: resumen.total, rechazados: resumen.rejected }
    } catch {
      return { subidos, pendientes: 0, rechazados: 0 }
    }
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

    // Los bytes de las fotos de versiones anteriores, a su tabla. Es idempotente
    // y con la cola limpia no hace nada, así que puede ir en cada pasada.
    await migrarFotosASusBytes()

    // Y rescatar lo que se quedó a medias en una pasada anterior.
    await recuperarEnVuelo()

    /*
     * La cola se vacía en PASADAS ENCADENADAS, no en una sola.
     *
     * Una pasada puede DEJAR trabajo listo para ya: el cierre de una revisión
     * espera a que suban sus comprobaciones —y quedaba para «la pasada
     * siguiente», o sea hasta un minuto de espera con la red perfectamente
     * bien—, y lo que el técnico encola mientras la subida está en vuelo nace
     * con su turno cumplido. Antes, todo eso se acumulaba hasta el siguiente
     * disparador aunque hubiera cobertura de sobra. Ahora la pasada se repite
     * mientras quede algo listo, con un techo por si el trabajo no deja de
     * entrar — lo que quede lo recoge el temporizador, como siempre.
     *
     * `forzar` solo vale para la primera vuelta: es la orden de «inténtalo ya»
     * sobre lo que estaba en su espera. Lo que falle dentro de ESTA llamada
     * vuelve a su backoff y no se martillea en la vuelta siguiente.
     */
    const MAX_PASADAS = 5
    for (let pasada = 0; pasada < MAX_PASADAS; pasada++) {
      const now = Date.now()
      const toca = (nextAttemptAt: number): boolean =>
        (pasada === 0 && (opciones.forzar ?? false)) || nextAttemptAt <= now

      const due = (await db.outbox.toArray())
        .filter((e) => e.status === 'pendiente' && toca(e.nextAttemptAt))
        .sort((a, b) => ORDER[a.entity] - ORDER[b.entity] || a.createdAt - b.createdAt)

      const duePhotos = (await db.photos.toArray()).filter(
        (p) => p.status === 'pendiente' && toca(p.nextAttemptAt),
      )

      if (due.length === 0 && duePhotos.length === 0) break

      /*
       * Cada entrada con su fallo acotado, igual que las fotos.
       *
       * Solo estaban protegidos los errores que devuelve el servidor; un fallo de
       * la propia base local —la escritura de estado, un `DatabaseClosedError`,
       * la cuota llena— seguía subiendo hasta el `catch` de abajo y abandonaba
       * todo lo que viniera detrás en la cola. Una entrada mala no puede decidir
       * por las otras diecinueve.
       */
      for (const entry of due) {
        try {
          if (await pushEntry(entry)) subidos += 1
        } catch (err) {
          console.error('pushEntry', entry.entity, err)
        }
      }

      /*
       * Las fotos, DESPUÉS de la cola y con su fallo acotado.
       *
       * Una foto que reviente no puede volver a llevarse por delante el trabajo
       * de campo: los partes de revisión son el registro, la foto es la prueba
       * que lo acompaña. Si hay que perder algo en una pasada, se pierde la
       * segunda, y solo esa.
       */
      for (const photo of duePhotos) {
        try {
          if (await pushPhoto(photo)) subidos += 1
        } catch (err) {
          console.error('pushPhoto', err)
        }
      }
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
    /*
     * Recuperar la red se lleva el backoff por delante, igual que el botón.
     *
     * Las esperas se acumularon SIN cobertura: tres fallos seguidos en un
     * sótano ponen la siguiente ventana a minutos vista, y sin el forzado, al
     * salir a la calle la cola seguía sentada esperando su turno — con la red
     * ya perfecta y el técnico mirando el chip de pendientes. El evento
     * `online` es exactamente la señal de que aquellas esperas ya no hablan
     * del mundo real.
     */
    void flush({ forzar: true })
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
