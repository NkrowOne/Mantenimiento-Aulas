import { describe, expect, it } from 'vitest'
import { salasQueCasan, type SalaBuscable } from './busqueda'

const SALAS: SalaBuscable[] = [
  { id: 'h17', edificio: 'H', codigo: '1.7', nombre: '1.7' },
  { id: 'h21', edificio: 'H', codigo: '2.1', nombre: 'Salón de grados' },
  { id: 'crai12', edificio: 'CRAI', codigo: '1.2', nombre: '1.2' },
  { id: 'c31', edificio: 'C', codigo: '3.1', nombre: '3.1' },
]

describe('salasQueCasan', () => {
  it('el edificio a secas trae el edificio entero, y solo ese', () => {
    // Es la búsqueda que motivó todo esto: «H» tiene que ser el edificio H —
    // su histórico completo, resueltas incluidas— y no cada sala con una hache.
    expect(salasQueCasan(SALAS, 'H')).toEqual(['h17', 'h21'])
  })

  it('un edificio no casa por subcadena: «C» no es media universidad', () => {
    expect(salasQueCasan(SALAS, 'C')).toEqual(['c31'])
    expect(salasQueCasan(SALAS, 'CRAI')).toEqual(['crai12'])
  })

  it('el código casa con y sin edificio, en los dos órdenes', () => {
    expect(salasQueCasan(SALAS, '1.7')).toEqual(['h17'])
    expect(salasQueCasan(SALAS, 'H 1.7')).toEqual(['h17'])
    // Como lo escribe el histórico importado: sala y luego edificio.
    expect(salasQueCasan(SALAS, '1.7 H')).toEqual(['h17'])
  })

  it('el nombre descriptivo también encuentra, normalizando tildes', () => {
    expect(salasQueCasan(SALAS, 'salon de grados')).toEqual(['h21'])
  })

  it('sin texto no casa nada: la lista vacía apaga el filtro de sala', () => {
    expect(salasQueCasan(SALAS, '  ')).toEqual([])
  })
})
