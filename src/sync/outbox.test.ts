import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * El motor de subida, por el caso que lo dejó clavado.
 *
 * Un móvil se quedó con «3 pendientes» en la cabecera que no bajaban de tres:
 * el botón Sincronizar contestaba «Al día: 1466 filas del servidor» —la bajada
 * funcionaba— y la cola seguía intacta detrás, sin un solo error a la vista.
 *
 * Eran dos averías encadenadas, y las dos se prueban aquí:
 *
 *  1. Una subida cortada a mitad deja la entrada en «enviando». Como `flush()`
 *     solo recoge las «pendiente», ahí se quedaba para siempre; y como
 *     «enviando» no es «rechazado», ni salía en rojo ni ofrecía «Reintentar».
 *  2. El botón respetaba el backoff, así que con tres fallos encima no
 *     intentaba nada y aun así anunciaba que todo estaba al día.
 */

const upsert = vi.fn()
const uploadFoto = vi.fn()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({ upsert }),
    storage: { from: () => ({ upload: uploadFoto }) },
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: { id: 'u1' } } } }),
      getUser: () => Promise.resolve({ data: { user: { id: 'u1' } } }),
    },
  },
}))

const { db, guardarBytesDeFoto } = await import('@/db/dexie')
const { flush } = await import('@/sync/outbox')

/** El entorno de pruebas es Node: no hay `navigator.onLine` y sin él no sube nada. */
Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true })

function entrada(over: Partial<Awaited<ReturnType<typeof db.outbox.get>>> = {}) {
  return {
    id: crypto.randomUUID(),
    entity: 'incident' as const,
    op: 'upsert' as const,
    payload: { id: 'x' },
    createdAt: 1,
    attempts: 0,
    nextAttemptAt: 0,
    status: 'pendiente' as const,
    lastError: null,
    ...over,
  }
}

/** Una foto en cola: bytes en su tabla, fila de estado en la suya. */
async function encolarFoto(over: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID()
  await guardarBytesDeFoto(id, new Blob(['jpeg']))
  await db.photos.put({
    id,
    entityType: 'incident',
    entityId: 'i1',
    takenAt: new Date(0).toISOString(),
    attempts: 0,
    nextAttemptAt: 0,
    status: 'pendiente',
    lastError: null,
    ...over,
  })
  return id
}

beforeEach(async () => {
  await db.outbox.clear()
  await db.photos.clear()
  await db.photoBlobs.clear()
  await db.inspections.clear()
  upsert.mockReset().mockResolvedValue({ error: null, status: 201 })
  uploadFoto.mockReset().mockResolvedValue({ error: null })
})

describe('flush', () => {
  it('rescata lo que se quedó en «enviando» de una pasada muerta', async () => {
    // Lo que deja atrás una app cerrada de un barrido a mitad de subida.
    await db.outbox.add(entrada({ status: 'enviando' }))

    const parte = await flush()

    expect(upsert).toHaveBeenCalledTimes(1)
    expect(parte.subidos).toBe(1)
    expect(await db.outbox.count()).toBe(0)
  })

  it('rescata también las fotos colgadas en «subiendo»', async () => {
    const id = await encolarFoto({ status: 'subiendo' })

    const parte = await flush()

    expect(uploadFoto).toHaveBeenCalledTimes(1)
    expect(parte.subidos).toBe(1)
    expect(await db.photos.count()).toBe(0)
    // Y sus bytes se van con ella: la cola es un búfer, no un archivo.
    expect(await db.photoBlobs.get(id)).toBeUndefined()
  })

  it('un fallo de red que LANZA no deja la entrada en vuelo ni abandona la cola', async () => {
    // El cliente devuelve `{ error }` cuando el servidor contesta algo, pero
    // lanza cuando no hay respuesta. Esa excepción se llevaba por delante la
    // entrada en curso Y todo lo que venía detrás.
    upsert
      .mockRejectedValueOnce(new Error('Load failed'))
      .mockResolvedValue({ error: null, status: 201 })

    const rota = entrada({ createdAt: 1 })
    const buena = entrada({ createdAt: 2 })
    await db.outbox.bulkAdd([rota, buena])

    const parte = await flush()

    // La segunda se ha intentado igual: una no tumba a las demás.
    expect(parte.subidos).toBe(1)
    expect(await db.outbox.get(buena.id)).toBeUndefined()

    // Y la que falló vuelve a estar en cola, con su motivo y su espera.
    const quedo = await db.outbox.get(rota.id)
    expect(quedo?.status).toBe('pendiente')
    expect(quedo?.attempts).toBe(1)
    expect(quedo?.lastError).toBe('Load failed')
  })

  it('sin forzar respeta el backoff; forzando lo intenta ya', async () => {
    await db.outbox.add(entrada({ attempts: 3, nextAttemptAt: Date.now() + 300_000 }))

    const espera = await flush()
    expect(upsert).not.toHaveBeenCalled()
    expect(espera.pendientes).toBe(1)

    // Pulsar «Sincronizar» es la señal de que ahora sí hay cobertura.
    const forzado = await flush({ forzar: true })
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(forzado.subidos).toBe(1)
    expect(forzado.pendientes).toBe(0)
  })

  it('un 4xx se rechaza y no se reintenta solo; un 5xx vuelve a la cola', async () => {
    upsert.mockResolvedValue({ error: { message: 'violates row-level security' }, status: 403 })
    const mala = entrada()
    await db.outbox.add(mala)

    const parte = await flush()

    expect(parte.rechazados).toBe(1)
    expect((await db.outbox.get(mala.id))?.status).toBe('rechazado')

    // Y ni siquiera forzando: rechazado se sale de la cola a propósito, se
    // reintenta desde su botón, que además pone los intentos a cero.
    upsert.mockClear()
    await flush({ forzar: true })
    expect(upsert).not.toHaveBeenCalled()
  })

  /*
   * El modelo de escritura del servidor es de una sola vez, y la cola hacía
   * upsert siempre. El registro de la base traía 234 rechazos por esto en tres
   * horas y media de trabajo de campo.
   */
  describe('reenvíos sobre tablas que solo aceptan altas', () => {
    it('las comprobaciones de una revisión CERRADA se reenvían sin pisar', async () => {
      await db.inspections.put({ id: 'insp-1', status: 'completa' } as never)
      await db.outbox.add(
        entrada({ entity: 'inspection_check', payload: { id: 'c1', inspection_id: 'insp-1' } }),
      )

      await flush()

      expect(upsert).toHaveBeenCalledWith(expect.anything(), {
        onConflict: 'id',
        ignoreDuplicates: true,
      })
    })

    it('pero las de un BORRADOR sí pisan: el técnico aún las está cambiando', async () => {
      await db.inspections.put({ id: 'insp-1', status: 'borrador' } as never)
      await db.outbox.add(
        entrada({ entity: 'inspection_check', payload: { id: 'c1', inspection_id: 'insp-1' } }),
      )

      await flush()

      expect(upsert).toHaveBeenCalledWith(expect.anything(), {
        onConflict: 'id',
        ignoreDuplicates: false,
      })
    })

    it('una foto que ya estaba en el almacén cuenta como subida, no como error', async () => {
      // El bucket no tiene política de UPDATE a propósito, así que reintentar
      // una foto que ya llegó devolvía un 409 que se leía como rechazo.
      uploadFoto.mockResolvedValue({ error: { message: 'The resource already exists' } })
      await encolarFoto()

      const parte = await flush()

      expect(parte.subidos).toBe(1)
      expect(await db.photos.count()).toBe(0)
    })
  })

  it('una foto rota no impide que suba el trabajo de campo', async () => {
    // Los partes de revisión son el registro; la foto es la prueba que lo
    // acompaña. Si se cae algo en una pasada, se cae lo segundo y solo eso.
    uploadFoto.mockRejectedValue(new Error('Blob detached'))
    const buena = entrada()
    await db.outbox.add(buena)
    await encolarFoto()

    const parte = await flush()

    expect(parte.subidos).toBe(1)
    expect(await db.outbox.get(buena.id)).toBeUndefined()
  })

  it('una foto sin bytes se marca rechazada, en vez de reintentarse para siempre', async () => {
    // Pasa si iOS descartó el fichero de respaldo del Blob: los bytes no están
    // en ninguna parte y repetir la foto es la única salida.
    const id = crypto.randomUUID()
    await db.photos.put({
      id,
      entityType: 'incident',
      entityId: 'i1',
      takenAt: new Date(0).toISOString(),
      attempts: 0,
      nextAttemptAt: 0,
      status: 'pendiente',
      lastError: null,
    })

    await flush()

    const foto = await db.photos.get(id)
    expect(foto?.status).toBe('rechazado')
    expect(foto?.lastError).toMatch(/repetirla/)
    expect(uploadFoto).not.toHaveBeenCalled()
  })

  it('sube los tipos antes que los equipos que los usan', async () => {
    const vistos: string[] = []
    upsert.mockImplementation((payload: { id: string }) => {
      vistos.push(payload.id)
      return Promise.resolve({ error: null, status: 201 })
    })

    await db.outbox.bulkAdd([
      entrada({ entity: 'asset', payload: { id: 'equipo' }, createdAt: 1 }),
      entrada({ entity: 'asset_type', payload: { id: 'tipo' }, createdAt: 2 }),
    ])

    await flush()

    expect(vistos).toEqual(['tipo', 'equipo'])
  })
})
