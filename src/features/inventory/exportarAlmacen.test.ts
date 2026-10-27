import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  articulosParaHoja,
  estaBajoMinimo,
  hojaDeExistencias,
  hojaDeUnidadesConSerie,
  hojasDelAlmacen,
  movimientosParaHoja,
  exportacionDelAlmacen,
  prepararExportacionDelAlmacen,
  tinteDelArticulo,
  tinteDeLaUnidad,
  unidadesParaHoja,
} from './exportarAlmacen'
import type {
  ArticuloParaHoja,
  DatosDelAlmacen,
  FilaArticulo,
  FilaMovimiento,
  FilaUnidad,
  UnidadParaHoja,
} from './exportarAlmacen'
import { hojaDeMovimientos } from '@/domain/hojasNuevas'
import { libroNuevo, nombreConFecha } from '@/domain/exportar'
import { abrirLibro, leerHoja } from '@/domain/xlsx'

/**
 * Un `supabase` de mentira: las tablas son listas, `range` corta la página como
 * PostgREST, y un fallo se configura por tabla (y por columnas pedidas, que es
 * como se distingue un servidor viejo de uno al día).
 */
const falso = vi.hoisted(() => {
  type Fallo = { message: string }
  const estado = {
    tablas: {} as Record<string, unknown[]>,
    rpc: {} as Record<string, unknown[] | Fallo>,
    fallo: (_tabla: string, _columnas: string): Fallo | null => null,
    peticiones: [] as string[],
  }
  const consulta = (tabla: string) => {
    let columnas = ''
    let desde = 0
    let hasta = Infinity
    const q = {
      select: (c: string) => ((columnas = c), q),
      order: () => q,
      range: (d: number, h: number) => ((desde = d), (hasta = h), q),
      abortSignal: () => q,
      then: (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) => {
        estado.peticiones.push(`${tabla}[${desde}-${hasta}] ${columnas}`)
        const error = estado.fallo(tabla, columnas)
        const filas = estado.tablas[tabla]
        const r = error
          ? { data: null, error }
          : filas
            ? { data: filas.slice(desde, hasta + 1), error: null }
            : { data: null, error: { message: `relation "${tabla}" does not exist` } }
        return Promise.resolve(r).then(ok, ko)
      },
    }
    return q
  }
  const supabase = {
    from: consulta,
    rpc: (nombre: string) => {
      const r = estado.rpc[nombre]
      const resultado =
        r === undefined
          ? { data: null, error: { message: `function ${nombre} does not exist` } }
          : Array.isArray(r)
            ? { data: r, error: null }
            : { data: null, error: r }
      const q = { abortSignal: () => q, then: (ok: (x: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(resultado).then(ok, ko) }
      return q
    },
  }
  return { estado, supabase }
})

vi.mock('@/lib/supabase', () => ({ supabase: falso.supabase }))

// Los días, en número de serie de Excel (`(fecha - 1899-12-30)` en días).
const D_2026_09_08 = 46273
const D_2026_09_23 = 46288
const D_2026_09_24 = 46289
const D_2026_10_27 = 46322

function articulo(extra: Partial<ArticuloParaHoja> = {}): ArticuloParaHoja {
  return {
    nombre: 'Cable HDMI',
    unidad: 'ud',
    existencias: 10,
    minimo: 3,
    tipoDeEquipo: null,
    activo: true,
    retiradoEl: null,
    motivoDeRetirada: null,
    ...extra,
  }
}

function unidad(extra: Partial<UnidadParaHoja> = {}): UnidadParaHoja {
  return {
    articulo: 'Ordenador Tiny M70Q',
    marca: 'Lenovo',
    modelo: 'M70q Gen 3',
    serial: 'PF3ABC12',
    condicion: 'nuevo',
    situacion: 'disponible',
    aula: null,
    desde: null,
    observaciones: null,
    ...extra,
  }
}

/** Las filas de datos de una hoja como objetos `{cabecera: valor}`, para no contar columnas. */
function comoObjetos(hoja: { filas: Array<Array<string | number | boolean | null>> }) {
  const [cabecera, ...datos] = hoja.filas
  return datos.map((f) => Object.fromEntries(cabecera!.map((c, i) => [String(c), f[i] ?? null])))
}

// -----------------------------------------------------------------------------
// Existencias
// -----------------------------------------------------------------------------

describe('estaBajoMinimo', () => {
  it('alcanzar el mínimo ya es estar bajo (igual que la vista stock_levels)', () => {
    expect(estaBajoMinimo(articulo({ existencias: 4, minimo: 3 }))).toBe(false)
    expect(estaBajoMinimo(articulo({ existencias: 3, minimo: 3 }))).toBe(true)
    expect(estaBajoMinimo(articulo({ existencias: 0, minimo: 3 }))).toBe(true)
  })

  it('sin mínimo (0) nunca está bajo, ni con cero existencias', () => {
    expect(estaBajoMinimo(articulo({ existencias: 0, minimo: 0 }))).toBe(false)
  })

  it('un retirado no cuenta: no pide reposición', () => {
    expect(estaBajoMinimo(articulo({ activo: false, existencias: 0, minimo: 5 }))).toBe(false)
  })
})

describe('tinteDelArticulo', () => {
  it('bajo mínimo es crítico', () => {
    expect(tinteDelArticulo(articulo({ existencias: 2, minimo: 3 }))).toBe('critico')
  })

  it('agotado sin mínimo es aviso; con mínimo ya es crítico', () => {
    expect(tinteDelArticulo(articulo({ existencias: 0, minimo: 0 }))).toBe('aviso')
    expect(tinteDelArticulo(articulo({ existencias: 0, minimo: 2 }))).toBe('critico')
  })

  it('un retirado va apagado, aunque esté a cero o por debajo del mínimo', () => {
    expect(tinteDelArticulo(articulo({ activo: false, existencias: 0, minimo: 5 }))).toBe('apagado')
    expect(tinteDelArticulo(articulo({ activo: false, existencias: 20 }))).toBe('apagado')
  })

  it('lo normal no se pinta', () => {
    expect(tinteDelArticulo(articulo({ existencias: 10, minimo: 3 }))).toBeUndefined()
    expect(tinteDelArticulo(articulo({ existencias: 1, minimo: 0 }))).toBeUndefined()
  })
})

describe('hojaDeExistencias', () => {
  it('es una hoja de la app con el nombre «Existencias» y la cabecera esperada', () => {
    const h = hojaDeExistencias([articulo()])
    expect(h.nombre).toBe('Existencias')
    expect(h.caracter).toBe('app')
    expect(h.filas[0]).toEqual([
      'Artículo',
      'Unidad',
      'Existencias',
      'Mínimo',
      'Bajo mínimo',
      'Tipo de equipo',
      'Estado',
      'Retirado el',
      'Motivo de la retirada',
    ])
    // La cabecera de una tabla es de texto, sin vacíos ni repetidos.
    expect(new Set(h.filas[0]).size).toBe(h.filas[0]!.length)
  })

  it('una fila por artículo, con «Sí» o «No» en Bajo mínimo', () => {
    const h = hojaDeExistencias([
      articulo({ nombre: 'Ratón', unidad: 'ud', existencias: 2, minimo: 5 }),
      articulo({ nombre: 'Teclado', unidad: 'ud', existencias: 9, minimo: 5 }),
    ])
    expect(comoObjetos(h)).toEqual([
      expect.objectContaining({ Artículo: 'Ratón', Existencias: 2, Mínimo: 5, 'Bajo mínimo': 'Sí', Estado: 'Activo' }),
      expect.objectContaining({ Artículo: 'Teclado', Existencias: 9, Mínimo: 5, 'Bajo mínimo': 'No', Estado: 'Activo' }),
    ])
  })

  it('el tinte va por fila de datos, en el mismo orden que las filas', () => {
    const h = hojaDeExistencias([
      articulo({ nombre: 'A normal', existencias: 10, minimo: 3 }),
      articulo({ nombre: 'B bajo', existencias: 1, minimo: 3 }),
      articulo({ nombre: 'C agotado', existencias: 0, minimo: 0 }),
      articulo({ nombre: 'D retirado', activo: false, existencias: 0, minimo: 3 }),
    ])
    expect(h.tintes).toEqual([undefined, 'critico', 'aviso', 'apagado'])
    expect(h.tintes).toHaveLength(h.filas.length - 1)
  })

  it('los retirados salen, con su estado, su fecha y su motivo, y «No» en Bajo mínimo', () => {
    const h = hojaDeExistencias([
      articulo({
        nombre: 'Cable VGA',
        activo: false,
        existencias: 0,
        minimo: 5,
        retiradoEl: '2026-09-23',
        motivoDeRetirada: 'Ya no se usa ningún VGA',
      }),
    ])
    expect(comoObjetos(h)[0]).toMatchObject({
      Artículo: 'Cable VGA',
      Estado: 'Retirado',
      'Bajo mínimo': 'No',
      'Retirado el': D_2026_09_23,
      'Motivo de la retirada': 'Ya no se usa ningún VGA',
    })
    expect(h.tintes).toEqual(['apagado'])
  })

  it('un vivo no lleva fecha ni motivo de retirada', () => {
    const o = comoObjetos(hojaDeExistencias([articulo()]))[0]!
    expect(o['Retirado el']).toBeNull()
    expect(o['Motivo de la retirada']).toBeNull()
  })

  it('el tipo de equipo enlazado sale si lo hay', () => {
    const o = comoObjetos(hojaDeExistencias([articulo({ tipoDeEquipo: 'Proyector' })]))[0]!
    expect(o['Tipo de equipo']).toBe('Proyector')
  })

  it('los vivos van primero por nombre (con los números en orden natural) y los retirados al final', () => {
    const h = hojaDeExistencias([
      articulo({ nombre: 'Cable 10 m' }),
      articulo({ nombre: 'Antiguo', activo: false }),
      articulo({ nombre: 'Cable 2 m' }),
      articulo({ nombre: 'Álbum' }),
    ])
    expect(comoObjetos(h).map((o) => o['Artículo'])).toEqual(['Álbum', 'Cable 2 m', 'Cable 10 m', 'Antiguo'])
    // Los tintes se reordenan con las filas.
    expect(h.tintes).toEqual([undefined, undefined, undefined, 'apagado'])
  })

  it('declara el formato de las columnas de número y de fecha', () => {
    const h = hojaDeExistencias([articulo()])
    expect(h.formatos?.[2]).toBe('entero')
    expect(h.formatos?.[3]).toBe('entero')
    expect(h.formatos?.[7]).toBe('fecha')
    expect(h.anchos).toHaveLength(h.filas[0]!.length)
  })

  it('sin artículos sale solo la cabecera', () => {
    const h = hojaDeExistencias([])
    expect(h.filas).toHaveLength(1)
    expect(h.tintes).toEqual([])
  })
})

// -----------------------------------------------------------------------------
// Unidades con número de serie
// -----------------------------------------------------------------------------

describe('tinteDeLaUnidad', () => {
  it('una averiada es un aviso, esté donde esté', () => {
    expect(tinteDeLaUnidad({ condicion: 'averiado', situacion: 'disponible' })).toBe('aviso')
    expect(tinteDeLaUnidad({ condicion: 'averiado', situacion: 'instalado' })).toBe('aviso')
  })

  it('una de baja va apagada, también si además estaba averiada', () => {
    expect(tinteDeLaUnidad({ condicion: 'usado', situacion: 'baja' })).toBe('apagado')
    expect(tinteDeLaUnidad({ condicion: 'averiado', situacion: 'baja' })).toBe('apagado')
  })

  it('lo demás no se pinta: ni nuevo, ni usado, ni reacondicionado, ni sin indicar', () => {
    for (const condicion of ['nuevo', 'usado', 'reacondicionado', 'sin_indicar'] as const) {
      expect(tinteDeLaUnidad({ condicion, situacion: 'disponible' }), condicion).toBeUndefined()
      expect(tinteDeLaUnidad({ condicion, situacion: 'instalado' }), condicion).toBeUndefined()
    }
  })
})

describe('hojaDeUnidadesConSerie', () => {
  it('lleva las columnas pedidas, sin repetidos', () => {
    const h = hojaDeUnidadesConSerie([unidad()])
    expect(h.nombre).toBe('Unidades con n.º de serie')
    expect(h.caracter).toBe('app')
    expect(h.filas[0]).toEqual([
      'Artículo',
      'Marca',
      'Modelo',
      'N.º de serie',
      'Estado',
      'Situación',
      'Aula',
      'Desde',
      'Observaciones',
    ])
    expect(new Set(h.filas[0]).size).toBe(h.filas[0]!.length)
    expect(h.anchos).toHaveLength(h.filas[0]!.length)
  })

  it('el nombre de la hoja cabe en un libro de Excel (31 caracteres, sin los prohibidos)', () => {
    const { nombre } = hojaDeUnidadesConSerie([])
    expect(nombre.length).toBeLessThanOrEqual(31)
    expect(nombre).not.toMatch(/[:\\/?*[\]]/)
  })

  it('una unidad en el almacén lleva su estado y no lleva aula ni fecha', () => {
    expect(comoObjetos(hojaDeUnidadesConSerie([unidad()]))[0]).toEqual({
      Artículo: 'Ordenador Tiny M70Q',
      Marca: 'Lenovo',
      Modelo: 'M70q Gen 3',
      'N.º de serie': 'PF3ABC12',
      Estado: 'Nuevo',
      Situación: 'En almacén',
      Aula: null,
      Desde: null,
      Observaciones: null,
    })
  })

  it('el estado y la situación son dos columnas y se leen con las palabras de las pantallas', () => {
    const h = hojaDeUnidadesConSerie([
      unidad({ serial: 'A', condicion: 'nuevo' }),
      unidad({ serial: 'B', condicion: 'usado' }),
      unidad({ serial: 'C', condicion: 'reacondicionado' }),
      unidad({ serial: 'D', condicion: 'averiado' }),
      unidad({ serial: 'E', condicion: 'sin_indicar' }),
      unidad({ serial: 'F', situacion: 'instalado' }),
      unidad({ serial: 'G', situacion: 'baja' }),
    ])
    const porSerie = Object.fromEntries(comoObjetos(h).map((o) => [o['N.º de serie'], o]))
    expect([porSerie['A']!.Estado, porSerie['B']!.Estado, porSerie['C']!.Estado, porSerie['D']!.Estado, porSerie['E']!.Estado]).toEqual([
      'Nuevo',
      'Usado',
      'Reacondicionado',
      'Averiado',
      'Sin indicar',
    ])
    expect([porSerie['A']!.Situación, porSerie['F']!.Situación, porSerie['G']!.Situación]).toEqual([
      'En almacén',
      'Instalada',
      'De baja',
    ])
  })

  it('una instalada lleva su aula y el día de la instalación como fecha de Excel', () => {
    const o = comoObjetos(
      hojaDeUnidadesConSerie([unidad({ situacion: 'instalado', aula: '2.1 C (Edificio H)', desde: '2026-09-08' })]),
    )[0]!
    expect(o).toMatchObject({ Situación: 'Instalada', Aula: '2.1 C (Edificio H)', Desde: D_2026_09_08 })
  })

  it('una de baja va apagada, con la fecha de la baja y sus observaciones', () => {
    const h = hojaDeUnidadesConSerie([
      unidad({ serial: 'A1' }),
      unidad({ serial: 'B2', situacion: 'baja', desde: '2026-09-23', observaciones: 'Placa quemada' }),
    ])
    expect(comoObjetos(h)[1]).toMatchObject({ Situación: 'De baja', Desde: D_2026_09_23, Observaciones: 'Placa quemada' })
    expect(h.tintes).toEqual([undefined, 'apagado'])
  })

  it('una averiada va en ámbar, y el tinte sigue a su fila cuando se reordena', () => {
    const h = hojaDeUnidadesConSerie([
      unidad({ serial: 'Z', condicion: 'averiado' }),
      unidad({ serial: 'Y', situacion: 'baja' }),
      unidad({ serial: 'X', condicion: 'usado' }),
      unidad({ serial: 'W', condicion: 'averiado', situacion: 'baja' }),
    ])
    // Primero lo que está en el almacén, por serie; después lo de baja.
    expect(comoObjetos(h).map((o) => [o['N.º de serie'], o.Estado])).toEqual([
      ['X', 'Usado'],
      ['Z', 'Averiado'],
      ['W', 'Averiado'],
      ['Y', 'Nuevo'],
    ])
    expect(h.tintes).toEqual([undefined, 'aviso', 'apagado', 'apagado'])
    expect(h.tintes).toHaveLength(h.filas.length - 1)
  })

  it('lleva unidades de cualquier artículo, juntas por artículo', () => {
    const h = hojaDeUnidadesConSerie([
      unidad({ serial: 'P2', articulo: 'Proyector Epson EB-L200', marca: 'Epson', modelo: 'EB-L200' }),
      unidad({ serial: 'T1', articulo: 'Teclado Logitech K120', marca: 'Logitech', modelo: 'K120' }),
      unidad({ serial: 'P1', articulo: 'Proyector Epson EB-L200', marca: 'Epson', modelo: 'EB-L200' }),
      unidad({ serial: 'O1' }),
    ])
    expect(comoObjetos(h).map((o) => [o['Artículo'], o['N.º de serie']])).toEqual([
      ['Ordenador Tiny M70Q', 'O1'],
      ['Proyector Epson EB-L200', 'P1'],
      ['Proyector Epson EB-L200', 'P2'],
      ['Teclado Logitech K120', 'T1'],
    ])
  })

  it('ordena por situación (en el almacén, instalada, de baja), después artículo, modelo y serie', () => {
    const h = hojaDeUnidadesConSerie([
      unidad({ serial: 'Z', situacion: 'baja' }),
      unidad({ serial: 'Y', situacion: 'instalado' }),
      unidad({ serial: 'B', modelo: 'M2' }),
      unidad({ serial: 'C', modelo: 'M1' }),
      unidad({ serial: 'A', modelo: 'M1' }),
    ])
    expect(comoObjetos(h).map((o) => o['N.º de serie'])).toEqual(['A', 'C', 'B', 'Y', 'Z'])
    expect(h.tintes).toEqual([undefined, undefined, undefined, undefined, 'apagado'])
  })

  it('declara la fecha y el ajuste de texto en sus columnas', () => {
    const h = hojaDeUnidadesConSerie([unidad()])
    expect(h.filas[0]![7]).toBe('Desde')
    expect(h.formatos?.[7]).toBe('fecha')
    expect(h.filas[0]![8]).toBe('Observaciones')
    expect(h.formatos?.[8]).toBe('textoAjustado')
  })

  it('sin unidades sale solo la cabecera', () => {
    const h = hojaDeUnidadesConSerie([])
    expect(h.filas).toHaveLength(1)
    expect(h.tintes).toEqual([])
  })
})

// -----------------------------------------------------------------------------
// De las filas de la base a las hojas
// -----------------------------------------------------------------------------

const ART = (extra: Partial<FilaArticulo> & { id: string; name: string }): FilaArticulo => ({
  unit: 'ud',
  min_threshold: 0,
  asset_type_id: null,
  active: true,
  retired_at: null,
  retired_reason: null,
  ...extra,
})

const MOV = (extra: Partial<FilaMovimiento> & { stock_item_id: string; qty: number }): FilaMovimiento => ({
  kind: kindDe(extra.qty),
  occurred_at: '2026-10-27T09:00:00Z',
  incident_id: null,
  room_id: null,
  by_user: null,
  source: 'app',
  note: null,
  ...extra,
})

function kindDe(n: number): string {
  return n > 0 ? 'compra' : 'consumo'
}

const VACIO: DatosDelAlmacen = {
  articulos: [],
  niveles: [],
  tipos: [],
  movimientos: [],
  incidencias: [],
  salas: [],
  zonas: [],
  edificios: [],
  perfiles: [],
  unidades: [],
}

describe('articulosParaHoja', () => {
  it('el saldo de un vivo es el de stock_levels, el de un retirado sale de sumar sus movimientos', () => {
    const r = articulosParaHoja({
      ...VACIO,
      articulos: [ART({ id: 'a', name: 'Ratón' }), ART({ id: 'b', name: 'VGA', active: false })],
      niveles: [{ stock_item_id: 'a', on_hand: 7 }],
      movimientos: [
        MOV({ stock_item_id: 'a', qty: 99 }), // la vista manda sobre la suma
        MOV({ stock_item_id: 'b', qty: 10 }),
        MOV({ stock_item_id: 'b', qty: -4 }),
      ],
    })
    expect(r.map((a) => [a.nombre, a.existencias])).toEqual([
      ['Ratón', 7],
      ['VGA', 6],
    ])
  })

  it('un artículo sin movimientos ni saldo tiene cero', () => {
    const r = articulosParaHoja({ ...VACIO, articulos: [ART({ id: 'a', name: 'Nuevo' })] })
    expect(r[0]!.existencias).toBe(0)
  })

  it('el tipo de equipo sigue las fusiones hasta el tipo vivo', () => {
    const r = articulosParaHoja({
      ...VACIO,
      articulos: [
        ART({ id: 'a', name: 'Lámpara', asset_type_id: 't-viejo' }),
        ART({ id: 'b', name: 'Cable', asset_type_id: 't-que-no-esta' }),
        ART({ id: 'c', name: 'Tóner' }),
      ],
      tipos: [
        { id: 't-viejo', name: 'TV', merged_into: 't-vivo' },
        { id: 't-vivo', name: 'Pantalla', merged_into: null },
      ],
    })
    expect(r.map((a) => a.tipoDeEquipo)).toEqual(['Pantalla', null, null])
  })

  it('la retirada se cuenta en el día de Madrid y el motivo se recorta', () => {
    const r = articulosParaHoja({
      ...VACIO,
      articulos: [
        // 22:30 UTC del 23 son las 00:30 del 24 en Madrid (horario de verano).
        ART({ id: 'a', name: 'X', active: false, retired_at: '2026-09-23T22:30:00Z', retired_reason: '  se rompió  ' }),
        ART({ id: 'b', name: 'Y', active: false, retired_at: null, retired_reason: '   ' }),
      ],
    })
    expect(r[0]).toMatchObject({ retiradoEl: '2026-09-24', motivoDeRetirada: 'se rompió', activo: false })
    expect(r[1]).toMatchObject({ retiradoEl: null, motivoDeRetirada: null })
  })

  it('con un servidor sin las columnas de la retirada, los inactivos salen retirados sin fecha', () => {
    const sinColumnas: FilaArticulo = { id: 'a', name: 'X', unit: 'ud', min_threshold: 0, asset_type_id: null, active: false }
    const r = articulosParaHoja({ ...VACIO, articulos: [sinColumnas] })
    expect(r[0]).toMatchObject({ activo: false, retiradoEl: null, motivoDeRetirada: null })
  })
})

describe('movimientosParaHoja', () => {
  const base: DatosDelAlmacen = {
    ...VACIO,
    articulos: [ART({ id: 'a', name: 'Cable HDMI' })],
    incidencias: [
      { id: 'i1', external_ref: 'I260102_0007', kind: 'incidencia', room_id: 's1' },
      { id: 'i2', external_ref: 'S260301_0004', kind: 'solicitud', room_id: 's2' },
      { id: 'i3', external_ref: 'O260301_0001', kind: 'observacion', room_id: null },
    ],
    salas: [
      { id: 's1', code: '1.7 H', zone_id: 'z' },
      { id: 's2', code: '0.1 P', zone_id: 'z' },
    ],
    perfiles: [
      { id: 'u1', full_name: 'Ana Pérez' },
      { id: 'u2', full_name: null },
    ],
  }

  it('cruza el parte, la clase de parte, el aula y la persona', () => {
    const [m] = movimientosParaHoja({
      ...base,
      movimientos: [MOV({ stock_item_id: 'a', qty: -1, incident_id: 'i1', by_user: 'u1', note: 'se gastó' })],
    })
    expect(m).toMatchObject({
      articulo: 'Cable HDMI',
      cantidad: -1,
      tipo: 'consumo',
      incidencia: 'I260102_0007',
      claseDeParte: 'incidencia',
      sala: '1.7 H',
      quien: 'Ana Pérez',
      nota: 'se gastó',
    })
  })

  it('una solicitud va como solicitud; una observación lleva número pero no es un parte', () => {
    const r = movimientosParaHoja({
      ...base,
      movimientos: [
        MOV({ stock_item_id: 'a', qty: -1, incident_id: 'i2' }),
        MOV({ stock_item_id: 'a', qty: -1, incident_id: 'i3' }),
      ],
    })
    expect(r.map((m) => [m.incidencia, m.claseDeParte])).toEqual([
      ['S260301_0004', 'solicitud'],
      ['O260301_0001', null],
    ])
  })

  it('el aula del propio movimiento gana a la del parte; sin ella, la del parte; sin ninguna, nada', () => {
    const r = movimientosParaHoja({
      ...base,
      movimientos: [
        MOV({ stock_item_id: 'a', qty: -1, incident_id: 'i1', room_id: 's2' }),
        MOV({ stock_item_id: 'a', qty: -1, incident_id: 'i1' }),
        MOV({ stock_item_id: 'a', qty: -1, room_id: 's2' }),
        MOV({ stock_item_id: 'a', qty: 5 }),
        MOV({ stock_item_id: 'a', qty: -1, room_id: 'sala-que-no-esta' }),
      ],
    })
    expect(r.map((m) => m.sala)).toEqual(['0.1 P', '1.7 H', '0.1 P', null, null])
  })

  it('«Quién»: la persona, «Excel» si entró por la hoja, y vacío si no hay dato', () => {
    const r = movimientosParaHoja({
      ...base,
      movimientos: [
        MOV({ stock_item_id: 'a', qty: 1, by_user: 'u1' }),
        MOV({ stock_item_id: 'a', qty: 1, by_user: null, source: 'sharepoint' }),
        MOV({ stock_item_id: 'a', qty: 1, by_user: null, source: 'app' }),
        MOV({ stock_item_id: 'a', qty: 1, by_user: 'u2' }),
        MOV({ stock_item_id: 'a', qty: 1, by_user: 'u-borrado' }),
      ],
    })
    expect(r.map((m) => m.quien)).toEqual(['Ana Pérez', 'Excel', null, null, null])
  })

  it('un artículo que ya no está en el catálogo sale como «—»; un parte desconocido, sin número', () => {
    const [m] = movimientosParaHoja({
      ...base,
      movimientos: [MOV({ stock_item_id: 'fantasma', qty: -1, incident_id: 'parte-borrado' })],
    })
    expect(m).toMatchObject({ articulo: '—', incidencia: null, claseDeParte: null })
  })

  it('un parte sin número no deja una cadena vacía en la columna', () => {
    const [m] = movimientosParaHoja({
      ...base,
      incidencias: [{ id: 'i9', external_ref: '', kind: 'incidencia', room_id: null }],
      movimientos: [MOV({ stock_item_id: 'a', qty: -1, incident_id: 'i9' })],
    })
    expect(m!.incidencia).toBeNull()
  })

  describe('en la hoja de movimientos', () => {
    const datos: DatosDelAlmacen = {
      ...base,
      movimientos: [
        MOV({ stock_item_id: 'a', qty: 10, occurred_at: '2026-09-23T09:00:00Z' }),
        // 22:30 UTC del 23 son las 00:30 del 24 en Madrid: el movimiento es del 24.
        MOV({ stock_item_id: 'a', qty: -3, occurred_at: '2026-09-23T22:30:00Z', incident_id: 'i1' }),
        MOV({ stock_item_id: 'a', qty: -2, occurred_at: '2026-10-27T09:00:00Z', incident_id: 'i2' }),
      ],
    }

    it('el saldo corre por artículo y la fecha es el día de Madrid', () => {
      const h = hojaDeMovimientos(movimientosParaHoja(datos))
      expect(h.nombre).toBe('Movimientos de Almacén')
      const filas = comoObjetos(h)
      expect(filas.map((f) => f['Fecha'])).toEqual([D_2026_09_23, D_2026_09_24, D_2026_10_27])
      expect(filas.map((f) => f['Saldo'])).toEqual([10, 7, 5])
      expect(filas.map((f) => [f['Entrada'], f['Salida']])).toEqual([
        [10, null],
        [null, 3],
        [null, 2],
      ])
    })

    it('el número del parte va a su columna: Incidencia o Solicitud', () => {
      const filas = comoObjetos(hojaDeMovimientos(movimientosParaHoja(datos)))
      expect(filas.map((f) => [f['Incidencia'], f['Solicitud'], f['Aula']])).toEqual([
        [null, null, null],
        ['I260102_0007', null, '1.7 H'],
        [null, 'S260301_0004', '0.1 P'],
      ])
    })

    it('la fecha no se mueve según la zona del aparato', () => {
      // `fechaAExcel` lee un instante en la zona del aparato; un día suelto a
      // medianoche UTC se iría al anterior en América. Se prueba cambiando la zona.
      const antes = process.env['TZ']
      try {
        for (const zona of ['America/Los_Angeles', 'America/New_York', 'Europe/Madrid', 'UTC', 'Asia/Tokyo', 'Australia/Sydney']) {
          process.env['TZ'] = zona
          const filas = comoObjetos(hojaDeMovimientos(movimientosParaHoja(datos)))
          expect(filas.map((f) => f['Fecha']), zona).toEqual([D_2026_09_23, D_2026_09_24, D_2026_10_27])
        }
      } finally {
        if (antes === undefined) delete process.env['TZ']
        else process.env['TZ'] = antes
      }
    })
  })
})

describe('unidadesParaHoja', () => {
  const FILA = (extra: Partial<FilaUnidad> = {}): FilaUnidad => ({
    articulo: 'Ordenador Tiny M70Q',
    item_name: 'Ordenador Tiny M70Q',
    brand: 'Lenovo',
    model: 'M70q',
    serial: 'S1',
    notes: null,
    status: 'disponible',
    condicion: 'nuevo',
    room_id: null,
    installed_at: null,
    retired_at: null,
    ...extra,
  })

  const sitio = {
    salas: [{ id: 'r1', code: '2.1 C', zone_id: 'z1' }],
    zonas: [{ id: 'z1', building_id: 'b1' }],
    edificios: [{ id: 'b1', name: 'Edificio H' }],
  }

  it('una instalada lleva el aula con su edificio y el día de la instalación en Madrid', () => {
    const [u] = unidadesParaHoja({
      ...sitio,
      unidades: [FILA({ status: 'instalado', room_id: 'r1', installed_at: '2026-09-07T22:30:00Z' })],
    })
    expect(u).toMatchObject({ situacion: 'instalado', aula: '2.1 C (Edificio H)', desde: '2026-09-08' })
  })

  it('una en el almacén no lleva aula ni fecha, aunque conserve un aula de antes', () => {
    const [u] = unidadesParaHoja({
      ...sitio,
      unidades: [FILA({ room_id: 'r1', installed_at: '2026-09-07T10:00:00Z' })],
    })
    expect(u).toMatchObject({ situacion: 'disponible', aula: null, desde: null })
  })

  it('una de baja lleva la fecha de la baja, no la de la instalación', () => {
    const [u] = unidadesParaHoja({
      ...sitio,
      unidades: [
        FILA({ status: 'baja', room_id: 'r1', installed_at: '2026-01-01T10:00:00Z', retired_at: '2026-09-23T10:00:00Z', notes: 'Quemado' }),
      ],
    })
    expect(u).toMatchObject({ situacion: 'baja', aula: null, desde: '2026-09-23', observaciones: 'Quemado' })
  })

  it('una situación desconocida se lee como en el almacén; un aula que ya no existe, sin aula', () => {
    const r = unidadesParaHoja({
      ...sitio,
      unidades: [FILA({ status: 'raro' }), FILA({ status: 'instalado', room_id: 'borrada', installed_at: '2026-09-08T10:00:00Z' })],
    })
    expect(r[0]!.situacion).toBe('disponible')
    expect(r[1]).toMatchObject({ situacion: 'instalado', aula: null, desde: '2026-09-08' })
  })

  it('sin edificio conocido, solo el código del aula', () => {
    const [u] = unidadesParaHoja({
      salas: [{ id: 'r1', code: '2.1 C', zone_id: 'zona-que-no-esta' }],
      zonas: [],
      edificios: [],
      unidades: [FILA({ status: 'instalado', room_id: 'r1' })],
    })
    expect(u!.aula).toBe('2.1 C')
  })

  it('conserva marca, modelo, serie y observaciones tal cual', () => {
    const [u] = unidadesParaHoja({ ...sitio, unidades: [FILA({ notes: 'Con cargador' })] })
    expect(u).toMatchObject({ articulo: 'Ordenador Tiny M70Q', marca: 'Lenovo', modelo: 'M70q', serial: 'S1', observaciones: 'Con cargador' })
  })

  describe('el artículo', () => {
    it('es el del almacén, no lo que apuntó quien la dio de alta', () => {
      const [u] = unidadesParaHoja({
        ...sitio,
        unidades: [FILA({ articulo: 'proyector epson', item_name: 'Proyector Epson EB-L200' })],
      })
      expect(u!.articulo).toBe('Proyector Epson EB-L200')
    })

    it('sin artículo casado, o con un servidor que no lo dice, queda lo apuntado', () => {
      const r = unidadesParaHoja({
        ...sitio,
        unidades: [
          FILA({ articulo: 'Ordenador Tiny', item_name: null }),
          FILA({ articulo: 'Ordenador Tiny', item_name: '   ' }),
          FILA({ articulo: 'Ordenador Tiny', item_name: undefined }),
        ],
      })
      expect(r.map((u) => u.articulo)).toEqual(['Ordenador Tiny', 'Ordenador Tiny', 'Ordenador Tiny'])
    })
  })

  describe('el estado', () => {
    it('se lee tal cual lo dice la base', () => {
      const r = unidadesParaHoja({
        ...sitio,
        unidades: (['nuevo', 'usado', 'reacondicionado', 'averiado', 'sin_indicar'] as const).map((c) => FILA({ condicion: c })),
      })
      expect(r.map((u) => u.condicion)).toEqual(['nuevo', 'usado', 'reacondicionado', 'averiado', 'sin_indicar'])
    })

    it('sin dato —un servidor sin la vista— es «sin indicar», nunca «nuevo»', () => {
      const r = unidadesParaHoja({
        ...sitio,
        unidades: [FILA({ condicion: undefined }), FILA({ condicion: null }), FILA({ condicion: '' })],
      })
      expect(r.map((u) => u.condicion)).toEqual(['sin_indicar', 'sin_indicar', 'sin_indicar'])
    })

    it('uno que la aplicación no conoce también es «sin indicar»: la hoja no escribe lo que no entiende', () => {
      const r = unidadesParaHoja({ ...sitio, unidades: [FILA({ condicion: 'roto' }), FILA({ condicion: 'toString' })] })
      expect(r.map((u) => u.condicion)).toEqual(['sin_indicar', 'sin_indicar'])
    })
  })
})

// -----------------------------------------------------------------------------
// Las tres hojas juntas, hasta el fichero
// -----------------------------------------------------------------------------

describe('hojasDelAlmacen', () => {
  const datos: DatosDelAlmacen = {
    articulos: [
      ART({ id: 'a', name: 'Cable HDMI', min_threshold: 5, asset_type_id: 't' }),
      ART({ id: 'b', name: 'Ratón', min_threshold: 0 }),
      ART({ id: 'c', name: 'Cable VGA', active: false, retired_at: '2026-09-23T10:00:00Z', retired_reason: 'Ya no se usa' }),
    ],
    niveles: [
      { stock_item_id: 'a', on_hand: 2 },
      { stock_item_id: 'b', on_hand: 0 },
    ],
    tipos: [{ id: 't', name: 'Proyector' }],
    movimientos: [
      MOV({ stock_item_id: 'a', qty: 6, occurred_at: '2026-09-23T09:00:00Z' }),
      MOV({ stock_item_id: 'a', qty: -4, occurred_at: '2026-10-27T09:00:00Z', incident_id: 'i1', by_user: 'u1', note: 'Cambio de cable' }),
      MOV({ stock_item_id: 'c', qty: 3, occurred_at: '2026-09-01T09:00:00Z' }),
    ],
    incidencias: [{ id: 'i1', external_ref: 'I261027_0001', kind: 'incidencia', room_id: 'r1' }],
    salas: [{ id: 'r1', code: '2.1 C', zone_id: 'z1' }],
    zonas: [{ id: 'z1', building_id: 'b1' }],
    edificios: [{ id: 'b1', name: 'Edificio H' }],
    perfiles: [{ id: 'u1', full_name: 'Ana Pérez' }],
    unidades: [
      {
        articulo: 'Ordenador Tiny M70Q',
        item_name: 'Ordenador Tiny M70Q',
        brand: 'Lenovo',
        model: 'M70q',
        serial: 'S1',
        notes: null,
        status: 'instalado',
        condicion: 'usado',
        room_id: 'r1',
        installed_at: '2026-09-08T10:00:00Z',
        retired_at: null,
      },
    ],
  }

  /** Una unidad en el almacén, de cualquier artículo. */
  const EN_ALMACEN = (serial: string, extra: Partial<FilaUnidad> = {}): FilaUnidad => ({
    articulo: 'Proyector Epson',
    item_name: 'Proyector Epson EB-L200',
    brand: 'Epson',
    model: 'EB-L200',
    serial,
    notes: null,
    status: 'disponible',
    condicion: 'nuevo',
    room_id: null,
    installed_at: null,
    retired_at: null,
    ...extra,
  })

  it('el inventario del almacén: título, cifras y qué va al PDF', () => {
    const e = exportacionDelAlmacen(datos)
    expect(e.titulo).toBe('Inventario del almacén')
    expect(e.nombreBase).toBe('Almacén')
    // Dos activos (el retirado no cuenta), el HDMI bajo mínimo, ninguna unidad en
    // el almacén (la única está instalada).
    expect(e.resumen).toBe('2 artículos · 1 bajo mínimo · 0 unidades con n.º de serie en el almacén')
    // El historial va en el Excel y en el PDF solo si se pide; las existencias, sin
    // la retirada, para que quepan en el A4.
    expect(e.hojas.map((h) => h.pdf?.incluir !== false)).toEqual([true, false, true])
    expect(e.hojas[0]!.pdf?.columnas).not.toContain('Motivo de la retirada')
  })

  it('al PDF van por defecto las existencias y las unidades, con todas sus columnas; los movimientos, no', () => {
    const e = exportacionDelAlmacen(datos)
    expect(e.hojas.map((h) => [h.hoja.nombre, h.pdf?.incluir !== false])).toEqual([
      ['Existencias', true],
      ['Movimientos de Almacén', false],
      ['Unidades con n.º de serie', true],
    ])
    expect(e.hojas[2]!.pdf?.columnas).toBeUndefined()
  })

  it('el resumen cuenta las unidades que están en el almacén, de cualquier artículo, en plural', () => {
    const e = exportacionDelAlmacen({
      ...datos,
      unidades: [
        EN_ALMACEN('P1'),
        EN_ALMACEN('P2', { condicion: 'averiado' }),
        EN_ALMACEN('T1', { item_name: 'Teclado Logitech K120' }),
        EN_ALMACEN('O1', { item_name: 'Ordenador Tiny M70Q' }),
        // Instalada y de baja no están en el almacén.
        EN_ALMACEN('I1', { status: 'instalado', room_id: 'r1' }),
        EN_ALMACEN('B1', { status: 'baja' }),
      ],
    })
    expect(e.resumen).toBe('2 artículos · 1 bajo mínimo · 4 unidades con n.º de serie en el almacén')
  })

  it('y en singular si es una', () => {
    const e = exportacionDelAlmacen({ ...datos, unidades: [EN_ALMACEN('P1')] })
    expect(e.resumen).toBe('2 artículos · 1 bajo mínimo · 1 unidad con n.º de serie en el almacén')
  })

  it('las averiadas van en ámbar y las de baja apagadas, en la hoja que se ve y se descarga', () => {
    const e = exportacionDelAlmacen({
      ...datos,
      unidades: [
        EN_ALMACEN('A', { condicion: 'averiado' }),
        EN_ALMACEN('B', { condicion: 'usado' }),
        EN_ALMACEN('C', { status: 'baja', retired_at: '2026-09-23T10:00:00Z' }),
      ],
    })
    expect(e.hojas[2]!.hoja.tintes).toEqual(['aviso', undefined, 'apagado'])
  })

  it('son tres, en este orden', () => {
    expect(hojasDelAlmacen(datos).map((h) => h.nombre)).toEqual([
      'Existencias',
      'Movimientos de Almacén',
      'Unidades con n.º de serie',
    ])
  })

  it('con ellas se hace un libro que se abre y se lee', async () => {
    const libro = await abrirLibro(await libroNuevo(hojasDelAlmacen(datos)))
    expect(libro.hojas.map((h) => h.nombre)).toEqual(['Existencias', 'Movimientos de Almacén', 'Unidades con n.º de serie'])

    const existencias = await leerHoja(libro, 'Existencias')
    // Vivos por nombre, retirado al final.
    expect(existencias.map((f) => f.celdas.A)).toEqual(['Artículo', 'Cable HDMI', 'Ratón', 'Cable VGA'])
    expect(existencias[1]!.celdas).toMatchObject({ C: 2, D: 5, E: 'Sí', F: 'Proyector', G: 'Activo' })
    expect(existencias[2]!.celdas).toMatchObject({ C: 0, E: 'No', G: 'Activo' })
    // El retirado: su saldo sale de los movimientos porque la vista no lo trae.
    expect(existencias[3]!.celdas).toMatchObject({ C: 3, E: 'No', G: 'Retirado', H: D_2026_09_23, I: 'Ya no se usa' })

    const movimientos = await leerHoja(libro, 'Movimientos de Almacén')
    expect(movimientos).toHaveLength(4)
    expect(movimientos[3]!.celdas).toMatchObject({ A: D_2026_10_27, B: 'Cable HDMI', C: 'Consumo', E: 4, F: 2, G: 'I261027_0001', I: '2.1 C', J: 'Ana Pérez', K: 'Cambio de cable' })

    const unidades = await leerHoja(libro, 'Unidades con n.º de serie')
    expect(unidades[0]!.celdas).toMatchObject({ D: 'N.º de serie', E: 'Estado', F: 'Situación', G: 'Aula', H: 'Desde' })
    expect(unidades[1]!.celdas).toEqual({
      A: 'Ordenador Tiny M70Q',
      B: 'Lenovo',
      C: 'M70q',
      D: 'S1',
      E: 'Usado',
      F: 'Instalada',
      G: '2.1 C (Edificio H)',
      H: D_2026_09_08,
    })
  })

  it('un nombre, una nota o una serie que empiecen por «=» salen como texto y no como fórmula', async () => {
    const hostil: DatosDelAlmacen = {
      ...datos,
      articulos: [ART({ id: 'a', name: '=HYPERLINK("http://malo","x")' })],
      niveles: [],
      movimientos: [MOV({ stock_item_id: 'a', qty: 1, note: '=1+1' })],
      incidencias: [],
      unidades: [{ ...datos.unidades[0]!, serial: '=cmd|\' /C calc\'!A0', notes: '@SUMA(1)' }],
    }
    const libro = await abrirLibro(await libroNuevo(hojasDelAlmacen(hostil)))
    for (const h of libro.hojas) {
      const filas = await leerHoja(libro, h.nombre)
      for (const f of filas) expect(f.formulas, `${h.nombre} fila ${f.fila}`).toEqual({})
    }
    expect((await leerHoja(libro, 'Existencias'))[1]!.celdas.A).toBe('\'=HYPERLINK("http://malo","x")')
    expect((await leerHoja(libro, 'Movimientos de Almacén'))[1]!.celdas.K).toBe("'=1+1")
    expect((await leerHoja(libro, 'Unidades con n.º de serie'))[1]!.celdas.D).toBe("'=cmd|' /C calc'!A0")
  })

  it('un almacén vacío también da un libro con las tres hojas', async () => {
    const libro = await abrirLibro(await libroNuevo(hojasDelAlmacen(VACIO)))
    expect(libro.hojas).toHaveLength(3)
    for (const h of libro.hojas) expect(await leerHoja(libro, h.nombre)).toHaveLength(1)
  })
})

// -----------------------------------------------------------------------------
// Leer de la base y armar el fichero
// -----------------------------------------------------------------------------

/** Lo que descarga «Descargar Excel» en la vista previa: las hojas de la exportación, en un libro. */
async function prepararExcelDelAlmacen(): Promise<{ nombre: string; bytes: Uint8Array }> {
  const e = await prepararExportacionDelAlmacen()
  return { nombre: nombreConFecha(e.nombreBase), bytes: await libroNuevo(e.hojas.map((h) => h.hoja)) }
}

describe('prepararExportacionDelAlmacen', () => {
  /** Lo mínimo de cada tabla, en el orden y con los nombres de la base. */
  function servidor(extra: Record<string, unknown[]> = {}): void {
    falso.estado.tablas = {
      stock_items: [
        { id: 'a', name: 'Cable HDMI', unit: 'ud', min_threshold: 5, asset_type_id: null, active: true, retired_at: null, retired_reason: null },
        { id: 'c', name: 'Cable VGA', unit: 'ud', min_threshold: 0, asset_type_id: null, active: false, retired_at: '2026-09-23T10:00:00Z', retired_reason: 'Ya no se usa' },
      ],
      stock_levels: [{ stock_item_id: 'a', on_hand: 2 }],
      asset_types: [],
      stock_movements: [
        { stock_item_id: 'a', qty: 6, kind: 'compra', occurred_at: '2026-09-23T09:00:00Z', incident_id: null, room_id: null, by_user: 'u1', source: 'app', note: null },
        { stock_item_id: 'c', qty: 3, kind: 'compra', occurred_at: '2026-09-01T09:00:00Z', incident_id: null, room_id: null, by_user: null, source: 'sharepoint', note: null },
      ],
      incidents: [],
      rooms: [{ id: 'r1', code: '2.1 C', zone_id: 'z1' }],
      zones: [{ id: 'z1', building_id: 'b1' }],
      buildings: [{ id: 'b1', name: 'Edificio H' }],
      profiles: [{ id: 'u1', full_name: 'Solo yo' }],
      // La vista: las unidades de cualquier artículo, con su nombre y su estado.
      stock_unit_list: [
        { articulo: 'Ordenador Tiny', item_name: 'Ordenador Tiny M70Q', brand: 'Lenovo', model: 'M70q', serial: 'S1', notes: null, status: 'instalado', condicion: 'usado', room_id: 'r1', installed_at: '2026-09-08T10:00:00Z', retired_at: null },
        { articulo: 'Proyector', item_name: 'Proyector Epson EB-L200', brand: 'Epson', model: 'EB-L200', serial: 'P1', notes: 'Lámpara por cambiar', status: 'disponible', condicion: 'averiado', room_id: null, installed_at: null, retired_at: null },
      ],
      // La tabla de antes —un servidor sin la migración de octubre—: solo ordenadores y sin estado.
      stock_units: [
        { articulo: 'Ordenador Tiny M70Q', brand: 'Lenovo', model: 'M70q', serial: 'S1', notes: null, status: 'instalado', room_id: 'r1', installed_at: '2026-09-08T10:00:00Z', retired_at: null },
      ],
      ...extra,
    }
    falso.estado.rpc = { nombres_del_personal: [{ id: 'u1', full_name: 'Ana Pérez' }] }
  }

  beforeEach(() => {
    falso.estado.fallo = () => null
    falso.estado.peticiones = []
    servidor()
  })

  it('devuelve el nombre con la fecha de Madrid y un libro con las tres hojas', async () => {
    const { nombre, bytes } = await prepararExcelDelAlmacen()
    expect(nombre).toMatch(/^Almacén \d{4}-\d{2}-\d{2}\.xlsx$/)

    const libro = await abrirLibro(bytes)
    expect(libro.hojas.map((h) => h.nombre)).toEqual(['Existencias', 'Movimientos de Almacén', 'Unidades con n.º de serie'])
    const existencias = await leerHoja(libro, 'Existencias')
    expect(existencias.map((f) => f.celdas.A)).toEqual(['Artículo', 'Cable HDMI', 'Cable VGA'])
    expect(existencias[1]!.celdas).toMatchObject({ C: 2, E: 'Sí', G: 'Activo' })
    expect(existencias[2]!.celdas).toMatchObject({ C: 3, G: 'Retirado', H: D_2026_09_23, I: 'Ya no se usa' })
  })

  it('las unidades salen de la vista: de cualquier artículo, con el nombre del almacén y su estado', async () => {
    const { bytes } = await prepararExcelDelAlmacen()
    const unidades = await leerHoja(await abrirLibro(bytes), 'Unidades con n.º de serie')

    // Primero lo que está en el almacén, después lo instalado.
    expect(unidades.map((f) => f.celdas.D)).toEqual(['N.º de serie', 'P1', 'S1'])
    expect(unidades[1]!.celdas).toEqual({
      A: 'Proyector Epson EB-L200',
      B: 'Epson',
      C: 'EB-L200',
      D: 'P1',
      E: 'Averiado',
      F: 'En almacén',
      I: 'Lámpara por cambiar',
    })
    expect(unidades[2]!.celdas).toMatchObject({
      A: 'Ordenador Tiny M70Q',
      D: 'S1',
      E: 'Usado',
      F: 'Instalada',
      G: '2.1 C (Edificio H)',
      H: D_2026_09_08,
    })
    // Y sin tocar la tabla: la vista basta.
    expect(falso.estado.peticiones.filter((p) => p.startsWith('stock_unit_list'))).toHaveLength(1)
    expect(falso.estado.peticiones.some((p) => p.startsWith('stock_units'))).toBe(false)
  })

  it('la vista previa sale de esas mismas unidades: el resumen y el color de cada fila', async () => {
    const e = await prepararExportacionDelAlmacen()
    // Un artículo vivo (el VGA está retirado), el HDMI con 2 y mínimo 5, y el proyector averiado en el almacén.
    expect(e.resumen).toBe('1 artículo · 1 bajo mínimo · 1 unidad con n.º de serie en el almacén')
    expect(e.hojas[2]!.hoja.tintes).toEqual(['aviso', undefined])
  })

  it('los nombres salen de nombres_del_personal, no de profiles (que a un técnico solo le da el suyo)', async () => {
    const { bytes } = await prepararExcelDelAlmacen()
    const movimientos = await leerHoja(await abrirLibro(bytes), 'Movimientos de Almacén')
    // Primero el del 1 de septiembre (Excel, sin persona) y después el del 23.
    expect(movimientos.map((f) => f.celdas.J)).toEqual(['Quién', 'Excel', 'Ana Pérez'])
    expect(falso.estado.peticiones.some((p) => p.startsWith('profiles'))).toBe(false)
  })

  it('sin esa función en el servidor, cae a profiles', async () => {
    falso.estado.rpc = {}
    const { bytes } = await prepararExcelDelAlmacen()
    const movimientos = await leerHoja(await abrirLibro(bytes), 'Movimientos de Almacén')
    expect(movimientos.map((f) => f.celdas.J)).toEqual(['Quién', 'Excel', 'Solo yo'])
  })

  it('pasa de las mil filas: pide página a página y no pierde ni repite ninguna', async () => {
    const muchos = Array.from({ length: 2300 }, (_, i) => ({
      stock_item_id: 'a',
      qty: 1,
      kind: 'compra',
      occurred_at: '2026-09-23T09:00:00Z',
      incident_id: null,
      room_id: null,
      by_user: null,
      source: 'app',
      note: `n${i}`,
    }))
    servidor({ stock_movements: muchos })
    const { bytes } = await prepararExcelDelAlmacen()
    const filas = await leerHoja(await abrirLibro(bytes), 'Movimientos de Almacén')
    expect(filas).toHaveLength(2301)
    expect(new Set(filas.slice(1).map((f) => f.celdas.K)).size).toBe(2300)
    expect(falso.estado.peticiones.filter((p) => p.startsWith('stock_movements'))).toHaveLength(3)
  })

  it('un servidor sin las columnas de la retirada se pide otra vez sin ellas', async () => {
    falso.estado.fallo = (tabla, columnas) =>
      tabla === 'stock_items' && columnas.includes('retired_at')
        ? { message: 'column stock_items.retired_at does not exist' }
        : null
    servidor({
      stock_items: [
        { id: 'a', name: 'Cable HDMI', unit: 'ud', min_threshold: 5, asset_type_id: null, active: true },
        { id: 'c', name: 'Cable VGA', unit: 'ud', min_threshold: 0, asset_type_id: null, active: false },
      ],
    })
    const { bytes } = await prepararExcelDelAlmacen()
    const existencias = await leerHoja(await abrirLibro(bytes), 'Existencias')
    expect(existencias[2]!.celdas).toMatchObject({ A: 'Cable VGA', G: 'Retirado' })
    expect(existencias[2]!.celdas.H).toBeUndefined()
  })

  describe('un servidor sin la migración del 27 de octubre', () => {
    it('sin la vista, lee la tabla de siempre: las unidades salen, sin estado y con lo que apuntó quien las dio de alta', async () => {
      delete falso.estado.tablas['stock_unit_list']
      const { bytes } = await prepararExcelDelAlmacen()
      const unidades = await leerHoja(await abrirLibro(bytes), 'Unidades con n.º de serie')

      expect(unidades).toHaveLength(2)
      expect(unidades[1]!.celdas).toEqual({
        A: 'Ordenador Tiny M70Q',
        B: 'Lenovo',
        C: 'M70q',
        D: 'S1',
        E: 'Sin indicar',
        F: 'Instalada',
        G: '2.1 C (Edificio H)',
        H: D_2026_09_08,
      })
      // Primero la vista, y al no estar, la tabla —sin pedirle columnas que no tiene—.
      const aLaTabla = falso.estado.peticiones.filter((p) => p.startsWith('stock_units'))
      expect(aLaTabla).toHaveLength(1)
      expect(aLaTabla[0]).not.toContain('condicion')
      expect(aLaTabla[0]).not.toContain('item_name')
    })

    it('con la vista pero sin la columna del estado, lo mismo', async () => {
      falso.estado.fallo = (tabla, columnas) =>
        tabla === 'stock_unit_list' && columnas.includes('condicion')
          ? { message: 'column stock_unit_list.condicion does not exist' }
          : null
      const { bytes } = await prepararExcelDelAlmacen()
      const unidades = await leerHoja(await abrirLibro(bytes), 'Unidades con n.º de serie')

      expect(unidades.map((f) => f.celdas.E)).toEqual(['Estado', 'Sin indicar'])
    })

    it('así lo cuenta PostgREST cuando falta la vista: «in the schema cache»', async () => {
      falso.estado.fallo = (tabla) =>
        tabla === 'stock_unit_list'
          ? { message: "Could not find the table 'public.stock_unit_list' in the schema cache" }
          : null
      const { bytes } = await prepararExcelDelAlmacen()

      expect(await leerHoja(await abrirLibro(bytes), 'Unidades con n.º de serie')).toHaveLength(2)
    })

    it('un servidor sin la vista ni stock_units saca el resto, y la hoja de unidades lleva solo la cabecera', async () => {
      delete falso.estado.tablas['stock_unit_list']
      delete falso.estado.tablas['stock_units']
      const { bytes } = await prepararExcelDelAlmacen()
      const libro = await abrirLibro(bytes)
      expect(await leerHoja(libro, 'Unidades con n.º de serie')).toHaveLength(1)
      expect(await leerHoja(libro, 'Existencias')).toHaveLength(3)
    })
  })

  it('un fallo de la vista que no es «falta la migración» detiene la exportación y no se esconde con la tabla', async () => {
    falso.estado.fallo = (tabla) => (tabla === 'stock_unit_list' ? { message: 'permission denied for view stock_unit_list' } : null)
    await expect(prepararExcelDelAlmacen()).rejects.toThrow(/No se pudo leer las unidades del almacén: permission denied/)
    expect(falso.estado.peticiones.some((p) => p.startsWith('stock_units'))).toBe(false)
  })

  it('una vista que no contesta a tiempo se dice con palabras, no como «falta la migración»', async () => {
    falso.estado.fallo = (tabla) =>
      tabla === 'stock_unit_list' ? { message: 'AbortError: The operation was aborted due to timeout' } : null
    await expect(prepararExcelDelAlmacen()).rejects.toThrow(/las unidades del almacén: el servidor no ha contestado a tiempo/)
  })

  it('si una descarga falla, no se exporta medio almacén y el mensaje dice cuál', async () => {
    falso.estado.fallo = (tabla) => (tabla === 'stock_movements' ? { message: 'permission denied' } : null)
    await expect(prepararExcelDelAlmacen()).rejects.toThrow(/No se pudo leer los movimientos de almacén: permission denied/)
  })

  it('un servidor que no contesta a tiempo se dice con palabras', async () => {
    falso.estado.fallo = (tabla) => (tabla === 'stock_levels' ? { message: 'AbortError: The operation was aborted due to timeout' } : null)
    await expect(prepararExcelDelAlmacen()).rejects.toThrow(/las existencias: el servidor no ha contestado a tiempo/)
  })

  it('sin conexión ni lo intenta, y lo dice', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    try {
      await expect(prepararExcelDelAlmacen()).rejects.toThrow(/Sin conexión/)
      expect(falso.estado.peticiones).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
