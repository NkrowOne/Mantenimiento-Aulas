import { describe, expect, it } from 'vitest'
import {
  TABLAS,
  describir,
  diferencias,
  nombreDelCampo,
  resumen,
  valorLegible,
  type FilaDeAuditoria,
  type Nombres,
} from './actividad'

const nombres: Nombres = {
  salas: new Map([['sala-1', '1.7 H — Aula 1.7']]),
  plantas: new Map(),
  edificios: new Map([['ed-h', 'H — Edificio H']]),
  tipos: new Map([['tipo-proy', 'Proyector']]),
  equipos: new Map(),
  articulos: new Map(),
  personas: new Map([['u-ana', 'Ana Técnica']]),
}

const fila = (parte: Partial<FilaDeAuditoria>): FilaDeAuditoria => ({
  id: 1,
  table_name: 'rooms',
  row_id: 'sala-1',
  op: 'UPDATE',
  old_data: null,
  new_data: null,
  by_user: 'u-ana',
  at: '2026-09-17T10:15:00Z',
  ...parte,
})

describe('describir', () => {
  it('un renombrado de sala se lee con la sala, quién y el antes y el después', () => {
    const a = describir(
      fila({
        old_data: { id: 'sala-1', code: '1.7', name: 'Aula 1.7', last_inspection_at: '2026-01-01T00:00:00Z' },
        new_data: { id: 'sala-1', code: '1.7', name: 'Laboratorio 1.7', last_inspection_at: '2026-09-17T00:00:00Z' },
      }),
      nombres,
    )
    expect(a).not.toBeNull()
    expect(a!.tabla).toBe('Sala')
    expect(a!.quien).toBe('Ana Técnica')
    expect(a!.que).toBe('1.7 — Laboratorio 1.7')
    // La fecha de última revisión cambia sola y no es un cambio de nadie.
    expect(a!.cambios).toEqual([{ campo: 'Nombre', antes: 'Aula 1.7', despues: 'Laboratorio 1.7' }])
    expect(resumen(a!)).toBe('1.7 — Laboratorio 1.7 · Nombre: Aula 1.7 → Laboratorio 1.7')
  })

  it('un cambio que solo tocó lo automático no se enseña', () => {
    const a = describir(
      fila({
        old_data: { id: 'sala-1', name: 'Aula', last_inspection_at: '2026-01-01T00:00:00Z' },
        new_data: { id: 'sala-1', name: 'Aula', last_inspection_at: '2026-09-17T00:00:00Z' },
      }),
    )
    expect(a).toBeNull()
  })

  it('los uuid se leen con su nombre: el equipo que cambia de sala dice a qué sala', () => {
    const a = describir(
      fila({
        table_name: 'assets',
        row_id: 'eq-1',
        old_data: { id: 'eq-1', label: 'Proyector', asset_type_id: 'tipo-proy', room_id: null, status: 'instalado' },
        new_data: { id: 'eq-1', label: 'Proyector', asset_type_id: 'tipo-proy', room_id: 'sala-1', status: 'averiado' },
      }),
      nombres,
    )
    expect(a!.que).toBe('Proyector · 1.7 H — Aula 1.7')
    expect(a!.cambios).toEqual([
      { campo: 'Sala', antes: null, despues: '1.7 H — Aula 1.7' },
      { campo: 'Estado', antes: 'Instalado', despues: 'Averiado' },
    ])
  })

  it('altas y bajas no llevan diferencias, solo qué fila era', () => {
    const alta = describir(
      fila({ table_name: 'buildings', op: 'INSERT', new_data: { id: 'ed-h', code: 'H', name: 'Edificio H' } }),
    )
    expect(alta).toMatchObject({ op: 'alta', tabla: 'Edificio', que: 'H — Edificio H', cambios: [] })
    expect(resumen(alta!)).toBe('Alta de edificio: H — Edificio H')

    const baja = describir(
      fila({ table_name: 'asset_types', op: 'DELETE', old_data: { id: 't', name: 'Cañón' }, by_user: null }),
    )
    expect(baja).toMatchObject({ op: 'baja', tabla: 'Tipo de equipo', que: 'Cañón', quien: null })
  })

  it('un uuid sin nombre conocido sale abreviado, no en crudo', () => {
    const a = describir(
      fila({
        table_name: 'assets',
        old_data: { id: 'eq-1', room_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
        new_data: { id: 'eq-1', room_id: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      }),
    )
    expect(a!.cambios[0]).toEqual({ campo: 'Sala', antes: '#aaaaaaaa', despues: '#ffffffff' })
  })

  it('una tabla que no conoce sale con su nombre de base y la fila abreviada', () => {
    const a = describir(fila({ table_name: 'algo_nuevo', op: 'INSERT', row_id: '12345678-x', new_data: { id: 1 } }))
    expect(a).toMatchObject({ tabla: 'algo_nuevo', que: '#12345678' })
  })
})

describe('valorLegible', () => {
  it('booleanos, vacíos y listas, en castellano', () => {
    expect(valorLegible(true)).toBe('sí')
    expect(valorLegible(false)).toBe('no')
    expect(valorLegible(null)).toBe('—')
    expect(valorLegible([])).toBe('—')
    expect(valorLegible(['jab', 'cañón'])).toBe('jab, cañón')
  })

  it('el equipamiento de la sala se lee como lo que hay, no como JSON', () => {
    expect(
      valorLegible({ proyector: true, altavoces: false, camara: true, microfono: false, botonera: false, tv: false }),
    ).toBe('proyector, cámara')
    expect(
      valorLegible({ proyector: false, altavoces: false, camara: false, microfono: false, botonera: false, tv: false }),
    ).toBe('nada')
  })

  it('los enumerados salen como en las pantallas', () => {
    expect(valorLegible('en_curso')).toBe('En curso')
    expect(valorLegible('sala_reunion')).toBe('Sala de reunión')
    expect(valorLegible('almacen')).toBe('Devolver al almacén')
  })
})

describe('diferencias', () => {
  it('el porcentaje de lámpara se lee en tanto por ciento', () => {
    expect(diferencias('rooms', { lamp_pct: 0.42 }, { lamp_pct: 0.15 })).toEqual([
      { campo: 'Lámpara', antes: '42 %', despues: '15 %' },
    ])
  })

  it('el campo que aparece o desaparece cuenta como cambio con un lado vacío', () => {
    expect(diferencias('incidents', {}, { easyvista_ref: 'I260916_0042' })).toEqual([
      { campo: 'Código EasyVista', antes: null, despues: 'I260916_0042' },
    ])
  })
})

describe('las unidades del almacén', () => {
  // Lo que guarda la auditoría de una unidad: la fila entera, con los nombres de la base.
  const antes = {
    id: 'u1',
    stock_item_id: null,
    articulo: 'Ordenador Tiny',
    brand: 'Lenovo',
    model: 'M70q',
    serial: 'PF3ABC12',
    notes: null,
    status: 'disponible',
    condicion: 'nuevo',
    asset_id: null,
    room_id: null,
    installed_at: null,
    retired_at: null,
    source: 'app',
    created_at: '2026-10-27T08:00:00Z',
    updated_at: '2026-10-27T08:00:00Z',
  }
  const deUnidad = (parte: Partial<FilaDeAuditoria>): FilaDeAuditoria =>
    fila({ table_name: 'stock_units', row_id: 'u1', ...parte })
  const conEquipos: Nombres = { ...nombres, equipos: new Map([['eq-9', 'Ordenador Tiny']]) }

  it('es una de las cosas que se auditan, y se llama como en las pantallas', () => {
    expect(TABLAS['stock_units']?.nombre).toBe('Unidad del almacén')
  })

  it('se nombra por su número de serie y su artículo', () => {
    const alta = describir(deUnidad({ op: 'INSERT', new_data: antes }), nombres)
    expect(alta).toMatchObject({ op: 'alta', tabla: 'Unidad del almacén', que: 'PF3ABC12 · Ordenador Tiny', cambios: [] })
    expect(resumen(alta!)).toBe('Alta de unidad del almacén: PF3ABC12 · Ordenador Tiny')

    const baja = describir(deUnidad({ op: 'DELETE', old_data: antes, by_user: null }))
    expect(baja).toMatchObject({ op: 'baja', que: 'PF3ABC12 · Ordenador Tiny', quien: null })
  })

  it('con solo una de las dos cosas se nombra con ella, y sin ninguna, «Unidad»', () => {
    expect(describir(deUnidad({ op: 'INSERT', new_data: { id: 'u1', serial: 'PF3ABC12' } }))!.que).toBe('PF3ABC12')
    expect(describir(deUnidad({ op: 'INSERT', new_data: { id: 'u1', articulo: 'Proyector', serial: ' ' } }))!.que).toBe('Proyector')
    expect(describir(deUnidad({ op: 'INSERT', new_data: { id: 'u1' } }))!.que).toBe('Unidad')
  })

  it('cambiar cómo está se lee «Estado: Nuevo → Averiado»', () => {
    const a = describir(deUnidad({ old_data: antes, new_data: { ...antes, condicion: 'averiado' } }), nombres)
    expect(a!.cambios).toEqual([{ campo: 'Estado', antes: 'Nuevo', despues: 'Averiado' }])
    expect(resumen(a!)).toBe('PF3ABC12 · Ordenador Tiny · Estado: Nuevo → Averiado')
  })

  it('los cinco estados se leen con las palabras de las pantallas', () => {
    const lee = (c: string): string | null => diferencias('stock_units', { condicion: 'nuevo' }, { condicion: c })[0]!.despues
    expect(lee('usado')).toBe('Usado')
    expect(lee('reacondicionado')).toBe('Reacondicionado')
    expect(lee('averiado')).toBe('Averiado')
    expect(lee('sin_indicar')).toBe('Sin indicar')
    expect(valorLegible('nuevo')).toBe('Nuevo')
  })

  it('el estado y la situación son dos campos con dos nombres: nunca dos líneas que dicen «Estado»', () => {
    // Instalar una unidad cambia las dos cosas a la vez.
    const a = describir(
      deUnidad({
        old_data: antes,
        new_data: {
          ...antes,
          status: 'instalado',
          condicion: 'usado',
          asset_id: 'eq-9',
          room_id: 'sala-1',
          installed_at: '2026-10-27T09:30:00Z',
        },
      }),
      conEquipos,
    )
    expect(a!.cambios).toEqual([
      { campo: 'Situación', antes: 'En almacén', despues: 'Instalada' },
      { campo: 'Estado', antes: 'Nuevo', despues: 'Usado' },
      { campo: 'Equipo', antes: null, despues: 'Ordenador Tiny' },
      { campo: 'Sala', antes: null, despues: '1.7 H — Aula 1.7' },
      { campo: 'Instalada el', antes: null, despues: expect.stringContaining('10:30') },
    ])
    expect(new Set(a!.cambios.map((c) => c.campo)).size).toBe(a!.cambios.length)
  })

  it('darla de baja: la situación pasa a «De baja» y queda la fecha', () => {
    const instalada = { ...antes, status: 'instalado', room_id: 'sala-1' }
    const a = describir(
      deUnidad({ old_data: instalada, new_data: { ...instalada, status: 'baja', retired_at: '2026-10-27T11:00:00Z' } }),
      nombres,
    )
    expect(a!.cambios).toEqual([
      { campo: 'Situación', antes: 'Instalada', despues: 'De baja' },
      { campo: 'Retirado el', antes: null, despues: expect.stringContaining('12:00') },
    ])
  })

  it('el artículo al que se enlaza se lee con su nombre', () => {
    const a = describir(
      deUnidad({ old_data: antes, new_data: { ...antes, stock_item_id: 'art-1' } }),
      { ...nombres, articulos: new Map([['art-1', 'Ordenador Tiny M70Q']]) },
    )
    expect(a!.cambios).toEqual([{ campo: 'Artículo', antes: null, despues: 'Ordenador Tiny M70Q' }])
  })

  it('un cambio que solo tocó lo automático no se enseña', () => {
    expect(describir(deUnidad({ old_data: antes, new_data: { ...antes, updated_at: '2026-10-27T09:00:00Z' } }))).toBeNull()
  })

  it('lo propio de las unidades no cambia cómo se leen los demás: «Instalado», «Baja», «Estado»', () => {
    // Un equipo instalado es «Instalado» y su campo, «Estado»; una gravedad baja,
    // «Baja». Solo la situación de una unidad cambia de nombre y de palabras.
    expect(diferencias('assets', { status: 'averiado' }, { status: 'instalado' })).toEqual([
      { campo: 'Estado', antes: 'Averiado', despues: 'Instalado' },
    ])
    expect(diferencias('incidents', { severity: 'media' }, { severity: 'baja' })).toEqual([
      { campo: 'Gravedad', antes: 'Media', despues: 'Baja' },
    ])
    expect(nombreDelCampo('status')).toBe('Estado')
    expect(nombreDelCampo('status', 'assets')).toBe('Estado')
    expect(nombreDelCampo('status', 'stock_units')).toBe('Situación')
    expect(nombreDelCampo('condicion')).toBe('Estado')
    expect(nombreDelCampo('articulo')).toBe('Artículo')
    expect(nombreDelCampo('installed_at')).toBe('Instalada el')
  })

  it('«disponible» se lee «En almacén», también suelto', () => {
    expect(valorLegible('disponible')).toBe('En almacén')
  })
})
