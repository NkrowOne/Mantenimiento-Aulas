import { describe, expect, it } from 'vitest'
import {
  assetTypeId,
  conflictoDeAlta,
  exactType,
  labelAvailable,
  nextLabel,
  resolveType,
  searchCatalog,
  sugerenciasDe,
  vocabularioDeTipo,
} from './inventory'
import type { Asset, AssetType } from './types'

function type(name: string, extra: Partial<AssetType> = {}): AssetType {
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

function asset(label: string, extra: Partial<Asset> = {}): Asset {
  return {
    id: `a-${label}`,
    asset_type_id: assetTypeId('Pantalla'),
    room_id: 'r1',
    label,
    serial: null,
    model: null,
    status: 'instalado',
    created_at: null,
    confirmed: true,
    ...extra,
  }
}

describe('assetTypeId', () => {
  it('da el mismo id a las grafías que solo cambian en tildes o mayúsculas', () => {
    // Es lo que impide que dos técnicos sin cobertura creen dos filas.
    expect(assetTypeId('Micrófono')).toBe(assetTypeId('MICROFONO'))
    expect(assetTypeId('  microfono  ')).toBe(assetTypeId('Micrófono'))
  })

  it('distingue tipos que de verdad son distintos', () => {
    expect(assetTypeId('Pantalla')).not.toBe(assetTypeId('Proyector'))
  })
})

describe('searchCatalog', () => {
  const catalog = [
    type('Proyector', { aliases: ['cañón'] }),
    type('Micrófono Jabra', { aliases: ['jab'] }),
    type('Pantalla', { aliases: ['tv'] }),
  ]

  it('encuentra por alias lo que el técnico dice en voz alta', () => {
    // Sin esto se teclea «jab», no sale nada, y nace un duplicado.
    expect(searchCatalog(catalog, 'jab')[0]?.type.name).toBe('Micrófono Jabra')
    expect(searchCatalog(catalog, 'cañon')[0]?.type.name).toBe('Proyector')
  })

  it('dice por qué ha salido cuando la coincidencia es de alias', () => {
    expect(searchCatalog(catalog, 'tv')[0]?.why).toContain('tv')
    expect(searchCatalog(catalog, 'pantalla')[0]?.why).toBe('')
  })

  it('prefiere el que empieza por lo tecleado', () => {
    const hits = searchCatalog([type('Micrófono'), type('Alargador de micrófono')], 'micro')
    expect(hits[0]?.type.name).toBe('Micrófono')
  })

  it('ignora los tipos fusionados: ya no son un destino válido', () => {
    const fusionado = [type('TV', { merged_into: assetTypeId('Pantalla') })]
    expect(searchCatalog(fusionado, 'tv')).toHaveLength(0)
  })
})

describe('exactType', () => {
  it('reconoce el nombre completo aunque cambie la grafía', () => {
    expect(exactType([type('Cámara')], 'camara')?.name).toBe('Cámara')
    expect(exactType([type('Cámara')], 'cam')).toBeNull()
  })
})

describe('nextLabel', () => {
  it('el primero se llama como su tipo, sin número', () => {
    expect(nextLabel([], 'Pantalla')).toBe('Pantalla')
  })

  it('el segundo lleva el 2 sin que nadie lo teclee', () => {
    expect(nextLabel([asset('Pantalla')], 'Pantalla')).toBe('Pantalla 2')
    expect(nextLabel([asset('Pantalla'), asset('Pantalla 2')], 'Pantalla')).toBe('Pantalla 3')
  })

  it('no reutiliza el número de uno retirado si la etiqueta sigue libre', () => {
    // Retirada la 2, el siguiente puede volver a ser «Pantalla 2»: la etiqueta
    // quedó libre y dejar huecos numéricos confunde más que reutilizarlos.
    const assets = [asset('Pantalla'), asset('Pantalla 2', { status: 'retirado' })]
    expect(nextLabel(assets, 'Pantalla')).toBe('Pantalla 2')
  })

  it('cuenta por etiqueta y no por cantidad, que es donde se cuela el duplicado', () => {
    // Dos elementos, pero la etiqueta libre es la 2 y no la 3.
    const assets = [asset('Pantalla'), asset('Pantalla 3')]
    expect(nextLabel(assets, 'Pantalla')).toBe('Pantalla 2')
  })
})

describe('labelAvailable', () => {
  it('rechaza una etiqueta que ya usa otro equipo de la sala', () => {
    expect(labelAvailable([asset('Pantalla')], 'pantalla')).toBe(false)
  })

  it('deja renombrar un equipo con su propio nombre', () => {
    const existing = asset('Pantalla')
    expect(labelAvailable([existing], 'Pantalla', existing.id)).toBe(true)
  })

  it('no deja poner una etiqueta vacía', () => {
    expect(labelAvailable([], '   ')).toBe(false)
  })
})

describe('conflictoDeAlta', () => {
  it('sin choque no hay conflicto: el nombre pedido queda tal cual', () => {
    expect(conflictoDeAlta([], 'Monitor Atril')).toBeNull()
    expect(conflictoDeAlta([asset('Pantalla')], 'Monitor Atril')).toBeNull()
  })

  it('detecta el equipo con el que se choca y anuncia la etiqueta siguiente', () => {
    // Es el caso del «Monitor Atril 2» fantasma: antes el alta renombraba en
    // silencio; ahora el choque sale a la luz con el aparato existente delante.
    const existente = asset('Monitor Atril')
    const conflicto = conflictoDeAlta([existente], 'monitor atril')
    expect(conflicto?.existente.id).toBe(existente.id)
    expect(conflicto?.siguiente).toBe('monitor atril 2')
  })

  it('compara normalizando, que es como compara el índice de la base', () => {
    expect(conflictoDeAlta([asset('MONITOR ATRIL')], 'Monitor  Atril')).not.toBeNull()
  })

  it('un retirado no choca: su etiqueta quedó libre', () => {
    expect(conflictoDeAlta([asset('Monitor Atril', { status: 'retirado' })], 'Monitor Atril')).toBeNull()
  })

  it('con la base ocupada y la 2 también, anuncia la 3', () => {
    const conflicto = conflictoDeAlta([asset('Pantalla'), asset('Pantalla 2')], 'Pantalla')
    expect(conflicto?.siguiente).toBe('Pantalla 3')
  })
})

describe('resolveType', () => {
  it('sigue la fusión hasta el tipo vivo', () => {
    const pantalla = type('Pantalla')
    const tv = type('TV', { merged_into: pantalla.id })
    const types = new Map([
      [tv.id, tv],
      [pantalla.id, pantalla],
    ])
    expect(resolveType(types, tv.id)?.name).toBe('Pantalla')
  })

  it('no se cuelga si dos tipos se apuntan el uno al otro', () => {
    // No debería pasar nunca, pero un bucle aquí congelaría la revisión entera.
    const a = type('A')
    const b = type('B')
    const types = new Map([
      [a.id, { ...a, merged_into: b.id }],
      [b.id, { ...b, merged_into: a.id }],
    ])
    expect(() => resolveType(types, a.id)).not.toThrow()
  })
})

describe('vocabularioDeTipo', () => {
  const PROY = assetTypeId('Proyector')
  const parque: Asset[] = [
    asset('Proyector', { id: 'p1', asset_type_id: PROY, model: 'NEC NP44', room_id: 'r1' }),
    asset('Proyector', { id: 'p2', asset_type_id: PROY, model: 'NEC NP44', room_id: 'r2' }),
    asset('Proyector del atril', { id: 'p3', asset_type_id: PROY, model: 'Epson EB-1485Fi', room_id: 'r3' }),
    // Otro tipo: su vocabulario no puede colarse en el del proyector.
    asset('Pantalla', { id: 'x1', model: 'Samsung QM85', room_id: 'r1' }),
  ]

  it('ordena por lo más repetido: es lo que va a teclear el siguiente', () => {
    expect(vocabularioDeTipo(parque, PROY, 'model')).toEqual([
      { valor: 'NEC NP44', veces: 2 },
      { valor: 'Epson EB-1485Fi', veces: 1 },
    ])
  })

  it('no mezcla el vocabulario de otros tipos de equipo', () => {
    const modelos = vocabularioDeTipo(parque, PROY, 'model').map((s) => s.valor)
    expect(modelos).not.toContain('Samsung QM85')
  })

  it('junta las grafías que solo cambian en mayúsculas o tildes', () => {
    // Es el problema que viene a arreglar: ofrecer las dos sería ofrecerlo.
    const conRuido = [
      ...parque,
      asset('Proyector', { id: 'p4', asset_type_id: PROY, model: 'nec np44', room_id: 'r4' }),
    ]
    const nec = vocabularioDeTipo(conRuido, PROY, 'model').find((s) => s.veces === 3)
    expect(nec).toEqual({ valor: 'NEC NP44', veces: 3 })
  })

  it('sirve también para los nombres de sala, que es de donde salen las plantillas', () => {
    expect(vocabularioDeTipo(parque, PROY, 'label')).toEqual([
      { valor: 'Proyector', veces: 2 },
      { valor: 'Proyector del atril', veces: 1 },
    ])
  })

  it('ignora los vacíos en vez de ofrecer una sugerencia en blanco', () => {
    const flojo = [
      asset('Proyector', { id: 'p9', asset_type_id: PROY, model: '   ' }),
      asset('Proyector 2', { id: 'p8', asset_type_id: PROY, model: null }),
    ]
    expect(vocabularioDeTipo(flojo, PROY, 'model')).toEqual([])
  })
})

describe('sugerenciasDe', () => {
  const voc = [
    { valor: 'NEC NP44', veces: 30 },
    { valor: 'Epson EB-1485Fi', veces: 4 },
    { valor: 'Epson EB-685W', veces: 2 },
  ]

  it('con el campo vacío ofrece lo más frecuente: es el caso que ahorra trabajo', () => {
    expect(sugerenciasDe(voc, '').map((s) => s.valor)).toEqual([
      'NEC NP44',
      'Epson EB-1485Fi',
      'Epson EB-685W',
    ])
  })

  it('filtra por lo tecleado, sin importar tildes ni mayúsculas', () => {
    expect(sugerenciasDe(voc, 'epson').map((s) => s.valor)).toEqual([
      'Epson EB-1485Fi',
      'Epson EB-685W',
    ])
  })

  it('lo que empieza por lo tecleado va antes de lo que solo lo contiene', () => {
    const conAmbos = [
      { valor: 'Cañón corto NEC', veces: 9 },
      { valor: 'NEC NP44', veces: 1 },
    ]
    expect(sugerenciasDe(conAmbos, 'nec').map((s) => s.valor)).toEqual([
      'NEC NP44',
      'Cañón corto NEC',
    ])
  })

  it('no ofrece lo que ya está escrito en el campo', () => {
    expect(sugerenciasDe(voc, 'NEC NP44', { excluir: ['NEC NP44'] })).toEqual([])
  })

  it('deja excluir lo que en esta sala haría choque de nombre', () => {
    const nombres = [{ valor: 'Pantalla', veces: 5 }, { valor: 'Pantalla del atril', veces: 2 }]
    expect(sugerenciasDe(nombres, '', { excluir: ['pantalla'] }).map((s) => s.valor)).toEqual([
      'Pantalla del atril',
    ])
  })

  it('corta la lista para que no tape el formulario', () => {
    const muchos = Array.from({ length: 20 }, (_, i) => ({ valor: `M${i}`, veces: 1 }))
    expect(sugerenciasDe(muchos, '')).toHaveLength(5)
    expect(sugerenciasDe(muchos, '', { limit: 3 })).toHaveLength(3)
  })
})
