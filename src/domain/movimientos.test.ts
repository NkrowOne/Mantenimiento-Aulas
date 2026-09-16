import { describe, expect, it } from 'vitest'
import { movimientosPrevistos } from './movimientos'
import type { Alta, HaciaLaBase, Plan } from './sincronizar'
import type { ArticuloVolcado, IncidenciaVolcada } from './volcado'

/**
 * La cuenta tiene que ser la MISMA que hace la base al aplicar: si aquí sale
 * «2 cables» y la base apunta 3, la pantalla miente justo en lo que existe para
 * no mentir. Los casos son los de `sync_material_del_parte` y
 * `sync_celda_de_articulo`, uno a uno.
 */

const CABLE: ArticuloVolcado = { id: 'cable', nombre: 'Cable HDMI fibra 10 m', meses: [], comprado: 28 }
const RATON: ArticuloVolcado = { id: 'raton', nombre: 'Ratón', meses: [], comprado: 0 }
const articulos = [CABLE, RATON]
const resolver = (nombre: string): string | null => {
  const n = nombre.toLowerCase()
  if (n.startsWith('cable')) return 'cable'
  if (n.startsWith('rat')) return 'raton'
  return null
}

function parte(over: Partial<IncidenciaVolcada> = {}): IncidenciaVolcada {
  return {
    id: 'i1',
    numero: 'I260102_0002',
    salaCode: '0.1 BC',
    abierta: '2026-01-02',
    resuelta: null,
    problema: 'No da imagen',
    observacion: null,
    resolucion: null,
    material: '1 Cable HDMI fibra 10 m',
    esParte: true,
    materialApuntado: [{ articuloId: 'cable', cantidad: 1 }],
    ...over,
  }
}

function plan(hoja: string, haciaLaBase: Partial<HaciaLaBase>[] = [], altas: Alta[] = []): Plan {
  return {
    hoja,
    celdas: [],
    insertar: [],
    borrar: [],
    haciaElExcel: [],
    filasQueEntran: [],
    filasQueSalen: [],
    haciaLaBase: haciaLaBase.map((h) => ({ fila: 2, letra: 'G', campo: '', destino: '', valor: null, motivo: '', ...h })),
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

describe('lo que el almacén va a apuntar', () => {
  it('«Total Comprado» por encima de lo que la aplicación tiene: la diferencia es una compra', () => {
    const m = movimientosPrevistos({
      planes: [plan('Bolsa 2026', [{ campo: 'articulo.comprado', destino: 'Cable HDMI fibra 10 m', valor: 32, letra: 'P' }])],
      incidencias: [],
      articulos,
      resolver,
    })
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ tipo: 'compra', articulo: 'Cable HDMI fibra 10 m', cantidad: 4 })
  })

  it('y por debajo no se deshace nada: se dice que va a la bandeja', () => {
    const m = movimientosPrevistos({
      planes: [plan('Bolsa 2026', [{ campo: 'articulo.comprado', destino: 'Cable HDMI fibra 10 m', valor: 20 }])],
      incidencias: [],
      articulos,
      resolver,
    })
    expect(m[0]).toMatchObject({ tipo: 'no_entra', cantidad: 8 })
  })

  it('más material en el parte que el que ya tiene descontado: sale la diferencia', () => {
    const m = movimientosPrevistos({
      planes: [plan('Material Instalado 2026', [{ campo: 'incidencia.material', destino: 'I260102_0002', valor: '3 Cable HDMI fibra 10 m' }])],
      incidencias: [parte()],
      articulos,
      resolver,
    })
    expect(m).toEqual([expect.objectContaining({ tipo: 'consumo', articulo: 'Cable HDMI fibra 10 m', cantidad: 2 })])
  })

  it('menos material: vuelve la diferencia; un artículo que ya no está, vuelve entero', () => {
    const m = movimientosPrevistos({
      planes: [plan('Material Instalado 2026', [{ campo: 'incidencia.material', destino: 'I260102_0002', valor: '1 Ratón' }])],
      incidencias: [parte({ materialApuntado: [{ articuloId: 'cable', cantidad: 2 }] })],
      articulos,
      resolver,
    })
    expect(m).toEqual([
      expect.objectContaining({ tipo: 'consumo', articulo: 'Ratón', cantidad: 1 }),
      expect.objectContaining({ tipo: 'devolucion', articulo: 'Cable HDMI fibra 10 m', cantidad: 2 }),
    ])
  })

  it('lo mismo que ya está descontado no mueve nada', () => {
    const m = movimientosPrevistos({
      planes: [plan('Material Instalado 2026', [{ campo: 'incidencia.material', destino: 'I260102_0002', valor: '1 Cable HDMI fibra 10 m' }])],
      incidencias: [parte()],
      articulos,
      resolver,
    })
    expect(m).toEqual([])
  })

  it('un artículo que el catálogo no conoce no descuenta nada, y se dice antes de aplicar', () => {
    const m = movimientosPrevistos({
      planes: [plan('Material Instalado 2026', [{ campo: 'incidencia.material', destino: 'I260102_0002', valor: '1 Cable HDMI fibra 10 m, 2 Regleta 6 tomas' }])],
      incidencias: [parte()],
      articulos,
      resolver,
    })
    expect(m).toEqual([expect.objectContaining({ tipo: 'sin_articulo', articulo: 'Regleta 6 tomas', cantidad: 2 })])
  })

  it('dos renglones del mismo artículo se suman antes de comparar', () => {
    const m = movimientosPrevistos({
      planes: [plan('Material Instalado 2026', [{ campo: 'incidencia.material', destino: 'I260102_0002', valor: '1 Cable HDMI fibra 10 m + 1 cable HDMI fibra 10 m' }])],
      incidencias: [parte()],
      articulos,
      resolver,
    })
    expect(m).toEqual([expect.objectContaining({ tipo: 'consumo', cantidad: 1 })])
  })

  it('una celda de material vaciada devuelve todo lo que el parte tenía', () => {
    const m = movimientosPrevistos({
      planes: [plan('Material Instalado 2026', [{ campo: 'incidencia.material', destino: 'I260102_0002', valor: null }])],
      incidencias: [parte()],
      articulos,
      resolver,
    })
    expect(m).toEqual([expect.objectContaining({ tipo: 'devolucion', cantidad: 1 })])
  })

  it('las altas también mueven: un artículo nuevo con lo comprado, un parte nuevo con su material', () => {
    const altas: Alta[] = [
      { tipo: 'articulo', fila: 40, nombre: 'Regleta', nombreAlternativo: null, comprado: 5, celdas: {} },
      {
        tipo: 'incidencia',
        fila: 99,
        salaId: null,
        aula: '',
        numero: null,
        abierta: null,
        resuelta: null,
        problema: 'Sin ratón',
        observacion: null,
        resolucion: null,
        material: '1 Ratón',
        celdas: {},
      },
    ]
    const m = movimientosPrevistos({ planes: [plan('Bolsa 2026', [], altas)], incidencias: [], articulos, resolver })
    expect(m).toEqual([
      expect.objectContaining({ tipo: 'compra', articulo: 'Regleta', cantidad: 5 }),
      expect.objectContaining({ tipo: 'consumo', articulo: 'Ratón', cantidad: 1, destino: 'fila 99' }),
    ])
  })
})
