/**
 * Un artículo retirado del almacén sale del libro.
 *
 * «Retirar» en la aplicación deja el artículo inactivo: sale de la pestaña
 * Almacén y deja de contarse. La bolsa del Excel lo seguía listando pasada tras
 * pasada, y encima la sincronización lo daba por desconocido —«no está en el
 * catálogo»— y preguntaba si darlo de alta, que es exactamente lo contrario de
 * lo que alguien acababa de decidir.
 */
import { describe, expect, it } from 'vitest'
import { BOLSA_2025, BOLSA_2026 } from './mapa'
import { sincronizarBolsa } from './sincronizar'
import type { ArticuloVolcado } from './volcado'
import type { FilaLeida } from './xlsx'

function fila(n: number, celdas: Record<string, string | number | boolean | null>): FilaLeida {
  const limpias: Record<string, string | number | boolean | null> = {}
  for (const [k, v] of Object.entries(celdas)) if (v !== null) limpias[k] = v
  return { fila: n, celdas: limpias, formulas: {} }
}

const CAB = fila(1, Object.fromEntries(BOLSA_2026.columnas.map((c) => [c.letra, c.cabecera])))

const vivo: ArticuloVolcado = {
  id: 'a1',
  nombre: 'Cable HDMI fibra 10 m',
  meses: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  comprado: 28,
  activo: true,
}
const retirado: ArticuloVolcado = {
  id: 'a2',
  nombre: 'Ratón de bola',
  meses: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  comprado: 4,
  activo: false,
  retirado: { cuando: '2026-09-23', motivo: 'Ya no se compran: todos los ratones son ópticos' },
}

const resolver = (nombre: string): string | null =>
  [vivo, retirado].find((a) => a.nombre.toLowerCase() === nombre.toLowerCase())?.id ?? null

describe('un artículo retirado del almacén', () => {
  it('su fila sale de la bolsa viva, y se dice por qué y qué llevaba', () => {
    const p = sincronizarBolsa({
      hoja: BOLSA_2026,
      filas: [CAB, fila(2, { A: vivo.nombre, P: 28 }), fila(3, { A: retirado.nombre, I: 1, P: 4 })],
      articulos: [vivo, retirado],
      resolver,
    })
    expect(p.borrar).toEqual([3])
    expect(p.filasQueSalen).toEqual([
      expect.objectContaining({ fila: 3, destino: retirado.nombre, motivo: expect.stringMatching(/retirad/i) }),
    ])
    const aviso = p.avisos.find((a) => a.includes('Ratón de bola'))
    expect(aviso).toMatch(/retir/i)
    expect(aviso).toMatch(/23\/09\/2026/)
    expect(aviso).toMatch(/ópticos/)
    // Lo que la fila llevaba queda escrito: no se pierde en silencio.
    expect(aviso).toMatch(/Total Comprado 4/)
    expect(aviso).toMatch(/Agosto 1/)
    // Y no se pregunta si darlo de alta ni se toca ninguna de sus celdas.
    expect(p.dudas).toEqual([])
    expect(p.altas).toEqual([])
    expect(p.celdas.filter((c) => /3$/.test(c.celda))).toEqual([])
    expect(p.haciaLaBase.filter((h) => h.fila === 3)).toEqual([])
  })

  it('no vuelve a entrar como fila nueva aunque el libro no lo tenga', () => {
    const p = sincronizarBolsa({
      hoja: BOLSA_2026,
      filas: [CAB, fila(2, { A: vivo.nombre, P: 28 })],
      articulos: [vivo, retirado],
      resolver,
    })
    expect(p.insertar).toEqual([])
    expect(p.filasQueEntran).toEqual([])
  })

  it('en la bolsa cerrada de 2025 se queda como está', () => {
    const cab = fila(1, Object.fromEntries(BOLSA_2025.columnas.map((c) => [c.letra, c.cabecera])))
    const p = sincronizarBolsa({
      hoja: BOLSA_2025,
      filas: [cab, fila(2, { A: retirado.nombre, B: 2 })],
      articulos: [vivo, retirado],
      resolver,
    })
    expect(p.borrar).toEqual([])
    expect(p.celdas).toEqual([])
  })

  it('un artículo sin la marca se trata como vivo: un espejo viejo no borra filas', () => {
    const sinMarca = { ...retirado, activo: undefined, retirado: undefined } as unknown as ArticuloVolcado
    const p = sincronizarBolsa({
      hoja: BOLSA_2026,
      filas: [CAB, fila(2, { A: retirado.nombre, P: 4 })],
      articulos: [vivo, sinMarca],
      resolver,
    })
    expect(p.borrar).toEqual([])
  })
})
