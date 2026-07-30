import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/dexie'
import {
  cuantoTrae,
  exportarPendientes,
  importarPendientes,
  leerCopia,
} from '@/sync/rescate'

/**
 * La salida de emergencia, probada por lo único que importa de ella: que el
 * trabajo salga entero y vuelva entero.
 *
 * Se escribió con veinte cambios atascados en los iPads de campo. Una copia que
 * pierda una foto por el camino, o que se importe a medias sin decirlo, es peor
 * que no tener copia: da por salvado lo que no lo está.
 */

const foto = (id: string, contenido: string) => ({
  id,
  entityType: 'inspection' as const,
  entityId: 'insp-1',
  blob: new Blob([contenido], { type: 'image/jpeg' }),
  takenAt: '2026-07-30T09:00:00.000Z',
  attempts: 3,
  nextAttemptAt: 9_999_999_999_999,
  status: 'pendiente' as const,
  lastError: 'sin cobertura',
})

const entrada = (id: string, over = {}) => ({
  id,
  entity: 'inspection' as const,
  op: 'upsert' as const,
  payload: { id, room_id: 'aula-3', notes: 'proyector con la lámpara fundida' },
  createdAt: 1,
  attempts: 5,
  nextAttemptAt: 9_999_999_999_999,
  status: 'pendiente' as const,
  lastError: 'Load failed',
  ...over,
})

beforeEach(async () => {
  await db.outbox.clear()
  await db.photos.clear()
})

describe('copia de rescate', () => {
  it('saca la cola entera y la devuelve intacta, fotos incluidas', async () => {
    await db.outbox.add(entrada('e1'))
    await db.photos.add(foto('f1', 'bytes-de-la-foto'))

    const copia = await exportarPendientes(Date.UTC(2026, 6, 30, 11, 48))
    expect(copia.entradas).toBe(1)
    expect(copia.fotos).toBe(1)
    expect(copia.nombre).toBe('pendientes-aulas-2026-07-30_1148.json')

    // El dispositivo se pierde: se vacía y se recupera desde el fichero.
    await db.outbox.clear()
    await db.photos.clear()

    const lectura = leerCopia(await copia.blob.text())
    expect(lectura.ok).toBe(true)
    if (!lectura.ok) return

    expect(cuantoTrae(lectura.copia)).toEqual({ entradas: 1, fotos: 1 })
    await importarPendientes(lectura.copia)

    const vuelta = await db.outbox.get('e1')
    expect(vuelta?.payload['notes']).toBe('proyector con la lámpara fundida')

    const fotoVuelta = await db.photos.get('f1')
    expect(await fotoVuelta?.blob.text()).toBe('bytes-de-la-foto')
  })

  it('lo importado entra listo para subir, sin arrastrar el backoff del viaje anterior', async () => {
    await db.outbox.add(entrada('e1'))
    await db.photos.add(foto('f1', 'x'))
    const copia = await exportarPendientes()
    await db.outbox.clear()
    await db.photos.clear()

    const lectura = leerCopia(await copia.blob.text())
    if (!lectura.ok) throw new Error('la copia debería leerse')
    await importarPendientes(lectura.copia)

    // Cinco intentos y una espera de años eran del dispositivo de origen.
    const e = await db.outbox.get('e1')
    expect(e?.status).toBe('pendiente')
    expect(e?.attempts).toBe(0)
    expect(e?.nextAttemptAt).toBe(0)

    const f = await db.photos.get('f1')
    expect(f?.attempts).toBe(0)
    expect(f?.nextAttemptAt).toBe(0)
  })

  it('se lleva también lo rechazado, que es lo que más falta hace salvar', async () => {
    await db.outbox.add(entrada('e1', { status: 'rechazado', lastError: '403: RLS' }))
    await db.outbox.add(entrada('e2', { status: 'enviando' }))

    const copia = await exportarPendientes()

    expect(copia.entradas).toBe(2)
  })

  it('importar dos veces la misma copia no duplica nada', async () => {
    await db.outbox.add(entrada('e1'))
    const copia = await exportarPendientes()
    const lectura = leerCopia(await copia.blob.text())
    if (!lectura.ok) throw new Error('la copia debería leerse')

    await importarPendientes(lectura.copia)
    await importarPendientes(lectura.copia)

    expect(await db.outbox.count()).toBe(1)
  })

  it('un fichero que no es una copia se rechaza en vez de importarse a medias', () => {
    expect(leerCopia('esto no es json')).toEqual({
      ok: false,
      error: 'El fichero no es una copia válida: no se puede leer.',
    })
    expect(leerCopia('{"formato":"otra-cosa"}')).toEqual({
      ok: false,
      error: 'Ese fichero no es una copia de pendientes de Aulas.',
    })

    const futura = leerCopia('{"formato":"aulas-pendientes","version":99,"entradas":[],"fotos":[]}')
    expect(futura.ok).toBe(false)

    const coja = leerCopia('{"formato":"aulas-pendientes","version":1,"entradas":[]}')
    expect(coja.ok).toBe(false)
  })
})
