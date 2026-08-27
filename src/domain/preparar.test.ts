import { describe, expect, it } from 'vitest'
import { construirIndice } from './cruce'
import type { Catalogo, SalaConocida } from './cruce'
import { columnaParaLaRef, prepararHojaDeEstado } from './preparar'
import type { FilaLeida } from './xlsx'

function sala(p: Partial<SalaConocida> & { code: string; edificioCodigo: string; shortRef: string }): SalaConocida {
  return {
    id: `id-${p.shortRef}`,
    name: p.name ?? p.code,
    active: true,
    zona: 'PLANTA BAJA',
    edificioNombre: p.edificioNombre ?? `EDIFICIO ${p.edificioCodigo}`,
    edificioActivo: true,
    alias: [],
    ...p,
  }
}

const CATALOGO: Catalogo = {
  salas: [
    sala({ code: '0.1', edificioCodigo: 'P', shortRef: 'SALA-000001' }),
    sala({ code: '0.2', edificioCodigo: 'P', shortRef: 'SALA-000002' }),
    sala({ code: '1.4', edificioCodigo: 'H', shortRef: 'SALA-000003' }),
    sala({ code: '1.4', edificioCodigo: 'M', shortRef: 'SALA-000004' }),
  ],
  edificios: [
    { codigo: 'P', nombre: 'EDIFICIO P', activo: true },
    { codigo: 'H', nombre: 'EDIFICIO H', activo: true },
    { codigo: 'M', nombre: 'EDIFICIO M', activo: true },
    { codigo: 'S', nombre: 'Edificio S (sin identificar)', activo: true, sinIdentificar: true },
  ],
}
const IX = construirIndice(CATALOGO)

/** La hoja de estado real: edificio y planta solo en la primera fila del grupo. */
const HOJA: FilaLeida[] = [
  { fila: 1, celdas: { A: 'EDIFICIO', B: 'PLANTA', C: 'AULA', D: 'PROYECTOR' } },
  { fila: 2, celdas: { A: 'EDIFICIO P', B: 'PLANTA BAJA', C: '0.1', D: 'EPSON' } },
  { fila: 3, celdas: { C: '0.2' } },
  { fila: 4, celdas: { A: 'EDIFICIO H', B: '1ª PLANTA', C: '1.4' } },
]

describe('dónde va la columna de matrículas', () => {
  it('la primera libre por la derecha, sin desplazar nada', () => {
    // Insertarla a la izquierda obligaría a reescribir cada referencia de la
    // hoja: fórmulas, autofiltro, formatos condicionales y validación.
    expect(columnaParaLaRef(HOJA, 1, 'Ref')).toBe('E')
  })

  it('si ya existe una columna con ese título, se reutiliza', () => {
    const con: FilaLeida[] = [{ fila: 1, celdas: { A: 'EDIFICIO', C: 'AULA', G: 'Ref' } }, ...HOJA.slice(1)]
    expect(columnaParaLaRef(con, 1, 'Ref')).toBe('G')
  })

  it('preparar dos veces el mismo libro no deja dos columnas', () => {
    const p1 = prepararHojaDeEstado(HOJA, IX)
    const yaPuesta: FilaLeida[] = HOJA.map((f) => ({
      ...f,
      celdas: {
        ...f.celdas,
        ...(f.fila === 1
          ? { [p1.columna]: 'Ref' }
          : { [p1.columna]: p1.escrituras.find((e) => e.fila === f.fila)?.valor ?? '' }),
      },
    }))
    const p2 = prepararHojaDeEstado(yaPuesta, IX)
    expect(p2.columna).toBe(p1.columna)
    expect(p2.cambios).toHaveLength(0)
    expect(p2.yaCorrectas).toBe(p1.escrituras.length)
  })
})

describe('las celdas combinadas de edificio y planta', () => {
  it('el edificio de arriba vale para las filas de debajo', () => {
    const p = prepararHojaDeEstado(HOJA, IX)
    // La fila 3 solo lleva `0.2`: sin arrastrar el edificio no cruzaría.
    expect(p.escrituras.find((e) => e.fila === 3)?.valor).toBe('SALA-000002')
  })

  it('las tres filas cruzan y ninguna se queda fuera', () => {
    const p = prepararHojaDeEstado(HOJA, IX)
    expect(p.total).toBe(3)
    expect(p.escrituras).toHaveLength(3)
    expect(p.sinCruce).toHaveLength(0)
  })

  it('la cabecera se escribe una vez, con la primera matrícula', () => {
    const p = prepararHojaDeEstado(HOJA, IX)
    expect(p.cambios[0]).toEqual({ celda: `${p.columna}1`, valor: 'Ref' })
    expect(p.cambios).toHaveLength(4)
  })
})

describe('lo que no se puede resolver no se inventa', () => {
  it('un aula ambigua se cuenta aparte y no se escribe', () => {
    const conAmbigua: FilaLeida[] = [
      HOJA[0]!,
      { fila: 2, celdas: { A: 'EDIFICIO S', B: 'PLANTA BAJA', C: '1.4' } },
    ]
    const p = prepararHojaDeEstado(conAmbigua, IX)
    expect(p.ambiguas).toHaveLength(1)
    expect(p.escrituras).toHaveLength(0)
  })

  it('un aula que no existe dice por qué', () => {
    const conFalla: FilaLeida[] = [
      HOJA[0]!,
      { fila: 2, celdas: { A: 'EDIFICIO P', B: 'PLANTA BAJA', C: '9.9' } },
    ]
    const p = prepararHojaDeEstado(conFalla, IX)
    expect(p.sinCruce).toHaveLength(1)
    expect(p.sinCruce[0]!.motivo).toContain('9.9')
  })

  it('las filas sin aula no cuentan como nada', () => {
    const conHueco: FilaLeida[] = [HOJA[0]!, { fila: 2, celdas: { A: 'EDIFICIO P' } }]
    expect(prepararHojaDeEstado(conHueco, IX).total).toBe(0)
  })
})

describe('una matrícula que ya estaba', () => {
  it('si coincide, no se reescribe', () => {
    const conRef: FilaLeida[] = [
      { fila: 1, celdas: { A: 'EDIFICIO', C: 'AULA', E: 'Ref' } },
      { fila: 2, celdas: { A: 'EDIFICIO P', C: '0.1', E: 'SALA-000001' } },
    ]
    const p = prepararHojaDeEstado(conRef, IX)
    expect(p.yaCorrectas).toBe(1)
    expect(p.cambios).toHaveLength(0)
  })

  it('si NO coincide, no se pisa: es la única señal de que algo no cuadra', () => {
    const conOtra: FilaLeida[] = [
      { fila: 1, celdas: { A: 'EDIFICIO', C: 'AULA', E: 'Ref' } },
      { fila: 2, celdas: { A: 'EDIFICIO P', C: '0.1', E: 'SALA-999999' } },
    ]
    const p = prepararHojaDeEstado(conOtra, IX)
    expect(p.discrepan).toHaveLength(1)
    expect(p.discrepan[0]!.actual).toBe('SALA-999999')
    expect(p.discrepan[0]!.valor).toBe('SALA-000001')
    expect(p.cambios).toHaveLength(0)
  })
})
