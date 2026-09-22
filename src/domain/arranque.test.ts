/**
 * El recuento del almacén arranca el 1 de agosto de 2026.
 *
 * La aplicación tomó el almacén ese día con «Total Comprado» como saldo de
 * partida, y lo de antes se quedó como estaba en el libro. Estas pruebas son
 * las tres consecuencias, una por una: los meses anteriores son del libro y no
 * se tocan; el material de un parte anterior se apunta y no mueve nada; y lo
 * comprado y lo consumido del año se cuentan desde ese día.
 */
import { describe, expect, it } from 'vitest'

import { fusionarCelda } from './fusion'
import { ARRANQUE_2026, BOLSA_2026, MATERIAL_2026, arranqueDelAnyo } from './mapa'
import { movimientosPrevistos } from './movimientos'
import type { Alta, Plan } from './sincronizar'
import { compradoEn, consumoPorMes } from './volcado'
import type { ArticuloVolcado, IncidenciaVolcada, MovimientoVolcado } from './volcado'

describe('la hoja declara el arranque', () => {
  it('las dos hojas vivas de 2026 arrancan el 1 de agosto', () => {
    expect(ARRANQUE_2026).toBe('2026-08-01')
    expect(BOLSA_2026.arranque).toBe(ARRANQUE_2026)
    expect(MATERIAL_2026.arranque).toBe(ARRANQUE_2026)
    expect(arranqueDelAnyo(2026)).toBe(ARRANQUE_2026)
    expect(arranqueDelAnyo(2025)).toBeUndefined()
  })

  it('enero–julio son del libro y agosto–diciembre de la aplicación', () => {
    const meses = BOLSA_2026.columnas.filter((c) => c.campo.startsWith('mes:'))
    expect(meses).toHaveLength(12)
    for (const c of meses) {
      const n = Number(c.campo.slice(4))
      expect(c.dueno, c.cabecera).toBe(n < 8 ? 'libro' : 'solo_app')
    }
  })
})

describe('una columna del libro ni se compara ni se escribe', () => {
  it('con la base a cero y un número apuntado a mano en la hoja, no pasa nada', () => {
    // Sin esto, la regla del hueco escribía el 0 de la aplicación encima del 1
    // que alguien apuntó en enero, o intentaba meter el 1 en la base.
    expect(fusionarCelda({ base: null, excel: 1, dueno: 'libro', tipo: 'numero' }).tipo).toBe('sin_cambios')
    expect(fusionarCelda({ base: 8, excel: null, dueno: 'libro', tipo: 'numero' }).tipo).toBe('sin_cambios')
    expect(fusionarCelda({ base: 8, excel: 3, antepasado: 3, dueno: 'libro', tipo: 'numero' }).tipo).toBe('sin_cambios')
  })
})

describe('lo comprado y lo consumido se cuentan desde el arranque', () => {
  const mov = (occurredAt: string, qty: number, kind: string): MovimientoVolcado =>
    ({ occurredAt, qty, kind, stockItemId: 'x' }) as MovimientoVolcado

  it('una compra de julio no es del recuento; el saldo de partida del 1 de agosto sí', () => {
    const m = [
      mov('2026-07-29T10:00:00Z', 1, 'compra'),
      mov('2026-07-31T22:30:00Z', 28, 'compra'), // las 00:30 del 1 de agosto en Madrid
      mov('2026-09-10T10:00:00Z', 5, 'compra'),
    ]
    expect(compradoEn(m, 2026, ARRANQUE_2026)).toBe(33)
    expect(compradoEn(m, 2026)).toBe(34)
  })

  it('los consumos de enero a julio no entran en los meses', () => {
    const m = [
      mov('2026-01-02T10:00:00Z', -8, 'consumo'),
      mov('2026-07-29T10:00:00Z', -1, 'consumo'),
      mov('2026-08-18T10:00:00Z', -1, 'consumo'),
      mov('2026-09-03T10:00:00Z', -2, 'consumo'),
    ]
    const meses = consumoPorMes(m, 2026, ARRANQUE_2026)
    expect(meses[0]).toBe(0)
    expect(meses[6]).toBe(0)
    expect(meses[7]).toBe(1)
    expect(meses[8]).toBe(2)
    // Sin arranque se cuenta el año entero, como siempre.
    expect(consumoPorMes(m, 2026)[0]).toBe(8)
  })
})

describe('el material de un parte anterior al arranque se apunta y no se descuenta', () => {
  const CABLE: ArticuloVolcado = { id: 'cable', nombre: 'Cable HDMI fibra 10 m', meses: [], comprado: 28 }
  const resolver = (nombre: string): string | null => (nombre.toLowerCase().startsWith('cable') ? 'cable' : null)

  function parte(over: Partial<IncidenciaVolcada>): IncidenciaVolcada {
    return {
      id: 'i1',
      numero: 'I260102_0007',
      salaCode: '1.7',
      abierta: '2026-01-02',
      resuelta: null,
      problema: 'Sin imagen',
      observacion: null,
      resolucion: null,
      material: null,
      esParte: true,
      materialApuntado: [],
      ...over,
    }
  }

  function plan(haciaLaBase: Plan['haciaLaBase'], altas: Alta[] = []): Plan {
    return {
      hoja: 'Material Instalado 2026',
      celdas: [],
      insertar: [],
      borrar: [],
      haciaElExcel: [],
      filasQueEntran: [],
      filasQueSalen: [],
      haciaLaBase,
      conflictos: [],
      cuarentena: [],
      instantanea: [],
      sinCruzar: [],
      dudas: [],
      altas,
      avisos: [],
      desajustes: [],
    }
  }

  const celda = (destino: string, valor: string) => ({
    fila: 2,
    letra: 'G',
    campo: 'incidencia.material',
    destino,
    valor,
    motivo: '',
  })

  it('un parte de enero sale como histórico, sin consumo ni devolución', () => {
    const movs = movimientosPrevistos({
      planes: [plan([celda('I260102_0007', '2 Cable HDMI fibra 10 m')])],
      incidencias: [parte({ materialApuntado: [{ articuloId: 'cable', cantidad: 1 }] })],
      articulos: [CABLE],
      resolver,
      arranque: ARRANQUE_2026,
    })
    expect(movs.map((m) => m.tipo)).toEqual(['historico'])
    expect(movs[0]).toMatchObject({ articulo: 'Cable HDMI fibra 10 m', cantidad: 2 })
  })

  it('el mismo parte, resuelto en septiembre, descuenta la diferencia como siempre', () => {
    const movs = movimientosPrevistos({
      planes: [plan([celda('I260102_0007', '2 Cable HDMI fibra 10 m')])],
      incidencias: [parte({ resuelta: '2026-09-03', materialApuntado: [{ articuloId: 'cable', cantidad: 1 }] })],
      articulos: [CABLE],
      resolver,
      arranque: ARRANQUE_2026,
    })
    expect(movs.map((m) => m.tipo)).toEqual(['consumo'])
    expect(movs[0]!.cantidad).toBe(1)
  })

  it('sin arranque declarado, nada cambia: un parte de enero descuenta', () => {
    const movs = movimientosPrevistos({
      planes: [plan([celda('I260102_0007', '2 Cable HDMI fibra 10 m')])],
      incidencias: [parte({})],
      articulos: [CABLE],
      resolver,
    })
    expect(movs.map((m) => m.tipo)).toEqual(['consumo'])
  })

  it('un parte nuevo del libro fechado en marzo entra con su material y sin mover nada', () => {
    const alta: Alta = {
      tipo: 'incidencia',
      fila: 9,
      salaId: null,
      aula: 'Varias aulas',
      numero: null,
      abierta: '2026-03-01',
      resuelta: '2026-03-01',
      problema: 'Regularización',
      observacion: null,
      resolucion: null,
      material: '3 Cable HDMI fibra 10 m',
      celdas: {},
    }
    const movs = movimientosPrevistos({
      planes: [plan([], [alta])],
      incidencias: [],
      articulos: [CABLE],
      resolver,
      arranque: ARRANQUE_2026,
    })
    expect(movs.map((m) => m.tipo)).toEqual(['historico'])
    expect(movs[0]!.cantidad).toBe(3)
  })
})

describe('la vista previa y la base cuentan lo mismo en un parte anterior', () => {
  const CABLE: ArticuloVolcado = {
    id: 'cable',
    nombre: 'Cable HDMI fibra 10 m',
    meses: [],
    comprado: 28,
  }
  const resolver = (n: string): string | null =>
    n.toLowerCase().startsWith('cable') ? 'cable' : null

  function planDe(valor: string): Plan {
    return {
      hoja: 'Material Instalado 2026',
      celdas: [],
      insertar: [],
      borrar: [],
      haciaElExcel: [],
      filasQueEntran: [],
      filasQueSalen: [],
      haciaLaBase: [
        {
          fila: 2,
          letra: 'G',
          campo: 'incidencia.material',
          destino: 'I260102_0007',
          valor,
          motivo: '',
        },
      ],
      conflictos: [],
      cuarentena: [],
      instantanea: [],
      sinCruzar: [],
      dudas: [],
      altas: [],
      avisos: [],
      desajustes: [],
    }
  }
  const parteDeEnero: IncidenciaVolcada = {
    id: 'i1',
    numero: 'I260102_0007',
    salaCode: '1.7',
    abierta: '2026-01-02',
    resuelta: null,
    problema: 'Sin imagen',
    observacion: null,
    resolucion: null,
    material: null,
    esParte: true,
    materialApuntado: [],
  }

  it('un artículo que el catálogo no reconoce, en un parte anterior, NO sale como desconocido', () => {
    // La base descarta el parte antiguo antes de mirar si el nombre cruza, así
    // que no apunta nada en cuarentena. La pantalla decía lo contrario.
    const movs = movimientosPrevistos({
      planes: [planDe('1 lampara NP30')],
      incidencias: [parteDeEnero],
      articulos: [CABLE],
      resolver,
      arranque: ARRANQUE_2026,
    })
    expect(movs.map((m) => m.tipo)).toEqual(['historico'])
    expect(movs[0]!.articulo).toBe('lampara NP30')
  })

  it('y en un parte de después sí sale, que es donde de verdad no se va a descontar', () => {
    const movs = movimientosPrevistos({
      planes: [planDe('1 lampara NP30')],
      incidencias: [{ ...parteDeEnero, resuelta: '2026-09-10' }],
      articulos: [CABLE],
      resolver,
      arranque: ARRANQUE_2026,
    })
    expect(movs.map((m) => m.tipo)).toEqual(['sin_articulo'])
  })
})
