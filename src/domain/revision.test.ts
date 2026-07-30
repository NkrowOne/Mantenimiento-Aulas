import { describe, expect, it } from 'vitest'
import {
  RESULTADO,
  SEVERIDAD_ETIQUETA,
  agruparEnVisitas,
  checksDeSemilla,
  detalleDeComprobacion,
  etiquetaDeCheck,
  etiquetaDeComprobacion,
  ordenDeResultado,
  ordenarComprobaciones,
  resultadoLegible,
  retrasoDeSubida,
  semillaDeCorreccion,
  textoDeFallos,
  tituloDeResultado,
  type RevisionCheckRow,
  type RevisionRow,
} from './revision'
import { assetCheckKey } from './types'

describe('cómo se nombra una comprobación', () => {
  it('usa el nombre del aparato que resuelve el servidor', () => {
    expect(etiquetaDeCheck('asset:1f2e3d4c-1111-4111-8111-111111111111', 'Pantalla 2')).toBe(
      'Pantalla 2',
    )
  })

  it('nombra en el cliente lo que no es un aparato', () => {
    expect(etiquetaDeCheck('red', null)).toBe('Red')
  })

  /*
   * La razón de que los nombres antiguos sigan en el vocabulario: hay revisiones
   * guardadas antes del inventario, y sin esto su ficha diría `pantallas`.
   */
  it('sigue leyendo las comprobaciones de antes del inventario', () => {
    expect(etiquetaDeCheck('pantallas', null)).toBe('Pantallas')
    expect(etiquetaDeCheck('botonera', null)).toBe('Botonera')
  })

  it('no escupe el uuid de un equipo que ya no está en el catálogo', () => {
    expect(etiquetaDeCheck('asset:1f2e3d4c-1111-4111-8111-111111111111', null)).toBe(
      'Equipo no identificado',
    )
  })

  it('y como última red devuelve la clave, que es mejor que nada', () => {
    expect(etiquetaDeCheck('algo_que_nadie_recuerda', null)).toBe('algo_que_nadie_recuerda')
  })
})

describe('qué falló, en una línea', () => {
  it('no dice nada cuando no falló nada', () => {
    expect(textoDeFallos([])).toBeNull()
  })

  it('junta los nombres cuando caben', () => {
    expect(
      textoDeFallos([
        { key: 'asset:1f2e3d4c-1111-4111-8111-111111111111', label: 'Proyector' },
        { key: 'red', label: null },
      ]),
    ).toBe('Proyector · Red')
  })

  it('corta y cuenta el resto en vez de partir la fila en cuatro líneas', () => {
    expect(
      textoDeFallos([
        { key: 'a', label: 'Proyector' },
        { key: 'b', label: 'Pantalla 2' },
        { key: 'c', label: 'Micrófono Jabra' },
        { key: 'd', label: 'Botonera' },
      ]),
    ).toBe('Proyector · Pantalla 2 y 2 más')
  })
})

describe('el orden de lectura de una ficha', () => {
  it('pone lo que falló primero y lo que no aplica al final', () => {
    const orden = (['na', 'ok', 'incidencia'] as const)
      .slice()
      .sort((a, b) => ordenDeResultado(a) - ordenDeResultado(b))
    expect(orden).toEqual(['incidencia', 'ok', 'na'])
  })
})

describe('el desfase entre el aula y el servidor', () => {
  it('se calla en el camino normal: se cierra y sube en segundos', () => {
    expect(
      retrasoDeSubida('2026-07-30T10:00:00.000Z', '2026-07-30T10:00:04.000Z'),
    ).toBeNull()
  })

  it('no dice nada de una revisión que todavía no ha llegado', () => {
    expect(retrasoDeSubida('2026-07-30T10:00:00.000Z', null)).toBeNull()
  })

  it('cuenta las horas cuando el aula no tenía cobertura', () => {
    expect(retrasoDeSubida('2026-07-30T08:00:00.000Z', '2026-07-30T13:00:00.000Z')).toBe(
      'Se hizo sin cobertura: subió 5 h después',
    )
  })

  it('y los días cuando el iPad pasó la noche fuera de línea', () => {
    expect(retrasoDeSubida('2026-07-28T08:00:00.000Z', '2026-07-30T08:00:00.000Z')).toBe(
      'Se hizo sin cobertura: subió 2 días después',
    )
  })

  it('un día en singular', () => {
    expect(retrasoDeSubida('2026-07-29T08:00:00.000Z', '2026-07-30T08:00:00.000Z')).toBe(
      'Se hizo sin cobertura: subió 1 día después',
    )
  })
})

describe('el resultado global', () => {
  it('un borrador no es una revisión sin incidencias: es una a medias', () => {
    expect(tituloDeResultado('borrador', null).etiqueta).toBe('Sin cerrar')
    // Y tampoco se pinta en verde, que se leería como «va bien».
    expect(tituloDeResultado('borrador', null).clase).toContain('warn')
  })

  it('distingue la que salió limpia de la que no', () => {
    expect(tituloDeResultado('completa', 'ok').etiqueta).toBe('Sin incidencias')
    expect(tituloDeResultado('completa', 'con_incidencias').etiqueta).toBe('Con incidencias')
  })
})

describe('el vocabulario compartido', () => {
  it('las gravedades se leen con las palabras del aula', () => {
    expect(SEVERIDAD_ETIQUETA.alta).toBe('Impide la clase')
    expect(SEVERIDAD_ETIQUETA.baja).toBe('Leve')
  })

  /* Quien marcó «Falla» en el aula tiene que encontrar «Falla» al leerlo. */
  it('los resultados se llaman igual al escribir y al leer', () => {
    expect(RESULTADO.incidencia.etiqueta).toBe('Falla')
    expect(RESULTADO.ok.etiqueta).toBe('Correcto')
    expect(RESULTADO.na.etiqueta).toBe('No aplica')
  })
})

// -----------------------------------------------------------------------------
// Y la otra mitad: leer una revisión pasada y corregirla sin repetirla.
// -----------------------------------------------------------------------------

const revision = (p: Partial<RevisionRow> & { id: string }): RevisionRow => ({
  room_id: 'sala',
  occurred_at: '2026-03-10T09:00:00Z',
  recorded_at: '2026-03-10T09:05:00Z',
  overall: 'ok',
  notes: null,
  by_user: 'u1',
  who: 'Ana',
  corrects: null,
  corrected_at: null,
  corrige_occurred_at: null,
  corregida_por: null,
  corregida_at: null,
  corregida_por_quien: null,
  vigente: true,
  total: 3,
  ok: 3,
  fallos: 0,
  na: 0,
  fotos: 0,
  incidencias: 0,
  sin_resolver: 0,
  fallos_detalle: [],
  status: 'completa',
  source: 'app',
  room_code: '1.7',
  room_name: 'Aula 1.7',
  zone_name: '1ª Planta',
  building_code: 'H',
  building_name: 'Edificio H',
  short_ref: 'SALA-000001',
  zone_id: 'z1',
  building_id: 'b1',
  ...p,
})

const comprobacion = (
  p: Partial<RevisionCheckRow> & { check_key: string },
): RevisionCheckRow => ({
  check_id: `c-${p.check_key}`,
  id: `c-${p.check_key}`,
  inspection_id: 'i1',
  asset_id: null,
  asset_label: null,
  asset_type: null,
  type_name: null,
  model: null,
  serial: null,
  asset_status: null,
  result: 'ok',
  severity: null,
  measure: null,
  measure_unit: null,
  note: null,
  incident_id: null,
  incident_title: null,
  incident_state: null,
  incident_ref: null,
  incident_resolved_at: null,
  incident_resolution: null,
  fallos_previos: 0,
  fallo_previo_at: null,
  ...p,
})

describe('una visita corregida sigue siendo una visita', () => {
  it('agrupa la cadena de correcciones en una sola visita', () => {
    // Es el punto de todo: tres versiones no son tres revisiones del aula.
    const original = revision({ id: 'a', vigente: false, corregida_por: 'b' })
    const correccion = revision({
      id: 'b',
      corrects: 'a',
      corrected_at: '2026-03-12T08:00:00Z',
      vigente: false,
      corregida_por: 'c',
    })
    const ultima = revision({ id: 'c', corrects: 'b', corrected_at: '2026-03-13T08:00:00Z' })

    const visitas = agruparEnVisitas([ultima, correccion, original])

    expect(visitas).toHaveLength(1)
    expect(visitas[0]!.vigente.id).toBe('c')
    expect(visitas[0]!.versiones.map((v) => v.id)).toEqual(['a', 'b', 'c'])
  })

  it('ordena las visitas por la fecha de la visita, no de la corrección', () => {
    // Corregir en junio una revisión de marzo no la convierte en la más reciente.
    const marzo = revision({ id: 'a', occurred_at: '2026-03-01T09:00:00Z', vigente: false })
    const correccionDeMarzo = revision({
      id: 'b',
      corrects: 'a',
      occurred_at: '2026-03-01T09:00:00Z',
      corrected_at: '2026-06-01T09:00:00Z',
    })
    const abril = revision({ id: 'c', occurred_at: '2026-04-01T09:00:00Z' })

    const visitas = agruparEnVisitas([correccionDeMarzo, abril, marzo])

    expect(visitas.map((v) => v.vigente.id)).toEqual(['c', 'b'])
  })

  it('no pierde una visita cuya original se quedó fuera de la consulta', () => {
    // La ficha pide las últimas N: la corrección puede llegar sin su original.
    const huerfana = revision({ id: 'b', corrects: 'no-descargada' })

    const visitas = agruparEnVisitas([huerfana])

    expect(visitas).toHaveLength(1)
    expect(visitas[0]!.versiones.map((v) => v.id)).toEqual(['b'])
  })

  it('dos correcciones de la misma revisión siguen siendo una visita', () => {
    // Dos personas corrigiendo lo mismo sin cobertura. Dos tarjetas con la misma
    // fecha y resultados distintos serían la peor forma de contarlo.
    const original = revision({ id: 'a', vigente: false })
    const unaCorreccion = revision({
      id: 'b',
      corrects: 'a',
      corrected_at: '2026-03-12T08:00:00Z',
    })
    const laOtra = revision({
      id: 'c',
      corrects: 'a',
      corrected_at: '2026-03-12T18:00:00Z',
      fallos: 2,
      overall: 'con_incidencias',
    })

    const visitas = agruparEnVisitas([laOtra, unaCorreccion, original])

    expect(visitas).toHaveLength(1)
    // Manda la última, y la otra se queda dentro: es información.
    expect(visitas[0]!.vigente.id).toBe('c')
    expect(visitas[0]!.versiones.map((v) => v.id)).toEqual(['a', 'b', 'c'])
  })

  it('sobrevive a un ciclo imposible sin colgarse', () => {
    const a = revision({ id: 'a', corrects: 'b' })
    const b = revision({ id: 'b', corrects: 'a' })

    // Con las dos apuntándose, ninguna es cabeza: lo que no puede pasar es que
    // la pantalla se quede girando.
    expect(agruparEnVisitas([a, b])).toEqual([])
  })

  it('cuenta los fallos en vez de decir solo «con incidencias»', () => {
    expect(resultadoLegible(revision({ id: 'a', overall: 'con_incidencias', fallos: 3 }))).toBe(
      '3 fallos',
    )
    expect(resultadoLegible(revision({ id: 'a', overall: 'con_incidencias', fallos: 1 }))).toBe(
      '1 fallo',
    )
    expect(resultadoLegible(revision({ id: 'a' }))).toBe('Sin incidencias')
  })

  it('no se calla que hubo incidencias aunque no haya podido contarlas', () => {
    // Una revisión importada del Excel no trae comprobaciones fila a fila.
    expect(
      resultadoLegible(revision({ id: 'a', overall: 'con_incidencias', fallos: 0 })),
    ).toBe('Con incidencias')
  })
})

describe('cómo se lee una revisión pasada', () => {
  it('nombra el aparato con lo que resolvió el servidor', () => {
    expect(
      etiquetaDeComprobacion(
        comprobacion({ check_key: 'asset:1', asset_label: 'Pantalla 2', asset_type: 'Pantalla' }),
      ),
    ).toBe('Pantalla 2')

    // Sin etiqueta propia, el tipo. Es lo que enseña también el formulario.
    expect(
      etiquetaDeComprobacion(comprobacion({ check_key: 'asset:1', asset_type: 'Proyector' })),
    ).toBe('Proyector')
  })

  it('traduce el vocabulario fijo y el de antes del inventario', () => {
    expect(etiquetaDeComprobacion(comprobacion({ check_key: 'red' }))).toBe('Red')
    // Sin esto, una revisión de 2025 se leería como `pantallas`.
    expect(etiquetaDeComprobacion(comprobacion({ check_key: 'pantallas' }))).toBe('Pantallas')
  })

  /*
   * El único punto en el que las dos mitades de esto no decían lo mismo, y aquí
   * queda decidido: un aparato que el servidor no ha podido nombrar se lee
   * «Equipo no identificado», no `asset:018f…`.
   *
   * Las dos versiones querían lo mismo —que la fila no se quede sin nombre— y la
   * diferencia es a quién se le está hablando: el uuid es una pista para quien
   * depura y ruido para quien está de pie en el aula, que es quien lee esto. La
   * clave sigue en la fila para lo primero.
   *
   * Y solo pasa con las claves de aparato: una clave que no sea de ninguno
   * —importada, antigua— sí se enseña tal cual, porque ahí el texto es el nombre.
   */
  it('nombra el equipo que no se ha podido resolver, en vez de enseñar su uuid', () => {
    expect(etiquetaDeComprobacion(comprobacion({ check_key: 'asset:018f' }))).toBe(
      'Equipo no identificado',
    )
    expect(etiquetaDeComprobacion(comprobacion({ check_key: 'lo_que_fuera' }))).toBe('lo_que_fuera')
  })

  it('avisa de que el equipo ya no está en la sala', () => {
    expect(
      detalleDeComprobacion(
        comprobacion({ check_key: 'asset:1', serial: 'SN9', asset_status: 'retirado' }),
      ),
    ).toBe('SN9 · retirado desde entonces')

    expect(detalleDeComprobacion(comprobacion({ check_key: 'red' }))).toBeNull()
  })

  it('ordena como el recorrido del aula, con lo de la sala al final', () => {
    const filas = [
      comprobacion({ check_key: 'red' }),
      comprobacion({ check_key: 'asset:2', asset_id: '2', asset_type: 'Botonera' }),
      comprobacion({ check_key: 'asset:1', asset_id: '1', asset_type: 'Proyector' }),
      comprobacion({ check_key: 'asset:3', asset_id: '3', asset_type: 'Cacharro raro' }),
    ]

    expect(ordenarComprobaciones(filas).map((c) => c.check_key)).toEqual([
      'asset:1',
      'asset:2',
      'asset:3',
      'red',
    ])
  })

  it('no altera el array que recibe', () => {
    const filas = [
      comprobacion({ check_key: 'red' }),
      comprobacion({ check_key: 'asset:1', asset_id: '1', asset_type: 'Proyector' }),
    ]
    ordenarComprobaciones(filas)
    expect(filas[0]!.check_key).toBe('red')
  })
})

describe('sembrar una corrección', () => {
  const proyector = assetCheckKey('018f0000-0000-7000-8000-000000000001')
  const retirado = assetCheckKey('018f0000-0000-7000-8000-000000000002')

  it('arrastra lo que se contestó para no volver a contestarlo todo', () => {
    const { checks } = semillaDeCorreccion(
      [
        comprobacion({
          check_key: proyector,
          asset_id: 'p',
          result: 'incidencia',
          severity: 'alta',
          note: 'no da imagen',
        }),
        comprobacion({ check_key: 'red', result: 'ok', measure: 94.3, measure_unit: 'Mbps' }),
      ],
      [proyector, 'red'],
    )

    expect(checks).toHaveLength(2)
    expect(checks[0]).toMatchObject({ result: 'incidencia', severity: 'alta', note: 'no da imagen' })
    expect(checks[1]).toMatchObject({ result: 'ok', measure: 94.3, measure_unit: 'Mbps' })
  })

  it('deja fuera lo que hoy no está en la sala, y lo dice', () => {
    const { checks, descartadas } = semillaDeCorreccion(
      [
        comprobacion({ check_key: proyector, asset_id: 'p', asset_type: 'Proyector' }),
        comprobacion({
          check_key: retirado,
          asset_id: 'r',
          asset_label: 'Pantalla 2',
          asset_status: 'retirado',
        }),
      ],
      [proyector],
    )

    expect(checks.map((c) => c.check_key)).toEqual([proyector])
    // Callarlo sería hacer desaparecer parte de la revisión sin avisar.
    expect(descartadas).toEqual(['Pantalla 2'])
  })

  it('no arrastra una gravedad huérfana', () => {
    // La pantalla no sabe producir un «correcto» con gravedad puesta, así que
    // tampoco puede nacer así un borrador.
    const { checks } = semillaDeCorreccion(
      [comprobacion({ check_key: 'red', result: 'ok', severity: 'alta' })],
      ['red'],
    )
    expect(checks[0]!.severity).toBeNull()
  })

  it('pone gravedad por defecto a una falla que no la traía', () => {
    const { checks } = semillaDeCorreccion(
      [comprobacion({ check_key: 'red', result: 'incidencia', severity: null })],
      ['red'],
    )
    expect(checks[0]!.severity).toBe('media')
  })

  it('convierte la semilla en filas de la revisión nueva, con identidad propia', () => {
    // Las comprobaciones de la corrección son filas nuevas: la clave de
    // `inspection_checks` es (revisión, comprobación), y reutilizar el id
    // chocaría contra la original.
    let n = 0
    const filas = checksDeSemilla(
      semillaDeCorreccion([comprobacion({ check_key: 'red', result: 'na' })], ['red']).checks,
      'nueva',
      () => `id-${++n}`,
    )

    expect(filas).toEqual([
      {
        id: 'id-1',
        inspection_id: 'nueva',
        check_key: 'red',
        result: 'na',
        severity: null,
        measure: null,
        measure_unit: null,
        note: null,
      },
    ])
  })
})
