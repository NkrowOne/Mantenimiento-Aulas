import { describe, expect, it } from 'vitest'
import { proponerSala, type EdificioDelMaestro, type SalaDelMaestro } from './propuesta'

const EDIFICIOS: EdificioDelMaestro[] = [
  { id: 'H', code: 'H' },
  { id: 'C', code: 'C' },
  { id: 'CRAI', code: 'CRAI' },
]

const SALAS: SalaDelMaestro[] = [
  { id: 'h17', buildingId: 'H', codigo: '1.7' },
  { id: 'h117', buildingId: 'H', codigo: '11.7' },
  { id: 'c17', buildingId: 'C', codigo: '1.7' },
  { id: 'crai-13', buildingId: 'CRAI', codigo: '-1.3' },
  { id: 'h54', buildingId: 'H', codigo: '5.4' },
]

describe('proponerSala', () => {
  it('«1.7 H», como lo escribe el histórico, es la 1.7 del H', () => {
    expect(proponerSala('1.7 H', SALAS, EDIFICIOS)).toEqual({ buildingId: 'H', roomId: 'h17' })
  })

  it('también con el edificio delante, en minúsculas y con coma', () => {
    expect(proponerSala('h 1,7', SALAS, EDIFICIOS)).toEqual({ buildingId: 'H', roomId: 'h17' })
  })

  it('el código casa entero: «1.7» no es «11.7»', () => {
    expect(proponerSala('11.7 H', SALAS, EDIFICIOS)).toEqual({ buildingId: 'H', roomId: 'h117' })
  })

  it('quita los adornos del histórico: sótano y nombre entre paréntesis', () => {
    expect(proponerSala('Sotano -1.3 CRAI', SALAS, EDIFICIOS)).toEqual({
      buildingId: 'CRAI',
      roomId: 'crai-13',
    })
    expect(proponerSala('5.4 (LAB 3D) H', SALAS, EDIFICIOS)).toEqual({
      buildingId: 'H',
      roomId: 'h54',
    })
  })

  it('si el edificio existe y la sala no, propone solo el edificio', () => {
    expect(proponerSala('9.9 H', SALAS, EDIFICIOS)).toEqual({ buildingId: 'H', roomId: '' })
  })

  it('sin edificio no propone nada: «1.7» está en dos', () => {
    expect(proponerSala('1.7', SALAS, EDIFICIOS)).toBeNull()
  })

  it('un edificio que el maestro no conoce no se adivina', () => {
    expect(proponerSala('0.1 BC', SALAS, EDIFICIOS)).toBeNull()
    expect(proponerSala('Ventanilla Única', SALAS, EDIFICIOS)).toBeNull()
  })

  it('con dos salas del mismo código en el edificio, no elige', () => {
    const repetida = [...SALAS, { id: 'h17b', buildingId: 'H', codigo: '1.7' }]
    expect(proponerSala('1.7 H', repetida, EDIFICIOS)).toEqual({ buildingId: 'H', roomId: '' })
  })

  it('sin texto, nada', () => {
    expect(proponerSala(null, SALAS, EDIFICIOS)).toBeNull()
    expect(proponerSala('  ', SALAS, EDIFICIOS)).toBeNull()
  })
})
