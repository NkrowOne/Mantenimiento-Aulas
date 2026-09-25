import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/dexie'
import type { Incident, Inspection } from '@/domain/types'
import type { Duda } from '@/domain/dudas'
import { cambiosDesde, dejarComoEsta, fraseDeCambios, nombreDelLibro } from './libroDeHoy'

describe('el nombre del libro que sale', () => {
  it('lleva el día, y una sola vez', () => {
    expect(nombreDelLibro('Material Aulas.xlsx', 'sincronizado 2026-09-25')).toBe(
      'Material Aulas (sincronizado 2026-09-25).xlsx',
    )
  })

  it('quita el sufijo de la pasada anterior en vez de colgarle otro', () => {
    expect(nombreDelLibro('Material Aulas (sincronizado).xlsx', 'sincronizado 2026-09-25')).toBe(
      'Material Aulas (sincronizado 2026-09-25).xlsx',
    )
    expect(nombreDelLibro('Material Aulas (sincronizado 2026-09-22).xlsx', 'sincronizado 2026-09-25')).toBe(
      'Material Aulas (sincronizado 2026-09-25).xlsx',
    )
    expect(nombreDelLibro('Material Aulas (vista previa).xlsx', 'vista previa')).toBe(
      'Material Aulas (vista previa).xlsx',
    )
  })

  it('y también como lo devuelve SharePoint, con guiones bajos y repetido', () => {
    expect(
      nombreDelLibro(
        'Material_Aulas_-_Salas_de_reuniones_sincronizado_sincronizado.xlsx',
        'sincronizado 2026-09-25',
      ),
    ).toBe('Material_Aulas_-_Salas_de_reuniones (sincronizado 2026-09-25).xlsx')
    expect(nombreDelLibro('Libro_sincronizado_2026-09-22.xlsx', 'sincronizado 2026-09-25')).toBe(
      'Libro (sincronizado 2026-09-25).xlsx',
    )
  })

  it('un nombre que era solo sufijo no se queda en nada', () => {
    expect(nombreDelLibro('(sincronizado).xlsx', 'sincronizado 2026-09-25')).toBe(
      'Libro (sincronizado 2026-09-25).xlsx',
    )
  })
})

describe('dejar como está lo que la pasada pregunta', () => {
  const dudas: Duda[] = [
    { tipo: 'alta', id: 'Estado!92!Panacast 50', hoja: 'Estado', fila: 92, que: 'equipo', texto: 'x', detalle: 'y' },
    { tipo: 'sala', id: 'Material!44', hoja: 'Material', fila: 44, que: 'parte', texto: 'x', motivo: 'y', candidatas: [] },
  ]

  it('un alta se contesta que no, y una sala se ignora', () => {
    const r = dejarComoEsta(dudas, {})
    expect(r['Estado!92!Panacast 50']).toEqual({ tipo: 'alta', aceptar: false })
    expect(r['Material!44']).toEqual({ tipo: 'ignorar' })
  })

  it('lo que ya estaba contestado no se pisa', () => {
    const r = dejarComoEsta(dudas, { 'Material!44': { tipo: 'sala', salaId: 's1' } })
    expect(r['Material!44']).toEqual({ tipo: 'sala', salaId: 's1' })
    expect(r['Estado!92!Panacast 50']).toEqual({ tipo: 'alta', aceptar: false })
  })
})

describe('cuánto ha cambiado la aplicación desde la última vez', () => {
  const CUANDO = '2026-09-22T15:10:00.000Z'

  const revision = (id: string, occurred_at: string, status: Inspection['status'] = 'completa'): Inspection =>
    ({ id, room_id: 'r1', by_user: null, occurred_at, recorded_at: null, status, overall: 'ok', notes: null }) as Inspection
  const parte = (id: string, opened_at: string, resolved_at: string | null = null): Incident =>
    ({ id, room_id: 'r1', opened_at, resolved_at, state: resolved_at ? 'resuelta' : 'abierta', kind: 'incidencia' }) as Incident

  beforeEach(async () => {
    await db.inspections.clear()
    await db.incidents.clear()
  })

  it('con el espejo vacío no se sabe, y se dice', async () => {
    const c = await cambiosDesde(CUANDO)
    expect(c.conocido).toBe(false)
    expect(fraseDeCambios(c).viejo).toBe(true)
    expect(fraseDeCambios(c).texto).toMatch(/no se sabe/)
  })

  it('cuenta las revisiones completas y los partes abiertos o resueltos después', async () => {
    await db.inspections.bulkPut([
      revision('a', '2026-09-20T10:00:00.000Z'),
      revision('b', '2026-09-23T10:00:00.000Z'),
      revision('c', '2026-09-24T10:00:00.000Z', 'borrador'),
    ])
    await db.incidents.bulkPut([
      parte('p1', '2026-09-10T10:00:00.000Z'),
      parte('p2', '2026-09-23T10:00:00.000Z'),
      parte('p3', '2026-09-10T10:00:00.000Z', '2026-09-24T10:00:00.000Z'),
    ])
    const c = await cambiosDesde(CUANDO)
    expect(c).toEqual({ revisiones: 1, incidencias: 2, conocido: true })
    const f = fraseDeCambios(c)
    expect(f.viejo).toBe(true)
    expect(f.texto).toBe('Desde entonces la aplicación tiene 1 revisión y 2 partes más: este libro se ha quedado viejo.')
  })

  it('si no hay nada nuevo, el libro guardado sigue valiendo', async () => {
    await db.inspections.bulkPut([revision('a', '2026-09-20T10:00:00.000Z')])
    const c = await cambiosDesde(CUANDO)
    expect(c).toEqual({ revisiones: 0, incidencias: 0, conocido: true })
    expect(fraseDeCambios(c).viejo).toBe(false)
  })
})
