import { describe, expect, it } from 'vitest'
import { incidenciasDeRevision, tituloDeIncidencia } from './incidencias'
import { assetCheckKey, type Incident, type Inspection, type InspectionCheck } from './types'

const REVISION: Inspection = {
  id: 'rev-1',
  room_id: 'sala-1',
  by_user: 'tecnico-1',
  occurred_at: '2026-07-30T08:15:00.000Z',
  recorded_at: null,
  status: 'completa',
  overall: 'con_incidencias',
  notes: null,
  corrects: null,
  corrected_at: null,
}

const PROYECTOR = assetCheckKey('equipo-proyector')

function check(over: Partial<InspectionCheck>): InspectionCheck {
  return {
    id: 'chk-1',
    inspection_id: 'rev-1',
    check_key: PROYECTOR,
    result: 'ok',
    severity: null,
    measure: null,
    measure_unit: null,
    note: null,
    ...over,
  }
}

function incidencia(over: Partial<Incident>): Incident {
  return {
    id: 'inc-vieja',
    room_id: 'sala-1',
    asset_id: null,
    opened_from_inspection_id: null,
    check_key: null,
    external_ref: null,
    title: 'algo',
    description: null,
    severity: 'media',
    state: 'abierta',
    kind: 'incidencia',
    opened_at: '2026-07-01T09:00:00.000Z',
    opened_by: null,
    resolved_at: null,
    resolved_by: null,
    resolution: null,
    source: 'app',
    ...over,
  }
}

const ETIQUETAS: Record<string, string> = { [PROYECTOR]: 'Proyector', red: 'Red' }

function abrir(entrada: {
  checks: InspectionCheck[]
  abiertas?: Incident[]
}): Incident[] {
  let n = 0
  return incidenciasDeRevision({
    inspection: REVISION,
    checks: entrada.checks,
    etiquetaDe: (k) => ETIQUETAS[k] ?? k,
    abiertas: entrada.abiertas ?? [],
    nuevoId: () => `nueva-${++n}`,
  })
}

describe('incidenciasDeRevision', () => {
  it('no abre nada cuando la revisión sale limpia', () => {
    expect(
      abrir({ checks: [check({ result: 'ok' }), check({ check_key: 'red', result: 'na' })] }),
    ).toEqual([])
  })

  it('abre una incidencia por equipo que falla, apuntando al aparato', () => {
    const [inc] = abrir({
      checks: [check({ result: 'incidencia', severity: 'alta', note: '  No da imagen  ' })],
    })

    expect(inc).toMatchObject({
      room_id: 'sala-1',
      asset_id: 'equipo-proyector',
      check_key: PROYECTOR,
      opened_from_inspection_id: 'rev-1',
      kind: 'incidencia',
      state: 'abierta',
      severity: 'alta',
      title: 'Proyector: No da imagen',
      description: 'No da imagen',
      opened_by: 'tecnico-1',
    })
  })

  it('fecha la incidencia cuando se vio el fallo, no cuando sube', () => {
    const [inc] = abrir({ checks: [check({ result: 'incidencia' })] })
    expect(inc?.opened_at).toBe(REVISION.occurred_at)
  })

  it('también abre incidencia para lo que no es un aparato', () => {
    const [inc] = abrir({ checks: [check({ check_key: 'red', result: 'incidencia' })] })
    expect(inc).toMatchObject({ asset_id: null, check_key: 'red', title: 'Red: fallo detectado en la revisión' })
  })

  /*
   * El caso que justifica todo el fichero: el proyector sigue roto la ronda
   * siguiente. Sin esto, cada revisión añadiría una copia y la sala acabaría con
   * cinco incidencias del mismo aparato.
   */
  it('no duplica cuando esa misma comprobación ya tiene una abierta', () => {
    expect(
      abrir({
        checks: [check({ result: 'incidencia' })],
        abiertas: [incidencia({ check_key: PROYECTOR })],
      }),
    ).toEqual([])
  })

  it('no duplica cuando el equipo ya tiene una abierta sin clave de comprobación', () => {
    expect(
      abrir({
        checks: [check({ result: 'incidencia' })],
        abiertas: [incidencia({ asset_id: 'equipo-proyector', check_key: null })],
      }),
    ).toEqual([])
  })

  it('vuelve a abrir cuando la anterior se resolvió', () => {
    const nuevas = abrir({
      checks: [check({ result: 'incidencia' })],
      abiertas: [
        incidencia({ check_key: PROYECTOR, state: 'resuelta', resolved_at: '2026-07-20T10:00:00.000Z' }),
      ],
    })
    expect(nuevas).toHaveLength(1)
  })

  /*
   * Un dispositivo que espejó incidencias antes de que existiera la columna trae
   * las filas sin `check_key`. No pueden bloquear nada por parecerse a una clave
   * vacía: el aparato sigue roto y la incidencia tiene que abrirse.
   */
  it('una incidencia vieja sin clave de comprobación ni equipo no bloquea nada', () => {
    const vieja = incidencia({})
    delete (vieja as Partial<Incident>).check_key
    expect(abrir({ checks: [check({ result: 'incidencia' })], abiertas: [vieja] })).toHaveLength(1)
  })

  it('una incidencia abierta de OTRO equipo no bloquea la de este', () => {
    const nuevas = abrir({
      checks: [check({ result: 'incidencia' })],
      abiertas: [incidencia({ asset_id: 'equipo-pantalla', check_key: assetCheckKey('equipo-pantalla') })],
    })
    expect(nuevas).toHaveLength(1)
  })

  it('abre una por cada fila que falla, con id propio', () => {
    const nuevas = abrir({
      checks: [
        check({ id: 'chk-1', result: 'incidencia' }),
        check({ id: 'chk-2', check_key: 'red', result: 'incidencia' }),
      ],
    })
    expect(nuevas.map((i) => i.id)).toEqual(['nueva-1', 'nueva-2'])
  })
})

describe('tituloDeIncidencia', () => {
  it('pone el equipo delante para que la lista se lea sin abrir la fila', () => {
    expect(tituloDeIncidencia('Pantalla 2', 'parpadea')).toBe('Pantalla 2: parpadea')
  })

  it('dice de dónde salió cuando no hay nota', () => {
    expect(tituloDeIncidencia('Proyector', null)).toBe('Proyector: fallo detectado en la revisión')
    expect(tituloDeIncidencia('Proyector', '   ')).toBe('Proyector: fallo detectado en la revisión')
  })

  it('se queda con la primera línea: el resto ya va en la descripción', () => {
    expect(tituloDeIncidencia('Botonera', 'no responde\ny huele a quemado')).toBe(
      'Botonera: no responde',
    )
  })

  it('recorta lo muy largo en vez de romper la lista', () => {
    const titulo = tituloDeIncidencia('Red', 'x'.repeat(300))
    expect(titulo.startsWith('Red: ')).toBe(true)
    expect(titulo.endsWith('…')).toBe(true)
    expect(titulo.length).toBeLessThanOrEqual('Red: '.length + 100)
  })
})
