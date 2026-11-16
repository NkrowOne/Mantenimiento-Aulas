import { describe, expect, it } from 'vitest'
import {
  filasDelParte,
  limitesDelDia,
  moverDia,
  resumenDelParte,
  textoParaEasyVista,
  type IncidenciaDelParte,
} from './parteDelDia'

const DIA = '2026-11-16'
const limites = limitesDelDia(DIA)

function inc(parcial: Partial<IncidenciaDelParte> & { id: string }): IncidenciaDelParte {
  return {
    title: 'Proyector: no da imagen',
    description: null,
    severity: 'media',
    state: 'abierta',
    kind: 'incidencia',
    opened_at: '2026-11-16T09:12:00Z',
    opened_by: null,
    resolved_at: null,
    resolved_by: null,
    resolution: null,
    external_ref: null,
    easyvista_ref: null,
    room_id: null,
    ...parcial,
  }
}

const nada = { servidor: [], espejo: [], cierres: [], altasEnCola: new Set<string>(), limites }

describe('los límites del día', () => {
  it('van de medianoche a medianoche de Madrid, no de UTC', () => {
    // Noviembre: Madrid va una hora por delante.
    expect(limites).toEqual({
      desde: '2026-11-15T23:00:00.000Z',
      hasta: '2026-11-16T23:00:00.000Z',
    })
    // Julio: dos.
    expect(limitesDelDia('2026-07-01').desde).toBe('2026-06-30T22:00:00.000Z')
  })

  it('el día del cambio de hora dura lo que dura', () => {
    // 25 de octubre de 2026: se atrasa el reloj y el día tiene 25 horas.
    const l = limitesDelDia('2026-10-25')
    expect((Date.parse(l.hasta) - Date.parse(l.desde)) / 3_600_000).toBe(25)
  })

  it('mover el día cruza meses y años', () => {
    expect(moverDia('2026-03-01', -1)).toBe('2026-02-28')
    expect(moverDia('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('qué entra en el parte', () => {
  it('lo abierto hoy y lo cerrado hoy; lo demás no', () => {
    const filas = filasDelParte({
      ...nada,
      servidor: [
        inc({ id: 'abierta-hoy' }),
        inc({
          id: 'de-antes-cerrada-hoy',
          opened_at: '2026-11-12T08:00:00Z',
          state: 'resuelta',
          resolved_at: '2026-11-16T11:40:00Z',
        }),
        inc({ id: 'de-ayer-sigue-abierta', opened_at: '2026-11-15T10:00:00Z' }),
        inc({
          id: 'de-ayer-cerrada-ayer',
          opened_at: '2026-11-15T10:00:00Z',
          state: 'resuelta',
          resolved_at: '2026-11-15T12:00:00Z',
        }),
      ],
    })
    expect(filas.map((f) => [f.id, f.abiertaHoy, f.cerradaHoy])).toEqual([
      ['abierta-hoy', true, false],
      ['de-antes-cerrada-hoy', false, true],
    ])
  })

  it('las 23:30 de ayer en UTC ya son hoy en Madrid', () => {
    const filas = filasDelParte({
      ...nada,
      servidor: [
        inc({ id: 'madrugada', opened_at: '2026-11-15T23:30:00Z' }),
        inc({ id: 'manana', opened_at: '2026-11-16T23:30:00Z' }),
      ],
    })
    expect(filas.map((f) => f.id)).toEqual(['madrugada'])
  })

  it('ni borradores ni observaciones', () => {
    const filas = filasDelParte({
      ...nada,
      servidor: [
        inc({ id: 'b', state: 'borrador' }),
        inc({ id: 'o', kind: 'observacion' }),
        inc({ id: 's', kind: 'solicitud' }),
      ],
    })
    expect(filas.map((f) => f.id)).toEqual(['s'])
  })

  it('lo abierto sin cobertura sale, marcado sin subir', () => {
    const filas = filasDelParte({
      ...nada,
      espejo: [inc({ id: 'local' }), inc({ id: 'vieja', opened_at: '2026-11-01T09:00:00Z' })],
      altasEnCola: new Set(['local']),
    })
    expect(filas.map((f) => [f.id, f.sinSubir])).toEqual([['local', true]])
  })

  it('un cierre en la cola cuenta como cerrada hoy, aunque arriba siga abierta', () => {
    const filas = filasDelParte({
      ...nada,
      espejo: [inc({ id: 'vieja', opened_at: '2026-11-01T09:00:00Z' })],
      cierres: [
        {
          incident_id: 'vieja',
          resolution: 'Cambiado el cable HDMI',
          resolved_at: '2026-11-16T11:40:00Z',
          resolved_by: 'u1',
          easyvista_ref: 'I261116_0042',
        },
      ],
    })
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({
      id: 'vieja',
      state: 'resuelta',
      cerradaHoy: true,
      abiertaHoy: false,
      sinSubir: true,
      resolution: 'Cambiado el cable HDMI',
      easyvista_ref: 'I261116_0042',
    })
  })

  it('si el servidor ya la da por resuelta, manda el servidor', () => {
    const filas = filasDelParte({
      ...nada,
      servidor: [
        inc({ id: 'x', state: 'resuelta', resolved_at: '2026-11-16T11:40:00Z', resolution: 'arriba' }),
      ],
      cierres: [
        { incident_id: 'x', resolution: 'cola', resolved_at: '2026-11-16T11:40:00Z', resolved_by: null },
      ],
    })
    expect(filas[0]).toMatchObject({ resolution: 'arriba', sinSubir: false })
  })

  it('el cierre de otro día no mete la avería en el parte de hoy', () => {
    const filas = filasDelParte({
      ...nada,
      espejo: [inc({ id: 'vieja', opened_at: '2026-11-01T09:00:00Z' })],
      cierres: [
        { incident_id: 'vieja', resolution: 'x', resolved_at: '2026-11-15T11:40:00Z', resolved_by: null },
      ],
    })
    expect(filas).toEqual([])
  })

  it('en el orden en que pasó el día', () => {
    const filas = filasDelParte({
      ...nada,
      servidor: [
        inc({ id: 'tarde', opened_at: '2026-11-16T15:00:00Z' }),
        inc({
          id: 'cerrada-a-media-manana',
          opened_at: '2026-11-10T08:00:00Z',
          state: 'resuelta',
          resolved_at: '2026-11-16T10:00:00Z',
        }),
        inc({ id: 'temprano', opened_at: '2026-11-16T08:00:00Z' }),
      ],
    })
    expect(filas.map((f) => f.id)).toEqual(['temprano', 'cerrada-a-media-manana', 'tarde'])
  })

  it('el resumen cuenta abiertas, cerradas y las que no tienen código', () => {
    const filas = filasDelParte({
      ...nada,
      servidor: [
        inc({ id: 'a' }),
        inc({ id: 'b', easyvista_ref: 'I1' }),
        inc({ id: 'c', state: 'resuelta', resolved_at: '2026-11-16T12:00:00Z' }),
      ],
    })
    expect(resumenDelParte(filas)).toEqual({ abiertas: 3, cerradas: 1, porPasar: 2 })
  })
})

describe('el texto para EasyVista', () => {
  it('una resuelta lleva todo, una línea por dato', () => {
    const texto = textoParaEasyVista(
      inc({
        id: 'x',
        description: 'Se ve en azul al encender.',
        state: 'resuelta',
        resolved_at: '2026-11-16T11:40:00Z',
        resolution: 'Cambiado el cable HDMI.',
        external_ref: 'I261116_0003',
      }),
      { sala: 'H 1.7', abrio: 'Ana Ruiz', cerro: 'Luis Gil' },
    )
    expect(texto).toBe(
      [
        'H 1.7 — Proyector: no da imagen',
        'Estado: Resuelta',
        'Abierta: 16 nov 2026, 10:12 · Ana Ruiz',
        'Descripción: Se ve en azul al encender.',
        'Cerrada: 16 nov 2026, 12:40 · Luis Gil',
        'Solución: Cambiado el cable HDMI.',
        'Ref. Aulas: I261116_0003',
      ].join('\n'),
    )
  })

  it('una abierta no arrastra líneas vacías', () => {
    const texto = textoParaEasyVista(inc({ id: 'x' }), { sala: null, abrio: null, cerro: null })
    expect(texto).toBe(
      ['Proyector: no da imagen', 'Estado: Abierta', 'Abierta: 16 nov 2026, 10:12'].join('\n'),
    )
  })
})
