import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Incident } from '@/domain/types'

/**
 * Cerrar una incidencia es un cambio, no un alta, y por eso se prueba aparte.
 *
 * Lo que hay que garantizar son dos cosas que no se ven desde la pantalla: que
 * la sala deja de contar la avería **en el momento** —el espejo, sin esperar a
 * la red— y que la orden queda encolada con una clave que no pisa el alta de esa
 * misma incidencia, que puede seguir esperando ahí al lado.
 */

// `flush()` habla con el servidor y aquí no hay ninguno. Lo que importa es lo
// que queda escrito antes de llamarla.
vi.mock('@/sync/outbox', () => ({ flush: vi.fn() }))

const { db } = await import('@/db/dexie')
const { avanzarIncidencia, puedeCerrar } = await import('./acciones')

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
      op: 'update',
      targetId: 'inc-1',
      status: 'pendiente',
    })
    // Un parche, no la fila entera: dos personas que toquen la misma incidencia
    // no se pisan campos que ninguna de las dos ha cambiado.
    expect(cola[0]?.payload).toEqual({
      state: 'resuelta',
      resolved_at: '2026-08-03T09:00:00.000Z',
      resolved_by: 'supervisor-1',
      resolution: 'Pieza sustituida',
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
    expect((await db.outbox.get('inc-1#estado'))?.payload).toEqual({ state: 'en_curso' })
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
    expect((cola[0]?.payload as { state: string }).state).toBe('resuelta')
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

  it('una resolución en blanco no se guarda como texto vacío', async () => {
    await avanzarIncidencia({ id: 'inc-1', estado: 'resuelta', resolucion: '   ', userId: null })
    expect((await db.outbox.get('inc-1#estado'))?.payload).toMatchObject({ resolution: null })
  })
})

describe('puedeCerrar', () => {
  it('es de supervisor para arriba, igual que en el servidor', () => {
    expect(puedeCerrar('tecnico')).toBe(false)
    expect(puedeCerrar('supervisor')).toBe(true)
    expect(puedeCerrar('admin')).toBe(true)
  })
})
