/**
 * La línea que lee el coordinador en la cuarentena.
 *
 * La pantalla pintaba el objeto entero con `Object.values(...).join(' · ')`, y
 * sobre una celda de material eso daba diez claves con el texto que importa en
 * la mitad y el array de renglones convertido en «[object Object]»: treinta
 * líneas idénticas de ruido en un móvil.
 */
import { describe, expect, it } from 'vitest'
import { resumenDelCrudo } from './CleanupPage'

describe('la línea de una fila de cuarentena', () => {
  it('pone delante el texto que no se pudo aplicar, no la clave interna', () => {
    // El crudo real de una celda de «Material Usado» rechazada.
    const crudo = {
      hoja: 'Material Instalado 2026',
      fila: 144,
      clave: 'I260810_0004',
      columna: 'G',
      campo: 'incidencia.material',
      valor: '1 lampara NP30',
      motivo: 'manda el Excel',
      anyo: 2026,
      arranque: '2026-08-01',
      detalle: [{ articulo_id: null, cantidad: 1, texto: '1 lampara NP30' }],
    }
    const linea = resumenDelCrudo(crudo)
    expect(linea.startsWith('1 lampara NP30')).toBe(true)
    expect(linea).not.toContain('[object Object]')
    expect(linea).toContain('Material Instalado 2026')
    expect(linea).toContain('144')
    // Y lo que no le dice nada a nadie, fuera.
    expect(linea).not.toContain('manda el Excel')
    expect(linea).not.toContain('2026-08-01')
  })

  it('un array de renglones se lee como los renglones, no como objetos', () => {
    const linea = resumenDelCrudo({
      detalle: [
        { articulo_id: null, texto: '2 lampara NP44' },
        { articulo_id: 'x', texto: '1 Cable HDMI fibra 10 m' },
      ],
    })
    expect(linea).toBe('2 lampara NP44, 1 Cable HDMI fibra 10 m')
  })

  it('una fila de la importación inicial, con otra forma, también se lee', () => {
    expect(resumenDelCrudo({ aula: '1.7 H', problema: 'No da imagen', fila: 88 })).toBe(
      '1.7 H · No da imagen · 88',
    )
  })

  it('y una fila sin nada que enseñar lo dice, en vez de quedarse en blanco', () => {
    expect(resumenDelCrudo({})).toBe('(sin contenido)')
    expect(resumenDelCrudo({ clave: 'solo ruido', motivo: 'y más ruido' })).toBe('(sin contenido)')
  })

  it('no repite un valor por salir en dos claves', () => {
    expect(resumenDelCrudo({ valor: 'uno', otra: 'dos' })).toBe('uno · dos')
  })
})
