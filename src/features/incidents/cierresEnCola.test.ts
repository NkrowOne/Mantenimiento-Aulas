import { describe, expect, it } from 'vitest'
import { incidenciasConCierreEnCola } from './cierresEnCola'
import type { OutboxEntry } from '@/db/dexie'

function entrada(over: Partial<Pick<OutboxEntry, 'entity' | 'payload'>> = {}) {
  return {
    entity: 'incident_resolution' as OutboxEntry['entity'],
    payload: { id: 'cierre-1', incident_id: 'averia-1' } as Record<string, unknown>,
    ...over,
  }
}

/**
 * La regla que impide cerrar dos veces la misma avería.
 *
 * El cierre viaja por la cola, así que durante un rato el servidor sigue
 * diciendo que la incidencia está abierta. Quien decide si se vuelve a ofrecer
 * «Resolver» es esto, y el `payload` de la cola es un saco sin tipo: si un día
 * la entrada cambia de forma, no salta ningún error — simplemente vuelve el
 * botón y aparecen dos asientos de cierre para la misma avería.
 */
describe('incidenciasConCierreEnCola', () => {
  it('saca la avería de cada cierre que espera en la cola', () => {
    const set = incidenciasConCierreEnCola([
      entrada(),
      entrada({ payload: { id: 'cierre-2', incident_id: 'averia-2' } }),
    ])
    expect([...set].sort()).toEqual(['averia-1', 'averia-2'])
  })

  it('no se lleva por delante lo que hay en la cola de otras cosas', () => {
    const set = incidenciasConCierreEnCola([
      entrada({ entity: 'incident', payload: { id: 'averia-9' } }),
      entrada({ entity: 'stock_movement', payload: { id: 'm1', incident_id: 'averia-9' } }),
      entrada(),
    ])
    expect([...set]).toEqual(['averia-1'])
  })

  it('con la cola vacía no hay nada tapado', () => {
    expect(incidenciasConCierreEnCola([]).size).toBe(0)
  })

  // Un cierre encolado por una versión anterior, o una entrada a medio escribir:
  // lo que no se puede es meter `undefined` en el conjunto y que el «¿está esta
  // avería cerrada?» conteste que sí a una fila sin id.
  it('una entrada sin avería no entra en el conjunto', () => {
    const set = incidenciasConCierreEnCola([
      entrada({ payload: { id: 'cierre-3' } }),
      entrada({ payload: { id: 'cierre-4', incident_id: '' } }),
    ])
    expect(set.size).toBe(0)
  })
})
