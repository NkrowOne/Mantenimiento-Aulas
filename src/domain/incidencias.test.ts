import { describe, expect, it } from 'vitest'
import {
  RESOLUCION_DUPLICADA,
  incidenciasDeRevision,
  resolucionPorCorreccion,
  tituloDeIncidencia,
} from './incidencias'
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

/** La corrección de la de arriba: misma visita, misma fecha, otra fila. */
const CORRECCION: Inspection = {
  ...REVISION,
  id: 'rev-2',
  corrects: 'rev-1',
  corrected_at: '2026-08-02T10:00:00.000Z',
}

const AHORA = '2026-08-02T10:00:00.000Z'

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

/** Una incidencia tal y como la deja la revisión de arriba. */
function deLaVisita(over: Partial<Incident> = {}): Incident {
  return incidencia({
    id: 'inc-de-rev-1',
    asset_id: 'equipo-proyector',
    check_key: PROYECTOR,
    opened_from_inspection_id: 'rev-1',
    opened_at: REVISION.occurred_at,
    title: 'Proyector: no da imagen',
    description: 'no da imagen',
    ...over,
  })
}

const ETIQUETAS: Record<string, string> = { [PROYECTOR]: 'Proyector', red: 'Red' }

function plan(entrada: {
  inspection?: Inspection
  checks: InspectionCheck[]
  abiertas?: Incident[]
  corrige?: string[]
}) {
  let n = 0
  return incidenciasDeRevision({
    inspection: entrada.inspection ?? REVISION,
    checks: entrada.checks,
    etiquetaDe: (k) => ETIQUETAS[k] ?? k,
    abiertas: entrada.abiertas ?? [],
    nuevoId: () => `nueva-${++n}`,
    corrige: entrada.corrige,
    ahora: AHORA,
  })
}

/** Lo que abre la revisión, que es lo que miraban las pruebas de siempre. */
function abrir(entrada: { checks: InspectionCheck[]; abiertas?: Incident[] }): Incident[] {
  return plan(entrada).nuevas
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

  it('una revisión normal no toca la incidencia que ya estaba', () => {
    const antes = deLaVisita()
    const resultado = plan({
      checks: [check({ result: 'ok' })],
      abiertas: [antes],
    })
    expect(resultado).toEqual({ nuevas: [], actualizadas: [], retiradas: [] })
  })
})

describe('incidenciasDeRevision · corrigiendo', () => {
  /*
   * El caso del enunciado, y el que más duele: se corrige la revisión, el
   * proyector sigue roto y la aplicación abre una SEGUNDA incidencia del mismo
   * aparato. Ni se duplica ni se ignora: manda la corrección sobre la fila que
   * ya estaba.
   */
  it('no abre una segunda incidencia cuando la corrección vuelve a marcar el mismo equipo', () => {
    const resultado = plan({
      inspection: CORRECCION,
      corrige: ['rev-1'],
      checks: [check({ result: 'incidencia', severity: 'alta', note: 'sigue sin dar imagen' })],
      abiertas: [deLaVisita({ severity: 'baja' })],
    })

    expect(resultado.nuevas).toEqual([])
    expect(resultado.retiradas).toEqual([])
    expect(resultado.actualizadas).toHaveLength(1)
    expect(resultado.actualizadas[0]).toMatchObject({
      id: 'inc-de-rev-1',
      severity: 'alta',
      title: 'Proyector: sigue sin dar imagen',
      description: 'sigue sin dar imagen',
      opened_from_inspection_id: 'rev-2',
      state: 'abierta',
    })
  })

  it('la corrección conserva la fecha, el autor y el ticket de la incidencia', () => {
    const [actualizada] = plan({
      inspection: CORRECCION,
      corrige: ['rev-1'],
      checks: [check({ result: 'incidencia', severity: 'alta' })],
      abiertas: [deLaVisita({ external_ref: 'I260730_0007', opened_by: 'tecnico-1' })],
    }).actualizadas

    expect(actualizada).toMatchObject({
      external_ref: 'I260730_0007',
      opened_at: REVISION.occurred_at,
      opened_by: 'tecnico-1',
    })
  })

  it('no reescribe nada si la corrección dice exactamente lo mismo', () => {
    const igual = deLaVisita({
      severity: 'media',
      title: 'Proyector: no da imagen',
      description: 'no da imagen',
      opened_from_inspection_id: 'rev-2',
    })
    const resultado = plan({
      inspection: CORRECCION,
      corrige: ['rev-1'],
      checks: [check({ result: 'incidencia', severity: 'media', note: 'no da imagen' })],
      abiertas: [igual],
    })
    expect(resultado.actualizadas).toEqual([])
  })

  it('retira la incidencia cuando la corrección dice que el equipo estaba bien', () => {
    const resultado = plan({
      inspection: CORRECCION,
      corrige: ['rev-1'],
      checks: [check({ result: 'ok' })],
      abiertas: [deLaVisita()],
    })

    expect(resultado.nuevas).toEqual([])
    expect(resultado.retiradas).toHaveLength(1)
    expect(resultado.retiradas[0]).toMatchObject({
      id: 'inc-de-rev-1',
      state: 'resuelta',
      resolved_at: AHORA,
      resolved_by: 'tecnico-1',
      resolution: resolucionPorCorreccion('ok'),
    })
  })

  it('y lo dice distinto cuando pasa a «no aplica»', () => {
    const [retirada] = plan({
      inspection: CORRECCION,
      corrige: ['rev-1'],
      checks: [check({ result: 'na' })],
      abiertas: [deLaVisita()],
    }).retiradas
    expect(retirada?.resolution).toBe(resolucionPorCorreccion('na'))
  })

  /*
   * La frontera: una avería que apuntó otra persona a mano desde la ficha no es
   * de esta visita, y corregir la revisión no puede cerrarle el parte a nadie.
   */
  it('no toca lo que se abrió a mano ni lo que abrió otra visita', () => {
    const aMano = incidencia({ id: 'inc-mano', asset_id: 'equipo-proyector', check_key: null })
    const deOtroDia = deLaVisita({
      id: 'inc-otro-dia',
      opened_from_inspection_id: 'rev-vieja',
      opened_at: '2026-05-05T08:00:00.000Z',
    })

    const resultado = plan({
      inspection: CORRECCION,
      corrige: ['rev-1'],
      checks: [check({ result: 'ok' })],
      abiertas: [aMano, deOtroDia],
    })
    expect(resultado.retiradas).toEqual([])
    expect(resultado.actualizadas).toEqual([])
  })

  /*
   * El dispositivo solo conoce un eslabón hacia atrás. La fecha de la visita
   * —que la corrección conserva— es lo que hace que corregir la corrección siga
   * reconociendo lo que abrió la visita original.
   */
  it('reconoce la incidencia de la visita aunque la cadena venga incompleta', () => {
    const resultado = plan({
      inspection: { ...CORRECCION, id: 'rev-3', corrects: 'rev-2' },
      corrige: ['rev-2'],
      checks: [check({ result: 'ok' })],
      abiertas: [deLaVisita()],
    })
    expect(resultado.retiradas.map((i) => i.id)).toEqual(['inc-de-rev-1'])
  })

  /*
   * La fecha nace en el dispositivo como `…T08:15:00.000Z` y vuelve del servidor
   * como `…T08:15:00+00:00`. Comparando el texto, esa red dejaría de funcionar
   * en cuanto la incidencia diera una vuelta por la red — o sea, siempre.
   */
  it('la fecha de la visita se compara por instante, no por cadena', () => {
    const resultado = plan({
      inspection: { ...CORRECCION, id: 'rev-3', corrects: 'rev-2' },
      corrige: ['rev-2'],
      checks: [check({ result: 'ok' })],
      abiertas: [deLaVisita({ opened_at: '2026-07-30T10:15:00+02:00' })],
    })
    expect(resultado.retiradas.map((i) => i.id)).toEqual(['inc-de-rev-1'])
  })

  it('retira la copia y conserva la más antigua cuando ya había dos del mismo equipo', () => {
    const vieja = deLaVisita({ id: 'inc-a', external_ref: 'I260730_0007' })
    const copia = deLaVisita({ id: 'inc-b', opened_at: '2026-07-30T09:00:00.000Z' })

    const resultado = plan({
      inspection: CORRECCION,
      corrige: ['rev-1'],
      checks: [check({ result: 'incidencia', severity: 'alta' })],
      abiertas: [copia, vieja],
    })

    expect(resultado.nuevas).toEqual([])
    expect(resultado.retiradas.map((i) => i.id)).toEqual(['inc-b'])
    expect(resultado.retiradas[0]?.resolution).toBe(RESOLUCION_DUPLICADA)
    // Y la que sobrevive es la que recibe lo que dice la corrección.
    expect(resultado.actualizadas.map((i) => i.id)).toEqual(['inc-a'])
    expect(resultado.actualizadas[0]).toMatchObject({ severity: 'alta', external_ref: 'I260730_0007' })
  })

  it('abre la incidencia que la revisión original no abrió', () => {
    const resultado = plan({
      inspection: CORRECCION,
      corrige: ['rev-1'],
      checks: [check({ result: 'incidencia', note: 'esto sí fallaba' })],
      abiertas: [],
    })
    expect(resultado.nuevas).toHaveLength(1)
    expect(resultado.nuevas[0]).toMatchObject({
      opened_from_inspection_id: 'rev-2',
      // Sigue siendo la fecha de la visita, no la del día en que se corrigió.
      opened_at: REVISION.occurred_at,
    })
  })

  it('sabe que es una corrección aunque no le pasen la cadena', () => {
    const resultado = plan({
      inspection: CORRECCION,
      checks: [check({ result: 'ok' })],
      abiertas: [deLaVisita()],
    })
    expect(resultado.retiradas).toHaveLength(1)
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
