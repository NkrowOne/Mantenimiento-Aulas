import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  BOLSA_2025,
  BOLSA_2026,
  ESTADO,
  HOJAS,
  MATERIAL_2025,
  MATERIAL_2026,
  capacidadDe,
  columna,
  columnaDeCampo,
  comprobarCabeceras,
  equipoDe,
  hojasDelAnyo,
  mesDe,
} from './mapa'
import { abrirLibro, leerHoja } from './xlsx'

const LIBRO = process.env.LIBRO_XLSX
const bytes = LIBRO ? readFileSync(LIBRO) : null

describe('el mapa', () => {
  it('no repite letras dentro de una hoja', () => {
    for (const hoja of HOJAS) {
      const letras = hoja.columnas.map((c) => c.letra)
      expect(new Set(letras).size, hoja.nombre).toBe(letras.length)
    }
  })

  it('no repite campos dentro de una hoja', () => {
    for (const hoja of HOJAS) {
      const campos = hoja.columnas.map((c) => c.campo)
      expect(new Set(campos).size, hoja.nombre).toBe(campos.length)
    }
  })

  it('las letras van en orden y sin saltos', () => {
    for (const hoja of HOJAS) {
      const nums = hoja.columnas.map((c) => c.letra.charCodeAt(0) - 64)
      expect(nums, hoja.nombre).toEqual(nums.map((_, i) => i + 1))
    }
  })

  it('toda columna de medida dice de dónde saca la fecha', () => {
    for (const hoja of HOJAS) {
      for (const c of hoja.columnas) {
        if (c.dueno === 'medida') expect(c.fechaDe, `${hoja.nombre}!${c.letra}`).toBeTruthy()
      }
    }
  })

  it('las columnas de fórmula de la hoja viva traen la fórmula que les toca', () => {
    for (const c of BOLSA_2026.columnas) {
      if (c.dueno === 'formula') expect(c.formula, c.letra).toContain('{f}')
    }
  })

  it('las hojas de 2025 están congeladas y las de 2026 no', () => {
    expect(MATERIAL_2025.congelada).toBe(true)
    expect(BOLSA_2025.congelada).toBe(true)
    expect(MATERIAL_2026.congelada).toBeUndefined()
    expect(BOLSA_2026.congelada).toBeUndefined()
  })

  it('la hoja de 2025 lleva una columna más y por eso las letras bailan', () => {
    // Es el fallo que la comprobación de cabeceras existe para pillar.
    expect(columnaDeCampo(MATERIAL_2026, 'incidencia.material')!.letra).toBe('G')
    expect(columnaDeCampo(MATERIAL_2025, 'incidencia.material')!.letra).toBe('H')
    expect(columnaDeCampo(MATERIAL_2025, 'incidencia.observacion')!.letra).toBe('F')
    expect(columnaDeCampo(MATERIAL_2026, 'incidencia.observacion')).toBeUndefined()
  })

  it('los doce meses están, y en su sitio', () => {
    const meses = BOLSA_2026.columnas.filter((c) => mesDe(c.campo) !== null)
    expect(meses).toHaveLength(12)
    expect(meses.map((c) => c.letra)).toEqual('BCDEFGHIJKLM'.split(''))
    expect(mesDe(columna(BOLSA_2026, 'C')!.campo)).toBe(2)
  })

  it('sabe leer las columnas de equipo y de capacidad', () => {
    expect(equipoDe('equipo:Proyector:serial')).toEqual({ tipo: 'Proyector', campo: 'serial' })
    expect(equipoDe('equipo:Panacast 50:serial')).toEqual({ tipo: 'Panacast 50', campo: 'serial' })
    expect(equipoDe('capacidad:altavoces')).toBeNull()
    expect(capacidadDe('capacidad:altavoces')).toBe('altavoces')
    expect(mesDe('mes:12')).toBe(12)
  })

  it('el nombre de las hojas del año se arma solo', () => {
    expect(hojasDelAnyo(2027)).toEqual({
      material: 'Material Instalado 2027',
      bolsa: 'Bolsa 2027',
    })
  })
})

describe('la comprobación de cabeceras', () => {
  it('perdona mayúsculas, tildes y espacios de sobra', () => {
    expect(
      comprobarCabeceras(ESTADO, cabeceras({ A: ' edificio ', B: 'PLANTA/MODULO', C: 'aulas' })),
    ).toHaveLength(0)
  })

  it('perdona el espacio duro, que es invisible', () => {
    expect(comprobarCabeceras(ESTADO, cabeceras({ A: 'EDIFICIO ' }))).toHaveLength(0)
  })

  it('pilla una columna insertada, que es para lo que está', () => {
    // Alguien mete una columna delante de `S/N Proyector`: todo se corre una.
    const desplazadas = cabeceras({ M: 'Modelo Proyector', N: 'S/N Proyector' })
    const fuera = comprobarCabeceras(ESTADO, desplazadas)
    expect(fuera.map((f) => f.letra)).toContain('M')
    expect(fuera.find((f) => f.letra === 'M')).toMatchObject({
      esperada: 'S/N Proyector',
      encontrada: 'Modelo Proyector',
    })
  })

  it('una cabecera que falta también se dice', () => {
    const sinX = cabeceras({})
    delete sinX.X
    expect(comprobarCabeceras(ESTADO, sinX).map((f) => f.letra)).toContain('X')
  })
})

/** Las cabeceras que declara el mapa, con los cambios que se pidan. */
function cabeceras(cambios: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of ESTADO.columnas) out[c.letra] = c.cabecera
  return { ...out, ...cambios }
}

describe.skipIf(!bytes)('contra el libro real', () => {
  it('las cinco hojas del mapa son las cinco del libro', async () => {
    const l = await abrirLibro(new Uint8Array(bytes!))
    expect(l.hojas.map((h) => h.nombre).sort()).toEqual(HOJAS.map((h) => h.nombre).sort())
  })

  it('todas las cabeceras declaradas están donde dice el mapa', async () => {
    const l = await abrirLibro(new Uint8Array(bytes!))
    for (const hoja of HOJAS) {
      const filas = await leerHoja(l, hoja.nombre)
      const cab = filas.find((f) => f.fila === hoja.cabecera)!
      const fuera = comprobarCabeceras(hoja, cab.celdas)
      expect(fuera, `${hoja.nombre}: ${JSON.stringify(fuera)}`).toEqual([])
    }
  })

  it('el mapa no se deja ninguna columna con datos sin declarar', async () => {
    const l = await abrirLibro(new Uint8Array(bytes!))
    for (const hoja of HOJAS) {
      const filas = await leerHoja(l, hoja.nombre)
      const cab = filas.find((f) => f.fila === hoja.cabecera)!
      const conCabecera = Object.entries(cab.celdas)
        .filter(([, v]) => String(v ?? '').trim() !== '')
        .map(([k]) => k)
      const declaradas = new Set(hoja.columnas.map((c) => c.letra))
      expect(conCabecera.filter((c) => !declaradas.has(c)), hoja.nombre).toEqual([])
    }
  })
})
