import { describe, expect, it } from 'vitest'
import { diaEnMadrid, inicioDeMes } from './fechas'

describe('diaEnMadrid', () => {
  it('a las 00:30 de Madrid ya es el día siguiente, aunque en UTC no lo sea', () => {
    // 22:30 UTC del 15 de julio son las 00:30 del 16 en Madrid. Es el caso que
    // hacía que el informe diario cubriera la jornada equivocada.
    expect(diaEnMadrid(new Date('2026-07-15T22:30:00Z'))).toBe('2026-07-16')
  })

  it('a las 23:00 de Madrid sigue siendo el mismo día', () => {
    expect(diaEnMadrid(new Date('2026-07-15T21:00:00Z'))).toBe('2026-07-15')
  })

  it('en invierno el desfase es de una hora, no de dos', () => {
    expect(diaEnMadrid(new Date('2026-01-15T23:30:00Z'))).toBe('2026-01-16')
    expect(diaEnMadrid(new Date('2026-01-15T22:30:00Z'))).toBe('2026-01-15')
  })
})

describe('la fecha que va y vuelve del Excel', () => {
  // La base está en `Europe/Madrid`, así que una fecha corregida en la hoja
  // entra como `'2026-02-19'::date::timestamptz`, que es el instante de abajo.
  // Si al leerla de vuelta se recorta la ISO —`slice(0, 10)`— sale el día de
  // antes, y la pasada siguiente reescribe la celda con él: la fecha que alguien
  // corrigió a mano se movía un día ella sola, una vez, en silencio.
  it('la medianoche de Madrid vuelve como el mismo día, no como el anterior', () => {
    const loQueGuardaLaBase = new Date('2026-02-18T23:00:00Z') // 2026-02-19 00:00 Madrid
    expect(diaEnMadrid(loQueGuardaLaBase)).toBe('2026-02-19')
    expect(loQueGuardaLaBase.toISOString().slice(0, 10)).toBe('2026-02-18')
  })

  it('y en verano, con dos horas de desfase, igual', () => {
    expect(diaEnMadrid(new Date('2026-07-14T22:00:00Z'))).toBe('2026-07-15')
  })

  it('lo que sembró el importador a medianoche UTC no se mueve', () => {
    // El importador escribe «2026-02-19T00:00:00.000Z». Madrid va por delante de
    // UTC, así que el día en Madrid es el mismo o el siguiente, nunca el
    // anterior: las fechas importadas se quedan donde están.
    expect(diaEnMadrid(new Date('2026-02-19T00:00:00.000Z'))).toBe('2026-02-19')
    expect(diaEnMadrid(new Date('2026-07-15T00:00:00.000Z'))).toBe('2026-07-15')
    expect(diaEnMadrid(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01')
  })
})

describe('inicioDeMes', () => {
  it('en verano el mes empieza a las 22:00 UTC del último día del anterior', () => {
    // Medianoche del 1 de julio en Madrid = 22:00 del 30 de junio en UTC.
    expect(inicioDeMes(new Date('2026-07-15T10:00:00Z')).toISOString()).toBe(
      '2026-06-30T22:00:00.000Z',
    )
  })

  it('en invierno el desfase cambia a una hora', () => {
    expect(inicioDeMes(new Date('2026-01-15T10:00:00Z')).toISOString()).toBe(
      '2025-12-31T23:00:00.000Z',
    )
  })

  it('no depende de la zona del aparato que pregunta', () => {
    // El mismo instante desde cualquier sitio tiene que dar el mismo límite: el
    // panel lo calcula en el navegador y el PDF en el servidor, y si no
    // coinciden dicen cifras distintas del mismo mes.
    const instante = new Date('2026-07-15T10:00:00Z')
    expect(inicioDeMes(instante).getTime()).toBe(inicioDeMes(new Date(instante)).getTime())
  })

  it('el primer día del mes, de madrugada, no salta al mes anterior', () => {
    // 23:30 UTC del 31 de julio ya son las 01:30 del 1 de agosto en Madrid.
    expect(inicioDeMes(new Date('2026-07-31T23:30:00Z')).toISOString()).toBe(
      '2026-07-31T22:00:00.000Z',
    )
  })
})
