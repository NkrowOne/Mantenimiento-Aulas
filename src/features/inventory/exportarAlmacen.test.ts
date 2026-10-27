import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  articulosParaHoja,
  estaBajoMinimo,
  hojaDeExistencias,
  hojaDePcsDeRepuesto,
  hojasDelAlmacen,
  movimientosParaHoja,
  prepararExcelDelAlmacen,
  tinteDelArticulo,
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
import { libroNuevo } from '@/domain/exportar'
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
    estado: 'disponible',
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
// Ordenadores de repuesto
// -----------------------------------------------------------------------------

describe('hojaDePcsDeRepuesto', () => {
  it('lleva las columnas pedidas', () => {
    const h = hojaDePcsDeRepuesto([unidad()])
    expect(h.nombre).toBe('PCs de repuesto')
    expect(h.filas[0]).toEqual([
      'Artículo',
      'Marca',
      'Modelo',
      'N.º de serie',
      'Situación',
      'Aula',
      'Desde',
      'Observaciones',
    ])
  })

  it('una unidad disponible no lleva aula ni fecha', () => {
    expect(comoObjetos(hojaDePcsDeRepuesto([unidad()]))[0]).toEqual({
      Artículo: 'Ordenador Tiny M70Q',
      Marca: 'Lenovo',
      Modelo: 'M70q Gen 3',
      'N.º de serie': 'PF3ABC12',
      Situación: 'Disponible',
      Aula: null,
      Desde: null,
      Observaciones: null,
    })
  })

  it('una instalada lleva su aula y el día de la instalación como fecha de Excel', () => {
    const o = comoObjetos(
      hojaDePcsDeRepuesto([unidad({ estado: 'instalado', aula: '2.1 C (Edificio H)', desde: '2026-09-08' })]),
    )[0]!
    expect(o).toMatchObject({ Situación: 'Instalado', Aula: '2.1 C (Edificio H)', Desde: D_2026_09_08 })
  })

  it('una de baja va apagada, con la fecha de la baja y sus observaciones', () => {
    const h = hojaDePcsDeRepuesto([
      unidad({ serial: 'A1' }),
      unidad({ serial: 'B2', estado: 'baja', desde: '2026-09-23', observaciones: 'Placa quemada' }),
    ])
    expect(comoObjetos(h)[1]).toMatchObject({ Situación: 'Baja', Desde: D_2026_09_23, Observaciones: 'Placa quemada' })
    expect(h.tintes).toEqual([undefined, 'apagado'])
  })

  it('ordena por situación (disponible, instalado, baja), después artículo, modelo y serie', () => {
    const h = hojaDePcsDeRepuesto([
      unidad({ serial: 'Z', estado: 'baja' }),
      unidad({ serial: 'Y', estado: 'instalado' }),
      unidad({ serial: 'B', modelo: 'M2' }),
      unidad({ serial: 'C', modelo: 'M1' }),
      unidad({ serial: 'A', modelo: 'M1' }),
    ])
    expect(comoObjetos(h).map((o) => o['N.º de serie'])).toEqual(['A', 'C', 'B', 'Y', 'Z'])
    expect(h.tintes).toEqual([undefined, undefined, undefined, undefined, 'apagado'])
  })

  it('declara la fecha y el ajuste de texto', () => {
    const h = hojaDePcsDeRepuesto([unidad()])
    expect(h.formatos?.[6]).toBe('fecha')
    expect(h.formatos?.[7]).toBe('textoAjustado')
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
    brand: 'Lenovo',
    model: 'M70q',
    serial: 'S1',
    notes: null,
    status: 'disponible',
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
    expect(u).toMatchObject({ estado: 'instalado', aula: '2.1 C (Edificio H)', desde: '2026-09-08' })
  })

  it('una disponible no lleva aula ni fecha, aunque conserve un aula de antes', () => {
    const [u] = unidadesParaHoja({
      ...sitio,
      unidades: [FILA({ room_id: 'r1', installed_at: '2026-09-07T10:00:00Z' })],
    })
    expect(u).toMatchObject({ estado: 'disponible', aula: null, desde: null })
  })

  it('una de baja lleva la fecha de la baja, no la de la instalación', () => {
    const [u] = unidadesParaHoja({
      ...sitio,
      unidades: [
        FILA({ status: 'baja', room_id: 'r1', installed_at: '2026-01-01T10:00:00Z', retired_at: '2026-09-23T10:00:00Z', notes: 'Quemado' }),
      ],
    })
    expect(u).toMatchObject({ estado: 'baja', aula: null, desde: '2026-09-23', observaciones: 'Quemado' })
  })

  it('un estado desconocido se lee como disponible; un aula que ya no existe, sin aula', () => {
    const r = unidadesParaHoja({
      ...sitio,
      unidades: [FILA({ status: 'raro' }), FILA({ status: 'instalado', room_id: 'borrada', installed_at: '2026-09-08T10:00:00Z' })],
    })
    expect(r[0]!.estado).toBe('disponible')
    expect(r[1]).toMatchObject({ estado: 'instalado', aula: null, desde: '2026-09-08' })
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
        brand: 'Lenovo',
        model: 'M70q',
        serial: 'S1',
        notes: null,
        status: 'instalado',
        room_id: 'r1',
        installed_at: '2026-09-08T10:00:00Z',
        retired_at: null,
      },
    ],
  }

  it('son tres, en este orden', () => {
    expect(hojasDelAlmacen(datos).map((h) => h.nombre)).toEqual([
      'Existencias',
      'Movimientos de Almacén',
      'PCs de repuesto',
    ])
  })

  it('con ellas se hace un libro que se abre y se lee', async () => {
    const libro = await abrirLibro(await libroNuevo(hojasDelAlmacen(datos)))
    expect(libro.hojas.map((h) => h.nombre)).toEqual(['Existencias', 'Movimientos de Almacén', 'PCs de repuesto'])

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

    const pcs = await leerHoja(libro, 'PCs de repuesto')
    expect(pcs[1]!.celdas).toEqual({
      A: 'Ordenador Tiny M70Q',
      B: 'Lenovo',
      C: 'M70q',
      D: 'S1',
      E: 'Instalado',
      F: '2.1 C (Edificio H)',
      G: D_2026_09_08,
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
    expect((await leerHoja(libro, 'PCs de repuesto'))[1]!.celdas.D).toBe("'=cmd|' /C calc'!A0")
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

describe('prepararExcelDelAlmacen', () => {
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
    expect(libro.hojas.map((h) => h.nombre)).toEqual(['Existencias', 'Movimientos de Almacén', 'PCs de repuesto'])
    const existencias = await leerHoja(libro, 'Existencias')
    expect(existencias.map((f) => f.celdas.A)).toEqual(['Artículo', 'Cable HDMI', 'Cable VGA'])
    expect(existencias[1]!.celdas).toMatchObject({ C: 2, E: 'Sí', G: 'Activo' })
    expect(existencias[2]!.celdas).toMatchObject({ C: 3, G: 'Retirado', H: D_2026_09_23, I: 'Ya no se usa' })
    const pcs = await leerHoja(libro, 'PCs de repuesto')
    expect(pcs[1]!.celdas).toMatchObject({ D: 'S1', E: 'Instalado', F: '2.1 C (Edificio H)', G: D_2026_09_08 })
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

  it('un servidor sin stock_units saca el resto, y la hoja de PCs lleva solo la cabecera', async () => {
    delete falso.estado.tablas['stock_units']
    const { bytes } = await prepararExcelDelAlmacen()
    const libro = await abrirLibro(bytes)
    expect(await leerHoja(libro, 'PCs de repuesto')).toHaveLength(1)
    expect(await leerHoja(libro, 'Existencias')).toHaveLength(3)
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
