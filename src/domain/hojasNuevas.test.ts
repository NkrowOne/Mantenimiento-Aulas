import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  hojaDeInventario,
  hojaDeMovimientos,
  hojaDeRevisiones,
  hojaDelParte,
} from './hojasNuevas'
import type { EquipoParaHoja, MovimientoParaHoja, RevisionParaHoja } from './hojasNuevas'
import { escribirLibro } from './libro'
import { abrirLibro, leerHoja } from './xlsx'
import { excelAFecha } from './valores'

const LIBRO = process.env.LIBRO_XLSX
const bytes = LIBRO ? readFileSync(LIBRO) : null

function revision(over: Partial<RevisionParaHoja> = {}): RevisionParaHoja {
  return {
    shortRef: 'SALA-000001',
    edificio: 'EDIFICIO P',
    zona: 'PLANTA BAJA',
    sala: '0.1P',
    cuando: '2025-06-23T09:35:00.000Z',
    quien: 'Ana Pérez',
    estado: 'completa',
    resultado: 'ok',
    horasProyector: 921,
    lampara: 0.73,
    comprobaciones: 'altavoces: ok · cámara: ok',
    incidenciasAbiertas: 0,
    notas: null,
    ...over,
  }
}

function movimiento(over: Partial<MovimientoParaHoja> = {}): MovimientoParaHoja {
  return {
    cuando: '2026-01-02',
    articulo: 'Cable HDMI fibra 10 m',
    cantidad: -1,
    tipo: 'consumo',
    incidencia: 'I260102_0002',
    sala: '0.1 BC',
    quien: 'Ana Pérez',
    nota: null,
    ...over,
  }
}

function equipo(over: Partial<EquipoParaHoja> = {}): EquipoParaHoja {
  return {
    shortRef: 'SALA-000001',
    edificio: 'EDIFICIO P',
    zona: 'PLANTA BAJA',
    sala: '0.1P',
    tipo: 'Proyector',
    modelo: 'NP-M403 HG',
    serial: '0340985RL',
    estado: 'instalado',
    desde: '2024-01-15',
    etiqueta: null,
    ...over,
  }
}

describe('la hoja de revisiones', () => {
  it('lleva la matrícula, que es lo que la hace cruzable', () => {
    const h = hojaDeRevisiones([revision()])
    expect(h.filas[0]![0]).toBe('Ref')
    expect(h.filas[1]![0]).toBe('SALA-000001')
  })

  it('la fecha y la hora van en columnas separadas', () => {
    const h = hojaDeRevisiones([revision()])
    // Con las dos juntas, filtrar «las del martes» deja de funcionar.
    expect(excelAFecha(h.filas[1]![4] as number)).toBe('2025-06-23')
    expect(h.filas[1]![5]).toMatch(/^\d{2}:\d{2}$/)
  })

  it('una revisión sin hora no se inventa una', () => {
    const h = hojaDeRevisiones([revision({ cuando: '2025-06-23' })])
    expect(h.filas[1]![5]).toBeNull()
  })

  it('salen de la más reciente a la más vieja', () => {
    const h = hojaDeRevisiones([
      revision({ cuando: '2024-01-01T10:00:00.000Z', sala: 'vieja' }),
      revision({ cuando: '2026-01-01T10:00:00.000Z', sala: 'nueva' }),
    ])
    expect(h.filas[1]![3]).toBe('nueva')
    expect(h.filas[2]![3]).toBe('vieja')
  })

  it('la fecha va con formato de fecha y el porcentaje con el suyo', () => {
    const h = hojaDeRevisiones([revision()])
    expect(h.formatos![4]).toBe('fecha')
    expect(h.formatos![10]).toBe('porcentaje')
  })
})

describe('la hoja de movimientos', () => {
  it('parte la cantidad en entrada y salida', () => {
    const h = hojaDeMovimientos([movimiento({ cantidad: -2 }), movimiento({ cantidad: 5, tipo: 'compra' })])
    const compra = h.filas.find((f) => f[2] === 'Compra')!
    const consumo = h.filas.find((f) => f[2] === 'Consumo')!
    expect(compra[3]).toBe(5)
    expect(compra[4]).toBeNull()
    expect(consumo[3]).toBeNull()
    expect(consumo[4]).toBe(2)
  })

  it('lleva el saldo detrás, que es la pregunta que se hace la gente', () => {
    const h = hojaDeMovimientos([
      movimiento({ cuando: '2026-01-01', cantidad: 10, tipo: 'compra' }),
      movimiento({ cuando: '2026-02-01', cantidad: -3 }),
      movimiento({ cuando: '2026-03-01', cantidad: -2 }),
    ])
    expect(h.filas.slice(1).map((f) => f[5])).toEqual([10, 7, 5])
  })

  it('el saldo se lleva por artículo, no por la hoja entera', () => {
    const h = hojaDeMovimientos([
      movimiento({ articulo: 'A', cantidad: 10, tipo: 'compra' }),
      movimiento({ articulo: 'B', cantidad: 4, tipo: 'compra' }),
    ])
    expect(h.filas.slice(1).map((f) => f[5])).toEqual([10, 4])
  })

  it('los movimientos se llaman como los llama la gente', () => {
    const h = hojaDeMovimientos([movimiento({ tipo: 'devolucion' })])
    expect(h.filas[1]![2]).toBe('Devolución')
  })

  it('un tipo que no conoce se enseña tal cual, no en blanco', () => {
    const h = hojaDeMovimientos([movimiento({ tipo: 'inventado' })])
    expect(h.filas[1]![2]).toBe('inventado')
  })
})

describe('la hoja de inventario', () => {
  it('saca las dos filas de un aula con dos proyectores', () => {
    const h = hojaDeInventario([
      equipo({ serial: 'UNO' }),
      equipo({ serial: 'DOS', desde: '2025-01-01' }),
    ])
    expect(h.filas).toHaveLength(3)
    expect(h.filas.slice(1).map((f) => f[6]).sort()).toEqual(['DOS', 'UNO'])
  })

  it('ordena por edificio, aula y equipo', () => {
    const h = hojaDeInventario([
      equipo({ edificio: 'B', sala: '1.10' }),
      equipo({ edificio: 'A', sala: '1.2' }),
      equipo({ edificio: 'A', sala: '1.10' }),
    ])
    expect(h.filas.slice(1).map((f) => `${f[1]}${f[3]}`)).toEqual(['A1.2', 'A1.10', 'B1.10'])
  })
})

describe('el parte de la pasada', () => {
  it('cuando todo cuadra lo dice, no sale en blanco', () => {
    const h = hojaDelParte([], '30/08/2026 10:15')
    expect(h.filas[1]![2]).toBe('Todo cuadra')
    expect(h.autofiltro).toBe(false)
  })

  it('lista lo que quedó pendiente con su celda', () => {
    const h = hojaDelParte(
      [{ hoja: 'Estado', celda: 'F87', que: 'Cuarentena', detalle: '«No tiene» no es un número' }],
      '30/08/2026 10:15',
    )
    expect(h.filas).toHaveLength(3)
    expect(h.filas[2]).toEqual(['Estado', 'F87', 'Cuarentena', '«No tiene» no es un número'])
  })
})

describe.skipIf(!bytes)('dentro del libro real', () => {
  it('las cuatro hojas se añaden y se vuelven a leer', async () => {
    const libro = await abrirLibro(new Uint8Array(bytes!))
    const salida = await escribirLibro(
      libro,
      [],
      [
        hojaDeRevisiones([revision()]),
        hojaDeMovimientos([movimiento()]),
        hojaDeInventario([equipo()]),
        hojaDelParte([], '30/08/2026 10:15'),
      ],
    )

    const otra = await abrirLibro(salida)
    expect(otra.hojas.map((h) => h.nombre)).toEqual([
      'Estado Aulas y Salas de reunion',
      'Material Instalado 2026',
      'Bolsa 2026',
      'Material Instalado 2025',
      'Bolsa 2025',
      'Revisiones',
      'Movimientos de Almacén',
      'Inventario por Sala',
      'Sincronización',
    ])

    const rev = await leerHoja(otra, 'Revisiones')
    expect(rev[0]!.celdas.A).toBe('Ref')
    expect(rev[1]!.celdas.A).toBe('SALA-000001')
    expect(excelAFecha(rev[1]!.celdas.E as number)).toBe('2025-06-23')
  })

  it('las fechas se escriben con el estilo de fecha del propio libro', async () => {
    const libro = await abrirLibro(new Uint8Array(bytes!))
    const salida = await escribirLibro(libro, [], [hojaDeRevisiones([revision()])])
    const otra = await abrirLibro(salida)

    // El estilo de la columna de fecha de la hoja nueva es el mismo que el de la
    // columna de fecha de la hoja de estado: si no, se vería `45831`.
    const estado = otra.entradas.find((e) => e.nombre === otra.hojas[0]!.ruta)!
    const nueva = otra.entradas.find(
      (e) => e.nombre === otra.hojas.find((h) => h.nombre === 'Revisiones')!.ruta,
    )!
    const { descomprimir } = await import('../lib/zip')
    const xmlEstado = new TextDecoder().decode(await descomprimir(estado))
    const xmlNueva = new TextDecoder().decode(await descomprimir(nueva))

    const estiloEstado = /<c\b[^>]*\br="E2"[^>]*\bs="(\d+)"/.exec(xmlEstado)?.[1]
    const estiloNueva = /<c\b[^>]*\br="E2"[^>]*\bs="(\d+)"/.exec(xmlNueva)?.[1]
    expect(estiloEstado).toBeTruthy()
    expect(estiloNueva).toBe(estiloEstado)
  })
})
