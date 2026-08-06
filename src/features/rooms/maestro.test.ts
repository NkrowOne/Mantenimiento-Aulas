import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import { EMPTY_CAPABILITIES, type Building, type Room, type Zone } from '@/domain/types'

/**
 * Las operaciones del maestro, y sobre todo lo que dejan en el espejo local.
 *
 * El servidor se finge —lo suyo se prueba en `rls-test.sql`— porque lo que aquí
 * puede romperse es otra cosa: que el iPad siga enseñando un edificio que
 * acaba de archivarse. `podar()` no puede arreglarlo (se planta ante una
 * respuesta vacía, que es justo lo que devuelve el servidor cuando se archiva
 * el último edificio), así que la limpieza de `aplicarOperacion` es la única
 * red que hay y tiene que estar probada.
 *
 * `pullMaster` se finge también, y sin hacer nada: si escribiera, taparía
 * exactamente el fallo que se quiere ver.
 */

const rpc = vi.fn()
const pullMaster = vi.fn(async () => ({
  ok: true,
  filas: 0,
  error: null,
  fallos: [],
  vacias: [],
  at: 0,
}))

vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: (nombre: string, args: unknown) => rpc(nombre, args) },
}))
vi.mock('@/sync/pull', () => ({ pullMaster: () => pullMaster() }))

const { db } = await import('@/db/dexie')
const { AVISO_SIN_RED, aplicarOperacion, explicarFallo, mensajeDeOperacion } = await import(
  '@/features/rooms/maestro'
)

/** El entorno de pruebas es Node: sin esto `navigator.onLine` es falso y no sale nada. */
Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true })

const qc = { invalidateQueries: vi.fn() } as unknown as QueryClient

function edificio(id: string, code: string): Building {
  return { id, code, name: `Edificio ${code}`, sort_order: 10, needs_review: false }
}

function planta(id: string, building_id: string, name: string): Zone {
  return { id, building_id, name, sort_order: 10 }
}

function sala(id: string, zone_id: string, code: string): Room {
  return {
    id,
    zone_id,
    code,
    name: code,
    kind: 'aula',
    capabilities: EMPTY_CAPABILITIES,
    projector_hours: null,
    lamp_pct: null,
    last_inspection_at: null,
    last_inventory_at: null,
    active: true,
    short_ref: null,
  }
}

/** Un campus mínimo pero con dos edificios: sin el segundo no se ve si la baja se pasa de larga. */
async function sembrar(): Promise<void> {
  await db.buildings.bulkPut([edificio('b-h', 'H'), edificio('b-c', 'C')])
  await db.zones.bulkPut([
    planta('z-baja', 'b-h', 'PLANTA BAJA'),
    planta('z-primera', 'b-h', '1ª PLANTA'),
    planta('z-c', 'b-c', 'PLANTA BAJA'),
  ])
  await db.rooms.bulkPut([
    sala('r-01', 'z-baja', '0.1'),
    sala('r-02', 'z-baja', '0.2'),
    sala('r-17', 'z-primera', '1.7'),
    sala('r-18', 'z-primera', '1.8'),
    sala('r-c1', 'z-c', 'C0.1'),
  ])
}

beforeEach(async () => {
  vi.clearAllMocks()
  await Promise.all([db.buildings.clear(), db.zones.clear(), db.rooms.clear()])
  await sembrar()
})

describe('aplicarOperacion · dar de baja un edificio', () => {
  it('lo borra del dispositivo entero: salas, plantas y edificio', async () => {
    // Es la promesa literal del encargo —«si se borra el edificio... limpiar la
    // vista»— y el único sitio donde se comprueba que no depende de `podar()`.
    rpc.mockResolvedValue({ data: 'archivado', error: null })

    await aplicarOperacion({ kind: 'baja-edificio', id: 'b-h', code: 'H' }, qc)

    expect(await db.buildings.get('b-h')).toBeUndefined()
    expect(await db.zones.where('building_id').equals('b-h').count()).toBe(0)
    expect(await db.rooms.get('r-17')).toBeUndefined()
    expect(await db.rooms.count()).toBe(1)
  })

  it('y no se lleva por delante lo del edificio de al lado', async () => {
    rpc.mockResolvedValue({ data: 'archivado', error: null })

    await aplicarOperacion({ kind: 'baja-edificio', id: 'b-h', code: 'H' }, qc)

    expect(await db.buildings.get('b-c')).toBeDefined()
    expect(await db.rooms.get('r-c1')).toBeDefined()
  })

  it('limpia igual cuando el servidor dice que lo ha borrado de verdad', async () => {
    // Archivado y borrado son la misma noticia para este iPad: ese edificio ya
    // no es trabajo. La diferencia solo importa en la papelera de «Datos».
    rpc.mockResolvedValue({ data: 'borrado', error: null })

    await aplicarOperacion({ kind: 'baja-edificio', id: 'b-c', code: 'C' }, qc)

    expect(await db.buildings.get('b-c')).toBeUndefined()
    expect(await db.zones.get('z-c')).toBeUndefined()
  })

  it('descarga el maestro DESPUÉS de llamar al servidor, nunca antes', async () => {
    // Lanzada antes, la descarga traería los valores viejos y su `bulkPut`
    // volvería a escribir encima justo lo que se acaba de cambiar.
    const orden: string[] = []
    rpc.mockImplementation(async () => {
      orden.push('rpc')
      return { data: 'archivado', error: null }
    })
    pullMaster.mockImplementation(async () => {
      orden.push('pull')
      return { ok: true, filas: 0, error: null, fallos: [], vacias: [], at: 0 }
    })

    await aplicarOperacion({ kind: 'baja-edificio', id: 'b-h', code: 'H' }, qc)

    expect(orden).toEqual(['rpc', 'pull'])
  })
})

describe('aplicarOperacion · renombrar', () => {
  it('el nombre nuevo se ve sin esperar a la descarga', async () => {
    rpc.mockResolvedValue({ data: 'renombrada', error: null })

    await aplicarOperacion(
      { kind: 'renombrar-sala', id: 'r-17', code: '1.10', name: 'Lab 3D', zona: null },
      qc,
    )

    const s = await db.rooms.get('r-17')
    expect(s?.code).toBe('1.10')
    expect(s?.name).toBe('Lab 3D')
    // Sin planta pedida, la sala se queda donde estaba: nulo es «no mover».
    expect(s?.zone_id).toBe('z-primera')
  })

  it('mover de planta cambia el grupo en el que sale la sala', async () => {
    rpc.mockResolvedValue({ data: 'movida', error: null })

    await aplicarOperacion(
      { kind: 'renombrar-sala', id: 'r-17', code: '1.7', name: '1.7', zona: 'planta baja' },
      qc,
    )

    // La planta se resuelve con la regla del servidor: «planta baja» y
    // «PLANTA BAJA» son la misma, y crear una segunda sería el fallo clásico.
    expect((await db.rooms.get('r-17'))?.zone_id).toBe('z-baja')
    expect(await db.zones.count()).toBe(3)
  })

  it('renombrar una planta cambia el nombre de su cabecera', async () => {
    rpc.mockResolvedValue({ data: 'renombrada', error: null })

    await aplicarOperacion({ kind: 'renombrar-planta', id: 'z-primera', name: '1ª PLANTA' }, qc)

    expect((await db.zones.get('z-primera'))?.name).toBe('1ª PLANTA')
  })

  it('fusionar dos plantas mueve sus aulas y hace desaparecer la vacía', async () => {
    // El servidor solo dice «fusionada»; el destino se resuelve aquí con la
    // misma regla, que es la que ya usó el aviso previo.
    rpc.mockResolvedValue({ data: 'fusionada', error: null })

    await aplicarOperacion({ kind: 'renombrar-planta', id: 'z-primera', name: 'planta baja' }, qc)

    expect(await db.zones.get('z-primera')).toBeUndefined()
    expect((await db.rooms.get('r-17'))?.zone_id).toBe('z-baja')
    expect(await db.rooms.where('zone_id').equals('z-baja').count()).toBe(4)
  })

  it('renombrar un edificio se ve en la lista de edificios al instante', async () => {
    rpc.mockResolvedValue({ data: null, error: null })

    await aplicarOperacion(
      { kind: 'renombrar-edificio', id: 'b-h', code: 'HU', name: 'Edificio Humanidades' },
      qc,
    )

    expect((await db.buildings.get('b-h'))?.code).toBe('HU')
    expect((await db.buildings.get('b-h'))?.name).toBe('Edificio Humanidades')
  })
})

describe('aplicarOperacion · altas y bajas de sala', () => {
  it('la sala nueva aparece en su planta con el id que ha dado el servidor', async () => {
    rpc.mockResolvedValue({ data: 'r-99', error: null })

    await aplicarOperacion(
      {
        kind: 'nueva-sala',
        building: 'b-h',
        zone: '1ª PLANTA',
        code: '1.9',
        name: '',
        tipo: 'aula',
      },
      qc,
    )

    const s = await db.rooms.get('r-99')
    expect(s?.zone_id).toBe('z-primera')
    // Sin nombre se queda con el código, igual que hace `create_room`.
    expect(s?.name).toBe('1.9')
    // La matrícula la pone un disparador del servidor y baja con la descarga:
    // inventarla aquí sería imprimir una placa que no corresponde a nada.
    expect(s?.short_ref).toBeNull()
  })

  it('dar de baja una sala la quita de la lista de trabajo', async () => {
    rpc.mockResolvedValue({ data: 'archivada', error: null })

    await aplicarOperacion({ kind: 'baja-sala', id: 'r-17', code: '1.7' }, qc)

    expect(await db.rooms.get('r-17')).toBeUndefined()
  })
})

describe('aplicarOperacion · cuando algo va mal', () => {
  it('si el servidor rechaza, el espejo se queda exactamente como estaba', async () => {
    // La verdad es lo que diga el servidor. Media aplicación de un cambio
    // rechazado es peor que ninguna: nadie sabría cuál de las dos cosas mira.
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'Ya hay una sala 1.8 en esa planta' },
    })

    await expect(
      aplicarOperacion(
        { kind: 'renombrar-sala', id: 'r-17', code: '1.8', name: '1.8', zona: null },
        qc,
      ),
    ).rejects.toThrow('Ya hay una sala 1.8 en esa planta')

    expect((await db.rooms.get('r-17'))?.code).toBe('1.7')
    expect(pullMaster).not.toHaveBeenCalled()
  })

  it('sin cobertura ni se intenta, y lo dice con todas las letras', async () => {
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true })
    try {
      await expect(
        aplicarOperacion({ kind: 'baja-edificio', id: 'b-h', code: 'H' }, qc),
      ).rejects.toThrow(AVISO_SIN_RED)
      expect(rpc).not.toHaveBeenCalled()
      expect(await db.buildings.get('b-h')).toBeDefined()
    } finally {
      Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true })
    }
  })
})

describe('mensajeDeOperacion · lo decide el servidor, no la interfaz', () => {
  it('distingue archivar de borrar', async () => {
    const archivado = mensajeDeOperacion({ kind: 'baja-edificio', id: 'b', code: 'H' }, 'archivado')
    const borrado = mensajeDeOperacion({ kind: 'baja-edificio', id: 'b', code: 'H' }, 'borrado')
    expect(archivado).toMatch(/archivado/)
    expect(archivado).toMatch(/restaura/)
    expect(borrado).toMatch(/vacío/)
  })

  it('y renombrar de fusionar', () => {
    expect(mensajeDeOperacion({ kind: 'renombrar-planta', id: 'z', name: '1ª PLANTA' }, 'fusionada'))
      .toMatch(/fusionad/i)
    expect(
      mensajeDeOperacion({ kind: 'renombrar-planta', id: 'z', name: '1ª PLANTA' }, 'renombrada'),
    ).not.toMatch(/fusionad/i)
  })

  it('y mover de solo renombrar', () => {
    const op = { kind: 'renombrar-sala', id: 'r', code: '1.7', name: '', zona: null } as const
    expect(mensajeDeOperacion(op, 'movida')).toMatch(/planta/)
    expect(mensajeDeOperacion(op, 'renombrada')).toMatch(/alias/)
  })
})

describe('explicarFallo', () => {
  it('respeta el mensaje que escribimos nosotros en el servidor', () => {
    // Un `raise exception` de estas funciones ya viene redactado para esta
    // pantalla; reescribirlo solo puede empeorarlo.
    expect(
      explicarFallo({
        code: 'P0001',
        message: 'El código H es de un edificio que está en la papelera.',
      }),
    ).toBe('El código H es de un edificio que está en la papelera.')
  })

  it('traduce lo que escribe Postgres, que habla de índices', () => {
    const dicho = explicarFallo({
      code: '23505',
      message: 'duplicate key value violates unique constraint "rooms_zone_id_code_key"',
    })
    expect(dicho).not.toMatch(/unique constraint/)
    expect(dicho).toMatch(/código/)
  })

  it('dice que falta desplegar cuando la función no existe todavía', () => {
    // Es el fallo que más parece una avería de la aplicación y no lo es.
    expect(explicarFallo({ code: 'PGRST202', message: 'Could not find the function' })).toMatch(
      /migración/,
    )
  })

  it('reconoce el fallo de red por su forma, no por su tipo', () => {
    /*
     * Esta es la forma EXACTA en la que llega: `postgrest-js` captura el
     * `TypeError` que lanza `fetch` y lo devuelve aplanado en un objeto literal
     * con `code: ''`. Escrito con `instanceof TypeError`, este caso no se
     * cumplía nunca y en la hoja se leía «TypeError: Failed to fetch» en rojo.
     */
    expect(explicarFallo({ code: '', message: 'TypeError: Failed to fetch' })).toBe(AVISO_SIN_RED)
    // El Safari del iPad, que es el navegador que importa, lo dice de otra
    // manera; y Firefox de una tercera.
    expect(explicarFallo({ code: '', message: 'TypeError: Load failed' })).toBe(AVISO_SIN_RED)
    expect(
      explicarFallo({ code: '', message: 'TypeError: NetworkError when attempting to fetch' }),
    ).toBe(AVISO_SIN_RED)
  })

  it('y no confunde con la red un mensaje del servidor que hable de fetch', () => {
    // Un fallo del servidor siempre trae código. Si además el texto lo escribimos
    // nosotros, se enseña tal cual: tragárselo con «no hay cobertura» mandaría a
    // buscar wifi a quien tiene delante un problema de datos.
    const dicho = explicarFallo({
      code: 'P0001',
      message: 'Ese edificio está en la papelera. Restáuralo antes de añadirle salas.',
    })
    expect(dicho).not.toBe(AVISO_SIN_RED)
    expect(dicho).toMatch(/papelera/)
  })

  it('y nunca se queda sin frase', () => {
    expect(explicarFallo(null)).toMatch(/No se ha podido/)
    expect(explicarFallo({})).toMatch(/No se ha podido/)
  })
})
