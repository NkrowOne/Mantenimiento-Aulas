import { beforeEach, describe, expect, it, vi } from 'vitest'
import { datosDeLaPasada } from './datosDeLaPasada'

/**
 * Lo que la pasada lee de las unidades del almacén.
 *
 * Las unidades salen de la vista `stock_unit_list`, que dice cuáles son
 * ordenadores, y de ahí sale `soloEnLaApp`: lo que la hoja «PCs STOCK» no debe
 * añadir. Un servidor sin la migración no tiene la vista, y la pasada no puede
 * dejar de sincronizar por eso: pide la tabla de siempre.
 *
 * Un `supabase` de mentira: las tablas son listas, `range` corta la página como
 * PostgREST, una tabla que no está contesta lo que contesta Postgres, y un
 * fallo se configura por tabla y columnas pedidas (que es como se distingue un
 * servidor al día de uno viejo).
 */
const falso = vi.hoisted(() => {
  type Fallo = { message: string }
  const estado = {
    tablas: {} as Record<string, unknown[]>,
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
  return { estado, supabase: { from: consulta } }
})

vi.mock('@/lib/supabase', () => ({ supabase: falso.supabase }))

// Lo que lleva cada unidad, con los nombres de la base.
const TINY = {
  id: 'u1',
  articulo: 'Ordenador Tiny',
  brand: 'Lenovo ThinkCentre',
  model: 'M710Q',
  serial: 'S4GM1899',
  notes: 'Ordenador con imagen funcional de repuesto',
  status: 'disponible',
  room_id: null,
  installed_at: null,
  retired_at: null,
}
const PROYECTOR = {
  id: 'u2',
  articulo: 'Proyector',
  brand: 'Epson',
  model: 'EB-L200',
  serial: 'X4TK123456',
  notes: null,
  status: 'instalado',
  room_id: 'r1',
  // 22:30 UTC del 20 son las 00:30 del 21 en Madrid (horario de verano).
  installed_at: '2026-10-20T22:30:00Z',
  retired_at: null,
}

/** Lo mínimo de cada tabla que lee la pasada. Las unidades, en las dos formas. */
function servidor(extra: Record<string, unknown[]> = {}): void {
  falso.estado.tablas = {
    rooms: [
      {
        id: 'r1',
        short_ref: 'SALA-000001',
        code: '2.1',
        name: 'Aula 2.1',
        active: true,
        zone_id: 'z1',
        projector_hours: null,
        lamp_pct: null,
        botonera_estado: null,
        capabilities: null,
      },
    ],
    zones: [{ id: 'z1', name: 'PLANTA 2', building_id: 'b1' }],
    buildings: [{ id: 'b1', name: 'EDIFICIO C', code: 'C', active: true }],
    assets: [],
    asset_types: [],
    inspections: [],
    inspection_checks: [],
    profiles: [],
    incidents: [],
    incident_materials: [],
    stock_items: [],
    stock_movements: [],
    // La vista: lo mismo y, además, si es un ordenador.
    stock_unit_list: [
      { ...TINY, es_ordenador: true },
      { ...PROYECTOR, es_ordenador: false },
    ],
    // La tabla de antes: sin saber qué es cada una.
    stock_units: [TINY, PROYECTOR],
    ...extra,
  }
}

const deLaTabla = (tabla: string): string[] => falso.estado.peticiones.filter((p) => p.startsWith(`${tabla}[`))

beforeEach(() => {
  falso.estado.fallo = () => null
  falso.estado.peticiones = []
  servidor()
})

describe('las unidades que lee la pasada', () => {
  it('con la vista, lo que no es un ordenador se marca para que la hoja de PCs no lo añada', async () => {
    const d = await datosDeLaPasada(2026)

    expect(d.sinUnidades).toBe(false)
    const porSerie = new Map(d.unidades.map((u) => [u.serial, u]))
    expect(porSerie.get('S4GM1899')).toMatchObject({ soloEnLaApp: false, estado: 'disponible' })
    expect(porSerie.get('X4TK123456')).toMatchObject({
      soloEnLaApp: true,
      estado: 'instalado',
      sala: '2.1 (EDIFICIO C)',
      // El día de Madrid, no el de UTC.
      desde: '2026-10-21',
    })
    // Y vienen todas: el cruce por número de serie las necesita todas.
    expect(d.unidades).toHaveLength(2)
    // Pide las columnas de la vista, `es_ordenador` incluida, y no toca la tabla.
    expect(deLaTabla('stock_unit_list')).toHaveLength(1)
    expect(deLaTabla('stock_unit_list')[0]).toContain('es_ordenador')
    expect(deLaTabla('stock_units')).toEqual([])
  })

  it('sin la vista, pide la tabla de siempre y no marca ninguna: todas siguen siendo ordenadores', async () => {
    delete falso.estado.tablas['stock_unit_list']

    const d = await datosDeLaPasada(2026)

    expect(d.sinUnidades).toBe(false)
    expect(d.unidades.map((u) => u.serial)).toEqual(['S4GM1899', 'X4TK123456'])
    // Sin la marca, no «con la marca a falso»: es no saberlo.
    for (const u of d.unidades) expect('soloEnLaApp' in u, u.serial).toBe(false)
    // Primero la vista, y al no estar, la tabla —sin pedir una columna que no tiene—.
    expect(deLaTabla('stock_unit_list')).toHaveLength(1)
    expect(deLaTabla('stock_units')).toHaveLength(1)
    expect(deLaTabla('stock_units')[0]).not.toContain('es_ordenador')
  })

  it('una vista a la que le falta la columna también cae a la tabla', async () => {
    falso.estado.fallo = (tabla, columnas) =>
      tabla === 'stock_unit_list' && columnas.includes('es_ordenador')
        ? { message: 'column stock_unit_list.es_ordenador does not exist' }
        : null

    const d = await datosDeLaPasada(2026)

    expect(d.sinUnidades).toBe(false)
    expect(d.unidades).toHaveLength(2)
    for (const u of d.unidades) expect('soloEnLaApp' in u, u.serial).toBe(false)
  })

  it('así lo cuenta PostgREST cuando falta la vista: «in the schema cache»', async () => {
    falso.estado.fallo = (tabla) =>
      tabla === 'stock_unit_list' ? { message: "Could not find the table 'public.stock_unit_list' in the schema cache" } : null

    const d = await datosDeLaPasada(2026)

    expect(d.unidades).toHaveLength(2)
    expect(deLaTabla('stock_units')).toHaveLength(1)
  })

  it('sin la vista ni la tabla, la pasada sigue sin unidades y lo dice', async () => {
    delete falso.estado.tablas['stock_unit_list']
    delete falso.estado.tablas['stock_units']

    const d = await datosDeLaPasada(2026)

    expect(d.unidades).toEqual([])
    expect(d.sinUnidades).toBe(true)
    // Lo demás se lee igual: es lo que no puede parar.
    expect(d.salas).toHaveLength(1)
  })

  it('un permiso denegado en la vista no es «falta la migración»: la pasada se para y lo dice', async () => {
    falso.estado.fallo = (tabla) =>
      tabla === 'stock_unit_list' ? { message: 'permission denied for view stock_unit_list' } : null

    await expect(datosDeLaPasada(2026)).rejects.toThrow(/No se pudo leer las unidades del almacén: permission denied/)
    // Y no se ha ido a la tabla a ver si por ahí cuela: eso escondería el fallo.
    expect(deLaTabla('stock_units')).toEqual([])
  })

  it('un estado que la aplicación no conoce se lee como en el almacén', async () => {
    servidor({ stock_unit_list: [{ ...TINY, status: 'raro', es_ordenador: true }] })

    const d = await datosDeLaPasada(2026)

    expect(d.unidades[0]).toMatchObject({ estado: 'disponible', desde: null, sala: null })
  })
})
