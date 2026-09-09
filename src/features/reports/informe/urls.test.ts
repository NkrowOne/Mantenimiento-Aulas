import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cargarDatos, fotosParaElegir } from './datos'

/**
 * Ninguna consulta del informe puede armar una URL que el servidor rechace.
 *
 * Esta prueba nace de un informe que no salía: «No se ha podido leer los
 * equipos del diario: TypeError: Load failed». No era la base diciendo que no
 * —eso llega con su mensaje— ni un plazo agotado: era una petición que no
 * llegaba a salir.
 *
 * La causa: `.in('id', [...])` mete TODOS los identificadores en la línea de
 * petición, y ahí no hay paginación que valga. La URL crecía con el periodo que
 * se pidiera. Un mes con inventario de por medio son miles de equipos movidos, a
 * 39 caracteres de URL cada uno —36 del uuid y 3 de la coma codificada—, y el
 * tope de la línea de petición es de 8 KB de fábrica en nginx, que es lo que hay
 * debajo de Kong.
 *
 * Por eso la prueba **no** comprueba que se llame a `trozos()`: comprueba lo
 * único que importa, que es que ninguna URL pase del tope. Aquí el `fetch` hace
 * de portero de entrada y rechaza como lo haría el de verdad, así que si alguien
 * vuelve a meter una lista entera en un `.in`, esto se pone rojo con el nombre
 * de la consulta que la armó.
 */

/** El tope de la línea de petición de nginx, de fábrica. */
const TOPE_URL = 8192

/** Un mes de inventario: miles de equipos movidos, cada uno el suyo. */
const EVENTOS = 3000

/** Un trimestre de incidencias: la lista de la que la rejilla pide adjuntos. */
const INCIDENCIAS = 1200

/**
 * Qué hay montado detrás del portero.
 *
 * Son dos preguntas distintas contra las mismas tablas —el diario del informe y
 * la rejilla de fotos— y cada una revienta por su lado: la primera por los
 * equipos movidos, la segunda por los adjuntos de un trimestre de incidencias.
 * Montarlas a la vez haría que ninguna de las dos dijera de dónde salió el
 * fallo.
 */
let escenario: 'equipos' | 'fotos' = 'equipos'

const uuid = (prefijo: string, n: number): string =>
  `${prefijo.padEnd(8, '0').slice(0, 8)}-1111-4222-8333-${String(n).padStart(12, '0')}`

interface Peticion {
  tabla: string
  largo: number
}

let peticiones: Peticion[] = []
let rechazadas: Peticion[] = []

/** Qué devuelve cada tabla. Lo que no esté aquí contesta vacío. */
function filasDe(tabla: string, primeraPagina: boolean): unknown[] {
  if (!primeraPagina) return []

  switch (tabla) {
    case 'room_overview':
      return [
        {
          room_id: uuid('sala', 1),
          room_code: '1.7',
          room_name: 'AULA 1.7',
          building_code: 'H',
          building_name: 'EDIFICIO H',
          last_inspection_at: '2026-08-02T09:00:00.000Z',
          open_incidents: 1,
        },
      ]
    case 'asset_events':
      // Todos con equipo distinto: es el caso que reventaba la URL.
      return Array.from({ length: EVENTOS }, (_, i) => ({
        id: uuid('ev', i),
        kind: 'traslado',
        occurred_at: `2026-08-${String((i % 25) + 1).padStart(2, '0')}T10:00:00.000Z`,
        room_id: uuid('sala', 1),
        by_user: uuid('user', 1),
        meta: {},
        asset_id: uuid('act', i),
      }))
    case 'incidents':
      if (escenario !== 'fotos') return []
      return Array.from({ length: INCIDENCIAS }, (_, i) => ({
        id: uuid('inc', i),
        kind: 'incidencia',
        severity: 'media',
        state: 'abierta',
        title: `Incidencia ${i}`,
        description: null,
        external_ref: null,
        room_id: uuid('sala', 1),
        opened_at: `2026-08-${String((i % 25) + 1).padStart(2, '0')}T10:00:00.000Z`,
        opened_by: uuid('user', 1),
        opened_from_inspection_id: null,
      }))
    case 'attachments':
      if (escenario !== 'fotos') return []
      return Array.from({ length: 5 }, (_, i) => ({
        id: uuid('adj', i),
        entity_id: uuid('inc', i),
        storage_path: `${uuid('inc', i)}/${i}.jpg`,
        taken_at: `2026-08-0${i + 1}T10:00:00.000Z`,
      }))
    case 'rooms':
      if (escenario !== 'fotos') return []
      return [{ id: uuid('sala', 1), code: '1.7', name: 'AULA 1.7', active: true, zones: null }]
    case 'assets':
      return []
    case 'asset_types':
      return [{ id: uuid('tipo', 1), name: 'Proyector' }]
    default:
      return []
  }
}

function porteroDeEntrada(entrada: RequestInfo | URL): Response {
  const url = String(entrada)
  const tabla = /\/rest\/v1\/([^?]+)/.exec(url)?.[1] ?? '(desconocida)'
  const registro: Peticion = { tabla, largo: url.length }
  peticiones.push(registro)

  // Como el de verdad: la petición no llega al servicio y el navegador se
  // queda sin respuesta que enseñar. Safari lo cuenta como «Load failed».
  if (url.length > TOPE_URL) {
    rechazadas.push(registro)
    return new Response(null, { status: 431 })
  }

  const desde = Number(/(?:^|[?&])offset=(\d+)/.exec(url)?.[1] ?? '0')
  const cuerpo = filasDe(tabla, desde === 0)
  return new Response(JSON.stringify(cuerpo), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-range': `0-${Math.max(0, cuerpo.length - 1)}/${cuerpo.length}`,
    },
  })
}

describe('las URL que arma el informe', () => {
  beforeEach(() => {
    peticiones = []
    rechazadas = []
    escenario = 'equipos'
    vi.stubGlobal('fetch', (entrada: RequestInfo | URL) =>
      Promise.resolve(porteroDeEntrada(entrada)),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('un mes con miles de equipos movidos no pasa del tope de ninguna', async () => {
    const datos = await cargarDatos('personalizado', { start: '2026-08-01', end: '2026-08-25' })

    expect(rechazadas).toEqual([])
    expect(peticiones.length).toBeGreaterThan(10)

    const laMasLarga = peticiones.reduce((a, b) => (a.largo >= b.largo ? a : b))
    expect(laMasLarga.largo).toBeLessThan(TOPE_URL)

    // Y el informe sale: los tres mil eventos entran en el recuento y el diario
    // se queda en lo que cabe impreso.
    expect(datos.eventosTotal).toBeGreaterThanOrEqual(EVENTOS)
    expect(datos.eventos.length).toBeLessThanOrEqual(150)
  })

  it('solo pregunta por los equipos que van a salir impresos, no por los del mes', async () => {
    await cargarDatos('personalizado', { start: '2026-08-01', end: '2026-08-25' })

    // Cada consulta a `assets` lleva como mucho cien identificadores, y en total
    // no se pregunta por más de los que caben en el diario.
    const aAssets = peticiones.filter((p) => p.tabla === 'assets')
    expect(aAssets.length).toBeGreaterThan(0)
    expect(aAssets.length).toBeLessThanOrEqual(2)
  })

  /*
   * La rejilla de fotos pregunta por los adjuntos de TODO lo que pasó en el
   * periodo, y esa lista de identificadores es la misma que reventaba la línea
   * de petición con los equipos. Elegir qué fotos van no puede ser lo que
   * impida pedir el informe.
   */
  it('la rejilla de fotos de un trimestre tampoco pasa del tope', async () => {
    escenario = 'fotos'
    const { total } = await fotosParaElegir({ start: '2026-08-01', end: '2026-08-25' })

    expect(rechazadas).toEqual([])
    const laMasLarga = peticiones.reduce((a, b) => (a.largo >= b.largo ? a : b))
    expect(laMasLarga.largo).toBeLessThan(TOPE_URL)

    // Y ha preguntado de verdad por los adjuntos, repartidos en varias
    // consultas: mil doscientas incidencias no caben en una sola línea.
    const aAdjuntos = peticiones.filter((p) => p.tabla === 'attachments')
    expect(aAdjuntos.length).toBeGreaterThan(1)
    // Y la lista sale de esos adjuntos: la rejilla enseña fotos, no incidencias.
    expect(total).toBeGreaterThan(0)
  })

  it('si el servidor rechaza la petición, lo dice en cristiano y no «Load failed»', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Load failed')))

    // Con holgura: el cliente reintenta por su cuenta antes de rendirse, y son
    // unos segundos. Que tarde es aceptable; que mienta, no.
    await expect(
      cargarDatos('personalizado', { start: '2026-08-01', end: '2026-08-25' }),
    ).rejects.toThrow(/la petición no ha llegado a salir/)
  }, 30_000)
})
