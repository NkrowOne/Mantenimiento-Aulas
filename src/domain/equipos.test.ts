import { describe, expect, it } from 'vitest'
import { canonicoDe, mismoTipo, normTipo, tipoCanonico } from './equipos'
import type { TipoConocido } from './equipos'

function catalogo(...tipos: TipoConocido[]): Map<string, TipoConocido> {
  return new Map(tipos.map((t) => [t.id, t]))
}

describe('el nombre de un tipo, normalizado', () => {
  it('quita tildes, mayúsculas y espacios de sobra, y no toca las comas', () => {
    expect(normTipo('  Cámara   Aver ')).toBe('CAMARA AVER')
    expect(normTipo('Monitor 24,5"')).toBe('MONITOR 24,5"')
  })
})

describe('el mismo aparato con dos nombres', () => {
  it('el Tiny es el ordenador de la columna', () => {
    expect(mismoTipo('Ordenador', 'Ordenador Tiny')).toBe(true)
    expect(mismoTipo('ORDENADOR TINY', 'Tiny')).toBe(true)
    expect(mismoTipo('Ordenador', 'PC')).toBe(true)
  })

  it('la pantalla es la TV', () => {
    expect(mismoTipo('TV', 'Pantalla')).toBe(true)
    expect(mismoTipo('tv', 'Televisor')).toBe(true)
  })

  it('pero el monitor NO es la TV, ni al revés', () => {
    expect(mismoTipo('Monitor', 'TV')).toBe(false)
    expect(mismoTipo('Monitor', 'Pantalla')).toBe(false)
    expect(mismoTipo('TV', 'Monitor PC')).toBe(false)
  })

  it('el monitor del atril y el Ideacentre son otros aparatos', () => {
    expect(mismoTipo('Monitor', 'Monitor Atril')).toBe(false)
    expect(mismoTipo('Ordenador', 'Ordenador Lenovo Ideacentre')).toBe(false)
    expect(mismoTipo('TV', 'Pantalla de proyección')).toBe(false)
    expect(mismoTipo('TV', 'Pantalla Proyector')).toBe(false)
  })

  it('los dos micrófonos contestan por la misma columna', () => {
    expect(mismoTipo('Micrófono', 'Micrófono Jabra')).toBe(true)
    expect(mismoTipo('Microfono', 'Micrófono')).toBe(true)
  })

  it('un nombre vacío no es igual a nada', () => {
    expect(mismoTipo('', '')).toBe(false)
    expect(mismoTipo('TV', '')).toBe(false)
  })

  it('lo que no es de ninguna columna se compara por nombre', () => {
    expect(mismoTipo('Atril', 'atril')).toBe(true)
    expect(mismoTipo('Atril', 'HDMI PC')).toBe(false)
  })
})

describe('el nombre canónico de un tipo del catálogo', () => {
  it('un tipo con el nombre de la columna se queda como está', () => {
    const tv: TipoConocido = { id: '1', name: 'TV', aliases: ['Pantalla'] }
    expect(tipoCanonico(tv, catalogo(tv))).toBe('TV')
  })

  it('«Ordenador Tiny» sin fusionar es «Ordenador»: la base sin migrar sincroniza igual', () => {
    const tiny: TipoConocido = { id: '1', name: 'Ordenador Tiny', aliases: [] }
    expect(tipoCanonico(tiny, catalogo(tiny))).toBe('Ordenador')
  })

  it('un tipo fundido en otro habla con el nombre del vivo', () => {
    const pantalla: TipoConocido = { id: '1', name: 'Pantalla', merged_into: '2' }
    const tv: TipoConocido = { id: '2', name: 'TV', aliases: ['Pantalla'] }
    expect(tipoCanonico(pantalla, catalogo(pantalla, tv))).toBe('TV')
  })

  it('un alias que responde a una columna basta', () => {
    const raro: TipoConocido = { id: '1', name: 'PC del aula', aliases: ['Ordenador Tiny'] }
    expect(tipoCanonico(raro, catalogo(raro))).toBe('Ordenador')
  })

  it('el nombre exacto gana al alias', () => {
    // Un tipo que se llama «Monitor» es un monitor aunque alguien le pusiera
    // «pantalla» de alias: el nombre es lo que la gente ve.
    const monitor: TipoConocido = { id: '1', name: 'Monitor', aliases: ['Pantalla'] }
    expect(tipoCanonico(monitor, catalogo(monitor))).toBe('Monitor')
  })

  it('lo que no es de ninguna columna sale con su nombre', () => {
    const atril: TipoConocido = { id: '1', name: 'Monitor Atril', aliases: [] }
    expect(tipoCanonico(atril, catalogo(atril))).toBe('Monitor Atril')
    const idea: TipoConocido = { id: '2', name: 'Ordenador Lenovo Ideacentre' }
    expect(tipoCanonico(idea, catalogo(idea))).toBe('Ordenador Lenovo Ideacentre')
  })

  it('canonicoDe dice a qué columna responde un nombre suelto', () => {
    expect(canonicoDe('Sreenbeam')).toBe('Screenbeam')
    expect(canonicoDe('Cámara Aver')).toBe('Cámara')
    expect(canonicoDe('HDMI PC')).toBeNull()
  })
})
