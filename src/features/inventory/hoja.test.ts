import { describe, expect, it } from 'vitest'
import {
  agruparPorSala,
  esBaja,
  filasDelEspejo,
  filtrar,
  nombreDeLaFila,
  resumen,
  ultimoMovimiento,
  type FilaDeInventario,
} from './hoja'
import { fechaCorta } from '@/domain/fechas'
import { assetTypeId } from '@/domain/inventory'
import type { Asset, AssetRemoval, AssetType, Building, Room, Zone } from '@/domain/types'

/**
 * Una fila como la que devuelve la vista del servidor, con todo relleno salvo lo
 * que cada prueba quiera cambiar. Las de sala y edificio van con valores fijos:
 * lo que se comprueba casi siempre es el orden, y con datos distintos en cada
 * fila no se sabría si el orden lo pone la hoja o el azar de la muestra.
 */
function fila(tipo: string | null, extra: Partial<FilaDeInventario> = {}): FilaDeInventario {
  return {
    asset_id: `a-${tipo ?? 'sin'}-${extra.label ?? ''}`,
    building_id: 'b-h',
    building_code: 'H',
    building_name: 'Edificio H',
    building_sort: 1,
    zone_id: 'z-primera',
    zone_name: '1ª PLANTA',
    zone_sort: 3,
    room_id: 'r-1.7',
    room_code: '1.7',
    room_name: 'Aula 1.7',
    room_short_ref: 'SALA-000087',
    room_last_inventory_at: null,
    type_name: tipo,
    label: tipo,
    brand: null,
    model: null,
    serial: null,
    status: 'instalado',
    confirmed: true,
    alta_at: null,
    cambio_at: null,
    baja_at: null,
    baja_destino: null,
    baja_motivo: null,
    retirada_pedida: false,
    ...extra,
  }
}

describe('agruparPorSala · orden dentro de la sala', () => {
  it('ordena por el recorrido del aula y no por el alfabeto', () => {
    // Alfabéticamente la botonera iría primera y el proyector el cuarto, que no
    // es el orden en que nadie recorre un aula — ni el que ve en la pantalla de
    // revisión al comparar el papel con lo que tiene delante.
    const filas = [fila('Botonera'), fila('Altavoces'), fila('Pantalla'), fila('Proyector')]
    const [sala] = agruparPorSala(filas)
    expect(sala?.filas.map((f) => f.type_name)).toEqual([
      'Proyector',
      'Pantalla',
      'Altavoces',
      'Botonera',
    ])
  })

  it('dentro de un mismo tipo desempata por la etiqueta, con los números como números', () => {
    const filas = [
      fila('Pantalla', { label: 'Pantalla 10', asset_id: 'a10' }),
      fila('Pantalla', { label: 'Pantalla 2', asset_id: 'a2' }),
      fila('Pantalla', { label: 'Pantalla', asset_id: 'a1' }),
    ]
    const [sala] = agruparPorSala(filas)
    expect(sala?.filas.map((f) => f.label)).toEqual(['Pantalla', 'Pantalla 2', 'Pantalla 10'])
  })

  it('lo que no está en el recorrido va al final, no en medio', () => {
    const filas = [fila('Deshumidificador'), fila('Proyector')]
    const [sala] = agruparPorSala(filas)
    expect(sala?.filas.map((f) => f.type_name)).toEqual(['Proyector', 'Deshumidificador'])
  })

  it('no deja el orden al azar cuando dos equipos comparten etiqueta', () => {
    // Pasa de verdad: el índice único de la base solo cubre los vivos, así que
    // una baja y el aparato que la sustituyó se llaman igual.
    const filas = [
      fila('Proyector', { asset_id: 'a-nuevo' }),
      fila('Proyector', { asset_id: 'a-baja', status: 'retirado' }),
    ]
    const ids = agruparPorSala(filas)[0]?.filas.map((f) => f.asset_id)
    expect(ids).toEqual(['a-baja', 'a-nuevo'])
    // Y con las filas al revés sale lo mismo: no depende del orden de entrada.
    expect(agruparPorSala([...filas].reverse())[0]?.filas.map((f) => f.asset_id)).toEqual(ids)
  })
})

describe('agruparPorSala · plantas y salas', () => {
  const enSala = (
    roomId: string,
    code: string,
    zone: { id: string; name: string; sort: number },
    extra: Partial<FilaDeInventario> = {},
  ): FilaDeInventario =>
    fila('Proyector', {
      asset_id: `a-${roomId}`,
      room_id: roomId,
      room_code: code,
      room_name: `Aula ${code}`,
      zone_id: zone.id,
      zone_name: zone.name,
      zone_sort: zone.sort,
      ...extra,
    })

  const SOTANO = { id: 'z-sotano', name: 'SÓTANO', sort: 1 }
  const BAJA = { id: 'z-baja', name: 'PLANTA BAJA', sort: 2 }
  const PRIMERA = { id: 'z-primera', name: '1ª PLANTA', sort: 3 }

  it('agrupa por sala y baja las plantas en el orden en que se recorren', () => {
    const filas = [
      enSala('r-1.7', '1.7', PRIMERA),
      enSala('r-0.3', '0.3', BAJA),
      enSala('r--1.2', '-1.2', SOTANO),
    ]
    expect(agruparPorSala(filas).map((g) => g.room_code)).toEqual(['-1.2', '0.3', '1.7'])
  })

  it('ordena los códigos como los lee una persona: 0.2 antes que 0.10', () => {
    const filas = [enSala('r-0.10', '0.10', BAJA), enSala('r-0.2', '0.2', BAJA)]
    expect(agruparPorSala(filas).map((g) => g.room_code)).toEqual(['0.2', '0.10'])
  })

  it('junta en un grupo todas las filas de la misma sala', () => {
    const filas = [
      enSala('r-0.3', '0.3', BAJA, { asset_id: 'p1' }),
      enSala('r-1.7', '1.7', PRIMERA, { asset_id: 'p2' }),
      enSala('r-0.3', '0.3', BAJA, { asset_id: 'p3', type_name: 'Pantalla', label: 'Pantalla' }),
    ]
    const grupos = agruparPorSala(filas)
    expect(grupos).toHaveLength(2)
    expect(grupos[0]?.filas.map((f) => f.asset_id)).toEqual(['p1', 'p3'])
  })

  it('no mezcla las plantas primeras de dos edificios distintos', () => {
    // Las dos llevan el mismo `sort_order`, así que sin ordenar por edificio la
    // hoja iría saltando de un edificio a otro planta por planta.
    const filas = [
      enSala('h-1.7', '1.7', PRIMERA, { building_id: 'b-h', building_sort: 1 }),
      enSala('e-1.1', '1.1', PRIMERA, { building_id: 'b-e', building_sort: 2 }),
      enSala('h-0.3', '0.3', BAJA, { building_id: 'b-h', building_sort: 1 }),
      enSala('e-0.1', '0.1', BAJA, { building_id: 'b-e', building_sort: 2 }),
    ]
    expect(agruparPorSala(filas).map((g) => g.room_id)).toEqual([
      'h-0.3',
      'h-1.7',
      'e-0.1',
      'e-1.1',
    ])
  })

  it('lleva al grupo lo que hace falta para encabezar la hoja de la sala', () => {
    const filas = [enSala('r-0.3', '0.3', BAJA, { room_last_inventory_at: '2026-05-04T09:00:00Z' })]
    expect(agruparPorSala(filas)[0]).toMatchObject({
      room_id: 'r-0.3',
      room_name: 'Aula 0.3',
      room_short_ref: 'SALA-000087',
      zone_name: 'PLANTA BAJA',
      room_last_inventory_at: '2026-05-04T09:00:00Z',
    })
  })

  it('sin filas no hay grupos', () => {
    expect(agruparPorSala([])).toEqual([])
  })
})

describe('ultimoMovimiento', () => {
  it('la baja manda sobre el cambio y el cambio sobre el alta', () => {
    const equipo = fila('Proyector', {
      alta_at: '2019-09-01T08:00:00Z',
      cambio_at: '2026-06-02T10:00:00Z',
      baja_at: '2026-07-18T10:00:00Z',
      status: 'retirado',
    })
    expect(ultimoMovimiento(equipo)).toEqual({ fecha: '18 jul 2026', que: 'Baja' })

    const editado = { ...equipo, baja_at: null, status: 'instalado' as const }
    expect(ultimoMovimiento(editado)).toEqual({ fecha: '2 jun 2026', que: 'Modificado' })

    const reciente = { ...editado, cambio_at: null }
    expect(ultimoMovimiento(reciente)).toEqual({ fecha: '1 sept 2019', que: 'Alta' })
  })

  it('distingue el que se murió del que volvió a la estantería', () => {
    // No es un matiz de redacción: solo el segundo suma una unidad al almacén, y
    // llamar «Baja» a los dos borra la distinción en la hoja archivada.
    const almacen = fila('Proyector', {
      status: 'retirado',
      baja_at: '2026-07-18T10:00:00Z',
      baja_destino: 'almacen',
    })
    expect(ultimoMovimiento(almacen).que).toBe('Devuelto al almacén')

    const muerto = { ...almacen, baja_destino: 'baja' }
    expect(ultimoMovimiento(muerto).que).toBe('Baja')
  })

  it('un retirado sin fecha de baja sigue siendo una baja, con el hueco a la vista', () => {
    // Es exactamente la hoja hecha desde el espejo local: se sabe QUÉ pasó y no
    // CUÁNDO. Decir «Alta» con la fecha de instalación sería mentir con datos.
    const sinEvento = fila('Proyector', { status: 'retirado', alta_at: '2019-09-01T08:00:00Z' })
    expect(ultimoMovimiento(sinEvento)).toEqual({ fecha: null, que: 'Baja' })
  })

  it('usa el formato de fechas del proyecto y no otro', () => {
    const equipo = fila('Proyector', { alta_at: '2026-07-18T10:00:00Z' })
    expect(ultimoMovimiento(equipo).fecha).toBe(fechaCorta('2026-07-18T10:00:00Z'))
  })

  it('con las tres fechas vacías dice «Alta» sin fecha, no «Invalid Date»', () => {
    // Los 1.094 equipos importados del Excel pueden llegar sin `created_at`.
    expect(ultimoMovimiento(fila('Proyector'))).toEqual({ fecha: null, que: 'Alta' })
  })

  it('una fecha ilegible se trata como fecha que falta', () => {
    const roto = fila('Proyector', { alta_at: '29-01-026' })
    expect(ultimoMovimiento(roto)).toEqual({ fecha: null, que: 'Alta' })
  })
})

describe('nombreDeLaFila', () => {
  it('no repite el tipo debajo cuando el equipo se llama como su tipo', () => {
    // Es el caso normal, no el raro: la primera unidad de cada tipo de cada sala
    // se llama como su tipo —`nextLabel` y el relleno del servidor coinciden en
    // eso—, así que casi todas las líneas imprimían «Proyector» y debajo
    // «Proyector» otra vez.
    expect(nombreDeLaFila(fila('Proyector', { label: 'Proyector' }))).toEqual({
      titulo: 'Proyector',
      tipoAparte: false,
    })
  })

  it('sin etiqueta tampoco lo repite: el título ya es el tipo', () => {
    expect(nombreDeLaFila(fila('Proyector', { label: null }))).toEqual({
      titulo: 'Proyector',
      tipoAparte: false,
    })
  })

  it('la segunda unidad sí lleva su tipo debajo, que es cuando añade algo', () => {
    expect(nombreDeLaFila(fila('Pantalla', { label: 'Pantalla 2' }))).toEqual({
      titulo: 'Pantalla 2',
      tipoAparte: true,
    })
  })

  it('una etiqueta escrita a mano con otra caja sigue siendo el mismo dato', () => {
    // Con el mismo `norm` que usa `nextLabel` para decidir si una etiqueta está
    // usada: si allí «proyector» y «Proyector» son lo mismo, aquí también.
    expect(nombreDeLaFila(fila('Proyector', { label: 'PROYECTOR ' })).tipoAparte).toBe(false)
  })

  it('el tipo que no consta sí baja, porque falta de verdad', () => {
    expect(nombreDeLaFila(fila(null, { label: 'Trasto del fondo' }))).toEqual({
      titulo: 'Trasto del fondo',
      tipoAparte: true,
    })
  })

  it('sin etiqueta y sin tipo la línea sigue teniendo nombre', () => {
    expect(nombreDeLaFila(fila(null, { label: null }))).toEqual({
      titulo: 'Equipo',
      tipoAparte: true,
    })
  })
})

describe('filtrar', () => {
  const vivo = fila('Proyector', { asset_id: 'vivo' })
  const averiado = fila('Pantalla', { asset_id: 'averiado', status: 'averiado' })
  const debaja = fila('Altavoces', {
    asset_id: 'debaja',
    status: 'retirado',
    baja_at: '2026-07-18T10:00:00Z',
  })
  const pedida = fila('Botonera', { asset_id: 'pedida', retirada_pedida: true })

  it('la hoja del inventario vivo no arrastra lo que ya salió de la sala', () => {
    const filas = filtrar([vivo, averiado, debaja, pedida], { incluirBajas: false })
    expect(filas.map((f) => f.asset_id)).toEqual(['vivo', 'averiado', 'pedida'])
  })

  it('la hoja de bajas las lleva todas', () => {
    expect(filtrar([vivo, debaja], { incluirBajas: true }).map((f) => f.asset_id)).toEqual([
      'vivo',
      'debaja',
    ])
  })

  it('una retirada solo PEDIDA no es una baja: el equipo sigue en el aula', () => {
    expect(filtrar([pedida], { incluirBajas: false })).toHaveLength(1)
  })

  it('quita también el que trae fecha de baja aunque el estado no lo diga', () => {
    // El equipo devuelto al almacén: el servidor guarda su baja en el evento y
    // la fila puede llegar con el estado de antes.
    const raro = fila('Proyector', { baja_at: '2026-07-18T10:00:00Z', baja_destino: 'almacen' })
    expect(filtrar([raro], { incluirBajas: false })).toEqual([])
  })

  it('no toca la lista original', () => {
    const original = [vivo, debaja]
    filtrar(original, { incluirBajas: false })
    expect(original).toHaveLength(2)
  })
})

describe('resumen', () => {
  it('cuenta los estados y agrupa los tipos repetidos', () => {
    const filas = [
      fila('Proyector', { asset_id: 'p1' }),
      fila('Pantalla', { asset_id: 'q1' }),
      fila('Pantalla', { asset_id: 'q2', status: 'averiado' }),
      fila('Pantalla', { asset_id: 'q3', status: 'retirado' }),
      fila('Altavoces', { asset_id: 's1' }),
    ]
    const r = resumen(filas)
    expect(r).toMatchObject({ total: 5, instalados: 3, averiados: 1, retirados: 1 })
    expect(r.porTipo).toEqual([
      { tipo: 'Proyector', n: 1 },
      { tipo: 'Pantalla', n: 3 },
      { tipo: 'Altavoces', n: 1 },
    ])
  })

  it('lista los tipos en el mismo orden que la tabla de abajo', () => {
    // Un resumen ordenado distinto que la tabla obliga a buscar cada tipo dos
    // veces en la misma hoja.
    const filas = [fila('Botonera'), fila('Proyector'), fila('Deshumidificador')]
    expect(resumen(filas).porTipo.map((t) => t.tipo)).toEqual([
      'Proyector',
      'Botonera',
      'Deshumidificador',
    ])
  })

  it('cuenta lo que falta por apuntar y lo que falta por validar', () => {
    const filas = [
      fila('Proyector', { asset_id: 'p1', serial: 'NP44-0012' }),
      fila('Proyector', { asset_id: 'p2', serial: '   ' }),
      fila('Proyector', { asset_id: 'p3', serial: null, confirmed: false }),
    ]
    expect(resumen(filas)).toMatchObject({ sinSerie: 2, sinValidar: 1 })
  })

  it('el equipo sin tipo resuelto sigue contando: si no, las sumas no cuadran', () => {
    const r = resumen([fila(null, { asset_id: 'x' })])
    expect(r.total).toBe(1)
    expect(r.porTipo).toEqual([{ tipo: 'Sin tipo', n: 1 }])
  })

  it('cuenta como baja lo que la tabla tacha como baja, aunque el estado no lo diga', () => {
    // La fila la produce el servidor: la cola de salida sube el equipo con un
    // `upsert` plano, así que un iPad que descargó la sala antes de que se
    // aprobara la retirada reescribe `status = 'instalado'` sobre un equipo que
    // ya tiene su evento de baja. Es la hoja con «Incluir equipos dados de
    // baja» marcada —la que se archiva para justificar dónde acabó un aparato—
    // y ahí la cabecera decía «1 instalado · 0 de baja» encima de una tabla con
    // esa única línea tachada. Los dos números salen del mismo predicado o no
    // salen: es lo único que ata la cabecera a la tabla.
    const conBajaYEstadoViejo = fila('Proyector', {
      baja_at: '2026-07-18T10:00:00Z',
      baja_destino: 'almacen',
    })
    expect(esBaja(conBajaYEstadoViejo)).toBe(true)
    expect(resumen([conBajaYEstadoViejo])).toMatchObject({
      total: 1,
      instalados: 0,
      averiados: 0,
      retirados: 1,
    })
  })

  it('un averiado con fecha de baja cuenta como baja, no como avería', () => {
    // El orden de las ramas es el de `FilaDeLaHoja`, que pinta «× Retirado» y
    // no «! Averiado» en cuanto la fila ha salido de la sala.
    const roto = fila('Pantalla', { status: 'averiado', baja_at: '2026-07-18T10:00:00Z' })
    expect(resumen([roto])).toMatchObject({ instalados: 0, averiados: 0, retirados: 1 })
  })

  it('con la hoja vacía no dice nada raro', () => {
    expect(resumen([])).toEqual({
      total: 0,
      instalados: 0,
      averiados: 0,
      retirados: 0,
      sinSerie: 0,
      sinValidar: 0,
      porTipo: [],
    })
  })
})

// -----------------------------------------------------------------------------
// La hoja hecha con el espejo local
// -----------------------------------------------------------------------------

const EDIFICIOS: Building[] = [
  { id: 'b-h', code: 'H', name: 'Edificio H', sort_order: 1, needs_review: false },
  { id: 'b-e', code: 'E', name: 'Edificio E', sort_order: 2, needs_review: false },
]

const ZONAS: Zone[] = [
  { id: 'z-baja', building_id: 'b-h', name: 'PLANTA BAJA', sort_order: 2 },
  { id: 'z-primera', building_id: 'b-h', name: '1ª PLANTA', sort_order: 3 },
  { id: 'z-e-baja', building_id: 'b-e', name: 'PLANTA BAJA', sort_order: 2 },
]

function sala(id: string, code: string, zoneId: string, extra: Partial<Room> = {}): Room {
  return {
    id,
    zone_id: zoneId,
    code,
    name: `Aula ${code}`,
    kind: 'aula',
    capabilities: {
      proyector: false,
      altavoces: false,
      camara: false,
      microfono: false,
      botonera: false,
      tv: false,
    },
    projector_hours: null,
    lamp_pct: null,
    last_inspection_at: null,
    last_inventory_at: null,
    active: true,
    short_ref: null,
    ...extra,
  }
}

const SALAS: Room[] = [
  sala('r-0.3', '0.3', 'z-baja', { short_ref: 'SALA-000003', last_inventory_at: '2026-05-04T09:00:00Z' }),
  sala('r-1.7', '1.7', 'z-primera'),
  sala('r-e-0.1', '0.1', 'z-e-baja'),
]

function tipo(name: string, extra: Partial<AssetType> = {}): AssetType {
  return {
    id: assetTypeId(name),
    name,
    category: 'av',
    tracks_serial: true,
    tracks_lamp_hours: false,
    confirmed: true,
    aliases: [],
    merged_into: null,
    ...extra,
  }
}

function equipo(id: string, typeName: string, roomId: string | null, extra: Partial<Asset> = {}): Asset {
  return {
    id,
    asset_type_id: assetTypeId(typeName),
    room_id: roomId,
    label: typeName,
    serial: null,
    model: null,
    brand: null,
    status: 'instalado',
    created_at: '2026-01-15T08:00:00Z',
    confirmed: true,
    ...extra,
  }
}

const TIPOS = new Map(
  [tipo('Proyector'), tipo('Pantalla'), tipo('Altavoces')].map((t) => [t.id, t]),
)

function espejo(assets: Asset[], retiradas: AssetRemoval[] = []) {
  return { assets, types: TIPOS, rooms: SALAS, zones: ZONAS, buildings: EDIFICIOS, retiradas }
}

describe('filasDelEspejo', () => {
  it('con alcance de sala trae solo los equipos de esa sala', () => {
    const filas = filasDelEspejo(
      espejo([
        equipo('p1', 'Proyector', 'r-0.3'),
        equipo('p2', 'Proyector', 'r-1.7'),
        equipo('p3', 'Proyector', 'r-e-0.1'),
      ]),
      { tipo: 'sala', roomId: 'r-0.3' },
    )
    expect(filas.map((f) => f.asset_id)).toEqual(['p1'])
  })

  it('con alcance de edificio trae todas sus plantas y ninguna del vecino', () => {
    const filas = filasDelEspejo(
      espejo([
        equipo('p1', 'Proyector', 'r-0.3'),
        equipo('p2', 'Proyector', 'r-1.7'),
        equipo('p3', 'Proyector', 'r-e-0.1'),
      ]),
      { tipo: 'edificio', buildingId: 'b-h' },
    )
    expect(filas.map((f) => f.asset_id).sort()).toEqual(['p1', 'p2'])
  })

  it('rellena la sala, la planta y el edificio de cada equipo', () => {
    const [f] = filasDelEspejo(espejo([equipo('p1', 'Proyector', 'r-0.3')]), {
      tipo: 'sala',
      roomId: 'r-0.3',
    })
    expect(f).toMatchObject({
      building_code: 'H',
      building_name: 'Edificio H',
      building_sort: 1,
      zone_name: 'PLANTA BAJA',
      zone_sort: 2,
      room_code: '0.3',
      room_short_ref: 'SALA-000003',
      room_last_inventory_at: '2026-05-04T09:00:00Z',
      type_name: 'Proyector',
    })
  })

  it('resuelve el nombre del tipo siguiendo las fusiones', () => {
    // Un equipo cuyo tipo se fusionó ayer tiene que salir con el nombre vivo, no
    // con la lápida.
    const tv = tipo('TV', { merged_into: assetTypeId('Pantalla') })
    const types = new Map([...TIPOS, [tv.id, tv]])
    const [f] = filasDelEspejo(
      { ...espejo([equipo('p1', 'TV', 'r-0.3')]), types },
      { tipo: 'sala', roomId: 'r-0.3' },
    )
    expect(f?.type_name).toBe('Pantalla')
  })

  it('marca el equipo con una retirada pendiente y no el que ya se decidió', () => {
    const retirada = (id: string, assetId: string, state: AssetRemoval['state']): AssetRemoval => ({
      id,
      asset_id: assetId,
      room_id: 'r-0.3',
      destino: 'almacen',
      reason: null,
      state,
      requested_at: '2026-07-01T08:00:00Z',
      requested_by: null,
    })
    const filas = filasDelEspejo(
      espejo(
        [equipo('p1', 'Proyector', 'r-0.3'), equipo('p2', 'Pantalla', 'r-0.3')],
        [retirada('s1', 'p1', 'pendiente'), retirada('s2', 'p2', 'aprobada')],
      ),
      { tipo: 'sala', roomId: 'r-0.3' },
    )
    expect(filas.find((f) => f.asset_id === 'p1')?.retirada_pedida).toBe(true)
    expect(filas.find((f) => f.asset_id === 'p2')?.retirada_pedida).toBe(false)
  })

  it('no fabrica las fechas que el dispositivo no puede saber', () => {
    // El espejo no guarda `asset_events` ni el `updated_at` del servidor. Poner
    // ahí `created_at` daría una hoja con todas las casillas llenas y una fecha
    // inventada en cada línea.
    const [f] = filasDelEspejo(
      espejo([equipo('p1', 'Proyector', 'r-0.3', { status: 'averiado' })]),
      { tipo: 'sala', roomId: 'r-0.3' },
    )
    expect(f?.alta_at).toBe('2026-01-15T08:00:00Z')
    expect(f?.cambio_at).toBeNull()
    expect(f?.baja_at).toBeNull()
    expect(f?.baja_destino).toBeNull()
    expect(f?.baja_motivo).toBeNull()
    // Y lo que la hoja dice de él es lo último que consta de verdad.
    expect(f && ultimoMovimiento(f)).toEqual({ fecha: '15 ene 2026', que: 'Alta' })
  })

  it('no inventa el equipo que volvió al almacén y ya no tiene sala', () => {
    // Al aprobar la retirada, `decide_asset_removal` deja `room_id` a NULL y la
    // sala solo queda en el `asset_events` de la baja, que el espejo no tiene.
    // Sin conexión ese equipo es invisible, y colocarlo a ojo en una sala sería
    // peor que no enseñarlo.
    const filas = filasDelEspejo(
      espejo([equipo('p1', 'Proyector', null, { status: 'retirado' })]),
      { tipo: 'edificio', buildingId: 'b-h' },
    )
    expect(filas).toEqual([])
  })

  it('aguanta un equipo sin fecha de alta, que es la mitad de los importados', () => {
    const [f] = filasDelEspejo(
      espejo([equipo('p1', 'Proyector', 'r-0.3', { created_at: null })]),
      { tipo: 'sala', roomId: 'r-0.3' },
    )
    expect(f?.alta_at).toBeNull()
    expect(f && ultimoMovimiento(f)).toEqual({ fecha: null, que: 'Alta' })
  })

  it('se salta el equipo cuya planta todavía no ha llegado al dispositivo', () => {
    // Pasa con una descarga a medias. Una fila sin edificio saldría con media
    // hoja en blanco.
    const filas = filasDelEspejo(
      { ...espejo([equipo('p1', 'Proyector', 'r-0.3')]), zones: [] },
      { tipo: 'edificio', buildingId: 'b-h' },
    )
    expect(filas).toEqual([])
  })

  it('sale ordenada en cuanto se agrupa, sin que quien la pinta ordene nada', () => {
    const filas = filasDelEspejo(
      espejo([
        equipo('a1', 'Altavoces', 'r-1.7'),
        equipo('p1', 'Proyector', 'r-1.7'),
        equipo('p2', 'Proyector', 'r-0.3'),
      ]),
      { tipo: 'edificio', buildingId: 'b-h' },
    )
    const grupos = agruparPorSala(filas)
    expect(grupos.map((g) => g.room_code)).toEqual(['0.3', '1.7'])
    expect(grupos[1]?.filas.map((f) => f.asset_id)).toEqual(['p1', 'a1'])
  })
})
