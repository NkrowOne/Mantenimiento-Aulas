/**
 * Quitar material tiene que cuadrar el almacén, y solo cuadra si se distingue
 * lo que salió del dispositivo de lo que no.
 *
 * Los dos errores que estas pruebas existen para impedir son opuestos y los dos
 * silenciosos: devolver algo que el servidor nunca vio —le suma una unidad de
 * la nada— y borrar de la cola algo que ya salió —se queda descontado para
 * siempre—. Ninguno de los dos da error en pantalla; los ve, meses después,
 * quien cuenta cajas.
 */
import { describe, expect, it } from 'vitest'

import {
  lineasDeMaterial,
  planQuitar,
  planRestar,
  planSumar,
  unidadesUsadas,
  type ApunteDeMaterial,
} from './material'

const CABLE = 'art-cable'
const REGLETA = 'art-regleta'

const consumo = (
  id: string,
  unidades: number,
  donde: ApunteDeMaterial['donde'],
  stockItemId = CABLE,
): ApunteDeMaterial => ({ id, stockItemId, qty: -unidades, kind: 'consumo', donde })

const devolucion = (
  id: string,
  unidades: number,
  donde: ApunteDeMaterial['donde'],
  stockItemId = CABLE,
): ApunteDeMaterial => ({ id, stockItemId, qty: unidades, kind: 'devolucion', donde })

describe('lo que lleva gastado una avería', () => {
  it('son los consumos menos las devoluciones', () => {
    const a = [consumo('m1', 3, 'arriba'), devolucion('m2', 1, 'arriba')]
    expect(unidadesUsadas(a, CABLE)).toBe(2)
  })

  it('la lista va por artículo y en el orden en que se apuntaron', () => {
    const a = [consumo('m1', 2, 'arriba'), consumo('m2', 1, 'en_cola', REGLETA), consumo('m3', 1, 'arriba')]
    expect(lineasDeMaterial(a)).toEqual([
      { stockItemId: CABLE, unidades: 3, sinSubir: false },
      { stockItemId: REGLETA, unidades: 1, sinSubir: true },
    ])
  })

  it('un artículo apuntado y devuelto entero desaparece de la lista', () => {
    // Dos asientos que se anulan son el error, no el trabajo.
    const a = [consumo('m1', 1, 'arriba'), devolucion('m2', 1, 'en_cola')]
    expect(lineasDeMaterial(a)).toEqual([])
  })
})

describe('sumar una unidad', () => {
  it('sin nada apuntado, es un apunte nuevo', () => {
    expect(planSumar([], CABLE)).toEqual([{ tipo: 'consumo', unidades: 1 }])
  })

  it('con un apunte todavía en la cola, se le sube la cantidad al mismo', () => {
    // Cinco cables tienen que llegar como un asiento de cinco, no como cinco
    // asientos de uno: es lo que se lee después en el histórico de la sala.
    const a = [consumo('m1', 2, 'en_cola')]
    expect(planSumar(a, CABLE)).toEqual([{ tipo: 'editar', id: 'm1', qty: -3 }])
  })

  it('si el apunte ya subió, no se toca: se abre otro', () => {
    expect(planSumar([consumo('m1', 2, 'arriba')], CABLE)).toEqual([
      { tipo: 'consumo', unidades: 1 },
    ])
  })

  it('y si está saliendo, tampoco se toca', () => {
    // Cambiarlo a mitad de vuelo es una carrera que se puede perder.
    expect(planSumar([consumo('m1', 2, 'saliendo')], CABLE)).toEqual([
      { tipo: 'consumo', unidades: 1 },
    ])
  })
})

describe('restar una unidad', () => {
  it('baja la cantidad del apunte que sigue en la cola', () => {
    expect(planRestar([consumo('m1', 3, 'en_cola')], CABLE)).toEqual([
      { tipo: 'editar', id: 'm1', qty: -2 },
    ])
  })

  it('si era la última unidad, el apunte se borra de la cola', () => {
    // No llegó a salir: no es devolver nada, es que no ocurrió.
    expect(planRestar([consumo('m1', 1, 'en_cola')], CABLE)).toEqual([
      { tipo: 'borrar', id: 'm1' },
    ])
  })

  it('si ya subió, se devuelve una al almacén', () => {
    expect(planRestar([consumo('m1', 3, 'arriba')], CABLE)).toEqual([
      { tipo: 'devolucion', unidades: 1 },
    ])
  })

  it('y no se resta de lo que ya está a cero', () => {
    const a = [consumo('m1', 1, 'arriba'), devolucion('m2', 1, 'arriba')]
    expect(planRestar(a, CABLE)).toEqual([])
  })
})

describe('quitar el artículo entero', () => {
  it('lo que no ha salido se borra', () => {
    expect(planQuitar([consumo('m1', 4, 'en_cola')], CABLE)).toEqual([
      { tipo: 'borrar', id: 'm1' },
    ])
  })

  it('lo que ya subió se devuelve', () => {
    expect(planQuitar([consumo('m1', 4, 'arriba')], CABLE)).toEqual([
      { tipo: 'devolucion', unidades: 4 },
    ])
  })

  it('y una línea a medias hace las dos cosas, cada una por lo suyo', () => {
    /*
     * El caso real: dos cables que subieron esta mañana y un tercero apuntado
     * hace un minuto en un aula sin cobertura. Borrar los tres de la cola
     * dejaría dos descontados para siempre; devolver tres le regalaría uno al
     * almacén.
     */
    const a = [consumo('m1', 2, 'arriba'), consumo('m2', 1, 'en_cola')]
    expect(planQuitar(a, CABLE)).toEqual([
      { tipo: 'borrar', id: 'm2' },
      { tipo: 'devolucion', unidades: 2 },
    ])
  })

  it('lo que está saliendo cuenta como subido', () => {
    const a = [consumo('m1', 2, 'saliendo')]
    expect(planQuitar(a, CABLE)).toEqual([{ tipo: 'devolucion', unidades: 2 }])
  })

  it('y lo ya devuelto no se devuelve dos veces', () => {
    const a = [consumo('m1', 3, 'arriba'), devolucion('m2', 1, 'arriba')]
    expect(planQuitar(a, CABLE)).toEqual([{ tipo: 'devolucion', unidades: 2 }])
  })

  it('un artículo que no está en la avería no hace nada', () => {
    expect(planQuitar([consumo('m1', 1, 'arriba')], REGLETA)).toEqual([])
  })
})
