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

import { ESTADO } from './mapa'
import type { Columna } from './mapa'
import { compradoEn, consumoPorMes, valorDeSala } from './volcado'
import type { MovimientoVolcado, SalaVolcada } from './volcado'

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

// -----------------------------------------------------------------------------
// Las columnas de SÍ/NO salen del inventario
// -----------------------------------------------------------------------------

/**
 * Antes salían de `rooms.capabilities`, que es un sí o un no guardado al margen
 * de los aparatos. En el libro del 22/09 los dos datos se contradicen 442
 * veces, y el caso gordo es el micrófono: la hoja decía que hay 30 y la
 * aplicación tiene 286 apuntados, porque el tipo se llama «Micrófono Jabra» y
 * aquí solo se buscaba «Micrófono».
 */
describe('las columnas de sí o no de la hoja de estado', () => {
  const columna = (letra: string): Columna => ESTADO.columnas.find((c) => c.letra === letra)!

  const conEquipos = (equipos: Array<[string, string | null]>, capacidades = {}): SalaVolcada =>
    ({
      id: 'r1',
      shortRef: 'SALA-000001',
      edificio: 'EDIFICIO P',
      zona: 'PLANTA BAJA',
      code: '0.1P',
      activa: true,
      projectorHours: null,
      lampPct: null,
      botoneraEstado: null,
      capacidades,
      revisiones: [],
      notas: null,
      equipos: equipos.map(([tipo, serial], i) => ({
        id: `e${i}`,
        tipo,
        serial,
        model: null,
        desde: null,
      })),
    }) as SalaVolcada

  it('un micrófono apuntado como «Micrófono Jabra» cuenta', () => {
    // 254 aulas decían NO teniéndolo. El tipo se llama así en 298 de ellas.
    const sala = conEquipos([['Micrófono Jabra', null]], { microfono: false })
    expect(valorDeSala(sala, columna('J'))).toBe('SI')
  })

  it('y manda el inventario, no la casilla guardada aparte', () => {
    expect(valorDeSala(conEquipos([['Altavoces', null]], { altavoces: false }), columna('H'))).toBe(true)
    expect(valorDeSala(conEquipos([['Cámara', null]], { camara: false }), columna('I'))).toBe(true)
    // Y al revés: si el inventario no lo tiene, la casilla vieja no lo resucita.
    expect(valorDeSala(conEquipos([['Proyector', null]], { altavoces: true }), columna('H'))).toBe(false)
  })

  it('un aula sin nada apuntado se queda con lo que dijera la casilla', () => {
    // Sin inventario no hay a qué preguntar, y su sí sigue siendo el único
    // dato que existe. Tirarlo sería cambiar «no lo sé» por «no lo tiene».
    expect(valorDeSala(conEquipos([], { altavoces: true }), columna('H'))).toBe(true)
    expect(valorDeSala(conEquipos([], {}), columna('H'))).toBeNull()
  })

  it('el número de serie del micrófono sigue ganando al sí', () => {
    const sala = conEquipos([['Micrófono Jabra', 'MIC-77']], { microfono: false })
    expect(valorDeSala(sala, columna('J'))).toBe('MIC-77')
  })

  it('y las tres columnas las escribe la aplicación', () => {
    // `solo_app`: escribir «SI» a mano ya no crea nada. La pasada siguiente
    // devuelve la celda a lo que diga el inventario y lo apunta en la hoja
    // «Sincronización».
    for (const letra of ['H', 'I', 'J']) expect(columna(letra).dueno).toBe('solo_app')
    // La botonera no: dice si está actualizada, y eso el inventario no lo sabe.
    expect(columna('K').dueno).toBe('ambos')
  })
})
