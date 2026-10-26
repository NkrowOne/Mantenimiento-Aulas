import { describe, expect, it } from 'vitest'
import { companerosVivos, cuandoVuelve, instanteDeAlta, MOTIVO_FUSION, retiradasPorFusion, tiposVivos } from './devolver'
import type { FilaDeInventario } from './hoja'

/**
 * Devolver al inventario lo que una fusión de duplicados retiró por error.
 *
 * Lo que se comprueba aquí es la parte que decide: qué filas cuentan como
 * «retiradas en una fusión» y qué fecha lleva el alta. Que se elija mal es
 * devolver a la sala un equipo que se dio de baja de verdad.
 */

function fila(parcial: Partial<FilaDeInventario>): FilaDeInventario {
  return {
    asset_id: 'a',
    building_id: 'b',
    building_code: 'E',
    building_name: 'EDIFICIO E',
    building_sort: 1,
    zone_id: 'z',
    zone_name: 'PLANTA BAJA',
    zone_sort: 1,
    room_id: 'r',
    room_code: '0.6',
    room_name: 'Laboratorio informatica 6',
    room_short_ref: null,
    room_last_inventory_at: null,
    type_name: 'Ordenador Lenovo Ideacentre',
    label: 'Puesto 1',
    brand: null,
    model: null,
    serial: null,
    status: 'retirado',
    confirmed: true,
    alta_at: null,
    cambio_at: null,
    baja_at: '2026-08-31T10:00:00Z',
    baja_destino: null,
    baja_motivo: MOTIVO_FUSION,
    retirada_pedida: false,
    ...parcial,
  }
}

describe('qué se devuelve', () => {
  it('lo que una fusión sacó y la hoja sigue contando como baja, aunque ya diga instalado', () => {
    const filas = [
      fila({ asset_id: 'fusion' }),
      fila({ asset_id: 'baja-de-verdad', baja_motivo: 'Se quemó la fuente' }),
      // Instalado pero con la baja de la fusión en pie: la hoja lo sigue
      // contando como baja y el PDF no lo trae. Es el limbo de producción.
      fila({ asset_id: 'limbo', status: 'instalado' }),
      // Devuelto de verdad: con su alta, la hoja ya no le pone baja.
      fila({ asset_id: 'ya-vuelto', status: 'instalado', baja_at: null, baja_motivo: null }),
      fila({ asset_id: 'sin-motivo', baja_motivo: null }),
    ]
    expect(retiradasPorFusion(filas).map((f) => f.asset_id)).toEqual(['fusion', 'limbo'])
  })

  it('el motivo es exactamente el que escribe la fusión en la base', () => {
    expect(MOTIVO_FUSION).toBe('Retirado en una fusión de duplicados')
  })
})

describe('qué fecha lleva el alta', () => {
  it('el día elegido, a las nueve de la mañana', () => {
    const alta = instanteDeAlta('2026-09-22')
    expect(alta.getFullYear()).toBe(2026)
    expect(alta.getMonth()).toBe(8)
    expect(alta.getDate()).toBe(22)
    expect(alta.getHours()).toBe(9)
  })

  it('por delante de la baja que deshace, aunque la baja sea posterior', () => {
    const alta = instanteDeAlta('2026-09-22')
    expect(cuandoVuelve(alta, '2026-08-31T10:00:00Z')).toBe(alta.toISOString())
    expect(cuandoVuelve(alta, '2026-10-01T10:00:00Z')).toBe('2026-10-01T10:01:00.000Z')
    expect(cuandoVuelve(alta, null)).toBe(alta.toISOString())
  })
})

describe('los compañeros que ya estaban', () => {
  it('son los vivos del mismo tipo en la misma sala, ni los de otra sala ni los de otro tipo', () => {
    const devolver = [fila({ asset_id: 'p1' })]
    const todas = [
      ...devolver,
      fila({ asset_id: 'p30', status: 'instalado', baja_at: null, baja_motivo: null }),
      fila({ asset_id: 'otra-sala', status: 'instalado', room_id: 'r2', baja_at: null, baja_motivo: null }),
      fila({ asset_id: 'micro', status: 'instalado', type_name: 'Micrófono', baja_at: null, baja_motivo: null }),
      fila({ asset_id: 'baja', baja_motivo: 'Se quemó' }),
    ]
    expect(companerosVivos(devolver, todas).map((f) => f.asset_id)).toEqual(['p30'])
  })
})

describe('corregir la fecha de alta', () => {
  it('ofrece los tipos que hay vivos en la sala, el más numeroso primero, y sin las bajas', () => {
    const vivo = { status: 'instalado' as const, baja_at: null, baja_motivo: null }
    const filas = [
      fila({ asset_id: 'p1', ...vivo }),
      fila({ asset_id: 'p2', ...vivo }),
      fila({ asset_id: 'mic', type_name: 'Micrófono', ...vivo }),
      fila({ asset_id: 'retirado' }),
    ]
    expect(tiposVivos(filas)).toEqual([
      { tipo: 'Ordenador Lenovo Ideacentre', ids: ['p1', 'p2'] },
      { tipo: 'Micrófono', ids: ['mic'] },
    ])
  })
})
