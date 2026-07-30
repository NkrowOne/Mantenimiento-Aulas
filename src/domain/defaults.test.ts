import { describe, expect, it } from 'vitest'
import { defaultsDelEdificio, faltantesPorDefecto } from './defaults'
import type { EquipoMinimo, SalaMinima } from './defaults'
import type { AssetDefault } from './types'

const PROYECTOR = 't-proyector'
const PANTALLA = 't-pantalla'

function def(asset_type_id: string, building_id: string | null, qty: number): AssetDefault {
  return { id: `d-${asset_type_id}-${building_id ?? 'global'}`, asset_type_id, building_id, qty }
}

function equipo(room_id: string, asset_type_id: string, extra: Partial<EquipoMinimo> = {}): EquipoMinimo {
  return { room_id, asset_type_id, status: 'instalado', ...extra }
}

/* Dos edificios, dos salas cada uno. La zona es lo que los une. */
const SALAS: SalaMinima[] = [
  { id: 's1', zone_id: 'z1' },
  { id: 's2', zone_id: 'z1' },
  { id: 's3', zone_id: 'z2' },
  { id: 's4', zone_id: 'z3' },
]
const ZONAS = new Map([
  ['z1', 'edA'],
  ['z2', 'edB'],
  // z3 a propósito sin edificio: es una sala cuya zona no resuelve.
])

describe('defaultsDelEdificio', () => {
  it('el del edificio pisa al global en vez de sumarse', () => {
    const toca = defaultsDelEdificio([def(PANTALLA, null, 1), def(PANTALLA, 'edA', 2)], 'edA')
    expect(toca.get(PANTALLA)).toBe(2)
  })

  it('el de OTRO edificio no se aplica', () => {
    const toca = defaultsDelEdificio([def(PANTALLA, null, 1), def(PANTALLA, 'edA', 3)], 'edB')
    expect(toca.get(PANTALLA)).toBe(1)
  })

  it('una sala sin edificio resuelto se queda con lo que vale en todas partes', () => {
    const toca = defaultsDelEdificio([def(PANTALLA, null, 1), def(PROYECTOR, 'edA', 5)], null)
    expect([...toca]).toEqual([[PANTALLA, 1]])
  })

  it('sin defectos declarados no toca nada', () => {
    expect(defaultsDelEdificio([], 'edA').size).toBe(0)
  })
})

describe('faltantesPorDefecto', () => {
  it('cuenta lo que falta, sala por sala', () => {
    const r = faltantesPorDefecto({
      defaults: [def(PROYECTOR, null, 1)],
      salas: SALAS,
      edificioDeZona: ZONAS,
      equipos: [equipo('s1', PROYECTOR)],
    })

    // s1 ya lo tiene; s2, s3 y s4 no. El global alcanza también a la sala sin
    // edificio resuelto.
    expect(r.equipos).toBe(3)
    expect(r.salas).toBe(3)
    expect(r.porTipo.get(PROYECTOR)).toBe(3)
  })

  it('lo que sobra no resta: el defecto es un mínimo, no una plantilla', () => {
    const r = faltantesPorDefecto({
      defaults: [def(PANTALLA, null, 1)],
      salas: [{ id: 's1', zone_id: 'z1' }],
      edificioDeZona: ZONAS,
      equipos: [equipo('s1', PANTALLA), equipo('s1', PANTALLA), equipo('s1', PANTALLA)],
    })

    expect(r.equipos).toBe(0)
    expect(r.salas).toBe(0)
  })

  it('un equipo retirado no cuenta como presente', () => {
    const r = faltantesPorDefecto({
      defaults: [def(PANTALLA, null, 1)],
      salas: [{ id: 's1', zone_id: 'z1' }],
      edificioDeZona: ZONAS,
      equipos: [equipo('s1', PANTALLA, { status: 'retirado' })],
    })

    expect(r.equipos).toBe(1)
  })

  it('un averiado sí cuenta: sigue estando en la sala', () => {
    const r = faltantesPorDefecto({
      defaults: [def(PANTALLA, null, 1)],
      salas: [{ id: 's1', zone_id: 'z1' }],
      edificioDeZona: ZONAS,
      equipos: [equipo('s1', PANTALLA, { status: 'averiado' })],
    })

    expect(r.equipos).toBe(0)
  })

  it('el defecto del edificio manda sobre el global también al contar', () => {
    const r = faltantesPorDefecto({
      defaults: [def(PANTALLA, null, 1), def(PANTALLA, 'edA', 2)],
      salas: SALAS,
      edificioDeZona: ZONAS,
      equipos: [],
    })

    // edA: dos salas × 2 pantallas = 4. edB: una × 1. Sin edificio: una × 1.
    expect(r.equipos).toBe(6)
    expect(r.salas).toBe(4)
  })

  it('acotar por edificio deja fuera al resto', () => {
    const r = faltantesPorDefecto({
      defaults: [def(PANTALLA, null, 1)],
      salas: SALAS,
      edificioDeZona: ZONAS,
      equipos: [],
      buildingId: 'edB',
    })

    expect(r.equipos).toBe(1)
    expect(r.salas).toBe(1)
  })

  it('un equipo sin sala no cuenta para ninguna', () => {
    const r = faltantesPorDefecto({
      defaults: [def(PANTALLA, null, 1)],
      salas: [{ id: 's1', zone_id: 'z1' }],
      edificioDeZona: ZONAS,
      equipos: [{ room_id: null, asset_type_id: PANTALLA, status: 'instalado' }],
    })

    expect(r.equipos).toBe(1)
  })

  it('sin defectos declarados no propone nada', () => {
    const r = faltantesPorDefecto({
      defaults: [],
      salas: SALAS,
      edificioDeZona: ZONAS,
      equipos: [],
    })

    expect(r).toEqual({ equipos: 0, salas: 0, porTipo: new Map() })
  })
})
