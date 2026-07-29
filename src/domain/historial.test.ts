import { describe, expect, it } from 'vitest'
import { cantidadLegible, diaDe, fechaLegible, subtipoLegible, type EventoSala } from './historial'
import { desdeDe } from '@/features/history/HistorialPage'

const evento = (p: Partial<EventoSala>): EventoSala => ({
  ref_id: 'x',
  kind: 'material',
  subkind: 'consumo',
  room_id: 'r',
  at: '2026-03-01T10:30:00Z',
  title: 'Cable HDMI fibra 15 m',
  detail: null,
  qty: -2,
  by_user: null,
  ...p,
})

describe('cómo se lee el histórico', () => {
  it('conserva el signo de la cantidad', () => {
    // Una devolución de 2 y un consumo de 2 son cosas opuestas, y la lista las
    // pone una debajo de la otra.
    expect(cantidadLegible(-2)).toBe('−2')
    expect(cantidadLegible(3)).toBe('+3')
  })

  it('no enseña cantidad cuando no la hay', () => {
    expect(cantidadLegible(null)).toBeNull()
    expect(cantidadLegible(0)).toBeNull()
  })

  it('traduce los subtipos de las cuatro familias', () => {
    expect(subtipoLegible(evento({ kind: 'material', subkind: 'consumo' }))).toBe('consumido')
    expect(subtipoLegible(evento({ kind: 'incidencia', subkind: 'resuelta' }))).toBe('resuelta')
    expect(subtipoLegible(evento({ kind: 'equipo', subkind: 'traslado' }))).toBe('traslado')
    // Una revisión completa no necesita adjetivo: es lo normal.
    expect(subtipoLegible(evento({ kind: 'revision_ok', subkind: 'completa' }))).toBe('')
  })

  it('deja pasar un subtipo que no conoce en vez de borrarlo', () => {
    expect(subtipoLegible(evento({ subkind: 'inventado' }))).toBe('inventado')
  })

  it('enseña la hora, que es lo que ordena dos cosas del mismo día', () => {
    const texto = fechaLegible('2026-03-01T10:30:00Z')
    expect(texto).toMatch(/2026/)
    expect(texto).toMatch(/\d{2}:\d{2}/)
  })

  it('no revienta con una fecha inservible', () => {
    expect(fechaLegible('no-es-una-fecha')).toBe('—')
  })

  it('agrupa por jornada', () => {
    expect(diaDe('2026-03-01T23:00:00Z')).toBe(diaDe('2026-03-01T08:00:00Z'))
    expect(diaDe('2026-03-01T08:00:00Z')).not.toBe(diaDe('2026-03-02T08:00:00Z'))
  })
})

describe('atajos de fecha', () => {
  /*
   * El corte tiene que caer en el principio del día. Este valor entra en la
   * clave de la consulta: con el instante exacto, cada redibujado producía una
   * clave nueva y la pantalla se quedaba recargando en bucle.
   */
  it('corta en el principio del día, no en el instante', () => {
    const a = desdeDe('30d', new Date('2026-03-15T10:00:00Z'))
    const b = desdeDe('30d', new Date('2026-03-15T23:59:00Z'))
    expect(a).toBe(b)
    expect(a).toMatch(/T00:00:00\.000Z$/)
  })

  it('cuenta los días hacia atrás', () => {
    expect(desdeDe('7d', new Date('2026-03-15T10:00:00Z'))).toBe('2026-03-08T00:00:00.000Z')
    expect(desdeDe('30d', new Date('2026-03-15T10:00:00Z'))).toBe('2026-02-13T00:00:00.000Z')
  })

  it('el curso empieza en septiembre, también visto desde marzo', () => {
    expect(desdeDe('curso', new Date('2026-03-15T10:00:00Z'))).toBe('2025-09-01T00:00:00.000Z')
    expect(desdeDe('curso', new Date('2026-10-02T10:00:00Z'))).toBe('2026-09-01T00:00:00.000Z')
  })

  it('«todo» no pone límite', () => {
    expect(desdeDe('todo')).toBeNull()
  })
})
