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
    expect(lineasDeMaterial(p)).toEqual([
      { stockItemId: REGLETA, unidades: 2, sinSubir: true },
      { stockItemId: CABLE, unidades: 2, sinSubir: false },
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
