/**
 * El fallo que estas pruebas existen para impedir tiene una víctima concreta: el
 * almacén.
 *
 * «Stock Disponible» es una fórmula, `=P8-N8`, y es la celda contra la que —
 * cuando manda el Excel— la aplicación cuadra el almacén con un ajuste. El
 * fichero trae ese resultado guardado de la última vez que alguien abrió el
 * libro con Excel, y la aplicación escribe en `P` y en los meses de los que
 * depende `N`, así que el número guardado se queda viejo en cuanto hay una
 * pasada. En el libro de hoy: `O8` dice 19 y `P8−N8` es 54−9 = 45.
 *
 * Cuadrar el almacén contra el 19 borra veintiséis cables y no lo ve nadie.
 */
import { describe, expect, it } from 'vitest'

import { calcular, conFormulasAlDia } from './formulas'
import type { FilaLeida } from './xlsx'

/** Una fila de hoja: `{ A: 3, B: '=A1*2' }` — lo que empieza por `=` es fórmula. */
function fila(n: number, celdas: Record<string, string | number | boolean>): FilaLeida {
  const valores: FilaLeida['celdas'] = {}
  const formulas: Record<string, string> = {}
  for (const [col, v] of Object.entries(celdas)) {
    if (typeof v === 'string' && v.startsWith('=')) formulas[col] = v.slice(1)
    else valores[col] = v
  }
  return { fila: n, celdas: valores, formulas }
}

/** Una fila cuyo valor guardado es una cosa y su fórmula otra: el caso real. */
function conCache(n: number, col: string, formula: string, cacheado: number): FilaLeida {
  return { fila: n, celdas: { [col]: cacheado }, formulas: { [col]: formula } }
}

const hojaDe = (...filas: FilaLeida[]) => new Map(filas.map((f) => [f.fila, f]))

describe('calcular una celda de fórmula', () => {
  it('no se cree el valor guardado: rehace la resta', () => {
    // El caso del libro de hoy, fila 8: O8 trae un 19 de cuando P8 valía 28.
    const hoja = hojaDe({
      fila: 8,
      celdas: { N: 9, O: 19, P: 54 },
      formulas: { N: 'B8+C8+D8+E8+F8+G8+H8+I8+J8+K8+L8+M8', O: 'P8-N8' },
    })
    // Y N8 también miente: los meses que quedan suman 4, no 9.
    expect(calcular('N8', hoja)).toBe(0)
    expect(calcular('O8', hoja)).toBe(54)
  })

  it('una fórmula que depende de otra se resuelve entera', () => {
    const hoja = hojaDe(fila(8, { I: 2, J: 2, N: '=I8+J8', O: '=P8-N8', P: 54 }))
    expect(calcular('O8', hoja)).toBe(50)
  })

  it('una celda vacía vale cero, como en Excel', () => {
    const hoja = hojaDe(fila(2, { C: 2, N: '=B2+C2+D2' }))
    expect(calcular('N2', hoja)).toBe(2)
  })

  it('una celda que no está en la hoja también', () => {
    expect(calcular('N9', hojaDe(fila(2, { A: 1 })))).toBe(0)
  })

  it('multiplica, y `*` va antes que `+`', () => {
    const hoja = hojaDe(fila(3, { A: 2, B: 3, C: 4, Q: '=A3+B3*C3' }))
    expect(calcular('Q3', hoja)).toBe(14)
  })

  it('los paréntesis mandan', () => {
    const hoja = hojaDe(fila(3, { A: 2, B: 3, C: 4, Q: '=(A3+B3)*C3' }))
    expect(calcular('Q3', hoja)).toBe(20)
  })

  it('resuelve un `SUM` de rango', () => {
    const hoja = hojaDe(fila(5, { B: 1, C: 2, E: 4, N: '=SUM(B5:M5)' }))
    expect(calcular('N5', hoja)).toBe(7)
  })

  it('y un `SUM` de celdas sueltas', () => {
    const hoja = hojaDe(fila(5, { B: 1, C: 2, U: '=SUM(B5,C5)' }))
    expect(calcular('U5', hoja)).toBe(3)
  })

  it('`SUM` se salta el texto; una suma normal no se lo inventa', () => {
    // Excel hace exactamente esto: `SUM` ignora lo que no es número y `+` da
    // `#VALUE!`. Devolver 0 por el texto sería inventarse el resultado.
    const hoja = hojaDe(fila(5, { B: 1, C: 'roto', X: '=SUM(B5:C5)', Y: '=B5+C5' }))
    expect(calcular('X5', hoja)).toBe(1)
    expect(calcular('Y5', hoja)).toBeNull()
  })

  it('una referencia a otra fila se sigue hasta esa fila', () => {
    // La fila 35 de la bolsa apuntaba a la 34. Es un error de arrastre, pero lo
    // que la hoja enseña es lo que calcula esa fórmula, no lo que uno esperaba.
    const hoja = hojaDe(fila(34, { N: 3, P: 10 }), fila(35, { O: '=P34-N34', P: 99 }))
    expect(calcular('O35', hoja)).toBe(7)
  })

  it('un número negativo delante no la rompe', () => {
    expect(calcular('Q1', hojaDe(fila(1, { A: 5, Q: '=-A1+2' })))).toBe(-3)
  })
})

describe('lo que no se sabe calcular no se calcula', () => {
  const noSeSabe = (formula: string, extra: Record<string, string | number> = {}) =>
    calcular('Q1', hojaDe(fila(1, { A: 2, B: 3, Q: `=${formula}`, ...extra })))

  it('una función que no es SUM', () => {
    expect(noSeSabe('VLOOKUP(A1,B1:C9,2,0)')).toBeNull()
  })

  it('una hoja distinta', () => {
    expect(noSeSabe("'Bolsa 2025'!A1+1")).toBeNull()
  })

  it('una comparación', () => {
    expect(noSeSabe('A1>B1')).toBeNull()
  })

  it('un rango suelto sin SUM', () => {
    expect(noSeSabe('A1:B1')).toBeNull()
  })

  it('media fórmula entendida no vale: sobra texto detrás', () => {
    expect(noSeSabe('A1+B1 ???')).toBeNull()
  })

  it('dividir entre cero', () => {
    expect(noSeSabe('A1/C1')).toBeNull()
  })

  it('una fórmula que se llama a sí misma', () => {
    const hoja = hojaDe(fila(1, { A: '=B1+1', B: '=A1+1' }))
    expect(calcular('A1', hoja)).toBeNull()
  })

  it('y con eso el que pregunta se queda con el valor guardado', () => {
    // La regla entera: si no se entiende, todo sigue exactamente como estaba.
    const f: FilaLeida = { fila: 1, celdas: { Q: 7 }, formulas: { Q: 'VLOOKUP(A1,B:C,2,0)' } }
    const r = conFormulasAlDia([f])
    expect(r.corregidas).toEqual([])
    expect(r.filas[0]!.celdas.Q).toBe(7)
  })
})

describe('poner al día una hoja entera', () => {
  it('cambia el valor, deja la fórmula y dice lo que ha corregido', () => {
    const f = conCache(8, 'O', 'P8-N8', 19)
    f.celdas.P = 54
    f.celdas.N = 9
    const r = conFormulasAlDia([f])

    expect(r.filas[0]!.celdas.O).toBe(45)
    expect(r.filas[0]!.formulas?.O).toBe('P8-N8')
    expect(r.corregidas).toEqual([{ ref: 'O8', cacheado: 19, real: 45 }])
  })

  it('no toca las filas que ya estaban bien', () => {
    // Misma referencia, no una copia: una hoja de 300 filas con dos corregidas
    // no tiene por qué regenerar las 298 buenas.
    const f = conCache(22, 'O', 'P22-N22', 2)
    f.celdas.P = 2
    const r = conFormulasAlDia([f])
    expect(r.filas[0]).toBe(f)
    expect(r.corregidas).toEqual([])
  })

  it('ni las filas sin fórmulas', () => {
    const f = fila(3, { A: 'Ratón', B: 1 })
    expect(conFormulasAlDia([f]).filas[0]).toBe(f)
  })

  it('y las de entrada se quedan como estaban', () => {
    const f = conCache(8, 'O', 'P8-N8', 19)
    f.celdas.P = 54
    conFormulasAlDia([f])
    expect(f.celdas.O).toBe(19)
  })
})
