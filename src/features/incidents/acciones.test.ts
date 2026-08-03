import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Incident } from '@/domain/types'

/**
 * Cerrar una incidencia es un cambio, no un alta, y por eso se prueba aparte.
 *
 * Lo que hay que garantizar son tres cosas que no se ven desde la pantalla: que
 * la sala deja de contar la avería **en el momento** —el espejo, sin esperar a
 * la red—, que la orden queda encolada con una clave que no pisa el alta de esa
 * misma incidencia, y que **no se puede cerrar sin decir qué se ha hecho**. Lo
 * último lo comprueba también el servidor (`avanzar_incidencia`); aquí se
 * comprueba antes para no gastar un viaje a la red en decir que no — y ese viaje,
 * desde un sótano, puede tardar horas en salir.
 */

// `flush()` habla con el servidor y aquí no hay ninguno. Lo que importa es lo
// que queda escrito antes de llamarla.
vi.mock('@/sync/outbox', () => ({ flush: vi.fn() }))

const { db } = await import('@/db/dexie')
const { avanzarIncidencia, conLaPieza, resolucionSuficiente } = await import('./acciones')

function incidencia(over: Partial<Incident> = {}): Incident {
  return {
    id: 'inc-1',
    room_id: 'sala-1',
    asset_id: null,
    opened_from_inspection_id: null,
    check_key: null,
    external_ref: null,
    title: 'Proyector: no da imagen',
    description: null,
    severity: 'media',
    state: 'abierta',
    kind: 'incidencia',
    opened_at: '2026-07-30T08:15:00.000Z',
    opened_by: 'tecnico-1',
    resolved_at: null,
    resolved_by: null,
    resolution: null,
    source: 'app',
    ...over,
  }
}

beforeEach(async () => {
  await db.incidents.clear()
  await db.outbox.clear()
})

describe('avanzarIncidencia', () => {
  it('cierra en el espejo y encola el cambio, sin esperar a la red', async () => {
    await db.incidents.put(incidencia())

    await avanzarIncidencia({
      id: 'inc-1',
      estado: 'resuelta',
      resolucion: 'Pieza sustituida',
      userId: 'supervisor-1',
      ahora: '2026-08-03T09:00:00.000Z',
    })

    const local = await db.incidents.get('inc-1')
    expect(local).toMatchObject({
      state: 'resuelta',
      resolution: 'Pieza sustituida',
      resolved_at: '2026-08-03T09:00:00.000Z',
      resolved_by: 'supervisor-1',
    })

    const cola = await db.outbox.toArray()
    expect(cola).toHaveLength(1)
    expect(cola[0]).toMatchObject({
      id: 'inc-1#estado',
      entity: 'incident',
      op: 'rpc',
      rpc: 'avanzar_incidencia',
      targetId: 'inc-1',
      status: 'pendiente',
    })
    /*
     * Una llamada a la función y no una escritura en la tabla: `incidents` sigue
     * cerrada a UPDATE para quien no sea supervisor, y la función es la puerta
     * con nombre por la que un técnico puede cerrar. La firma la pone el
     * servidor con quien llama, así que aquí no viaja.
     */
    expect(cola[0]?.payload).toEqual({
      p_id: 'inc-1',
      p_estado: 'resuelta',
      p_resolucion: 'Pieza sustituida',
    })
  })

  /*
   * La clave con sufijo es lo que hace posible cerrar sin cobertura una
   * incidencia recién abierta: `enqueue` guarda por clave primaria, así que sin
   * el sufijo el cierre reemplazaría el alta y la fila no llegaría a existir en
   * el servidor.
   */
  it('no pisa el alta de la incidencia que todavía está en la cola', async () => {
    await db.outbox.put({
      id: 'inc-1',
      entity: 'incident',
      op: 'upsert',
      payload: { id: 'inc-1' },
      createdAt: 1,
      attempts: 0,
      nextAttemptAt: 0,
      status: 'pendiente',
      lastError: null,
    })

    await avanzarIncidencia({ id: 'inc-1', estado: 'resuelta', resolucion: 'Reparado', userId: null })

    expect((await db.outbox.toArray()).map((e) => e.id).sort()).toEqual([
      'inc-1',
      'inc-1#estado',
    ])
  })

  it('empezar no inventa una resolución', async () => {
    await db.incidents.put(incidencia())
    await avanzarIncidencia({ id: 'inc-1', estado: 'en_curso', userId: 'supervisor-1' })

    expect((await db.incidents.get('inc-1'))?.state).toBe('en_curso')
    expect((await db.outbox.get('inc-1#estado'))?.payload).toEqual({
      p_id: 'inc-1',
      p_estado: 'en_curso',
      p_resolucion: null,
    })
  })

  /*
   * Empezar y luego resolver es una sola orden con el estado final. Con dos
   * entradas, la segunda podría llegar antes que la primera y dejar la
   * incidencia «en curso» después de haberla cerrado.
   */
  it('el segundo toque reemplaza al primero en vez de competir con él', async () => {
    await db.incidents.put(incidencia())
    await avanzarIncidencia({ id: 'inc-1', estado: 'en_curso', userId: 'u' })
    await avanzarIncidencia({ id: 'inc-1', estado: 'resuelta', resolucion: 'Reparado', userId: 'u' })

    const cola = await db.outbox.toArray()
    expect(cola).toHaveLength(1)
    expect((cola[0]?.payload as { p_estado: string }).p_estado).toBe('resuelta')
  })

  /*
   * El espejo solo guarda lo que no está resuelto, así que la fila puede no
   * estar —una incidencia vieja abierta desde la búsqueda—. No es un error: el
   * cambio viaja igual.
   */
  it('funciona aunque la incidencia no esté en el espejo', async () => {
    await avanzarIncidencia({ id: 'inc-vieja', estado: 'resuelta', resolucion: 'Reparado', userId: null })

    expect(await db.incidents.count()).toBe(0)
    expect(await db.outbox.get('inc-vieja#estado')).toBeDefined()
  })

  /*
   * Cerrar sin decir qué se ha hecho no se encola siquiera. Es lo que sustituye
   * a la firma del supervisor: sin texto, la fila diría «resuelta» y nada más,
   * que es exactamente lo que hacía inútil el cierre de antes.
   */
  it('no deja cerrar sin escribir qué se ha hecho, y no toca nada al negarse', async () => {
    await db.incidents.put(incidencia())

    for (const vacia of [undefined, '', '   ', '.', 'x']) {
      await expect(
        avanzarIncidencia({ id: 'inc-1', estado: 'resuelta', resolucion: vacia, userId: 'u' }),
      ).rejects.toThrow(/qué se ha hecho/)
    }

    expect((await db.incidents.get('inc-1'))?.state).toBe('abierta')
    expect(await db.outbox.count()).toBe(0)
  })
})

describe('resolucionSuficiente', () => {
  it('el suelo está en tres caracteres, y los espacios no cuentan', () => {
    expect(resolucionSuficiente('')).toBe(false)
    expect(resolucionSuficiente('   ')).toBe(false)
    expect(resolucionSuficiente('ok')).toBe(false)
    expect(resolucionSuficiente(' ok ')).toBe(false)
    expect(resolucionSuficiente('Cambiada la lámpara')).toBe(true)
  })
})

/*
 * «Pieza sustituida» pregunta cuál, y la respuesta se escribe en el cierre. El
 * nombre del artículo del almacén describe lo hecho mejor que cualquier frase
 * —«Lámpara Epson ELPLP96» dice más que «cambiada la lámpara»— así que no se
 * queda solo en el movimiento de almacén: entra en la resolución.
 */
describe('conLaPieza', () => {
  it('escribe la pieza cuando no había nada escrito', () => {
    expect(conLaPieza('', 'Lámpara Epson ELPLP96', 1)).toBe('Lámpara Epson ELPLP96')
    expect(conLaPieza('   ', 'Cable HDMI 5 m', 1)).toBe('Cable HDMI 5 m')
  })

  it('lleva la cantidad solo cuando es más de una', () => {
    expect(conLaPieza('', 'Cable HDMI 5 m', 1)).toBe('Cable HDMI 5 m')
    expect(conLaPieza('', 'Cable HDMI 5 m', 3)).toBe('Cable HDMI 5 m ×3')
  })

  /*
   * Añade y no sustituye: en una avería se cambian dos cosas más veces de las
   * que parece, y lo que el técnico haya escrito a mano es suyo.
   */
  it('se suma a lo que ya estuviera escrito, sin pisarlo', () => {
    expect(conLaPieza('Reiniciada la matriz', 'Cable HDMI 5 m', 1)).toBe(
      'Reiniciada la matriz · Cable HDMI 5 m',
    )
    expect(conLaPieza('Cable HDMI 5 m', 'Conector RJ45', 2)).toBe(
      'Cable HDMI 5 m · Conector RJ45 ×2',
    )
  })

  it('y lo que escribe basta para poder cerrar', () => {
    expect(resolucionSuficiente(conLaPieza('', 'Lámpara Epson ELPLP96', 1))).toBe(true)
  })
})
