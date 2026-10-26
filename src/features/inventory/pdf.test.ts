import { afterEach, describe, expect, it, vi } from 'vitest'
import { documentoDeLaHoja, esAppInstalada, nombreDelPdf } from './pdf'

/**
 * El PDF de la hoja de inventario sale del servidor, como el del informe.
 *
 * En la app instalada en el iPhone no hay diálogo de imprimir, y la ventana
 * propia que se probó antes dejaba encerrado a quien la abría. Lo que viaja al
 * servidor es la propia hoja, sin la interfaz y con su hoja de estilo dentro:
 * WeasyPrint no ve las de la aplicación.
 *
 * Las pruebas corren en Node, sin DOM: la hoja es un objeto con lo justo que la
 * función toca.
 */

const TABLA =
  '<div class="hoja-inventario"><table><tbody><tr><td>Puesto 1</td></tr><tr><td>Puesto 2</td></tr></tbody></table></div>'

function contenedor(): { quitados: number; el: HTMLElement } {
  const estado = { quitados: 0, el: null as unknown as HTMLElement }
  const copia = {
    querySelectorAll: (sel: string) => (sel === '.solo-pantalla' ? [{ remove: () => (estado.quitados += 1) }] : []),
    outerHTML: TABLA,
  }
  const hoja = { cloneNode: () => copia }
  estado.el = { querySelector: (sel: string) => (sel === '.hoja-inventario' ? hoja : null) } as unknown as HTMLElement
  return estado
}

afterEach(() => vi.unstubAllGlobals())

describe('el PDF de la hoja de inventario', () => {
  it('sabe si está en la app instalada', () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('window', { matchMedia: (q: string) => ({ matches: q.includes('standalone') }) })
    expect(esAppInstalada()).toBe(true)
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    expect(esAppInstalada()).toBe(false)
  })

  it('el documento lleva la tabla y su estilo dentro, y nada de la interfaz', () => {
    const c = contenedor()
    const html = documentoDeLaHoja(c.el, 'Inventario de E 0.6')
    expect(html).toContain('<td>Puesto 1</td>')
    expect(html).toContain('<td>Puesto 2</td>')
    expect(c.quitados).toBe(1)
    expect(html).toContain('<title>Inventario de E 0.6</title>')
    // Autocontenido: el servidor no puede pedir las hojas de estilo de la app.
    expect(html).not.toMatch(/<link\b/)
    expect(html).toContain('@page { size: A4 landscape')
    expect(html).toContain('thead { display: table-header-group; }')
  })

  it('nombra el fichero de forma que se lea en Archivos', () => {
    expect(nombreDelPdf('E 0.6 · Laboratorio informática 6', '2026-10-26T15:00:00Z')).toBe(
      'Inventario-E-0.6-Laboratorio-informatica-6-2026-10-26.pdf',
    )
  })
})
