import { describe, expect, it } from 'vitest'
import { MOTIVO_MIN, faltanParaElMotivo, motivoValido } from './motivo'

describe('motivo de una retirada o una baja', () => {
  it('exige diez caracteres sin contar los espacios de los extremos', () => {
    expect(MOTIVO_MIN).toBe(10)
    expect(motivoValido('')).toBe(false)
    expect(motivoValido('roto')).toBe(false)
    expect(motivoValido('   roto     ')).toBe(false)
    expect(motivoValido('123456789')).toBe(false)
    expect(motivoValido('1234567890')).toBe(true)
    expect(motivoValido('  Pantalla rota, sin arreglo  ')).toBe(true)
  })

  it('dice cuántos faltan, y cero cuando ya vale', () => {
    expect(faltanParaElMotivo('')).toBe(10)
    expect(faltanParaElMotivo('roto')).toBe(6)
    expect(faltanParaElMotivo('  roto  ')).toBe(6)
    expect(faltanParaElMotivo('1234567890')).toBe(0)
    expect(faltanParaElMotivo('más que suficiente para explicarlo')).toBe(0)
  })
})
