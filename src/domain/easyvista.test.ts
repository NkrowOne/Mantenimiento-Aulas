import { describe, expect, it } from 'vitest'
import {
  CODIGO_EASYVISTA_MAX,
  normalizarCodigoEasyVista,
  problemaDeCodigoEasyVista,
} from './easyvista'

describe('normalizarCodigoEasyVista', () => {
  it('recorta y pasa a mayúsculas: el código es el mismo se teclee como se teclee', () => {
    expect(normalizarCodigoEasyVista('  i260916_0042 ')).toBe('I260916_0042')
  })

  it('sin nada escrito no hay código, y eso es lo normal', () => {
    expect(normalizarCodigoEasyVista('')).toBeNull()
    expect(normalizarCodigoEasyVista('   ')).toBeNull()
    expect(normalizarCodigoEasyVista(null)).toBeNull()
    expect(normalizarCodigoEasyVista(undefined)).toBeNull()
  })
})

describe('problemaDeCodigoEasyVista', () => {
  it('vacío vale: el código es opcional en las tres puertas', () => {
    expect(problemaDeCodigoEasyVista('')).toBeNull()
    expect(problemaDeCodigoEasyVista('  ')).toBeNull()
  })

  it('acepta la numeración de EasyVista tal cual, y también otros prefijos', () => {
    expect(problemaDeCodigoEasyVista('I260916_0042')).toBeNull()
    expect(problemaDeCodigoEasyVista('S260121_0107')).toBeNull()
    expect(problemaDeCodigoEasyVista('EV-2026-000123')).toBeNull()
  })

  it('un espacio dentro es dos cosas, no un código', () => {
    expect(problemaDeCodigoEasyVista('I260916 0042')).toMatch(/espacios/)
  })

  it('lo que no cabe en una etiqueta no es un código', () => {
    expect(problemaDeCodigoEasyVista('X'.repeat(CODIGO_EASYVISTA_MAX))).toBeNull()
    expect(problemaDeCodigoEasyVista('X'.repeat(CODIGO_EASYVISTA_MAX + 1))).toMatch(/caracteres/)
  })
})
