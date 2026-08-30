/**
 * El volcado cuenta en hora de Madrid, igual que la base.
 *
 * `getFullYear()` y `getMonth()` usan el huso del aparato que pregunta, y aquí
 * eso no vale: `sync_celda_de_articulo` cuadra `Comprado` filtrando por
 * `extract(year from occurred_at at time zone 'Europe/Madrid')`. Con un lado
 * contando en local y el otro en Madrid, una compra de fin de año es de 2025
 * para uno y de 2026 para el otro, y esa celda no cuadra nunca: cada pasada
 * propone el mismo movimiento y la siguiente lo vuelve a proponer.
 */
import { describe, expect, it } from 'vitest'

import { compradoEn, consumoPorMes } from './volcado'
import type { MovimientoVolcado } from './volcado'

const mov = (occurredAt: string, qty: number, kind: string): MovimientoVolcado =>
  ({ occurredAt, qty, kind }) as MovimientoVolcado

describe('lo comprado en un año', () => {
  it('solo cuenta las compras de ese año', () => {
    const m = [mov('2025-06-01T10:00:00Z', 40, 'compra'), mov('2026-03-01T10:00:00Z', 12, 'compra')]
    expect(compradoEn(m, 2026)).toBe(12)
    expect(compradoEn(m, 2025)).toBe(40)
  })

  it('no cuenta lo que no es una compra', () => {
    const m = [mov('2026-03-01T10:00:00Z', 12, 'compra'), mov('2026-03-02T10:00:00Z', 30, 'ajuste')]
    expect(compradoEn(m, 2026)).toBe(12)
  })

  it('la nochevieja se cuenta como la cuenta la base: en Madrid', () => {
    // 23:30 UTC del 31 de diciembre es la 00:30 del 1 de enero en Madrid. La
    // base dice 2026 y el volcado tiene que decir lo mismo, corra donde corra.
    const m = [mov('2025-12-31T23:30:00Z', 7, 'compra')]
    expect(compradoEn(m, 2026)).toBe(7)
    expect(compradoEn(m, 2025)).toBe(0)
  })
})

describe('el consumo por meses', () => {
  it('da la vuelta al signo y reparte por mes', () => {
    const m = [mov('2026-02-10T09:00:00Z', -3, 'consumo'), mov('2026-02-20T09:00:00Z', -1, 'consumo')]
    expect(consumoPorMes(m, 2026)[1]).toBe(4)
  })

  it('un mes sin movimientos es cero, no un hueco', () => {
    expect(consumoPorMes([], 2026)).toEqual(new Array(12).fill(0))
  })

  it('y también reparte en hora de Madrid', () => {
    // 23:30 UTC del 28 de febrero es marzo en Madrid.
    const m = [mov('2026-02-28T23:30:00Z', -2, 'consumo')]
    const meses = consumoPorMes(m, 2026)
    expect(meses[1]).toBe(0)
    expect(meses[2]).toBe(2)
  })
})
