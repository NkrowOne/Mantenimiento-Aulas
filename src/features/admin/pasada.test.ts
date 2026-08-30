/**
 * Lo que la pasada guarda como antepasado.
 *
 * `sync_celdas.valor_base` es una columna `text` y la fusión compara con
 * `canonizar`. Si lo que se guarda no vuelve canonizándose igual que la celda,
 * el antepasado no coincide con nada y la fusión cree que los dos lados se
 * movieron: choque permanente en una celda que nadie tocó.
 */
import { describe, expect, it } from 'vitest'

import { canonizar } from '@/domain/fusion'
import { paraLaInstantanea } from './pasada'

describe('el antepasado que se guarda', () => {
  it('un sí/no se guarda como lo canoniza la fusión, no como «true»', () => {
    expect(paraLaInstantanea(true)).toBe('SI')
    expect(paraLaInstantanea(false)).toBe('NO')
    // Lo que importa de verdad: que al volver de la columna `text` siga
    // diciendo lo mismo que la celda.
    expect(canonizar(paraLaInstantanea(true))).toBe(canonizar(true))
    expect(canonizar(paraLaInstantanea(false))).toBe(canonizar(false))
    expect(canonizar('true')).not.toBe(canonizar(true))
  })

  it('un número vuelve igual', () => {
    expect(canonizar(paraLaInstantanea(4200))).toBe(canonizar(4200))
    expect(canonizar(paraLaInstantanea(0.86))).toBe(canonizar(0.86))
  })

  it('un texto se guarda tal cual, que es lo que se lee en la bandeja', () => {
    expect(paraLaInstantanea('Cámara Aver')).toBe('Cámara Aver')
    expect(canonizar(paraLaInstantanea('Cámara Aver'))).toBe(canonizar('Cámara Aver'))
  })

  it('vacío es vacío', () => {
    expect(paraLaInstantanea(null)).toBeNull()
    expect(canonizar(paraLaInstantanea(''))).toBe(canonizar(null))
  })
})
