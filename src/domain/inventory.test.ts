import { describe, expect, it } from 'vitest'
import {
  assetTypeId,
  exactType,
  labelAvailable,
  nextLabel,
  resolveType,
  searchCatalog,
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
