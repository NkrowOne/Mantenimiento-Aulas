/**
 * El parte de material de una avería: lo que dice y cómo cambia con cada toque.
 *
 * Lo que estas pruebas impiden es lo que se veía en el Historial de un aula:
 * cinco líneas para un hub —«+1 +1 −1 −1 −1»— porque cada toque era un asiento
 * del almacén. Ahora los toques cambian una fila del parte, siempre la misma,
 * y del almacén se ocupa el servidor al cerrar. Aquí se comprueba que el
 * parte se lee bien —una línea por artículo, en su orden— y que cada toque va
 * a la fila que toca, incluidas las que trajo el Excel y las que aún no han
 * salido del dispositivo.
 */
import { describe, expect, it } from 'vitest'

import {
  claveDe,
  detalleDe,
  lineasDeMaterial,
  mezclarParte,
  planQuitar,
  planRestar,
  planSumar,
  unidadesApuntadas,
  type LineaDelParte,
} from './material'

const CABLE = 'art-cable'
const REGLETA = 'art-regleta'

const fila = (
  id: string,
  qty: number,
  donde: LineaDelParte['donde'] = 'arriba',
  stockItemId = CABLE,
): LineaDelParte => ({ id, stockItemId, qty, donde })

const nuevoId = (): string => 'nuevo'

describe('lo que dice el parte', () => {
  it('es la suma de sus filas por artículo', () => {
    // Dos filas del mismo cable pasan cuando el Excel lo nombra dos veces.
    expect(unidadesApuntadas([fila('m1', 2), fila('m2', 1)], CABLE)).toBe(3)
  })

  it('la lista va por artículo y en el orden en que se apuntaron', () => {
    const p = [fila('m3', 1), fila('m1', 2, 'en_cola', REGLETA), fila('m2', 1)]
    expect(lineasDeMaterial(p)).toMatchObject([
      { stockItemId: REGLETA, unidades: 2, sinSubir: true },
      { stockItemId: CABLE, unidades: 2, sinSubir: false },
    ])
    // Sin nada elegido, el detalle es una sola entrada «sin decir» con todas.
    expect(lineasDeMaterial(p).map((l) => l.detalle)).toEqual([
      [{ clave: '', condicion: null, unitId: null, unidades: 2 }],
      [{ clave: '', condicion: null, unitId: null, unidades: 2 }],
    ])
  })

  it('el orden no depende de por dónde llegó la fila', () => {
    /*
     * La cola va delante al mezclar, y si el orden de la lista fuera el de la
     * mezcla, la línea que se acaba de tocar saltaría al principio a cada
     * toque. Manda el id, que es el momento en que se apuntó.
     */
    const p = mezclarParte([fila('m2', 3, 'en_cola', REGLETA)], [fila('m1', 1)], [])
    expect(lineasDeMaterial(p).map((l) => l.stockItemId)).toEqual([CABLE, REGLETA])
  })

  it('un artículo quitado desaparece de la lista', () => {
    expect(lineasDeMaterial([fila('m1', 0)])).toEqual([])
  })
})

describe('sumar una unidad', () => {
  it('sin nada apuntado, abre una fila nueva con el id que se le da', () => {
    expect(planSumar([], CABLE, nuevoId)).toEqual([{ id: 'nuevo', stockItemId: CABLE, qty: 1 }])
  })

  it('con una fila del artículo, le sube la cantidad a esa misma', () => {
    // Siempre la misma fila: en el servidor es un UPDATE y en el Historial,
    // al cerrar, un solo asiento.
    expect(planSumar([fila('m1', 2, 'en_cola')], CABLE, nuevoId)).toEqual([
      { id: 'm1', stockItemId: CABLE, qty: 3 },
    ])
  })

  it('también si la fila ya está arriba: se corrige, no se abre otra', () => {
    expect(planSumar([fila('m1', 2)], CABLE, nuevoId)).toEqual([{ id: 'm1', stockItemId: CABLE, qty: 3 }])
  })

  it('una fila quitada vuelve a contar desde uno', () => {
    expect(planSumar([fila('m1', 0)], CABLE, nuevoId)).toEqual([{ id: 'm1', stockItemId: CABLE, qty: 1 }])
  })
})

describe('restar una unidad', () => {
  it('baja la cantidad de la fila', () => {
    expect(planRestar([fila('m1', 3)], CABLE)).toEqual([{ id: 'm1', stockItemId: CABLE, qty: 2 }])
  })

  it('la última unidad deja la fila a cero, no la borra', () => {
    // El servidor tiene que ver el cero: si la avería ya estaba cerrada, es lo
    // que le dice que devuelva la unidad al almacén.
    expect(planRestar([fila('m1', 1)], CABLE)).toEqual([{ id: 'm1', stockItemId: CABLE, qty: 0 }])
  })

  it('con dos filas del artículo, baja de la primera que tenga unidades', () => {
    expect(planRestar([fila('m1', 0), fila('m2', 2)], CABLE)).toEqual([
      { id: 'm2', stockItemId: CABLE, qty: 1 },
    ])
  })

  it('y no resta de lo que ya está a cero', () => {
    expect(planRestar([fila('m1', 0)], CABLE)).toEqual([])
    expect(planRestar([], CABLE)).toEqual([])
  })
})

describe('quitar el artículo entero', () => {
  it('pone a cero todas sus filas', () => {
    expect(planQuitar([fila('m1', 2), fila('m2', 1, 'en_cola')], CABLE)).toEqual([
      { id: 'm1', stockItemId: CABLE, qty: 0 },
      { id: 'm2', stockItemId: CABLE, qty: 0 },
    ])
  })

  it('las que ya estaban a cero no se reenvían', () => {
    expect(planQuitar([fila('m1', 0), fila('m2', 1)], CABLE)).toEqual([
      { id: 'm2', stockItemId: CABLE, qty: 0 },
    ])
  })

  it('un artículo que no está en la avería no hace nada', () => {
    expect(planQuitar([fila('m1', 1)], REGLETA)).toEqual([])
  })
})

describe('juntar la cola, lo recordado y el servidor', () => {
  it('una fila que ya subió pero que el servidor todavía no devuelve no desaparece', () => {
    const r = mezclarParte([], [], [fila('m1', 2, 'en_cola')])
    expect(r).toEqual([fila('m1', 2, 'arriba')])
    expect(unidadesApuntadas(r, CABLE)).toBe(2)
  })

  it('y cuando el servidor la devuelve, no se cuenta dos veces', () => {
    const r = mezclarParte([], [fila('m1', 2)], [fila('m1', 2, 'en_cola')])
    expect(r).toHaveLength(1)
    expect(unidadesApuntadas(r, CABLE)).toBe(2)
  })

  it('manda la cola, que tiene la cantidad más reciente', () => {
    const r = mezclarParte([fila('m1', 3, 'en_cola')], [fila('m1', 2)], [fila('m1', 2, 'en_cola')])
    expect(r).toEqual([fila('m1', 3, 'en_cola')])
  })

  it('y lo recordado gana a la copia del servidor, que puede ir por detrás', () => {
    // Entre que la cola sube la fila y la lista del servidor se vuelve a pedir,
    // el servidor devuelve la cantidad de antes del último toque.
    const r = mezclarParte([], [fila('m1', 2)], [fila('m1', 3, 'en_cola')])
    expect(r).toEqual([fila('m1', 3, 'arriba')])
  })

  it('las tres fuentes a la vez dan cada fila una sola vez', () => {
    const r = mezclarParte(
      [fila('m3', 1, 'en_cola', REGLETA)],
      [fila('m1', 2), fila('m2', 1)],
      [fila('m1', 2, 'en_cola'), fila('m3', 1, 'en_cola', REGLETA)],
    )
    expect(r.map((l) => l.id)).toEqual(['m3', 'm1', 'm2'])
    expect(unidadesApuntadas(r, CABLE)).toBe(3)
  })
})

/*
 * Desde el 18/11/2026 una fila puede decir cuál: de qué estado salen sus
 * unidades o qué aparato es. Lo que se comprueba es que cada toque va a SU
 * fila —la de ese estado, la de ese aparato, la que no dice nada— y que una
 * fila que dice cuál no lo pierde al cambiarle la cantidad.
 */
describe('el parte dice cuál', () => {
  const ids = (): (() => string) => {
    let n = 0
    return () => `nueva-${++n}`
  }
  const con = (l: LineaDelParte, extra: Partial<LineaDelParte>): LineaDelParte => ({ ...l, ...extra })

  it('cada fila tiene su clave: el aparato, el estado, o ninguna', () => {
    expect(claveDe({})).toBe('')
    expect(claveDe({ condicion: 'nuevo' })).toBe('c:nuevo')
    expect(claveDe({ condicion: 'usado', unitId: 'u1' })).toBe('u:u1')
  })

  it('una nueva más abre su fila, y la siguiente nueva sube ESA, no la que no dice nada', () => {
    const p = [fila('m1', 2)]
    const [primera] = planSumar(p, CABLE, ids(), { condicion: 'nuevo' })
    expect(primera).toEqual({ id: 'nueva-1', stockItemId: CABLE, qty: 1, condicion: 'nuevo' })

    const p2 = [...p, con(fila('nueva-1', 1), { condicion: 'nuevo' })]
    expect(planSumar(p2, CABLE, ids(), { condicion: 'nuevo' })).toEqual([
      { id: 'nueva-1', stockItemId: CABLE, qty: 2, condicion: 'nuevo' },
    ])
    // Y una usada, otra fila: no se mezcla con las nuevas.
    expect(planSumar(p2, CABLE, ids(), { condicion: 'usado' })).toEqual([
      { id: 'nueva-1', stockItemId: CABLE, qty: 1, condicion: 'usado' },
    ])
  })

  it('sin decir cuál va a la fila que no dice nada, aunque haya otras del artículo', () => {
    const p = [con(fila('m1', 2), { condicion: 'nuevo' }), fila('m2', 1)]
    expect(planSumar(p, CABLE, ids())).toEqual([{ id: 'm2', stockItemId: CABLE, qty: 2 }])
    // Y si no hay ninguna que no diga nada, se abre: no se le suma a las nuevas.
    expect(planSumar([p[0]!], CABLE, ids())).toEqual([{ id: 'nueva-1', stockItemId: CABLE, qty: 1 }])
  })

  it('un aparato es uno: su fila nace con su unidad y su estado, y tocarlo otra vez no hace nada', () => {
    const cual = { unitId: 'u1', condicion: 'usado' as const }
    expect(planSumar([], CABLE, ids(), cual)).toEqual([
      { id: 'nueva-1', stockItemId: CABLE, qty: 1, condicion: 'usado', unitId: 'u1' },
    ])
    const ya = [con(fila('m1', 1), cual)]
    expect(planSumar(ya, CABLE, ids(), cual)).toEqual([])
  })

  it('el aparato que se quitó y se vuelve a apuntar reutiliza su fila', () => {
    const quitado = [con(fila('m1', 0), { unitId: 'u1', condicion: 'usado' })]
    expect(planSumar(quitado, CABLE, ids(), { unitId: 'u1', condicion: 'usado' })).toEqual([
      { id: 'm1', stockItemId: CABLE, qty: 1, condicion: 'usado', unitId: 'u1' },
    ])
  })

  it('el − de «nuevas» baja las nuevas y no otra fila, y no pierde lo que dice', () => {
    const p = [fila('m1', 1), con(fila('m2', 2), { condicion: 'nuevo' }), con(fila('m3', 1), { unitId: 'u1', condicion: 'usado' })]
    expect(planRestar(p, CABLE, 'c:nuevo')).toEqual([{ id: 'm2', stockItemId: CABLE, qty: 1, condicion: 'nuevo' }])
    expect(planRestar(p, CABLE, 'u:u1')).toEqual([
      { id: 'm3', stockItemId: CABLE, qty: 0, condicion: 'usado', unitId: 'u1' },
    ])
    expect(planRestar(p, CABLE, '')).toEqual([{ id: 'm1', stockItemId: CABLE, qty: 0 }])
    expect(planRestar(p, CABLE, 'c:averiado')).toEqual([])
  })

  it('quitar el artículo pone a cero todas sus filas, cada una diciendo lo suyo', () => {
    const p = [con(fila('m1', 2), { condicion: 'nuevo' }), con(fila('m2', 1), { unitId: 'u1', condicion: 'usado' })]
    expect(planQuitar(p, CABLE)).toEqual([
      { id: 'm1', stockItemId: CABLE, qty: 0, condicion: 'nuevo' },
      { id: 'm2', stockItemId: CABLE, qty: 0, condicion: 'usado', unitId: 'u1' },
    ])
  })

  it('el detalle junta por lo elegido, en el orden en que se apuntó, y calla lo que está a cero', () => {
    const p = [
      con(fila('m3', 1), { unitId: 'u1', condicion: 'usado' }),
      con(fila('m1', 2), { condicion: 'nuevo' }),
      con(fila('m4', 1), { condicion: 'nuevo' }),
      fila('m2', 1),
      con(fila('m5', 0), { condicion: 'averiado' }),
    ]
    expect(detalleDe(p, CABLE)).toEqual([
      { clave: 'c:nuevo', condicion: 'nuevo', unitId: null, unidades: 3 },
      { clave: '', condicion: null, unitId: null, unidades: 1 },
      { clave: 'u:u1', condicion: 'usado', unitId: 'u1', unidades: 1 },
    ])
    expect(unidadesApuntadas(p, CABLE)).toBe(5)
  })

  it('la mezcla no pierde lo que dice cada fila', () => {
    const p = mezclarParte(
      [con(fila('m1', 1, 'en_cola'), { condicion: 'nuevo' })],
      [con(fila('m2', 1), { unitId: 'u1', condicion: 'usado' })],
      [],
    )
    expect(p.map(claveDe)).toEqual(['c:nuevo', 'u:u1'])
  })
})
