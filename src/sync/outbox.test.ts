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
/** Lo que contesta el servidor cuando se le pregunta cómo está una fila. */
const maybeSingle = vi.fn()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({ upsert, select: () => ({ eq: () => ({ maybeSingle }) }) }),
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
  maybeSingle.mockReset().mockResolvedValue({ data: null })
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

    /*
     * Y la fila de la revisión SÍ pisa, cerrada o no, porque su segundo envío no
     * es un reintento: es el cierre.
     *
     * La cola sube la revisión dos veces —borrador mientras se rellena, completa
     * al terminar—. Ignorando duplicados, ese segundo envío se convierte en un
     * «no hagas nada» sobre la fila que ya está y la revisión se queda en
     * borrador en el servidor para siempre: invisible en el histórico de la sala,
     * en la fiabilidad, en el informe y en la lista de revisiones de la ficha.
     * El técnico ve su trabajo guardado en el iPad y en el servidor no hay nada.
     */
    it('la revisión al cerrarse SÍ pisa la que ya está: ese envío es el cierre', async () => {
      await db.inspections.put({ id: 'insp-1', status: 'completa' } as never)
      await db.outbox.add(
        entrada({ entity: 'inspection', id: 'insp-1', payload: { id: 'insp-1', status: 'completa' } }),
      )

      await flush()

      expect(upsert).toHaveBeenCalledWith(expect.anything(), {
        onConflict: 'id',
        ignoreDuplicates: false,
      })
    })

    /*
     * Y el otro lado del cierre: cuando la respuesta se pierde por el camino.
     *
     * El cierre es un UPDATE de verdad y el servidor solo lo permite mientras la
     * revisión siga siendo borrador —así no se reescribe un registro cerrado—. El
     * reintento llega a una fila ya cerrada y vuelve un 42501, que es permanente:
     * la entrada se quedaba rechazada para siempre enseñando «sin enviar» por una
     * revisión que sí estaba guardada.
     */
    it('el reintento del cierre no se rechaza si la revisión ya está cerrada arriba', async () => {
      upsert.mockResolvedValue({
        error: { message: 'new row violates row-level security policy' },
        status: 403,
      })
      maybeSingle.mockResolvedValue({ data: { status: 'completa' } })

      const cierre = entrada({
        entity: 'inspection',
        id: 'insp-2',
        payload: { id: 'insp-2', status: 'completa' },
      })
      await db.outbox.add(cierre)

      const parte = await flush()

      expect(parte.subidos).toBe(1)
      expect(parte.rechazados).toBe(0)
      expect(await db.outbox.get(cierre.id)).toBeUndefined()
    })

    it('pero si arriba sigue en borrador, el rechazo es real y se queda a la vista', async () => {
      upsert.mockResolvedValue({
        error: { message: 'new row violates row-level security policy' },
        status: 403,
      })
      maybeSingle.mockResolvedValue({ data: { status: 'borrador' } })

      const cierre = entrada({
        entity: 'inspection',
        id: 'insp-3',
        payload: { id: 'insp-3', status: 'completa' },
      })
      await db.outbox.add(cierre)

      const parte = await flush()

      expect(parte.rechazados).toBe(1)
      expect((await db.outbox.get(cierre.id))?.status).toBe('rechazado')
    })

    /*
     * El caso que se llevaba por delante una corrección entera, y de paso los
     * últimos toques de cualquier revisión.
     *
     * El servidor solo acepta cambiar las comprobaciones mientras la revisión sea
     * un borrador. Si el cierre se adelanta a sus filas, las que llegan después se
     * quedan fuera en silencio: la corrección se cerraba arriba con los valores de
     * la revisión que venía a corregir.
     */
    it('el cierre espera a sus comprobaciones, y ellas pisan mientras espera', async () => {
      await db.inspections.put({ id: 'insp-4', status: 'completa' } as never)
      await db.outbox.bulkAdd([
        entrada({
          entity: 'inspection',
          id: 'insp-4',
          payload: { id: 'insp-4', status: 'completa', overall: 'con_incidencias' },
        }),
        entrada({
          entity: 'inspection_check',
          payload: { id: 'c9', inspection_id: 'insp-4', result: 'incidencia' },
        }),
      ])

      const primera = await flush()

      // La revisión ha subido como borrador —crea la fila, que es lo que sus
      // comprobaciones necesitan— y su cierre sigue esperando en la cola.
      const [payloadRevision] = upsert.mock.calls[0]!
      expect(payloadRevision).toMatchObject({ id: 'insp-4', status: 'borrador' })
      expect((await db.outbox.get('insp-4'))?.status).toBe('pendiente')

      // Y la comprobación ha ido a pisar, no a «no pises»: es justo el valor que
      // el técnico acaba de cambiar.
      expect(upsert.mock.calls[1]![1]).toEqual({ onConflict: 'id', ignoreDuplicates: false })
      expect(primera.subidos).toBe(1)

      // Segunda vuelta: ya no queda nada dentro, así que ahora sí se cierra.
      upsert.mockClear()
      const segunda = await flush({ forzar: true })

      expect(upsert.mock.calls[0]![0]).toMatchObject({ id: 'insp-4', status: 'completa' })
      expect(segunda.subidos).toBe(1)
      expect(await db.outbox.count()).toBe(0)
    })

    it('y no espera a una comprobación rechazada, que no va a moverse sola', async () => {
      await db.inspections.put({ id: 'insp-5', status: 'completa' } as never)
      await db.outbox.bulkAdd([
        entrada({
          entity: 'inspection',
          id: 'insp-5',
          payload: { id: 'insp-5', status: 'completa' },
        }),
        entrada({
          entity: 'inspection_check',
          status: 'rechazado',
          payload: { id: 'c8', inspection_id: 'insp-5' },
        }),
      ])

      await flush()

      // Sin esta salida, una comprobación rechazada dejaría la revisión sin cerrar
      // para siempre.
      expect(upsert.mock.calls[0]![0]).toMatchObject({ status: 'completa' })
      expect(await db.outbox.get('insp-5')).toBeUndefined()
    })

    /*
     * Y el fallo que explica las incidencias que no aparecen nunca en su pestaña:
     * la revisión se corta a mitad de subir, y sus hijos chocan contra una clave
     * ajena que todavía no existe. Eso no es contenido malo, es orden.
     */
    it('un choque de clave ajena vuelve a la cola en vez de rechazarse para siempre', async () => {
      upsert.mockResolvedValue({
        error: {
          message:
            'insert or update on table "incidents" violates foreign key constraint "incidents_opened_from_inspection_id_fkey"',
        },
        status: 409,
      })
      const hija = entrada({ entity: 'incident', payload: { id: 'inc-1' } })
      await db.outbox.add(hija)

      const parte = await flush()

      expect(parte.rechazados).toBe(0)
      const quedo = await db.outbox.get(hija.id)
      expect(quedo?.status).toBe('pendiente')
      expect(quedo?.nextAttemptAt).toBeGreaterThan(0)
    })

    it('un reencolado durante la subida no se pierde al terminar', async () => {
      // El técnico toca otra vez la misma fila mientras está en vuelo. Borrar por
      // id a secas se llevaba el toque nuevo con la entrada vieja.
      const { enqueue } = await import('@/db/dexie')
      const tocada = entrada({ id: 'tocada', payload: { id: 'tocada', v: 1 } })
      await db.outbox.add(tocada)

      upsert.mockImplementation(async () => {
        await enqueue('incident', 'tocada', { id: 'tocada', v: 2 })
        return { error: null, status: 201 }
      })

      await flush()

      const quedo = await db.outbox.get('tocada')
      expect(quedo?.payload['v']).toBe(2)
      expect(quedo?.status).toBe('pendiente')
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

  it('una entrada que revienta la base local no abandona al resto de la cola', async () => {
    // Un fallo de la base local —cuota, base cerrada— subía hasta el `catch` de
    // `flush()` y se llevaba por delante todo lo que viniera detrás.
    const rota = entrada({ createdAt: 1 })
    const buena = entrada({ createdAt: 2 })
    await db.outbox.bulkAdd([rota, buena])

    const updateReal = db.outbox.update.bind(db.outbox)
    vi.spyOn(db.outbox, 'update')
      .mockImplementationOnce(() => Promise.reject(new Error('DatabaseClosedError')) as never)
      // El resto de la pasada usa la implementación de verdad.
      .mockImplementation(updateReal as never)

    const parte = await flush()
    vi.restoreAllMocks()

    expect(parte.subidos).toBe(1)
    expect(await db.outbox.get(buena.id)).toBeUndefined()
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
