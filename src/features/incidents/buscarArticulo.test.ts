/**
 * El buscador de material tiene que enseñar TODO lo que coincide.
 *
 * El fallo que se arregla era silencioso: «HDMI» devolvía seis cables y el que
 * se había gastado era el séptimo. No había error, solo un artículo al que no
 * se podía llegar.
 */
import { describe, expect, it } from 'vitest'

import { buscarArticulos } from './buscarArticulo'

const nombres = (r: Array<{ articulo: { name: string } }>): string[] => r.map((x) => x.articulo.name)

describe('buscarArticulos', () => {
  const cables = [
    'Cable HDMI 1 m',
    'Cable HDMI 2 m',
    'Cable HDMI 3 m',
    'Cable HDMI 5 m',
    'Cable HDMI 10 m',
    'Cable HDMI 15 m',
    'Cable HDMI 20 m',
    'Adaptador USB-C a HDMI',
    'Extensor HDMI por red',
  ].map((name) => ({ name }))

  it('devuelve todos los que coinciden, no los seis primeros', () => {
    expect(buscarArticulos(cables, 'hdmi')).toHaveLength(9)
  })

  it('con el campo vacío no devuelve nada', () => {
    expect(buscarArticulos(cables, '')).toEqual([])
    expect(buscarArticulos(cables, '   ')).toEqual([])
  })

  it('por palabras y en cualquier orden', () => {
    expect(nombres(buscarArticulos(cables, '5 hdmi'))).toEqual(['Cable HDMI 5 m', 'Cable HDMI 15 m'])
    expect(nombres(buscarArticulos(cables, 'usb hdmi'))).toEqual(['Adaptador USB-C a HDMI'])
  })

  it('sin distinguir mayúsculas ni tildes', () => {
    const items = [{ name: 'Batería CR2032' }, { name: 'Ratón USB' }]
    expect(nombres(buscarArticulos(items, 'bateria'))).toEqual(['Batería CR2032'])
    expect(nombres(buscarArticulos(items, 'RATON'))).toEqual(['Ratón USB'])
  })

  it('primero lo que empieza por lo tecleado, y los números en su sitio', () => {
    const items = [{ name: 'Cable HDMI 10 m' }, { name: 'HDMI conector' }, { name: 'Cable HDMI 2 m' }]
    expect(nombres(buscarArticulos(items, 'hdmi'))).toEqual([
      'HDMI conector',
      'Cable HDMI 2 m',
      'Cable HDMI 10 m',
    ])
  })

  it('lo que lleva la frase entera va antes que lo que tiene las palabras sueltas', () => {
    const items = [{ name: 'Cable largo USB' }, { name: 'Cable USB' }]
    expect(nombres(buscarArticulos(items, 'cable usb'))).toEqual(['Cable USB', 'Cable largo USB'])
  })

  it('un artículo renombrado se encuentra por su nombre de antes, y se dice cuál', () => {
    const items = [
      { name: 'Cable HDMI 2 m', aliases: ['Latiguillo HDMI corto'] },
      { name: 'Latiguillo de red' },
    ]
    const r = buscarArticulos(items, 'latiguillo')
    expect(nombres(r)).toEqual(['Latiguillo de red', 'Cable HDMI 2 m'])
    expect(r[0]!.alias).toBeNull()
    expect(r[1]!.alias).toBe('Latiguillo HDMI corto')
  })

  it('si coincide el nombre, no se le cuelga un alias', () => {
    const r = buscarArticulos([{ name: 'Cable HDMI 2 m', aliases: ['HDMI 2m'] }], 'hdmi')
    expect(r).toEqual([{ articulo: { name: 'Cable HDMI 2 m', aliases: ['HDMI 2m'] }, alias: null }])
  })

  it('sin alias guardados no rompe', () => {
    expect(buscarArticulos([{ name: 'Pila AA', aliases: null }], 'pila')).toHaveLength(1)
  })

  it('lo que no coincide no sale', () => {
    expect(buscarArticulos(cables, 'vga')).toEqual([])
  })
})
