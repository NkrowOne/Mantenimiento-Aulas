import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, leerBytesDeFoto, migrarFotosASusBytes } from '@/db/dexie'

/**
 * El traslado de los bytes de las fotos a su propia tabla.
 *
 * Es el camino de vuelta de los dispositivos que ya están atascados, así que
 * tiene que funcionar sobre lo que tengan guardado, y tiene que sobrevivir a
 * que una de las fotos sea justamente la que WebKit ya no sabe leer.
 *
 * El fallo que lo motivó: Dexie implementa `update()` y `modify()` como leer la
 * fila, cambiarla y reescribirla ENTERA. Con el Blob dentro, cada cambio de
 * estado obligaba a reescribir el Blob, y WebKit contesta `UnknownError: Error
 * preparing Blob/File data to be stored in object store` al reescribir uno que
 * salió de IndexedDB. Eso reventaba la sincronización completa.
 */

/** Una foto como las guardaba la versión anterior: con los bytes en la fila. */
async function comoAntes(id: string, contenido: string): Promise<void> {
  await db.photos.put({
    id,
    entityType: 'inspection',
    entityId: 'insp-1',
    blob: new Blob([contenido], { type: 'image/jpeg' }),
    takenAt: '2026-07-30T09:00:00.000Z',
    attempts: 0,
    nextAttemptAt: 0,
    status: 'pendiente',
    lastError: null,
  })
}

beforeEach(async () => {
  await db.photos.clear()
  await db.photoBlobs.clear()
})

describe('migrarFotosASusBytes', () => {
  it('saca los bytes de la fila y los deja legibles', async () => {
    await comoAntes('f1', 'los-bytes')

    expect(await migrarFotosASusBytes()).toEqual({ movidas: 1, ilegibles: 0 })

    // La fila de estado se queda sin bytes: a partir de aquí cambiarla es
    // escribir cuatro campos de texto, y no hay Blob que WebKit pueda rechazar.
    expect((await db.photos.get('f1'))?.blob).toBeUndefined()
    expect(await (await leerBytesDeFoto('f1'))?.text()).toBe('los-bytes')
  })

  it('la foto ilegible se marca y no bloquea a las demás', async () => {
    // Los ids fijan el orden en que las lee Dexie: primero la buena.
    await comoAntes('a-buena', 'intacta')
    await comoAntes('b-rota', 'perdida')

    /*
     * Así falla de verdad en un iPad: el Blob está guardado y `arrayBuffer()`
     * revienta al leerlo porque iOS ya se llevó el fichero que lo respaldaba.
     */
    const real = Blob.prototype.arrayBuffer
    vi.spyOn(Blob.prototype, 'arrayBuffer')
      .mockImplementationOnce(function (this: Blob) {
        return real.call(this)
      })
      .mockImplementationOnce(() => Promise.reject(new Error('Blob detached')))

    expect(await migrarFotosASusBytes()).toEqual({ movidas: 1, ilegibles: 1 })
    vi.restoreAllMocks()

    // La que sí se podía leer pasa igual: es la diferencia entre salvar lo que
    // hay y no salvar nada.
    expect(await (await leerBytesDeFoto('a-buena'))?.text()).toBe('intacta')

    // Y la rota lo dice, en un estado visible y con botón de reintentar, en vez
    // de quedarse reintentándose en silencio para siempre.
    const rota = await db.photos.get('b-rota')
    expect(rota?.status).toBe('rechazado')
    expect(rota?.lastError).toMatch(/repetirla/)
    expect(rota?.blob).toBeUndefined()
  })

  it('es idempotente: pasarla otra vez no hace nada', async () => {
    await comoAntes('f1', 'x')
    await migrarFotosASusBytes()

    expect(await migrarFotosASusBytes()).toEqual({ movidas: 0, ilegibles: 0 })
    expect(await (await leerBytesDeFoto('f1'))?.text()).toBe('x')
  })
})
