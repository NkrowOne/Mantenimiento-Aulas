import { describe, expect, it } from 'vitest'
import {
  FILTRO_INICIAL,
  borradorDe,
  cambiosDeFicha,
  coincideConBusqueda,
  esIp,
  estadoDeVida,
  filtrarEquipos,
  finDeVida,
  hojaDeEntradasYSalidas,
  hojaDeEquipos,
  leerPrecio,
  normalizarMac,
  problemasDeFicha,
  resumenDeEquipos,
} from './fichaDeEquipo'
import type { EquipoDelRegistro, MovimientoDeEquipo } from './fichaDeEquipo'

function equipo(p: Partial<EquipoDelRegistro> = {}): EquipoDelRegistro {
  return {
    id: 'a1',
    asset_type_id: 't-proy',
    type_name: 'Proyector',
    category: 'av',
    label: 'Proyector',
    brand: 'Epson',
    model: 'EB-1485Fi',
    serial: 'X5LK8700123',
    inventory_tag: null,
    status: 'instalado',
    confirmed: true,
    room_id: 'r1',
    room_code: '1.7',
    room_name: null,
    zone_name: '1ª PLANTA',
    building_id: 'b-h',
    building_code: 'H',
    building_name: 'Edificio H',
    short_ref: 'SALA-000017',
    created_at: '2026-07-28T10:00:00Z',
    updated_at: null,
    acquired_at: null,
    supplier: null,
    purchase_price: null,
    purchase_ref: null,
    warranty_until: null,
    end_of_life: null,
    vida_util_anyos: null,
    fin_vida: null,
    estado_vida: 'sin_datos',
    en_garantia: null,
    hostname: null,
    mac_address: null,
    ip_address: null,
    cpu: null,
    ram: null,
    storage: null,
    os: null,
    notes: null,
    baja_at: null,
    ultimo_evento_at: null,
    ...p,
  }
}

describe('el fin de vida', () => {
  it('la fecha fijada a mano gana a la calculada', () => {
    expect(finDeVida({ acquired_at: '2020-03-01', end_of_life: '2024-01-15', vida_util_anyos: 8 })).toBe('2024-01-15')
  })

  it('sin fecha a mano, compra más vida útil del tipo', () => {
    expect(finDeVida({ acquired_at: '2021-09-22', end_of_life: null, vida_util_anyos: 5 })).toBe('2026-09-22')
  })

  it('un 29 de febrero cae en el 28, como en Postgres', () => {
    expect(finDeVida({ acquired_at: '2024-02-29', end_of_life: null, vida_util_anyos: 1 })).toBe('2025-02-28')
    expect(finDeVida({ acquired_at: '2024-02-29', end_of_life: null, vida_util_anyos: 4 })).toBe('2028-02-29')
  })

  it('sin compra o sin vida útil no se inventa nada', () => {
    expect(finDeVida({ acquired_at: null, end_of_life: null, vida_util_anyos: 5 })).toBeNull()
    expect(finDeVida({ acquired_at: '2021-01-01', end_of_life: null, vida_util_anyos: null })).toBeNull()
  })

  it('el estado, con la frontera de un año', () => {
    const hoy = '2026-10-27'
    expect(estadoDeVida(null, hoy)).toBe('sin_datos')
    expect(estadoDeVida('2026-10-27', hoy)).toBe('obsoleto')
    expect(estadoDeVida('2027-10-27', hoy)).toBe('proximo')
    expect(estadoDeVida('2027-10-28', hoy)).toBe('vigente')
  })
})

describe('lo que se escribe en la ficha', () => {
  it('el precio se lee como se escribe en España y como se pega de una hoja en inglés', () => {
    expect(leerPrecio('849')).toBe(849)
    expect(leerPrecio('849,5')).toBe(849.5)
    expect(leerPrecio('849.50')).toBe(849.5)
    expect(leerPrecio('1.299,00 €')).toBe(1299)
    expect(leerPrecio('1,299.00')).toBe(1299)
    expect(leerPrecio('1.299')).toBe(1299)
    expect(leerPrecio('')).toBeNull()
    expect(leerPrecio('caro')).toBeNaN()
  })

  it('una MAC se lleva a una sola forma', () => {
    expect(normalizarMac('aa-bb-cc-dd-ee-ff')).toBe('AA:BB:CC:DD:EE:FF')
    expect(normalizarMac('aabb.ccdd.eeff')).toBe('AA:BB:CC:DD:EE:FF')
    expect(normalizarMac('AABBCCDDEEFF')).toBe('AA:BB:CC:DD:EE:FF')
    expect(normalizarMac('AA:BB:CC:DD:EE')).toBeNull()
    expect(normalizarMac('GG:BB:CC:DD:EE:FF')).toBeNull()
  })

  it('las IP', () => {
    expect(esIp('10.20.1.15')).toBe(true)
    expect(esIp('10.20.1.256')).toBe(false)
    expect(esIp('10.20.1')).toBe(false)
    expect(esIp('fe80::1')).toBe(true)
  })

  it('cada casilla mal escrita dice qué le pasa', () => {
    const b = { ...borradorDe({}), mac_address: '12:34', ip_address: 'diez', purchase_price: '-3', acquired_at: '2026-02-30' }
    const p = problemasDeFicha(b)
    expect(p.mac_address).toMatch(/doce cifras/)
    expect(p.ip_address).toMatch(/IP/)
    expect(p.purchase_price).toBeDefined()
    expect(p.acquired_at).toMatch(/fecha/)
  })

  it('la garantía y el fin de vida no van antes de la compra', () => {
    const b = { ...borradorDe({}), acquired_at: '2026-05-01', warranty_until: '2026-04-30', end_of_life: '2025-01-01' }
    const p = problemasDeFicha(b)
    expect(p.warranty_until).toBeDefined()
    expect(p.end_of_life).toBeDefined()
  })

  it('una ficha vacía y bien escrita no tiene problemas', () => {
    expect(problemasDeFicha(borradorDe(equipo()))).toEqual({})
  })
})

describe('qué se manda al guardar', () => {
  it('solo lo que ha cambiado, normalizado', () => {
    const e = equipo({ mac_address: 'AA:BB:CC:DD:EE:FF', purchase_price: '849.00' })
    const b = { ...borradorDe(e), mac_address: 'aa-bb-cc-dd-ee-ff', purchase_price: '849', supplier: '  Distribuidor  S.L. ' }
    expect(cambiosDeFicha(e, b)).toEqual({ supplier: 'Distribuidor S.L.' })
  })

  it('vaciar una casilla manda null', () => {
    const e = equipo({ hostname: 'AULA-H17-PC01' })
    expect(cambiosDeFicha(e, { ...borradorDe(e), hostname: ' ' })).toEqual({ hostname: null })
  })

  it('los códigos van en mayúsculas y el precio en número', () => {
    const e = equipo()
    const b = { ...borradorDe(e), inventory_tag: 'inv-2026-42', hostname: 'aula-h17-pc01', purchase_price: '1.299,00' }
    expect(cambiosDeFicha(e, b)).toEqual({ inventory_tag: 'INV-2026-42', hostname: 'AULA-H17-PC01', purchase_price: 1299 })
  })

  it('la fecha que llega con hora se compara por el día', () => {
    const e = equipo({ acquired_at: '2024-09-01' })
    expect(borradorDe(e).acquired_at).toBe('2024-09-01')
    expect(cambiosDeFicha(e, borradorDe(e))).toEqual({})
  })
})

describe('buscar y filtrar', () => {
  it('cada palabra en algún campo, sin tildes ni mayúsculas', () => {
    const e = equipo({ building_name: 'Edificio H' })
    expect(coincideConBusqueda(e, 'epson h')).toBe(true)
    expect(coincideConBusqueda(e, 'epson crai')).toBe(false)
    expect(coincideConBusqueda(e, 'proyéctor')).toBe(true)
  })

  it('los códigos se encuentran sin separadores', () => {
    const e = equipo({ mac_address: 'AA:BB:CC:DD:EE:FF', serial: 'S4GM-1899' })
    expect(coincideConBusqueda(e, 'aabbccddeeff')).toBe(true)
    expect(coincideConBusqueda(e, 's4gm1899')).toBe(true)
  })

  it('por defecto salen los que están en las aulas, no los retirados', () => {
    const lista = [equipo({ id: '1' }), equipo({ id: '2', status: 'averiado' }), equipo({ id: '3', status: 'retirado' })]
    expect(filtrarEquipos(lista, FILTRO_INICIAL).map((e) => e.id)).toEqual(['1', '2'])
    expect(filtrarEquipos(lista, { ...FILTRO_INICIAL, estado: 'todos' })).toHaveLength(3)
    expect(filtrarEquipos(lista, { ...FILTRO_INICIAL, estado: 'retirado' }).map((e) => e.id)).toEqual(['3'])
  })

  it('solo ordenadores, por la categoría del tipo', () => {
    const lista = [equipo({ id: '1' }), equipo({ id: '2', category: 'ti', type_name: 'Ordenador Tiny' })]
    expect(filtrarEquipos(lista, { ...FILTRO_INICIAL, soloOrdenadores: true }).map((e) => e.id)).toEqual(['2'])
  })

  it('el resumen cuenta solo lo que está en las aulas', () => {
    const r = resumenDeEquipos([
      equipo({ estado_vida: 'obsoleto', serial: null }),
      equipo({ status: 'averiado', estado_vida: 'proximo', acquired_at: '2020-01-01' }),
      equipo({ status: 'retirado', estado_vida: 'obsoleto' }),
    ])
    expect(r).toEqual({ activos: 2, averiados: 1, obsoletos: 1, proximos: 1, sinSerie: 1, sinCompra: 1 })
  })
})

describe('las hojas del Excel', () => {
  it('una fila por equipo, con fechas como fechas y el precio como número', () => {
    const hoja = hojaDeEquipos([
      equipo({ acquired_at: '2021-09-22', purchase_price: '849.50', estado_vida: 'obsoleto', fin_vida: '2026-09-22' }),
      equipo({ id: 'a2', status: 'retirado', building_code: 'C', building_name: 'Edificio Central' }),
    ])
    expect(hoja.nombre).toBe('Equipos')
    expect(hoja.filas).toHaveLength(3)
    const cab = hoja.filas[0]!
    expect(hoja.anchos).toHaveLength(cab.length)
    const fila = hoja.filas.find((f) => f[1] === 'Edificio H')!
    expect(typeof fila[cab.indexOf('Adquisición')]).toBe('number')
    expect(fila[cab.indexOf('Precio (€)')]).toBe(849.5)
    expect(fila[cab.indexOf('Vida útil')]).toBe('Obsoleto')
    expect(hoja.formatos?.[cab.indexOf('Adquisición')]).toBe('fecha')
    // Central antes que H; el retirado sale apagado y el obsoleto en rojo.
    expect(hoja.tintes).toEqual(['apagado', 'critico'])
  })

  it('las entradas y salidas, de la más antigua a la más reciente', () => {
    const base: MovimientoDeEquipo = {
      id: 'm1',
      occurred_at: '2026-10-01T09:00:00Z',
      recorded_at: null,
      kind: 'baja',
      asset_id: 'a1',
      type_name: 'Proyector',
      label: 'Proyector',
      brand: null,
      model: null,
      serial: 'X1',
      inventory_tag: null,
      room_id: 'r1',
      room_code: '1.7',
      building_code: 'H',
      by_user: null,
      by_name: 'Ana',
      motivo: 'No enciende y no compensa repararlo',
      destino: 'baja',
      source: null,
      meta: null,
    }
    const hoja = hojaDeEntradasYSalidas([base, { ...base, id: 'm0', kind: 'alta', occurred_at: '2026-09-01T09:00:00Z', destino: null }])
    expect(hoja.filas.map((f) => f[1])).toEqual(['Movimiento', 'Entrada (alta)', 'Salida (baja)'])
    expect(hoja.filas[2]![10]).toBe('Baja definitiva')
    expect(hoja.tintes).toEqual(['ok', 'critico'])
  })
})
