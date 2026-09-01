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
import { filasDeLaPasada, paraLaInstantanea } from './pasada'
import type { Analisis } from './pasada'

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

describe('las filas que se mandan a `sync_filas`', () => {
  // El fallo real: «new row for relation "sync_filas" violates check constraint
  // "sync_filas_fila_check"», con la pasada entera perdida —1732 celdas— porque
  // el RPC es una transacción y una sola fila mala se lo lleva todo.
  const plan = (hoja: string, instantanea: Array<{ clave: string; fila: number; letra: string; valor: unknown }>) =>
    ({ hoja, instantanea }) as unknown as Analisis['planes'][number]

  it('una fila nueva no viaja: no estaba en el libro, no tiene procedencia', () => {
    // `anotarCeldaNueva` marca con `fila: 0` las celdas de las salas que la
    // aplicación tiene y el libro todavía no.
    const filas = filasDeLaPasada([
      plan('Estado Aulas y Salas de reunion', [
        { clave: 'SALA-000001', fila: 5, letra: 'C', valor: '1.2' },
        { clave: 'SALA-000900', fila: 0, letra: 'C', valor: '9.9' },
        { clave: 'SALA-000901', fila: 0, letra: 'C', valor: '9.8' },
      ]),
    ])
    expect(filas.every((f) => f.fila > 0)).toBe(true)
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ fila: 5, ref: 'SALA-000001' })
  })

  it('y no se funden todas las nuevas en una «fila 0» con los datos mezclados', () => {
    // Antes se agrupaba solo por número de fila: las de dos salas distintas
    // caían en el mismo grupo, con el `ref` de la primera y el `contenido` de
    // las dos. Un registro de procedencia que describe una fila que no existe.
    const filas = filasDeLaPasada([
      plan('Estado Aulas y Salas de reunion', [
        { clave: 'SALA-000900', fila: 0, letra: 'C', valor: '9.9' },
        { clave: 'SALA-000901', fila: 0, letra: 'C', valor: '9.8' },
      ]),
    ])
    expect(filas).toEqual([])
  })

  it('las celdas de una misma fila se juntan en una sola, con todas sus columnas', () => {
    const filas = filasDeLaPasada([
      plan('Bolsa 2026', [
        { clave: 'ART-1', fila: 7, letra: 'A', valor: 'Cable HDMI' },
        { clave: 'ART-1', fila: 7, letra: 'N', valor: 3 },
        { clave: 'ART-2', fila: 8, letra: 'A', valor: 'Pantalla' },
      ]),
    ])
    expect(filas).toEqual([
      { hoja: 'Bolsa 2026', fila: 7, ref: 'ART-1', contenido: { A: 'Cable HDMI', N: 3 } },
      { hoja: 'Bolsa 2026', fila: 8, ref: 'ART-2', contenido: { A: 'Pantalla' } },
    ])
  })

  it('cada hoja va por su cuenta: dos hojas pueden tener la misma fila 7', () => {
    const filas = filasDeLaPasada([
      plan('Bolsa 2026', [{ clave: 'ART-1', fila: 7, letra: 'A', valor: 'x' }]),
      plan('Bolsa 2025', [{ clave: 'ART-9', fila: 7, letra: 'A', valor: 'y' }]),
    ])
    expect(filas.map((f) => `${f.hoja}|${f.fila}`)).toEqual(['Bolsa 2026|7', 'Bolsa 2025|7'])
  })
})
