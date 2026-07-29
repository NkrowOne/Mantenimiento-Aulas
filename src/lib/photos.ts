/**
 * Captura y compresión de fotos.
 *
 * El riesgo real en iOS no es la orientación EXIF —los navegadores ya la
 * respetan— sino **el límite de área de canvas de Safari**: una foto de 48 MP
 * falla en silencio y devuelve un lienzo negro. Por eso se usa una librería que
 * reescala por pasos en vez de una compresión artesanal.
 */

import { v7 as uuidv7 } from 'uuid'
import { db } from '@/db/dexie'

const MAX_DIMENSION = 1600
const TARGET_MB = 0.2

/**
 * `accept` deliberadamente sin `image/heic`: desde Safari 17, incluirlo hace que
 * iOS entregue el HEIC original en vez de convertir a JPEG.
 */
export const PHOTO_ACCEPT = 'image/jpeg,image/png'

/** Comprueba el tipo real por los primeros bytes, no por lo que diga el nombre. */
async function sniffType(file: Blob): Promise<'jpeg' | 'png' | 'heic' | 'desconocido'> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpeg'
  if (head[0] === 0x89 && head[1] === 0x50) return 'png'
  const brand = String.fromCharCode(...head.slice(8, 12))
  if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'heic'
  return 'desconocido'
}

export interface PhotoResult {
  ok: boolean
  id?: string
  error?: string
}

export async function capturePhoto(
  file: File,
  entityType: 'inspection' | 'incident',
  entityId: string,
): Promise<PhotoResult> {
  const kind = await sniffType(file)
  if (kind === 'heic') {
    return {
      ok: false,
      error: 'La foto llegó en formato HEIC. Cambia en Ajustes → Cámara → Formatos a "Más compatible".',
    }
  }

  let blob: Blob
  try {
    // Import dinámico: la librería de compresión pesa y solo hace falta la
    // primera vez que alguien fotografía una incidencia, no al arrancar.
    const { default: imageCompression } = await import('browser-image-compression')
    blob = await imageCompression(file, {
      maxSizeMB: TARGET_MB,
      maxWidthOrHeight: MAX_DIMENSION,
      useWebWorker: true,
      fileType: 'image/jpeg',
      initialQuality: 0.7,
    })
  } catch {
    return { ok: false, error: 'No se pudo procesar la foto. Inténtalo de nuevo.' }
  }

  if (blob.size === 0) {
    return { ok: false, error: 'La foto salió vacía. Repítela.' }
  }

  const id = uuidv7()
  const takenAt = new Date().toISOString()

  await db.photos.put({
    id,
    entityType,
    entityId,
    blob,
    takenAt,
    attempts: 0,
    nextAttemptAt: 0,
    status: 'pendiente',
    lastError: null,
  })

  /*
   * Y se apunta el adjunto en local, no solo la foto en cola.
   *
   * La cola es un búfer: `pushPhoto` borra la entrada en cuanto la sube. Si la
   * interfaz contara fotos desde ahí, el número caería a cero al sincronizar y
   * volvería a aparecer «Añade una foto de la incidencia» sobre una revisión que
   * sí la tiene. Con la fila de adjunto, el recuento sobrevive a la subida, a
   * salir de la sala y a recargar la aplicación.
   */
  await db.attachments.put({
    id,
    entity_type: entityType,
    entity_id: entityId,
    storage_path: `${entityType}/${entityId}/${id}.jpg`,
    taken_at: takenAt,
    by_user: null,
  })

  return { ok: true, id }
}
