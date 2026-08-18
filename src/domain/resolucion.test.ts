import { describe, expect, it } from 'vitest'
import {
  cierreDeIncidencia,
  equipoDeIncidencia,
  EXPLICACION_MINIMA,
  incidenciaCerrada,
  problemaDeExplicacion,
  sePuedeResolver,
} from './resolucion'
import type { Incident } from './types'

function incidencia(over: Partial<Incident> = {}): Incident {
  return {
    id: 'inc-1',
    room_id: 'sala-1',
    asset_id: null,
    opened_from_inspection_id: null,
    check_key: null,
    external_ref: null,
    title: 'Proyector: no da imagen',
    description: 'No da imagen',
    severity: 'alta',
    state: 'abierta',
    kind: 'incidencia',
    opened_at: '2026-08-01T09:00:00.000Z',
    opened_by: 'tecnico-1',
    resolved_at: null,
    resolved_by: null,
    resolution: null,
    source: 'app',
    ...over,
  }
}

describe('sePuedeResolver', () => {
  it('lo abierto y lo empezado sí; lo ya resuelto no', () => {
    expect(sePuedeResolver({ state: 'abierta', kind: 'incidencia' })).toBe(true)
    expect(sePuedeResolver({ state: 'en_curso', kind: 'incidencia' })).toBe(true)
    expect(sePuedeResolver({ state: 'resuelta', kind: 'incidencia' })).toBe(false)
  })

  // Un borrador es una nota a medio escribir: cerrarlo dejaría una fila resuelta
  // sin título, que es lo que la restricción de la base impide.
  it('un borrador no se resuelve: todavía no es trabajo de nadie', () => {
    expect(sePuedeResolver({ state: 'borrador', kind: 'incidencia' })).toBe(false)
  })

  it('una solicitud sí se cierra; una observación no tiene final que firmar', () => {
    expect(sePuedeResolver({ state: 'abierta', kind: 'solicitud' })).toBe(true)
    expect(sePuedeResolver({ state: 'abierta', kind: 'observacion' })).toBe(false)
  })
})

describe('problemaDeExplicacion', () => {
  it('sin nada escrito, lo dice', () => {
    expect(problemaDeExplicacion('')).toMatch(/qué se ha hecho/)
    expect(problemaDeExplicacion('   \n ')).toMatch(/qué se ha hecho/)
  })

  // El listón está donde separa «ok» de una frase. Ni más arriba: quien acaba de
  // arreglar algo de pie en un aula no tiene que redactar.
  it('«Arreglado» no basta y «Cable nuevo» sí', () => {
    expect(problemaDeExplicacion('Arreglado')).not.toBeNull()
    expect(problemaDeExplicacion('Cable nuevo')).toBeNull()
    expect('Cable nuevo'.length).toBeGreaterThanOrEqual(EXPLICACION_MINIMA)
  })

  it('los espacios no cuentan como explicación', () => {
    expect(problemaDeExplicacion('   ok      ')).not.toBeNull()
  })
})

describe('cierreDeIncidencia', () => {
  const base = {
    incidenciaId: 'inc-1',
    explicacion: '  Lámpara nueva y filtro limpiado  ',
    autor: 'tecnico-1',
    ahora: '2026-08-18T10:30:00.000Z',
    nuevoId: () => 'cierre-1',
  }

  it('devuelve el asiento, con la explicación limpia y firmada', () => {
    expect(cierreDeIncidencia(base)).toEqual({
      id: 'cierre-1',
      incident_id: 'inc-1',
      resolution: 'Lámpara nueva y filtro limpiado',
      resolved_at: '2026-08-18T10:30:00.000Z',
      resolved_by: 'tecnico-1',
    })
  })

  it('se niega a cerrar sin explicación, con el mismo mensaje que se pinta', () => {
    expect(() => cierreDeIncidencia({ ...base, explicacion: 'ok' })).toThrow(/Cuenta un poco más/)
    expect(() => cierreDeIncidencia({ ...base, explicacion: '   ' })).toThrow(/qué se ha hecho/)
  })

  // Sin sesión resuelta no hay quien firme. La fila se construye igual —quien
  // decide si eso puede subir es la pantalla—, pero el autor no se inventa.
  it('sin autor, el cierre va sin firmar y no se inventa uno', () => {
    expect(cierreDeIncidencia({ ...base, autor: null }).resolved_by).toBeNull()
  })
})

describe('incidenciaCerrada', () => {
  const cierre = cierreDeIncidencia({
    incidenciaId: 'inc-1',
    explicacion: 'Lámpara nueva y filtro limpiado',
    autor: 'tecnico-1',
    ahora: '2026-08-18T10:30:00.000Z',
    nuevoId: () => 'cierre-1',
  })

  // El espejo tiene que quedar EXACTAMENTE como quedará arriba: lo que la
  // persona ve al pulsar es esto, y no puede cambiar al sincronizar.
  it('deja la incidencia resuelta diciendo lo mismo que el asiento', () => {
    const cerrada = incidenciaCerrada(incidencia(), cierre)

    expect(cerrada.state).toBe('resuelta')
    expect(cerrada.resolution).toBe('Lámpara nueva y filtro limpiado')
    expect(cerrada.resolved_at).toBe(cierre.resolved_at)
    expect(cerrada.resolved_by).toBe(cierre.resolved_by)
  })

  it('no toca nada más de la incidencia', () => {
    const original = incidencia({ external_ref: 'I260728_0001' })
    const cerrada = incidenciaCerrada(original, cierre)

    expect(cerrada.id).toBe(original.id)
    expect(cerrada.title).toBe(original.title)
    expect(cerrada.opened_at).toBe(original.opened_at)
    expect(cerrada.opened_by).toBe(original.opened_by)
    expect(cerrada.external_ref).toBe('I260728_0001')
  })
})

describe('equipoDeIncidencia', () => {
  const nombres = new Map([['equipo-1', 'Pantalla 2']])
  const nombreDeEquipo = (id: string): string | null => nombres.get(id) ?? null

  it('el equipo al que apunta manda', () => {
    expect(
      equipoDeIncidencia({ asset_id: 'equipo-1', check_key: 'asset:equipo-1' }, nombreDeEquipo),
    ).toBe('Pantalla 2')
  })

  it('sin equipo, la comprobación de sala se lee con palabras', () => {
    expect(equipoDeIncidencia({ asset_id: null, check_key: 'red' }, nombreDeEquipo)).toBe('Red')
  })

  // Las revisiones de antes del inventario guardaron `pantallas`, `sonido`… y
  // sin esto el histórico las enseñaría como claves.
  it('las casillas viejas conservan su nombre', () => {
    expect(equipoDeIncidencia({ asset_id: null, check_key: 'botonera' }, nombreDeEquipo)).toBe(
      'Botonera',
    )
  })

  it('un equipo que este dispositivo no tiene no se enseña como uuid', () => {
    expect(
      equipoDeIncidencia({ asset_id: 'equipo-9', check_key: 'asset:equipo-9' }, nombreDeEquipo),
    ).toBeNull()
  })

  it('lo importado del Excel no tiene de dónde sacarlo', () => {
    expect(equipoDeIncidencia({ asset_id: null, check_key: null }, nombreDeEquipo)).toBeNull()
  })
})
