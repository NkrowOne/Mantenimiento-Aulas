/**
 * ¿Hay algo que elegir? Casi nunca, y eso es lo que se vigila aquí: que la
 * pregunta salga cuando tiene más de una respuesta y solo entonces. Una pregunta
 * de más en cada cable es una aplicación que nadie quiere usar en el aula; una
 * de menos es el almacén diciendo que se puso un teclado usado cuando era nuevo.
 */
import { describe, expect, it } from 'vitest'

import type { NivelPorEstado } from '@/domain/estados'
import type { UnidadDeAlmacen } from '@/domain/unidades'
import { opcionesDeMaterial, unidadesLibres } from './cual'

const nivel = (extra: Partial<NivelPorEstado> = {}): NivelPorEstado => {
  const n = {
    stock_item_id: 'a',
    seguimiento: 'cantidad' as const,
    nuevo: 0,
    usado: 0,
    reacondicionado: 0,
    averiado: 0,
    sin_indicar: 0,
    ...extra,
  }
  const on_hand = extra.on_hand ?? n.nuevo + n.usado + n.reacondicionado + n.averiado + n.sin_indicar
  return { ...n, on_hand, disponibles: on_hand - n.averiado }
}

const unidad = (id: string, extra: Partial<UnidadDeAlmacen> = {}): UnidadDeAlmacen =>
  ({
    id,
    stock_item_id: 'a',
    serial: `SN-${id}`,
    status: 'disponible',
    condicion: 'nuevo',
    brand: null,
    model: null,
    ...extra,
  }) as UnidadDeAlmacen

const base = { seguimiento: null, nivel: null, quedan: null, unidades: [], apuntado: [] }

describe('por cantidad', () => {
  it('sin saber cuántas hay de cada estado, no se pregunta nada', () => {
    const o = opcionesDeMaterial({ ...base, quedan: 8 })
    expect(o.hayQueElegir).toBe(false)
    expect(o.unica).toBeNull()
  })

  it('todas de un mismo estado: no se pregunta, y se apunta sin decir cuál', () => {
    for (const n of [nivel({ sin_indicar: 8 }), nivel({ nuevo: 5 }), nivel({ usado: 1 })]) {
      const o = opcionesDeMaterial({ ...base, nivel: n })
      expect(o.hayQueElegir).toBe(false)
      expect(o.unica).toBeNull()
    }
  })

  it('con nuevas y usadas se pregunta, lo nuevo primero y lo averiado al final', () => {
    const o = opcionesDeMaterial({ ...base, nivel: nivel({ averiado: 1, usado: 3, nuevo: 5, sin_indicar: 2 }) })
    expect(o.hayQueElegir).toBe(true)
    expect(o.estados).toEqual([
      { condicion: 'nuevo', quedan: 5 },
      { condicion: 'usado', quedan: 3 },
      { condicion: 'sin_indicar', quedan: 2 },
      { condicion: 'averiado', quedan: 1 },
    ])
  })

  it('lo que el parte ya lleva de un estado se descuenta de lo que queda por ofrecer', () => {
    const o = opcionesDeMaterial({
      ...base,
      nivel: nivel({ nuevo: 2, usado: 3 }),
      apuntado: [{ clave: 'c:nuevo', condicion: 'nuevo', unitId: null, unidades: 1 }],
    })
    expect(o.estados).toEqual([
      { condicion: 'nuevo', quedan: 1 },
      { condicion: 'usado', quedan: 3 },
    ])
  })

  it('agotado un estado del que ya se apuntó, se sigue preguntando: el siguiente es de otro y hay que verlo', () => {
    const o = opcionesDeMaterial({
      ...base,
      nivel: nivel({ nuevo: 2, usado: 3 }),
      apuntado: [{ clave: 'c:nuevo', condicion: 'nuevo', unitId: null, unidades: 2 }],
    })
    expect(o.estados).toEqual([{ condicion: 'usado', quedan: 3 }])
    expect(o.hayQueElegir).toBe(true)
  })

  it('sin existencias no hay nada que elegir: se apunta y el aviso de la pantalla dice que no queda', () => {
    expect(opcionesDeMaterial({ ...base, nivel: nivel() }).hayQueElegir).toBe(false)
  })
})

describe('por número de serie', () => {
  const serie = { ...base, seguimiento: 'serie' as const }

  it('un solo aparato y nada más: es ese, sin preguntar', () => {
    const o = opcionesDeMaterial({ ...serie, quedan: 1, unidades: [unidad('u1', { condicion: 'usado' })] })
    expect(o.hayQueElegir).toBe(false)
    expect(o.unica).toEqual({ unitId: 'u1', condicion: 'usado' })
  })

  it('varios aparatos: se pregunta, en el orden en que se elegirían', () => {
    const o = opcionesDeMaterial({
      ...serie,
      quedan: 3,
      unidades: [unidad('u1', { condicion: 'averiado' }), unidad('u2', { condicion: 'usado' }), unidad('u3')],
    })
    expect(o.hayQueElegir).toBe(true)
    expect(o.unidades.map((u) => u.id)).toEqual(['u3', 'u2', 'u1'])
    expect(o.sinNumero).toBe(0)
  })

  it('un aparato y más contadas sin número: se pregunta, porque puede ser una de esas', () => {
    const o = opcionesDeMaterial({ ...serie, quedan: 3, unidades: [unidad('u1')] })
    expect(o.hayQueElegir).toBe(true)
    expect(o.sinNumero).toBe(2)
  })

  it('los aparatos que el parte ya lleva no se ofrecen otra vez', () => {
    const o = opcionesDeMaterial({
      ...serie,
      quedan: 2,
      unidades: [unidad('u1'), unidad('u2')],
      apuntado: [{ clave: 'u:u1', condicion: 'nuevo', unitId: 'u1', unidades: 1 }],
    })
    expect(o.unidades.map((u) => u.id)).toEqual(['u2'])
    // Queda uno y ninguna sin número: es ese.
    expect(o.hayQueElegir).toBe(false)
    expect(o.unica).toEqual({ unitId: 'u2', condicion: 'nuevo' })
  })

  it('sin ningún aparato apuntado en el almacén, se cuenta como siempre', () => {
    const o = opcionesDeMaterial({ ...serie, quedan: 4, unidades: [] })
    expect(o.hayQueElegir).toBe(false)
    expect(o.unica).toBeNull()
    expect(o.sinNumero).toBe(4)
  })

  it('un artículo que no dice cómo se lleva pero tiene aparatos se trata por número de serie', () => {
    const o = opcionesDeMaterial({ ...base, quedan: 2, unidades: [unidad('u1'), unidad('u2')] })
    expect(o.hayQueElegir).toBe(true)
    expect(o.unidades).toHaveLength(2)
  })
})

describe('las unidades que se pueden ofrecer', () => {
  it('por artículo, solo las disponibles y sin las que otra avería de este iPad ya lleva', () => {
    const libres = unidadesLibres(
      [
        unidad('u1'),
        unidad('u2'),
        unidad('u3', { stock_item_id: 'b' }),
        unidad('u4', { status: 'instalado' }),
        unidad('u5', { stock_item_id: null }),
      ],
      new Set(['u2']),
    )
    expect([...libres.keys()]).toEqual(['a', 'b'])
    expect(libres.get('a')!.map((u) => u.id)).toEqual(['u1'])
  })
})
