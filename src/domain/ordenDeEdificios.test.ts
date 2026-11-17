import { describe, expect, it } from 'vitest'
import { ordenarEdificios } from './ordenDeEdificios'

const e = (code: string, name = code): { code: string; name: string } => ({ code, name })

describe('el orden de los edificios', () => {
  it('va por el código, alfabético, y no por el orden en que llegaron', () => {
    // El orden del Excel, que es el que se veía.
    const delExcel = [e('P'), e('O'), e('M'), e('E'), e('C'), e('H'), e('EPS'), e('CRAI'), e('CD')]
    expect(ordenarEdificios(delExcel).map((b) => b.code)).toEqual([
      'C', 'CD', 'CRAI', 'E', 'EPS', 'H', 'M', 'O', 'P',
    ])
  })

  it('no distingue mayúsculas ni tildes, y los números van como números', () => {
    expect(ordenarEdificios([e('M10'), e('m2'), e('Ñ'), e('N')]).map((b) => b.code)).toEqual([
      'm2', 'M10', 'N', 'Ñ',
    ])
  })

  it('con el mismo código desempata el nombre: el orden no baila entre cargas', () => {
    const dos = [e('H', 'Hospital'), e('H', 'Edificio H')]
    expect(ordenarEdificios(dos).map((b) => b.name)).toEqual(['Edificio H', 'Hospital'])
    expect(ordenarEdificios([...dos].reverse()).map((b) => b.name)).toEqual(['Edificio H', 'Hospital'])
  })

  it('devuelve una copia: la lista de entrada no se toca', () => {
    const lista = [e('P'), e('C')]
    ordenarEdificios(lista)
    expect(lista.map((b) => b.code)).toEqual(['P', 'C'])
  })
})
