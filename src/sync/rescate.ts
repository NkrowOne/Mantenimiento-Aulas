/**
 * La salida de emergencia de la cola.
 *
 * La regla de oro del proyecto es que nada pendiente viva solo en el móvil, y
 * la cola de salida existe para cumplirla. Pero mientras la cola no sube, esa
 * regla está rota y nadie lo dice: veinte revisiones hechas a mano, en aulas a
 * las que hay que volver a subir, existen en un único IndexedDB de un único
 * iPad. Si ese iPad se pierde, se rompe, o iOS decide desalojar el
 * almacenamiento del sitio —siete días sin abrirlo bastan cuando la aplicación
 * no está instalada en la pantalla de inicio—, ese trabajo no está en ninguna
 * otra parte del mundo.
 *
 * Esto no arregla la subida. Hace algo más básico y más importante: permite
 * sacar el trabajo del dispositivo **ahora**, sin servidor, sin permisos y sin
 * red, a un fichero que se manda por AirDrop, correo o lo que haya. Y permite
 * volver a meterlo por otro lado.
 *
 * Por eso la copia lleva los datos y no una referencia a ellos: las fotos van
 * dentro, en base64. Una copia que apunte a algo que sigue en el dispositivo
 * que se ha perdido no es una copia.
 */

import {
  db,
  guardarBytesDeFoto,
  leerBytesDeFoto,
  migrarFotosASusBytes,
  type OutboxEntry,
  type QueuedPhoto,
} from '@/db/dexie'

export const FORMATO = 'aulas-pendientes'
export const VERSION = 1

export interface CopiaFoto {
  id: string
  entityType: QueuedPhoto['entityType']
  entityId: string
  takenAt: string
  /** El JPEG entero, en base64. La foto es la prueba: sin ella sobra la copia. */
  datos: string
}

export interface Copia {
  formato: string
  version: number
  creado: string
  /** Para saber de qué iPad salió cuando lleguen tres copias por correo. */
  dispositivo: string
  entradas: OutboxEntry[]
  fotos: CopiaFoto[]
}

// -----------------------------------------------------------------------------
// El formato, aparte de la base de datos: se puede probar sin abrir ninguna.
// -----------------------------------------------------------------------------

export function construirCopia(
  entradas: OutboxEntry[],
  fotos: CopiaFoto[],
  dispositivo: string,
  creado: string,
): Copia {
  return { formato: FORMATO, version: VERSION, creado, dispositivo, entradas, fotos }
}

export type Lectura = { ok: true; copia: Copia } | { ok: false; error: string }

/**
 * Lee una copia y se niega a adivinar.
 *
 * Quien importa está recuperando trabajo que no puede repetir, así que un
 * fichero equivocado tiene que decir que lo es. Aceptar un JSON cualquiera y
 * escribir lo que se pueda dejaría una cola a medias, y peor: parecería que ha
 * funcionado.
 */
export function leerCopia(texto: string): Lectura {
  let crudo: unknown
  try {
    crudo = JSON.parse(texto)
  } catch {
    return { ok: false, error: 'El fichero no es una copia válida: no se puede leer.' }
  }

  const c = crudo as Partial<Copia>
  if (c?.formato !== FORMATO) {
    return { ok: false, error: 'Ese fichero no es una copia de pendientes de Aulas.' }
  }
  if (typeof c.version !== 'number' || c.version > VERSION) {
    return {
      ok: false,
      error: `La copia es de una versión más nueva (${String(c.version)}). Actualiza la aplicación.`,
    }
  }
  if (!Array.isArray(c.entradas) || !Array.isArray(c.fotos)) {
    return { ok: false, error: 'La copia está incompleta: le faltan las entradas o las fotos.' }
  }

  return {
    ok: true,
    copia: {
      formato: c.formato,
      version: c.version,
      creado: typeof c.creado === 'string' ? c.creado : '',
      dispositivo: typeof c.dispositivo === 'string' ? c.dispositivo : '',
      entradas: c.entradas,
      fotos: c.fotos,
    },
  }
}

/** Cuántas cosas trae una copia, para poder decirlo antes y después. */
export function cuantoTrae(copia: Copia): { entradas: number; fotos: number } {
  return { entradas: copia.entradas.length, fotos: copia.fotos.length }
}

// -----------------------------------------------------------------------------
// Base64: las fotos viajan dentro del fichero
// -----------------------------------------------------------------------------

/** En bloques, porque `String.fromCharCode(...bytes)` revienta la pila con un JPEG. */
async function aBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const trozos: string[] = []
  for (let i = 0; i < bytes.length; i += 8192) {
    trozos.push(String.fromCharCode(...bytes.subarray(i, i + 8192)))
  }
  return btoa(trozos.join(''))
}

function deBase64(datos: string): Blob {
  const bin = atob(datos)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: 'image/jpeg' })
}

// -----------------------------------------------------------------------------
// Sacar y meter
// -----------------------------------------------------------------------------

export interface Exportacion {
  nombre: string
  blob: Blob
  entradas: number
  fotos: number
  /** Estaban en cola pero sus bytes ya no se pueden leer en este dispositivo. */
  fotosIlegibles: number
}

/**
 * Todo lo que no ha llegado al servidor, en un fichero.
 *
 * Se lleva la cola **entera**, no solo lo que está esperando turno: lo
 * rechazado es justamente lo que más falta hace poner a salvo, porque es lo que
 * el servidor no quiere y por tanto lo que más tiempo va a pasar aquí dentro.
 */
export async function exportarPendientes(ahora: number = Date.now()): Promise<Exportacion> {
  // Los bytes de versiones anteriores, a su tabla, antes de leerlos: si no, las
  // fotos viejas saldrían de la copia justo cuando más falta hace tenerlas.
  await migrarFotosASusBytes()

  const entradas = await db.outbox.toArray()
  const enCola = await db.photos.toArray()

  const fotos: CopiaFoto[] = []
  for (const f of enCola) {
    /*
     * Una foto sin bytes no tumba la copia.
     *
     * Es la diferencia entre salvar 19 cosas y salvar ninguna, y la copia se
     * hace precisamente cuando algo va mal. Lo que falte se dice al final, con
     * su nombre, en vez de perderse en silencio.
     */
    const bytes = await leerBytesDeFoto(f.id)
    if (!bytes) continue

    fotos.push({
      id: f.id,
      entityType: f.entityType,
      entityId: f.entityId,
      takenAt: f.takenAt,
      datos: await aBase64(bytes),
    })
  }

  const fecha = new Date(ahora)
  const copia = construirCopia(
    entradas,
    fotos,
    typeof navigator === 'undefined' ? '' : navigator.userAgent,
    fecha.toISOString(),
  )

  // El nombre lleva la fecha y la hora porque van a llegar varias, de varios
  // iPads, y «pendientes.json» tres veces en la misma carpeta es una copia.
  const sello = fecha.toISOString().slice(0, 16).replace('T', '_').replace(':', '')
  return {
    nombre: `pendientes-aulas-${sello}.json`,
    blob: new Blob([JSON.stringify(copia)], { type: 'application/json' }),
    entradas: entradas.length,
    fotos: fotos.length,
    // Las que estaban en cola pero cuyos bytes ya no se pueden leer. Se cuentan
    // para poder decirlo: dar por salvado lo que no lo está es peor que no
    // tener copia.
    fotosIlegibles: enCola.length - fotos.length,
  }
}

export interface Importacion {
  entradas: number
  fotos: number
}

/**
 * Devuelve una copia a la cola de salida.
 *
 * Todo entra como «pendiente» y con los intentos a cero: la copia puede venir
 * de un dispositivo donde algo llevaba ocho fallos encima, y esa cuenta es del
 * viaje anterior, no de este.
 *
 * Reimportar lo que ya subió no duplica nada —el id es la clave de idempotencia
 * del upsert, y por eso mismo tampoco pasa nada por importar dos veces la misma
 * copia—, así que ante la duda se importa.
 */
export async function importarPendientes(copia: Copia): Promise<Importacion> {
  const entradas: OutboxEntry[] = copia.entradas.map((e) => ({
    ...e,
    status: 'pendiente',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
  }))

  const fotos: QueuedPhoto[] = copia.fotos.map((f) => ({
    id: f.id,
    entityType: f.entityType,
    entityId: f.entityId,
    takenAt: f.takenAt,
    attempts: 0,
    nextAttemptAt: 0,
    status: 'pendiente',
    lastError: null,
  }))

  if (entradas.length > 0) await db.outbox.bulkPut(entradas)

  // Los bytes antes que las filas de estado, por lo mismo que al capturar: una
  // fila en cola apuntando a unos bytes que no están es una foto perdida.
  for (const f of copia.fotos) await guardarBytesDeFoto(f.id, deBase64(f.datos))
  if (fotos.length > 0) await db.photos.bulkPut(fotos)

  return { entradas: entradas.length, fotos: fotos.length }
}

/**
 * Ofrece el fichero al usuario por el mejor camino que tenga el dispositivo.
 *
 * En iOS —que es donde ocurre esto— un `<a download>` no siempre guarda nada:
 * según la versión abre el JSON en una pestaña y el técnico se queda mirando
 * texto. La hoja de compartir sí funciona y además es la que lleva a AirDrop y
 * a Correo, que es exactamente lo que hay que hacer con esta copia. Se intenta
 * primero, y el `<a download>` queda de red para el escritorio.
 */
export async function ofrecerFichero(nombre: string, blob: Blob): Promise<'compartido' | 'descargado'> {
  const fichero = new File([blob], nombre, { type: blob.type })

  if (navigator.canShare?.({ files: [fichero] })) {
    try {
      await navigator.share({ files: [fichero], title: nombre })
      return 'compartido'
    } catch (err) {
      // Cancelar la hoja de compartir no es un fallo, pero tampoco ha guardado
      // nada: se cae a la descarga para que siempre quede una copia.
      if ((err as Error)?.name !== 'AbortError') console.warn('compartir', err)
    }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nombre
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Un objeto URL vivo retiene el Blob entero en memoria; con las fotos dentro
  // eso son megas. Se revoca en cuanto el navegador ha tenido su oportunidad.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return 'descargado'
}
