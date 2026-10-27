import { describe, expect, it } from 'vitest'
import { columnasDelPdf, documentoDeTablas, nombreDelPdfDe, textoDeCelda } from './vistaPrevia'
import type { HojaNueva } from './libro'
import { fechaAExcel } from './valores'

const HOJA: HojaNueva = {
  nombre: 'Existencias',
  filas: [
    ['Artículo', 'Existencias', 'Alta', 'Precio', 'Nota'],
    ['Cable HDMI <5 m>', 1234, fechaAExcel('2026-09-23'), 849.5, null],
    ['Ratón', 0, null, 12, 'Pedido & pendiente'],
  ],
  formatos: [undefined, 'entero', 'fecha'],
  tintes: ['critico', undefined],
}

describe('el texto de una celda', () => {
  it('una fecha de Excel se lee como día', () => {
    expect(textoDeCelda(fechaAExcel('2026-09-23'), 'fecha')).toBe('23/09/2026')
  })

  it('los números con la coma y el punto de aquí', () => {
    expect(textoDeCelda(1234, 'entero')).toBe((1234).toLocaleString('es-ES'))
    expect(textoDeCelda(849.5, undefined)).toBe((849.5).toLocaleString('es-ES', { minimumFractionDigits: 2 }))
    expect(textoDeCelda(0.25, 'porcentaje')).toBe('25 %')
  })

  it('vacío, booleanos y lo que no es un número', () => {
    expect(textoDeCelda(null, undefined)).toBe('')
    expect(textoDeCelda(true, undefined)).toBe('Sí')
    expect(textoDeCelda(Number.NaN, 'entero')).toBe('')
    expect(textoDeCelda('Tal cual', undefined)).toBe('Tal cual')
  })
})

describe('las columnas del PDF', () => {
  it('sin lista, todas', () => {
    expect(columnasDelPdf(HOJA)).toEqual([0, 1, 2, 3, 4])
  })

  it('por su cabecera, en el orden de la hoja, y lo que no existe se ignora', () => {
    expect(columnasDelPdf(HOJA, ['Nota', 'Artículo', 'No existe'])).toEqual([0, 4])
  })
})

describe('el documento del PDF', () => {
  const html = documentoDeTablas(
    { titulo: 'Inventario del almacén', resumen: '2 artículos' },
    [{ hoja: HOJA, columnas: [0, 1, 2, 4] }],
    '2026-10-27',
    'body { color: #000; }',
  )

  it('lleva el título, la fecha de emisión y el resumen', () => {
    expect(html).toContain('<title>Inventario del almacén</title>')
    expect(html).toContain('Emitido el 27/10/2026 · 2 artículos')
  })

  it('una tabla por hoja, con las columnas pedidas y nada más', () => {
    expect(html).toContain('<caption>Existencias · 2 filas</caption>')
    expect(html).toContain('<th>Artículo</th>')
    expect(html).not.toContain('<th>Precio</th>')
    expect(html).toContain('<td>23/09/2026</td>')
  })

  it('escapa lo que se escribió, para que un nombre no rompa el documento', () => {
    expect(html).toContain('Cable HDMI &lt;5 m&gt;')
    expect(html).toContain('Pedido &amp; pendiente')
    expect(html).not.toContain('<5 m>')
  })

  it('las filas llevan su color y los números van a la derecha', () => {
    expect(html).toContain('<tr class="t-critico">')
    expect(html).toContain('<th class="num">Existencias</th>')
    expect(html).toContain('body { color: #000; }')
  })

  it('una hoja vacía lo dice', () => {
    const vacia = documentoDeTablas({ titulo: 'X' }, [{ hoja: { nombre: 'Vacía', filas: [['A', 'B']] }, columnas: [0, 1] }], '2026-10-27', '')
    expect(vacia).toContain('<td colspan="2">Sin filas.</td>')
    expect(vacia).toContain('<caption>Vacía · 0 filas</caption>')
  })
})

describe('el nombre del PDF', () => {
  it('sin tildes ni espacios, con el día', () => {
    expect(nombreDelPdfDe('Inventario del almacén', '2026-10-27')).toBe('Inventario-del-almacen-2026-10-27.pdf')
  })
})
