import { describe, expect, it, vi } from 'vitest'
import { abrirLibro, leerHoja } from '@/domain/xlsx'
import { TIPO_XLSX, libroNuevo } from '@/domain/exportar'
import { fechaAExcel } from '@/domain/valores'
import type { DatosDelAlmacen, FilaArticulo, FilaMovimiento } from '@/features/inventory/exportarAlmacen'

/*
 * El almacén de mentira que lee `prepararExcelDelPeriodo`. Lo demás del módulo
 * de exportación se queda como es: las hojas de existencias y de unidades son
 * las de verdad, que es justo lo que este libro promete reutilizar.
 */
const almacen = vi.hoisted(() => ({ datos: null as unknown, fallo: null as Error | null }))

vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/features/inventory/exportarAlmacen', async (original) => ({
  ...(await original<typeof import('@/features/inventory/exportarAlmacen')>()),
  cargarDatosDelAlmacen: vi.fn(() =>
    almacen.fallo ? Promise.reject(almacen.fallo) : Promise.resolve(almacen.datos),
  ),
}))

import {
  balanceDelPeriodo,
  hojaDeConsumoPorAula,
  hojaDeMovimientosDelPeriodo,
  hojaDeResumen,
  hojaDeStockDelPeriodo,
  libroDelPeriodo,
  prepararExcelDelPeriodo,
} from './almacenDelPeriodo'

/**
 * El Excel que acompaña al informe.
 *
 * Lo que este fichero vigila es lo que haría que nadie se fiara del libro: que
 * el stock de un día pasado no cuadre con sus movimientos, que un movimiento de
 * las 00:30 caiga en la semana que no es, o que el saldo de la hoja de
 * movimientos empiece de cero cuando el almacén no estaba vacío.
 */

const SEMANA = { start: '2026-11-16', end: '2026-11-20' }

const articulo = (id: string, name: string, min = 0, extra: Partial<FilaArticulo> = {}): FilaArticulo => ({
  id,
  name,
  unit: 'ud',
  min_threshold: min,
  asset_type_id: null,
  active: true,
  retired_at: null,
  retired_reason: null,
  ...extra,
})

const mov = (
  item: string,
  qty: number,
  kind: string,
  at: string,
  extra: Partial<FilaMovimiento> = {},
): FilaMovimiento => ({
  stock_item_id: item,
  qty,
  kind,
  occurred_at: at,
  incident_id: null,
  room_id: null,
  by_user: 'u1',
  source: 'app',
  note: null,
  ...extra,
})

function datos(): DatosDelAlmacen {
  const movimientos: FilaMovimiento[] = [
    // Antes del periodo: el saldo de partida y lo gastado hasta entonces.
    mov('cable', 12, 'compra', '2026-08-01T10:00:00Z', { by_user: null, source: 'sharepoint' }),
    mov('cable', -4, 'consumo', '2026-10-06T09:00:00Z', { room_id: 's1' }),
    mov('pilas', 40, 'compra', '2026-08-01T10:00:00Z', { by_user: null, source: 'sharepoint' }),
    mov('vga', 2, 'compra', '2026-08-01T10:00:00Z', { by_user: null, source: 'sharepoint' }),
    mov('raton', 5, 'compra', '2026-08-01T10:00:00Z', { by_user: null, source: 'sharepoint' }),
    // El domingo 15 a las 23:30 de Madrid: todavía NO es el periodo.
    mov('cable', -1, 'consumo', '2026-11-15T22:30:00Z', { room_id: 's1' }),
    // El lunes 16 a las 00:30 de Madrid —23:30 UTC del 15—: ya SÍ lo es.
    mov('cable', -2, 'consumo', '2026-11-15T23:30:00Z', { incident_id: 'i1' }),
    mov('cable', 20, 'compra', '2026-11-17T11:00:00Z', { by_user: 'u2', note: 'Pedido de noviembre' }),
    mov('pilas', -4, 'consumo', '2026-11-18T09:00:00Z', { room_id: 's2' }),
    mov('pilas', 1, 'devolucion', '2026-11-18T12:00:00Z', { room_id: 's2', note: 'Sobró una' }),
    mov('pilas', -2, 'ajuste', '2026-11-19T15:00:00Z', { note: 'Recuento' }),
    mov('cable', -1, 'consumo', '2026-11-19T10:00:00Z', { note: 'Para el plató' }),
    // El viernes 20 a las 23:50 de Madrid: el último minuto del periodo.
    mov('cable', -1, 'consumo', '2026-11-20T22:50:00Z', { incident_id: 'i2' }),
    // El sábado 21: ya no.
    mov('cable', -3, 'consumo', '2026-11-21T09:00:00Z', { room_id: 's1' }),
  ]
  const saldo = new Map<string, number>()
  for (const m of movimientos) saldo.set(m.stock_item_id, (saldo.get(m.stock_item_id) ?? 0) + m.qty)

  return {
    articulos: [
      articulo('cable', 'Cable HDMI 3 m', 5),
      articulo('pilas', 'Pilas AAA', 40),
      articulo('raton', 'Ratón USB', 2),
      // Retirado con saldo: sigue en el libro, apagado.
      articulo('vga', 'Cable VGA 2 m', 0, { active: false, retired_at: '2026-09-23T10:00:00Z', retired_reason: 'Sin uso' }),
      // Retirado a cero y sin tocar: no pinta nada.
      articulo('viejo', 'Conversor SCART', 0, { active: false }),
    ],
    niveles: ['cable', 'pilas', 'raton'].map((id) => ({ stock_item_id: id, on_hand: saldo.get(id) ?? 0 })),
    estados: null,
    tipos: [],
    movimientos,
    incidencias: [
      { id: 'i1', external_ref: 'I261116_0001', kind: 'incidencia', room_id: 's1' },
      { id: 'i2', external_ref: 'S261120_0002', kind: 'solicitud', room_id: 's2' },
    ],
    salas: [
      { id: 's1', code: '2.1', zone_id: 'z1' },
      { id: 's2', code: '01', zone_id: 'z2' },
    ],
    zonas: [
      { id: 'z1', building_id: 'b1' },
      { id: 'z2', building_id: 'b2' },
    ],
    edificios: [
      { id: 'b1', name: 'EDIFICIO H', code: 'H' },
      { id: 'b2', name: 'CRAI', code: 'CRAI' },
    ],
    perfiles: [
      { id: 'u1', full_name: 'Ana Pérez' },
      { id: 'u2', full_name: 'Marta Ruiz' },
    ],
    unidades: [
      {
        articulo: 'Ordenador Tiny',
        brand: 'Lenovo',
        model: 'M70q',
        serial: 'PF4XK2M1',
        notes: null,
        status: 'disponible',
        room_id: null,
        installed_at: null,
        retired_at: null,
      },
    ],
  }
}

const dia = (iso: string): number | null => fechaAExcel(`${iso}T12:00:00Z`)

describe('el balance del periodo', () => {
  const balance = balanceDelPeriodo(datos(), SEMANA)
  const de = (nombre: string) => balance.find((b) => b.nombre === nombre)!

  it('el stock al abrir es la suma de lo anterior, y los límites son medianoche de Madrid', () => {
    // 12 − 4 − 1 (el domingo a las 23:30). El de las 00:30 del lunes ya es del periodo.
    expect(de('Cable HDMI 3 m').alAbrir).toBe(7)
    expect(de('Cable HDMI 3 m').salidas).toBe(4)
    expect(de('Cable HDMI 3 m').entradas).toBe(20)
    // 7 + 20 − 4, sin el del sábado 21, que para este libro todavía no existe.
    expect(de('Cable HDMI 3 m').alCerrar).toBe(23)
  })

  it('cada movimiento cae en una sola columna, y las cuatro cuadran', () => {
    const pilas = de('Pilas AAA')
    // La devolución entra; el ajuste va aparte, con su signo.
    expect(pilas).toMatchObject({ alAbrir: 40, entradas: 1, salidas: 4, ajustes: -2, alCerrar: 35 })
    for (const b of balance) {
      expect(b.alAbrir + b.entradas - b.salidas + b.ajustes, b.nombre).toBe(b.alCerrar)
    }
  })

  it('cuenta los apuntes, los partes y las aulas de cada artículo', () => {
    const cable = de('Cable HDMI 3 m')
    expect(cable.movimientos).toBe(4)
    expect(cable.partes).toBe(2)
    // s1 por el parte i1 y s2 por el parte i2; el del plató no tiene aula.
    expect(cable.aulas).toBe(2)
  })

  it('trae lo que no se ha movido y lo retirado con saldo; lo retirado a cero, no', () => {
    expect(de('Ratón USB')).toMatchObject({ alAbrir: 5, alCerrar: 5, movimientos: 0 })
    expect(de('Cable VGA 2 m')).toMatchObject({ activo: false, alCerrar: 2 })
    expect(balance.map((b) => b.nombre)).not.toContain('Conversor SCART')
  })
})

describe('la hoja «Stock del periodo»', () => {
  const hoja = hojaDeStockDelPeriodo(balanceDelPeriodo(datos(), SEMANA))

  it('primero lo que se ha movido, después lo quieto y al final lo retirado', () => {
    expect(hoja.filas.slice(1).map((f) => f[0])).toEqual([
      'Cable HDMI 3 m',
      'Pilas AAA',
      'Ratón USB',
      'Cable VGA 2 m',
    ])
  })

  it('el stock lleva su cero y los movimientos van en blanco cuando no hubo', () => {
    expect(hoja.filas[0]).toEqual([
      'Artículo',
      'Unidad',
      'Stock al abrir',
      'Entradas',
      'Salidas',
      'Ajustes',
      'Stock al cerrar',
      'Variación',
      'Movimientos',
      'Partes',
      'Aulas',
      'Mínimo',
      'Situación',
    ])
    expect(hoja.filas[1]).toEqual(['Cable HDMI 3 m', 'ud', 7, 20, 4, null, 23, 16, 4, 2, 2, 5, 'Activo'])
    expect(hoja.filas[3]).toEqual(['Ratón USB', 'ud', 5, null, null, null, 5, null, null, null, null, 2, 'Activo'])
  })

  it('en verde donde ha entrado material, apagado lo retirado', () => {
    expect(hoja.tintes).toEqual(['ok', 'ok', undefined, 'apagado'])
  })
})

describe('la hoja «Movimientos del periodo»', () => {
  const hoja = hojaDeMovimientosDelPeriodo(datos(), SEMANA)
  const filas = hoja.filas.slice(1)

  it('solo los del periodo, del más antiguo al más reciente', () => {
    expect(filas).toHaveLength(7)
    expect(filas[0]![0]).toBe(dia('2026-11-16'))
    expect(filas[filas.length - 1]![0]).toBe(dia('2026-11-20'))
  })

  /*
   * El motivo de que esta hoja no sea la de la sincronización con un filtro:
   * aquella acumula el saldo desde cero sobre lo que recibe. Con solo los
   * movimientos de la semana, el primer consumo dejaría el cable en −2.
   */
  it('el saldo es el de verdad: arranca de lo que había, no de cero', () => {
    const cable = filas.filter((f) => f[2] === 'Cable HDMI 3 m').map((f) => f[6])
    expect(cable).toEqual([5, 25, 24, 23])
    const pilas = filas.filter((f) => f[2] === 'Pilas AAA').map((f) => f[6])
    expect(pilas).toEqual([36, 37, 35])
  })

  it('el parte va en su columna, y el aula es la del movimiento o la del parte', () => {
    const [primero] = filas
    // Fecha, hora, artículo, movimiento, entrada, salida, saldo, incidencia, solicitud, edificio, aula, quién, nota.
    expect(primero).toEqual([
      dia('2026-11-16'),
      '00:30',
      'Cable HDMI 3 m',
      'Consumo',
      null,
      2,
      5,
      'I261116_0001',
      null,
      'H',
      '2.1',
      'Ana Pérez',
      null,
    ])
    const ultimo = filas[filas.length - 1]!
    expect(ultimo[7]).toBeNull()
    expect(ultimo[8]).toBe('S261120_0002')
    expect(ultimo.slice(9, 11)).toEqual(['CRAI', '01'])
  })

  it('las compras en verde; la devolución y el ajuste, en ámbar', () => {
    expect(hoja.tintes).toEqual([undefined, 'ok', undefined, 'aviso', undefined, 'aviso', undefined])
  })

  it('lo que entró por el Excel no lleva hora inventada, y dice de dónde vino', () => {
    const d = datos()
    d.movimientos.push(
      mov('raton', -1, 'consumo', '2026-11-17T11:00:00Z', { by_user: null, source: 'sharepoint' }),
    )
    const fila = hojaDeMovimientosDelPeriodo(d, SEMANA).filas.find((f) => f[2] === 'Ratón USB')!
    expect(fila[1]).toBeNull()
    expect(fila[11]).toBe('Excel')
  })
})

describe('la hoja «Consumo por aula»', () => {
  const hoja = hojaDeConsumoPorAula(datos(), SEMANA)

  it('una fila por aula y artículo, y lo que no tiene aula al final', () => {
    expect(hoja.filas.slice(1)).toEqual([
      ['CRAI', '01', 'Cable HDMI 3 m', 1, 1, dia('2026-11-20')],
      ['CRAI', '01', 'Pilas AAA', 4, null, dia('2026-11-18')],
      ['H', '2.1', 'Cable HDMI 3 m', 2, 1, dia('2026-11-16')],
      [null, 'Sin aula', 'Cable HDMI 3 m', 1, null, dia('2026-11-19')],
    ])
  })

  it('suma lo mismo que las salidas del periodo: no se deja material fuera', () => {
    const unidades = hoja.filas.slice(1).reduce((s, f) => s + Number(f[3]), 0)
    const salidas = balanceDelPeriodo(datos(), SEMANA).reduce((s, b) => s + b.salidas, 0)
    expect(unidades).toBe(salidas)
  })
})

describe('el libro entero', () => {
  const libro = libroDelPeriodo(datos(), SEMANA, {
    titulo: 'Almacén · Informe semanal · del 16 al 20 de noviembre de 2026',
    emitido: '20/11/26, 9:14',
  })

  it('son seis hojas, y la primera es el contexto', () => {
    expect(libro.hojas.map((h) => h.nombre)).toEqual([
      'Resumen',
      'Stock del periodo',
      'Movimientos del periodo',
      'Consumo por aula',
      'Stock actual',
      'Unidades con n.º de serie',
    ])
  })

  it('las cifras del resumen son las de las hojas, sumadas', () => {
    expect(libro.cifras).toEqual({
      movimientos: 7,
      salidas: 8,
      entradas: 21,
      articulosMovidos: 2,
      aulasServidas: 2,
      articulosActivos: 3,
      conExistencias: 3,
      // Las pilas: 32 hoy con un mínimo de 40.
      bajoMinimo: 1,
      unidadesEnAlmacen: 1,
    })
  })

  it('«Stock actual» es la hoja de existencias de la pestaña Almacén, con su nombre de aquí', () => {
    const hoja = libro.hojas[4]!
    expect(hoja.filas[0]!.slice(0, 3)).toEqual(['Artículo', 'Unidad', 'Existencias'])
    // El de HOY: con el consumo del sábado 21, que el periodo no cuenta.
    expect(hoja.filas.find((f) => f[0] === 'Cable HDMI 3 m')![2]).toBe(20)
    expect(hoja.filas.find((f) => f[0] === 'Pilas AAA')![4]).toBe('Sí')
  })

  it('el resumen dice de qué periodo es y qué hay que reponer, y no deja casillas con borde', () => {
    const resumen = libro.hojas[0]!
    const texto = resumen.filas.flat().filter((v) => typeof v === 'string').join(' ')
    expect(texto).toContain('del 16 al 20 de noviembre de 2026 (16/11/2026 – 20/11/2026)')
    expect(texto).toContain('20/11/26, 9:14, hora de Madrid')
    expect(texto).toContain('Para reponer: Pilas AAA.')
    // Las cifras, como números: se pueden copiar y sumar.
    expect(resumen.filas.find((f) => f[0] === 'Unidades servidas')![1]).toBe(8)
    // Cada celda lleva su estilo: sin él, el escritor de hojas la pinta como
    // una celda de datos —con borde— y la primera fila como cabecera gris.
    resumen.filas.forEach((fila, i) =>
      fila.forEach((_, c) => expect(resumen.estilos?.[`${'ABC'[c]}${i + 1}`], `${'ABC'[c]}${i + 1}`).toBeTruthy()),
    )
    expect(resumen.estilos?.['A1']).toBe('titulo')
    expect(resumen.estilos?.['B1']).toBe('textoSinBorde')
  })

  it('sin nada que reponer lo dice como la buena noticia que es', () => {
    const resumen = hojaDeResumen({
      titulo: 'Almacén',
      rango: SEMANA,
      emitido: '20/11/26, 9:14',
      cifras: { ...libro.cifras, bajoMinimo: 0, salidas: 0, entradas: 0 },
      porReponer: [],
    })
    const texto = resumen.filas.flat().filter((v) => typeof v === 'string').join(' ')
    expect(texto).toContain('Ninguno: todo lo que tiene un mínimo fijado está por encima de él.')
    expect(texto).toContain('No ha salido material del almacén en el periodo.')
  })

  it('se abre como un Excel de verdad, con sus seis hojas y sus datos dentro', async () => {
    const abierto = await abrirLibro(await libroNuevo(libro.hojas))
    expect(abierto.hojas.map((h) => h.nombre)).toEqual(libro.hojas.map((h) => h.nombre))
    const stock = await leerHoja(abierto, 'Stock del periodo')
    expect(stock[1]!.celdas).toMatchObject({ A: 'Cable HDMI 3 m', C: 7, D: 20, E: 4, G: 23 })
    const movimientos = await leerHoja(abierto, 'Movimientos del periodo')
    expect(movimientos).toHaveLength(8)
    expect(movimientos[1]!.celdas).toMatchObject({ C: 'Cable HDMI 3 m', G: 5, H: 'I261116_0001' })
  })
})

describe('el Excel, listo para entregar', () => {
  const pedido = {
    titulo: 'Almacén · Informe semanal · del 16 al 20 de noviembre de 2026',
    nombre: 'informe-semanal-2026-11-16_2026-11-20-almacen.xlsx',
    emitido: '20/11/26, 9:14',
  }

  it('devuelve el fichero con su nombre y su tipo, sin comprimir en nada más', async () => {
    almacen.datos = datos()
    almacen.fallo = null
    const excel = await prepararExcelDelPeriodo(SEMANA, pedido)
    expect(excel.nombre).toBe('informe-semanal-2026-11-16_2026-11-20-almacen.xlsx')
    expect(excel.blob.type).toBe(TIPO_XLSX)
    expect(excel.blob.size).toBeGreaterThan(1000)
    expect(excel.cifras.movimientos).toBe(7)
  })

  it('si el almacén no se puede leer, lanza con el motivo: quien llama decide', async () => {
    almacen.fallo = new Error('No se pudo leer las existencias: permission denied')
    await expect(prepararExcelDelPeriodo(SEMANA, pedido)).rejects.toThrow(/No se pudo leer las existencias/)
    almacen.fallo = null
  })
})
