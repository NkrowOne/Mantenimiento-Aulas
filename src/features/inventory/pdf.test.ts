import { afterEach, describe, expect, it, vi } from 'vitest'
import { descargarPdf, documentoDeLaHoja, esAppInstalada } from './pdf'

/**
 * «Descargar PDF» en la app instalada en el iPhone.
 *
 * Allí `window.print()` no hace nada: el botón parecía muerto. En la app
 * instalada la hoja sale a una ventana propia, que sí tiene diálogo de
 * imprimir; en el navegador normal se sigue imprimiendo en el sitio.
 *
 * Las pruebas corren en Node, sin DOM: la hoja es un objeto con lo justo que la
 * función toca —clonarse, buscar la interfaz para quitarla y dar su HTML—.
 */

const TABLA = '<div class="hoja-inventario"><table><tbody><tr><td>Puesto 1</td></tr><tr><td>Puesto 2</td></tr></tbody></table></div>'

function hoja(): { quitados: number; el: HTMLElement } {
  const estado = { quitados: 0, el: null as unknown as HTMLElement }
  const copia = {
    querySelectorAll: (sel: string) => (sel === '.solo-pantalla' ? [{ remove: () => (estado.quitados += 1) }] : []),
    outerHTML: TABLA,
  }
  estado.el = { cloneNode: () => copia } as unknown as HTMLElement
  return estado
}

function entorno(instalada: boolean, abrir: () => unknown = () => null): { print: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> } {
  const print = vi.fn()
  const open = vi.fn(abrir)
  vi.stubGlobal('window', {
    matchMedia: (q: string) => ({ matches: instalada && q.includes('standalone'), media: q }),
    location: { origin: 'https://aulas.example' },
    print,
    open,
  })
  vi.stubGlobal('navigator', {})
  vi.stubGlobal('document', { querySelectorAll: () => [{ outerHTML: '<link rel="stylesheet" href="/assets/index.css">' }] })
  return { print, open }
}

afterEach(() => vi.unstubAllGlobals())

describe('el PDF de la hoja de inventario', () => {
  it('sabe si está en la app instalada', () => {
    entorno(true)
    expect(esAppInstalada()).toBe(true)
    entorno(false)
    expect(esAppInstalada()).toBe(false)
  })

  it('el documento lleva la tabla, las hojas de estilo y nada de la interfaz', () => {
    entorno(true)
    const h = hoja()
    const html = documentoDeLaHoja(h.el, 'Inventario de E 0.6')
    expect(html).toContain('<td>Puesto 1</td>')
    expect(html).toContain('<td>Puesto 2</td>')
    expect(h.quitados).toBe(1)
    expect(html).toContain('<link rel="stylesheet" href="/assets/index.css">')
    expect(html).toContain('<base href="https://aulas.example/">')
    expect(html).toContain('<title>Inventario de E 0.6</title>')
    expect(html).toContain('data-theme="light"')
  })

  it('en el navegador normal imprime en el sitio', () => {
    const { print, open } = entorno(false)
    expect(descargarPdf(hoja().el, 'x')).toBe('dialogo')
    expect(print).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
  })

  it('en la app instalada abre su propia ventana, y dice si se la bloquean', () => {
    const { print, open } = entorno(true)
    expect(descargarPdf(hoja().el, 'x')).toBe('bloqueado')
    expect(open).toHaveBeenCalledOnce()
    expect(print).not.toHaveBeenCalled()
  })
})
