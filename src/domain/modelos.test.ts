import { describe, expect, it } from 'vitest'
import {
  assetModelId,
  assetTypeId,
  duplicadosProbables,
  exactModel,
  identifyAsset,
  modelLabel,
  resolveModel,
  searchModels,
  splitBrandModel,
} from './inventory'
import type { Asset, AssetModel, AssetType } from './types'

const ORDENADOR = assetTypeId('Ordenador')
const PANTALLA = assetTypeId('Pantalla')

function tipo(name: string, extra: Partial<AssetType> = {}): AssetType {
  return {
    id: assetTypeId(name),
    name,
    category: 'ti',
    tracks_serial: true,
    tracks_lamp_hours: false,
    confirmed: true,
    aliases: [],
    merged_into: null,
    active: true,
    spec_fields: [],
    ...extra,
  }
}

function modelo(
  typeId: string,
  brand: string,
  model: string,
  extra: Partial<AssetModel> = {},
): AssetModel {
  return {
    id: assetModelId(typeId, brand, model),
    asset_type_id: typeId,
    brand,
    model,
    aliases: [],
    specs: {},
    notes: null,
    eol_on: null,
    confirmed: true,
    active: true,
    merged_into: null,
    created_at: null,
    ...extra,
  }
}

function equipo(extra: Partial<Asset> = {}): Asset {
  return {
    id: 'a1',
    asset_type_id: ORDENADOR,
    room_id: 'r1',
    label: 'Ordenador',
    serial: null,
    model: null,
    asset_model_id: null,
    installed_at: null,
    warranty_until: null,
    specs: {},
    notes: null,
    status: 'instalado',
    created_at: null,
    confirmed: true,
    ...extra,
  }
}

describe('assetModelId', () => {
  it('da el mismo id a las grafías que solo cambian en tildes, espacios o mayúsculas', () => {
    // Es lo que impide que dos técnicos sin cobertura creen dos filas del mismo
    // modelo, y lo que hace que converjan al sincronizar.
    expect(assetModelId(ORDENADOR, 'Lenovo', 'U3302')).toBe(
      assetModelId(ORDENADOR, 'LENOVO', 'u3302'),
    )
    expect(assetModelId(ORDENADOR, '  Lenovo  ', 'U3302')).toBe(
      assetModelId(ORDENADOR, 'Lenovo', 'U3302'),
    )
  })

  it('separa por tipo: un U3302 de ordenador no es un U3302 de pantalla', () => {
    expect(assetModelId(ORDENADOR, 'Lenovo', 'U3302')).not.toBe(
      assetModelId(PANTALLA, 'Lenovo', 'U3302'),
    )
  })

  it('separa la marca del modelo: «Lenovo U3302» junto no es lo mismo que partido', () => {
    // Importa porque el relleno del servidor los parte y el cliente también:
    // si el id no dependiera de las dos piezas por separado, un modelo creado a
    // mano sin marca chocaría con el mismo ya partido.
    expect(assetModelId(ORDENADOR, '', 'Lenovo U3302')).not.toBe(
      assetModelId(ORDENADOR, 'Lenovo', 'U3302'),
    )
  })
})

describe('splitBrandModel', () => {
  it('reconoce la marca al principio', () => {
    expect(splitBrandModel('Lenovo U3302')).toEqual({ brand: 'Lenovo', model: 'U3302' })
    expect(splitBrandModel('epson EB-992F')).toEqual({ brand: 'Epson', model: 'EB-992F' })
  })

  it('acepta el guion como separador', () => {
    expect(splitBrandModel('TP-Link Archer')).toEqual({ brand: 'TP-Link', model: 'Archer' })
  })

  it('prefiere la marca más larga', () => {
    // Sin esto, «TP-Link» se partiría por una marca más corta que empezara igual.
    expect(splitBrandModel('TP-Link AX50', ['TP', 'TP-Link'])).toEqual({
      brand: 'TP-Link',
      model: 'AX50',
    })
  })

  it('no inventa marca cuando no la reconoce', () => {
    // Es la regla de fondo: un modelo entero mal partido se arregla en dos
    // segundos; una marca inventada se queda para siempre y nadie la revisa.
    expect(splitBrandModel('ME403U')).toEqual({ brand: '', model: 'ME403U' })
    expect(splitBrandModel('M403H *')).toEqual({ brand: '', model: 'M403H *' })
  })

  it('no deja el modelo vacío cuando el texto es solo la marca', () => {
    expect(splitBrandModel('Epson')).toEqual({ brand: '', model: 'Epson' })
  })

  it('no se traga el principio de una palabra que empieza igual que una marca', () => {
    // «LG» no puede comerse «LGX-40»: hace falta un separador detrás.
    expect(splitBrandModel('LGX-40')).toEqual({ brand: '', model: 'LGX-40' })
  })
})

describe('identifyAsset', () => {
  const tipos = new Map([[ORDENADOR, tipo('Ordenador')]])

  it('junta tipo, marca, modelo y serie', () => {
    const m = modelo(ORDENADOR, 'Lenovo', 'U3302')
    const id = identifyAsset(
      equipo({ label: 'Ordenador 2', asset_model_id: m.id, serial: 'ABC123' }),
      tipos,
      new Map([[m.id, m]]),
    )

    expect(id.etiqueta).toBe('Ordenador 2')
    expect(id.completo).toBe('Ordenador Lenovo U3302')
    expect(id.modeloLargo).toBe('Lenovo U3302')
    expect(id.ficha).toBe('Lenovo U3302 · S/N ABC123')
  })

  it('cae en el texto libre cuando todavía no hay modelo de catálogo', () => {
    // Los 1.094 equipos importados están así, y quedarse mudos sería perder el
    // único dato de modelo que existe.
    const id = identifyAsset(equipo({ model: 'ME403U' }), tipos, new Map())
    expect(id.modelo).toBe('ME403U')
    expect(id.completo).toBe('Ordenador ME403U')
  })

  it('lo dice cuando no hay nada que decir', () => {
    const id = identifyAsset(equipo(), tipos, new Map())
    expect(id.modeloLargo).toBe('Sin modelo')
    expect(id.ficha).toBe('')
  })

  it('sigue la fusión del modelo', () => {
    // Un equipo cuyo modelo se fusionó ayer tiene que enseñar el nombre bueno,
    // no la lápida.
    const viejo = modelo(ORDENADOR, '', 'ME-403U')
    const bueno = modelo(ORDENADOR, 'NEC', 'ME403U')
    const modelos = new Map([
      [viejo.id, { ...viejo, merged_into: bueno.id }],
      [bueno.id, bueno],
    ])

    const id = identifyAsset(equipo({ asset_model_id: viejo.id }), tipos, modelos)
    expect(id.modeloLargo).toBe('NEC ME403U')
  })

  it('marca el modelo sin validar', () => {
    const m = modelo(ORDENADOR, 'Lenovo', 'U3302', { confirmed: false })
    const id = identifyAsset(equipo({ asset_model_id: m.id }), tipos, new Map([[m.id, m]]))
    expect(id.modeloSinValidar).toBe(true)
  })
})

describe('resolveModel', () => {
  it('no se cuelga con una cadena de fusiones circular', () => {
    // Pasa si alguien fusiona A en B y luego B en A. La base no lo impide y un
    // bucle infinito aquí congela el iPad en mitad de un aula.
    const a = modelo(ORDENADOR, '', 'A')
    const b = modelo(ORDENADOR, '', 'B')
    const mapa = new Map([
      [a.id, { ...a, merged_into: b.id }],
      [b.id, { ...b, merged_into: a.id }],
    ])
    expect(resolveModel(mapa, a.id)).not.toBeNull()
  })

  it('devuelve null sin id', () => {
    expect(resolveModel(new Map(), null)).toBeNull()
  })
})

describe('searchModels', () => {
  const catalogo = [
    modelo(ORDENADOR, 'Lenovo', 'U3302'),
    modelo(ORDENADOR, 'Lenovo', 'M70Q Gen3'),
    modelo(ORDENADOR, 'HP', 'ProDesk 400', { confirmed: false, aliases: ['hp400'] }),
    modelo(PANTALLA, 'Sony', '85BZ30L'),
  ]

  it('busca por marca y modelo juntos, que es como se teclea', () => {
    const hits = searchModels(catalogo, ORDENADOR, 'lenovo u33')
    expect(hits).toHaveLength(1)
    expect(modelLabel(hits[0]!.model)).toBe('Lenovo U3302')
  })

  it('no ofrece modelos de otro tipo', () => {
    expect(searchModels(catalogo, ORDENADOR, '85BZ30L')).toHaveLength(0)
  })

  it('encuentra por alias y lo dice', () => {
    const hits = searchModels(catalogo, ORDENADOR, 'hp400')
    expect(hits[0]?.why).toContain('alias')
  })

  it('sin nada tecleado ofrece primero los validados', () => {
    const hits = searchModels(catalogo, ORDENADOR, '')
    expect(hits[0]?.model.confirmed).toBe(true)
  })

  it('esconde los fusionados y los retirados', () => {
    const conLapida = [
      ...catalogo,
      modelo(ORDENADOR, '', 'ME-403U', { merged_into: catalogo[0]!.id }),
      modelo(ORDENADOR, '', 'ARCHIVADO', { active: false }),
    ]
    expect(searchModels(conLapida, ORDENADOR, 'ME-403U')).toHaveLength(0)
    expect(searchModels(conLapida, ORDENADOR, 'ARCHIVADO')).toHaveLength(0)
  })
})

describe('exactModel', () => {
  it('detecta el duplicado exacto antes de crearlo', () => {
    // Es lo que impide mandar al servidor una fila que su índice único va a
    // rechazar horas después y lejos del aula.
    const catalogo = [modelo(ORDENADOR, 'Lenovo', 'U3302')]
    expect(exactModel(catalogo, ORDENADOR, 'lenovo', ' u3302 ')).not.toBeNull()
    expect(exactModel(catalogo, ORDENADOR, 'HP', 'U3302')).toBeNull()
  })
})

describe('duplicadosProbables', () => {
  it('agrupa lo que solo cambia en guiones, espacios y asteriscos', () => {
    // Son los datos reales del Excel: ME403U, ME-403U y «ME403U *» son el mismo
    // proyector escrito por tres personas distintas.
    const grupos = duplicadosProbables([
      modelo(ORDENADOR, '', 'ME403U'),
      modelo(ORDENADOR, '', 'ME-403U'),
      modelo(ORDENADOR, '', 'ME403U *'),
      modelo(ORDENADOR, 'Lenovo', 'U3302'),
    ])

    expect(grupos).toHaveLength(1)
    expect(grupos[0]).toHaveLength(3)
  })

  it('no agrupa modelos de tipos distintos aunque se llamen igual', () => {
    expect(
      duplicadosProbables([modelo(ORDENADOR, '', 'X1'), modelo(PANTALLA, '', 'X1')]),
    ).toHaveLength(0)
  })

  it('no agrupa por el nombre vacío', () => {
    // Un modelo sin nombre normalizable —«*****»— no es duplicado de otro igual
    // de vacío: fusionarlos a ciegas mezclaría equipos que no tienen que ver.
    expect(
      duplicadosProbables([modelo(ORDENADOR, '', '*****'), modelo(ORDENADOR, '', '###')]),
    ).toHaveLength(0)
  })
})
