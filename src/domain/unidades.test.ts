import { describe, expect, it } from 'vitest'
import {
  coincideUnidad,
  entraPorDefecto,
  ordenarUnidades,
  resumenDeCondiciones,
  serialComparable,
  sinNumeroDeSerie,
  type UnidadDeAlmacen,
} from './unidades'

function unidad(p: Partial<UnidadDeAlmacen> = {}): UnidadDeAlmacen {
  return {
    id: 'u1',
    stock_item_id: 'a1',
    item_name: 'Ordenador Tiny M710Q',
    item_active: true,
    articulo: 'Ordenador Tiny',
    asset_type_id: 't-pc',
    type_name: 'Ordenador',
    es_ordenador: true,
    brand: 'Lenovo',
    model: 'ThinkCentre M710Q',
    serial: 'S4GM1899',
    notes: null,
    status: 'disponible',
    condicion: 'nuevo',
    asset_id: null,
    room_id: null,
    room_code: null,
    room_name: null,
    building_code: null,
    installed_at: null,
    retired_at: null,
    source: 'app',
    created_at: null,
    updated_at: null,
    ...p,
  }
}

describe('buscar una unidad', () => {
  it('el número de serie a medias y con otros separadores', () => {
    expect(coincideUnidad(unidad(), 's4gm')).toBe(true)
    expect(coincideUnidad(unidad({ serial: 'S4G-M18 99' }), 's4gm1899')).toBe(true)
    expect(coincideUnidad(unidad(), 'S4KP')).toBe(false)
  })

  it('el modelo, la marca, el artículo o el estado, sin tildes', () => {
    expect(coincideUnidad(unidad(), 'thinkcentre')).toBe(true)
    expect(coincideUnidad(unidad(), 'lenovo m710')).toBe(true)
    expect(coincideUnidad(unidad({ condicion: 'reacondicionado' }), 'reacondicionado')).toBe(true)
    expect(coincideUnidad(unidad(), 'epson')).toBe(false)
  })

  it('vacío es todas', () => {
    expect(coincideUnidad(unidad(), '  ')).toBe(true)
  })

  it('el número comparable quita espacios y separadores', () => {
    expect(serialComparable(' s4-gm.18/99 ')).toBe('S4GM1899')
  })
})

describe('el orden en que se eligen', () => {
  it('primero las del almacén, y dentro, lo nuevo antes que lo averiado', () => {
    const lista = ordenarUnidades([
      unidad({ id: 'averiada', condicion: 'averiado', serial: 'A1' }),
      unidad({ id: 'instalada', status: 'instalado', serial: 'A0' }),
      unidad({ id: 'usada', condicion: 'usado', serial: 'A2' }),
      unidad({ id: 'nueva', condicion: 'nuevo', serial: 'A3' }),
      unidad({ id: 'reacondicionada', condicion: 'reacondicionado', serial: 'A4' }),
    ])
    expect(lista.map((u) => u.id)).toEqual(['nueva', 'reacondicionada', 'usada', 'averiada', 'instalada'])
  })
})

describe('el resumen de cómo están', () => {
  it('solo las del almacén, en femenino y con plural', () => {
    expect(
      resumenDeCondiciones([
        unidad({ condicion: 'nuevo' }),
        unidad({ condicion: 'nuevo' }),
        unidad({ condicion: 'usado' }),
        unidad({ condicion: 'averiado', status: 'instalado' }),
      ]),
    ).toBe('2 nuevas · 1 usada')
  })

  it('sin unidades en el almacén no dice nada', () => {
    expect(resumenDeCondiciones([unidad({ status: 'baja' })])).toBe('')
  })
})

describe('¿entra ahora o ya estaba contada?', () => {
  it('si todas las contadas ya tienen número, la nueva entra', () => {
    expect(entraPorDefecto(3, 3)).toBe(true)
    expect(entraPorDefecto(0, 0)).toBe(true)
  })

  it('si quedan contadas sin número, es una de esas', () => {
    expect(entraPorDefecto(8, 3)).toBe(false)
  })

  it('las que faltan por numerar', () => {
    expect(sinNumeroDeSerie(8, 3)).toBe(5)
    expect(sinNumeroDeSerie(2, 5)).toBe(0)
  })
})
