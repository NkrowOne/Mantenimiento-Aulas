import { describe, expect, it } from 'vitest'
import { describir, diferencias, resumen, valorLegible, type FilaDeAuditoria, type Nombres } from './actividad'

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
