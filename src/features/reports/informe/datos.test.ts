import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type FilaApertura,
  type FilaCierre,
  type FilaMovimiento,
  type FilaRevision,
  type FilaSala,
  type FilasDelPeriodo,
  contadores,
  materiales,
  ordenadoresDeRepuesto,
  porEdificio,
  porVisita,
  repartoDelTrabajo,
  resolucion,
  serieDiaria,
  trozos,
} from './datos'

/**
 * Las reglas de recuento del informe, sin base de datos.
 *
 * Antes las hacía SQL y estaban probadas por el hecho de ser SQL: un
 * `count(distinct coalesce(corrects, id))` dice lo que dice. Al traerlas a la
 * aplicación pasan a ser código, y cada una de ellas nació de una cifra
 * equivocada en un informe firmado. Esto es lo que impide que vuelvan.
 */

const vacias: FilasDelPeriodo = {
  revisiones: [],
  abiertas: [],
  cerradas: [],
  movimientos: [],
  inventarios: [],
  equipos: [],
}

function revision(p: Partial<FilaRevision> & { id: string }): FilaRevision {
  return {
    corrects: null,
    room_id: 'sala-1',
    occurred_at: '2026-07-27T08:00:00.000Z',
    corrected_at: null,
    by_user: 'ana',
    overall: 'ok',
    ...p,
  }
}

function apertura(p: Partial<FilaApertura> & { id: string }): FilaApertura {
  return {
    kind: 'incidencia',
    severity: 'media',
    state: 'abierta',
    title: 'Algo',
    description: null,
    external_ref: null,
    room_id: 'sala-1',
    opened_at: '2026-07-27T09:00:00.000Z',
    opened_by: 'ana',
    opened_from_inspection_id: null,
    ...p,
  }
}

function cierre(abierta: string, resuelta: string): FilaCierre {
  return {
    id: `${abierta}->${resuelta}`,
    kind: 'incidencia',
    title: 'Algo',
    resolution: null,
    external_ref: null,
    room_id: 'sala-1',
    opened_at: abierta,
    resolved_at: resuelta,
    resolved_by: 'ana',
  }
}

describe('una visita al aula se cuenta una vez', () => {
  it('la corrección reemplaza a la original, no se suma a ella', () => {
    // Sin esto, el informe del viernes diría que el equipo hizo 42 revisiones
    // la semana en que hizo 38 y corrigió cuatro.
    const filas = [
      revision({ id: 'a' }),
      revision({ id: 'b', corrects: 'a', corrected_at: '2026-07-28T10:00:00.000Z' }),
    ]
    const visitas = porVisita(filas)
    expect(visitas).toHaveLength(1)
    expect(visitas[0]?.id).toBe('b')
  })

  it('con dos correcciones simultáneas gana la última', () => {
    const visitas = porVisita([
      revision({ id: 'b', corrects: 'a', corrected_at: '2026-07-28T10:00:00.000Z' }),
      revision({ id: 'c', corrects: 'a', corrected_at: '2026-07-28T12:00:00.000Z' }),
    ])
    expect(visitas).toHaveLength(1)
    expect(visitas[0]?.id).toBe('c')
  })

  it('una versión sin corregir solo gana si es la única', () => {
    const visitas = porVisita([
      revision({ id: 'b', corrects: 'a', corrected_at: null }),
      revision({ id: 'c', corrects: 'a', corrected_at: '2026-07-28T12:00:00.000Z' }),
    ])
    expect(visitas[0]?.id).toBe('c')
  })
})

describe('los contadores del periodo', () => {
  it('separan los tipos de registro y marcan la gravedad alta', () => {
    const c = contadores({
      ...vacias,
      revisiones: [
        revision({ id: 'a', room_id: 'sala-1' }),
        revision({ id: 'b', room_id: 'sala-2' }),
        revision({ id: 'c', corrects: 'a', corrected_at: '2026-07-28T10:00:00.000Z' }),
      ],
      abiertas: [
        apertura({ id: '1', kind: 'incidencia', severity: 'alta' }),
        apertura({ id: '2', kind: 'solicitud', severity: 'baja' }),
        apertura({ id: '3', kind: 'observacion', severity: null }),
      ],
      cerradas: [cierre('2026-07-20T09:00:00.000Z', '2026-07-27T09:00:00.000Z')],
    })

    expect(c.revisiones).toBe(2)
    expect(c.salasRevisadas).toBe(2)
    expect(c.registros).toBe(3)
    expect(c.incidencias).toBe(1)
    expect(c.solicitudes).toBe(1)
    expect(c.observaciones).toBe(1)
    expect(c.gravedadAlta).toBe(1)
    expect(c.resueltas).toBe(1)
  })

  it('el material consumido se cuenta en positivo y solo el consumo', () => {
    const mov = (kind: string, qty: number): FilaMovimiento => ({
      id: `${kind}${qty}`,
      kind,
      qty,
      note: null,
      occurred_at: '2026-07-27T09:00:00.000Z',
      room_id: 'sala-1',
      by_user: 'ana',
      stock_item_id: 'art-1',
      incident_id: null,
    })
    const c = contadores({ ...vacias, movimientos: [mov('consumo', -3), mov('compra', 20)] })
    expect(c.materialConsumido).toBe(3)
  })
})

describe('la serie diaria', () => {
  it('trae todos los días, incluidos los que no tuvieron nada', () => {
    // Sin los días vacíos, una semana con dos jornadas de trabajo se dibuja
    // igual que una semana entera y el hueco no se ve.
    const serie = serieDiaria(
      { start: '2026-07-27', end: '2026-07-29' },
      [revision({ id: 'a', occurred_at: '2026-07-27T08:00:00.000Z' })],
      { ...vacias, abiertas: [apertura({ id: '1', opened_at: '2026-07-29T10:00:00.000Z' })] },
    )
    expect(serie.map((d) => d.dia)).toEqual(['2026-07-27', '2026-07-28', '2026-07-29'])
    expect(serie[0]).toMatchObject({ revisiones: 1, abiertas: 0, resueltas: 0 })
    expect(serie[1]).toMatchObject({ revisiones: 0, abiertas: 0, resueltas: 0 })
    expect(serie[2]).toMatchObject({ revisiones: 0, abiertas: 1, resueltas: 0 })
  })

  it('la medianoche es la de Madrid, no la de UTC', () => {
    // Las 22:30 UTC del 27 en julio son las 00:30 del 28 en Madrid. Contarlo en
    // UTC corría la actividad un día entero.
    const serie = serieDiaria(
      { start: '2026-07-27', end: '2026-07-28' },
      [revision({ id: 'a', occurred_at: '2026-07-27T22:30:00.000Z' })],
      vacias,
    )
    expect(serie[0]?.revisiones).toBe(0)
    expect(serie[1]?.revisiones).toBe(1)
  })
})

describe('el reparto por edificio', () => {
  const sala = (id: string, edificio: string, abiertas: number): FilaSala => ({
    room_id: id,
    room_code: id.toUpperCase(),
    room_name: id.toUpperCase(),
    building_code: edificio,
    building_name: `EDIFICIO ${edificio}`,
    last_inspection_at: null,
    open_incidents: abiertas,
  })

  const salas = [sala('h1', 'H', 2), sala('h2', 'H', 1), sala('c1', 'CRAI', 0)]
  const deSala = new Map(salas.map((s) => [s.room_id, s]))

  it('cuenta las salas del campus vivo y su cola de hoy', () => {
    const filas = porEdificio(salas, [], [], deSala)
    expect(filas.find((b) => b.code === 'H')).toMatchObject({ salas: 2, pendientes: 3 })
    expect(filas.find((b) => b.code === 'CRAI')).toMatchObject({ salas: 1, pendientes: 0 })
  })

  /*
   * El caso del edificio que se reorganiza: se manda a la papelera y sus aulas
   * dejan de salir en `room_overview`. Lo que pasó en él durante el periodo no
   * puede evaporarse — los totales de arriba lo siguen contando, así que el
   * informe se contradiría a sí mismo.
   */
  it('cuenta el trabajo de un edificio archivado, y lo marca', () => {
    const archivada: FilaSala = { ...sala('t1', 'TM', 0), archivada: true }
    const conArchivada = new Map(deSala)
    conArchivada.set(archivada.room_id, archivada)

    const filas = porEdificio(
      salas, // la lista de trabajo NO la trae: está archivada
      [revision({ id: 'a', room_id: 't1' })],
      [apertura({ id: '1', room_id: 't1' })],
      conArchivada,
    )

    const tm = filas.find((b) => b.code === 'TM')
    expect(tm).toMatchObject({ salas: 0, revisadas: 1, abiertas: 1, archivado: true })
  })

  it('un edificio en servicio no se marca como archivado', () => {
    const filas = porEdificio(salas, [], [], deSala)
    expect(filas.every((b) => !b.archivado)).toBe(true)
  })

  it('las salas revisadas son distintas, no visitas', () => {
    const visitas = [
      revision({ id: 'a', room_id: 'h1' }),
      revision({ id: 'b', room_id: 'h1' }),
      revision({ id: 'c', room_id: 'h2' }),
    ]
    expect(porEdificio(salas, visitas, [], deSala).find((b) => b.code === 'H')?.revisadas).toBe(2)
  })

  it('ordena por lo abierto en el periodo, y el que más arriba', () => {
    const abiertas = [
      apertura({ id: '1', room_id: 'c1' }),
      apertura({ id: '2', room_id: 'c1' }),
      apertura({ id: '3', room_id: 'h1' }),
    ]
    expect(porEdificio(salas, [], abiertas, deSala)[0]?.code).toBe('CRAI')
  })

  it('un registro sin sala no se le cuelga a ningún edificio', () => {
    const filas = porEdificio(salas, [], [apertura({ id: '1', room_id: null })], deSala)
    expect(filas.reduce((a, b) => a + b.abiertas, 0)).toBe(0)
  })
})

describe('cuánto se tarda en cerrar', () => {
  it('la mediana no la mueve una incidencia antiquísima; la media sí', () => {
    // Es el motivo de que vayan las dos, y la mediana primero: dos incidencias
    // del histórico arrastran la media a semanas y esconden que el trabajo del
    // día se cierra en horas.
    const r = resolucion([
      cierre('2026-07-27T08:00:00.000Z', '2026-07-27T12:00:00.000Z'),
      cierre('2026-07-26T08:00:00.000Z', '2026-07-27T08:00:00.000Z'),
      cierre('2025-07-27T08:00:00.000Z', '2026-07-27T08:00:00.000Z'),
    ])
    expect(r.resueltas).toBe(3)
    expect(r.medianaDias).toBe(1)
    expect(r.mediaDias).toBeGreaterThan(100)
    expect(r.enMenosDe48h).toBe(2)
  })

  it('sin cierres no se inventa un cero, que se leería como «instantáneo»', () => {
    const r = resolucion([])
    expect(r.medianaDias).toBeNull()
    expect(r.mediaDias).toBeNull()
  })
})

describe('el material del periodo', () => {
  const articulos = new Map([
    ['cable', { name: 'Cable HDMI 3 m', unit: 'ud' }],
    ['lampara', { name: 'Lámpara proyector', unit: 'ud' }],
  ])
  const mov = (art: string, qty: number, incidente: string | null): FilaMovimiento => ({
    id: `${art}${qty}${incidente ?? ''}`,
    kind: 'consumo',
    qty,
    note: null,
    occurred_at: '2026-07-27T09:00:00.000Z',
    room_id: 'sala-1',
    by_user: 'ana',
    stock_item_id: art,
    incident_id: incidente,
  })

  it('agrupa por artículo y ordena por lo más gastado', () => {
    const filas = materiales(
      [mov('lampara', -1, 'i1'), mov('cable', -2, 'i1'), mov('cable', -3, 'i2')],
      articulos,
    )
    expect(filas[0]).toMatchObject({ name: 'Cable HDMI 3 m', consumido: 5, incidencias: 2 })
    expect(filas[1]).toMatchObject({ name: 'Lámpara proyector', consumido: 1, incidencias: 1 })
  })

  it('un consumo sin incidencia no cuenta como una incidencia más', () => {
    const filas = materiales([mov('cable', -2, null), mov('cable', -1, 'i1')], articulos)
    expect(filas[0]).toMatchObject({ consumido: 3, incidencias: 1 })
  })
})

describe('el reparto del trabajo', () => {
  it('una visita corregida se le apunta a quien firmó la que vale', () => {
    const quien = new Map([
      ['ana', 'Ana Pérez'],
      ['luis', 'Luis Martín'],
    ])
    const filas = repartoDelTrabajo(
      {
        ...vacias,
        revisiones: [
          revision({ id: 'a', by_user: 'ana' }),
          revision({
            id: 'b',
            corrects: 'a',
            by_user: 'luis',
            corrected_at: '2026-07-28T10:00:00.000Z',
          }),
        ],
        abiertas: [apertura({ id: '1', opened_by: 'ana' })],
      },
      quien,
    )
    expect(filas).toHaveLength(2)
    expect(filas.find((p) => p.nombre === 'Luis Martín')).toMatchObject({
      revisiones: 1,
      registros: 0,
    })
    expect(filas.find((p) => p.nombre === 'Ana Pérez')).toMatchObject({
      revisiones: 0,
      registros: 1,
    })
  })
})

/*
 * El fallo que costó un «TypeError: Load failed» en la pantalla del informe.
 *
 * `.in('id', [...])` mete todos los identificadores en la URL, y ahí no hay
 * paginación: la URL crece con el periodo que se pida. Un informe de un mes con
 * inventario de por medio son miles de equipos, cada uno 39 caracteres de URL,
 * y la petición no llega ni a salir. Medido: 200 identificadores son 7,8 KB, y
 * el tope de la línea de petición son 8 KB de fábrica.
 */
describe('las listas de identificadores que viajan en la URL', () => {
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `id-${i}`)

  it('no deja ningún trozo por encima de cien', () => {
    for (const n of [0, 1, 99, 100, 101, 250, 2000]) {
      const partes = trozos(ids(n))
      expect(partes.every((p) => p.length <= 100)).toBe(true)
    }
  })

  it('no pierde ni repite ningún identificador', () => {
    const original = ids(2537)
    const juntos = trozos(original).flat()
    expect(juntos).toEqual(original)
    expect(new Set(juntos).size).toBe(original.length)
  })

  it('una lista vacía no genera ninguna consulta', () => {
    expect(trozos([])).toEqual([])
  })

  it('la URL de un trozo se queda en la mitad del tope del servidor', () => {
    // 39 caracteres por identificador: 36 del uuid y 3 de la coma codificada,
    // medidos sobre la URL que arma supabase-js.
    expect(100 * 39).toBeLessThan(8192 / 2)
  })

  it('un tamaño de trozo imposible se rechaza en vez de colgarse', () => {
    expect(() => trozos(ids(3), 0)).toThrow()
  })
})

/*
 * Los «ordenadores de repuesto» de la foto de hoy.
 *
 * El almacén guarda ya como unidad cualquier aparato con número de serie, y el
 * informe cuenta ordenadores: solo los de la vista `stock_unit_list` que lo son.
 * Un servidor sin la migración no tiene la vista y se cuenta como siempre.
 *
 * Aquí el `fetch` hace de servidor y el cliente de Supabase es el de verdad, a
 * propósito: lo que importa es cómo se lee lo que **contesta** un servidor al
 * que le falta la vista, y eso es cosa del cliente. La consulta es un `HEAD`
 * (se pide la cuenta, no las filas), y un `HEAD` 404 no lleva cuerpo.
 */
describe('los ordenadores de repuesto del informe', () => {
  type Peticion = { metodo: string; tabla: string; consulta: string }
  let peticiones: Peticion[] = []

  /** Lo que contesta el servidor, por tabla; lo que no esté aquí, que no existe. */
  function servidor(respuestas: Record<string, () => Response>): void {
    peticiones = []
    vi.stubGlobal('fetch', (entrada: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(entrada))
      const tabla = /\/rest\/v1\/(.+)$/.exec(url.pathname)?.[1] ?? '(desconocida)'
      peticiones.push({ metodo: init?.method ?? 'GET', tabla, consulta: decodeURIComponent(url.search) })
      return Promise.resolve(respuestas[tabla]?.() ?? sinCuerpo(404))
    })
  }

  // Una cuenta hecha: `content-range` como lo escribe PostgREST. Con filas, `0-2/3`; sin ninguna, `*` y el cero.
  const cuenta = (n: number) => (): Response =>
    new Response(null, { status: 200, headers: { 'content-range': n === 0 ? '*/0' : `0-${n - 1}/${n}` } })

  /** Un `HEAD` que falla: sin cuerpo, como todo `HEAD`. */
  const sinCuerpo = (status: number): Response => new Response(null, { status })

  /** Un fallo con su explicación, como lo dice PostgREST a un `GET`. */
  const fallo = (status: number, code: string, message: string) => (): Response =>
    new Response(JSON.stringify({ code, message, details: null, hint: null }), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  const aLaVista = (): Peticion[] => peticiones.filter((p) => p.tabla === 'stock_unit_list')
  const aLaTabla = (): Peticion[] => peticiones.filter((p) => p.tabla === 'stock_units')

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('cuenta los disponibles de la vista que son ordenadores, y solo esos', async () => {
    servidor({ stock_unit_list: cuenta(3) })

    await expect(ordenadoresDeRepuesto()).resolves.toBe(3)

    expect(peticiones).toHaveLength(1)
    expect(peticiones[0]).toMatchObject({ metodo: 'HEAD', tabla: 'stock_unit_list' })
    expect(peticiones[0]!.consulta).toContain('status=eq.disponible')
    expect(peticiones[0]!.consulta).toContain('es_ordenador=eq.true')
  })

  it('cero ordenadores es un cero, no una vista que falte: no cae a la tabla', async () => {
    // Una cuenta de cero trae su número, y es el caso en que una comprobación
    // «¿hay cifra?» hecha con `!count` caería a la tabla y contaría lo que no es.
    servidor({ stock_unit_list: cuenta(0), stock_units: cuenta(7) })

    await expect(ordenadoresDeRepuesto()).resolves.toBe(0)

    expect(aLaTabla()).toEqual([])
  })

  it('sin la vista cuenta los disponibles de la tabla, como se contaba', async () => {
    // Lo que contesta un servidor sin la migración a un `HEAD`: 404 y ni una
    // palabra. El cliente lo deja pasar como un 204 sin error y sin cifra; si
    // solo se mirara el error, el informe diría «0 ordenadores» donde hay siete.
    servidor({ stock_units: cuenta(7) })

    await expect(ordenadoresDeRepuesto()).resolves.toBe(7)

    expect(aLaVista()).toHaveLength(1)
    expect(aLaTabla()).toHaveLength(1)
    expect(aLaTabla()[0]!.consulta).toContain('status=eq.disponible')
    // De la tabla de antes no se sabe qué es cada una: no se pregunta por ello.
    expect(aLaTabla()[0]!.consulta).not.toContain('es_ordenador')
  })

  it('sin la vista y con el error en el cuerpo (PGRST205), igual', async () => {
    servidor({
      stock_unit_list: fallo(404, 'PGRST205', "Could not find the table 'public.stock_unit_list' in the schema cache"),
      stock_units: cuenta(7),
    })

    await expect(ordenadoresDeRepuesto()).resolves.toBe(7)
  })

  it('con la vista sin la columna, también', async () => {
    servidor({
      stock_unit_list: fallo(400, '42703', 'column stock_unit_list.es_ordenador does not exist'),
      stock_units: cuenta(7),
    })

    await expect(ordenadoresDeRepuesto()).resolves.toBe(7)
  })

  it('sin la vista ni la tabla, cero y a seguir: no tumba el informe', async () => {
    servidor({})

    await expect(ordenadoresDeRepuesto()).resolves.toBe(0)
    expect(peticiones.map((p) => p.tabla)).toEqual(['stock_unit_list', 'stock_units'])
  })

  it('otro fallo de la vista no es «falta la migración»: cero, y no se cuenta la tabla', async () => {
    servidor({
      stock_unit_list: fallo(403, '42501', 'permission denied for view stock_unit_list'),
      stock_units: cuenta(7),
    })

    await expect(ordenadoresDeRepuesto()).resolves.toBe(0)
    expect(aLaTabla()).toEqual([])
  })
})
