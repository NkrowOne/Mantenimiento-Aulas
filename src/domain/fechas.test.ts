import { describe, expect, it } from 'vitest'
import { diaEnMadrid, diaMasDias, inicioDeMes } from './fechas'

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

describe('diaMasDias', () => {
  it('suma días naturales, no 24 horas', () => {
    expect(diaMasDias(90, new Date('2026-07-15T10:00:00Z'))).toBe('2026-10-13')
    expect(diaMasDias(1, new Date('2026-07-15T10:00:00Z'))).toBe('2026-07-16')
  })

  it('cruza el cambio de hora sin perder ni ganar un día', () => {
    // El domingo 25 de octubre de 2026 Madrid pasa de UTC+2 a UTC+1: ese día
    // natural tiene 25 horas. Sumando milisegundos a secas, un salto por encima
    // se quedaría corto.
    expect(diaMasDias(1, new Date('2026-10-24T10:00:00Z'))).toBe('2026-10-25')
    expect(diaMasDias(2, new Date('2026-10-24T10:00:00Z'))).toBe('2026-10-26')
    // Y el de marzo, que tiene 23.
    expect(diaMasDias(1, new Date('2026-03-28T10:00:00Z'))).toBe('2026-03-29')
    expect(diaMasDias(2, new Date('2026-03-28T10:00:00Z'))).toBe('2026-03-30')
  })

  it('parte del día de Madrid y no del de UTC', () => {
    // 22:30 UTC del 15 de julio ya son las 00:30 del 16 en Madrid: mañana es el 17.
    expect(diaMasDias(1, new Date('2026-07-15T22:30:00Z'))).toBe('2026-07-17')
  })

  it('con cero devuelve hoy, y con negativo mira atrás', () => {
    expect(diaMasDias(0, new Date('2026-07-15T10:00:00Z'))).toBe('2026-07-15')
    expect(diaMasDias(-1, new Date('2026-07-15T10:00:00Z'))).toBe('2026-07-14')
  })

  it('cambia de año sin saltarse el 31 de diciembre', () => {
    expect(diaMasDias(1, new Date('2026-12-31T10:00:00Z'))).toBe('2027-01-01')
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
