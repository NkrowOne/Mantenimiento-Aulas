import { describe, expect, it } from 'vitest'
import { averiasPorEdificio, averiasPorSala, esAveriaViva, type IncidenciaMinima } from './averias'

function inc(over: Partial<IncidenciaMinima> = {}): IncidenciaMinima {
  return { room_id: 'sala-1', state: 'abierta', kind: 'incidencia', ...over }
}

describe('esAveriaViva', () => {
  // La regla tiene que ser LA MISMA que room_overview.open_incidents: si
  // divergen, el triángulo de la lista y el recuento de la ficha se
  // contradicen en la misma pantalla.
  it('una incidencia abierta o en curso cuenta; una resuelta no', () => {
    expect(esAveriaViva(inc())).toBe(true)
    expect(esAveriaViva(inc({ state: 'en_curso' }))).toBe(true)
    expect(esAveriaViva(inc({ state: 'resuelta' }))).toBe(false)
  })

  it('un borrador no cuenta: lo dejado a medio escribir no es trabajo de nadie', () => {
    expect(esAveriaViva(inc({ state: 'borrador' }))).toBe(false)
  })

  it('una observación no cuenta, pero una solicitud sí', () => {
    expect(esAveriaViva(inc({ kind: 'observacion' }))).toBe(false)
    expect(esAveriaViva(inc({ kind: 'solicitud' }))).toBe(true)
  })

  it('sin sala no hay a qué fila señalar', () => {
    expect(esAveriaViva(inc({ room_id: null }))).toBe(false)
  })
})

describe('averiasPorSala', () => {
  it('agrupa por sala y las salas sanas no aparecen', () => {
    const mapa = averiasPorSala([
      inc(),
      inc(),
      inc({ room_id: 'sala-2', state: 'en_curso' }),
      inc({ room_id: 'sala-3', state: 'resuelta' }),
      inc({ room_id: 'sala-3', kind: 'observacion' }),
    ])
    expect(mapa.get('sala-1')).toBe(2)
    expect(mapa.get('sala-2')).toBe(1)
    expect(mapa.has('sala-3')).toBe(false)
  })
})

describe('averiasPorEdificio', () => {
  it('suma las salas de cada edificio siguiendo las zonas', () => {
    const porSala = averiasPorSala([
      inc(),
      inc(),
      inc({ room_id: 'sala-2' }),
      inc({ room_id: 'sala-huerfana' }),
    ])
    const mapa = averiasPorEdificio(
      porSala,
      [
        { id: 'sala-1', zone_id: 'planta-1' },
        { id: 'sala-2', zone_id: 'planta-2' },
        { id: 'sala-sana', zone_id: 'planta-1' },
        // La huérfana apunta a una zona que el espejo no tiene: no revienta ni
        // se cuela en ningún edificio.
        { id: 'sala-huerfana', zone_id: 'planta-fantasma' },
      ],
      new Map([
        ['planta-1', 'edificio-h'],
        ['planta-2', 'edificio-h'],
      ]),
    )
    expect(mapa.get('edificio-h')).toBe(3)
    expect(mapa.size).toBe(1)
  })
})
