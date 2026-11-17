import { describe, expect, it } from 'vitest'
import {
  fechasDelPeriodo,
  hayAlgoQueExportar,
  periodoLegible,
  problemaDeLasOpciones,
  recortarHistorial,
  TODO_EL_HISTORIAL,
  hojaDeIncidencias,
  hojaDeIntervenciones,
  hojaDeMaterialUsado,
  hojasDelHistorial,
  materialPorIncidencia,
  resumenDelHistorial,
  type DatosDelHistorial,
  type EventoDelHistorial,
  type IncidenciaDelHistorial,
} from './historialExportado'
import { excelAFecha } from './valores'

const evento = (extra: Partial<EventoDelHistorial>): EventoDelHistorial => ({
  ref_id: 'x',
  kind: 'incidencia',
  subkind: 'abierta',
  room_id: 'r17',
  at: '2026-03-02T09:15:00Z',
  title: 'Proyector: no da imagen',
  detail: null,
  qty: null,
  by_user: 'u-ana',
  who: 'Ana Ruiz',
  ref: null,
  room_code: '1.7',
  ...extra,
})

const incidencia = (extra: Partial<IncidenciaDelHistorial>): IncidenciaDelHistorial => ({
  id: 'i1',
  room_id: 'r17',
  kind: 'incidencia',
  state: 'resuelta',
  severity: 'alta',
  title: 'Proyector: no da imagen',
  description: 'El led parpadea en rojo',
  opened_at: '2026-03-02T09:15:00Z',
  opened_by: 'u-ana',
  resolved_at: '2026-03-04T11:40:00Z',
  resolved_by: 'u-luis',
  resolution: 'Sustituida la lámpara',
  external_ref: 'I260302_0007',
  easyvista_ref: 'EV-4471',
  ...extra,
})

/** Una avería abierta por Ana, cerrada por Luis dos días después con material. */
const DATOS: DatosDelHistorial = {
  eventos: [
    // A propósito desordenados: la hoja tiene que ordenarlos ella.
    evento({ ref_id: 'm2', kind: 'material', subkind: 'devolucion', at: '2026-03-04T11:45:00Z', title: 'Cable HDMI 2 m', qty: 1, by_user: 'u-luis', who: 'Luis Gil' }),
    evento({ ref_id: 'i1', kind: 'incidencia', subkind: 'resuelta', at: '2026-03-04T11:40:00Z', title: 'Resuelta: Proyector: no da imagen', detail: 'Sustituida la lámpara', by_user: 'u-luis', who: 'Luis Gil', ref: 'I260302_0007' }),
    evento({ ref_id: 'i1', ref: 'I260302_0007' }),
    evento({ ref_id: 'm1', kind: 'material', subkind: 'consumo', at: '2026-03-04T11:40:00Z', title: 'Cable HDMI 2 m', qty: -2, by_user: 'u-luis', who: 'Luis Gil' }),
    evento({ ref_id: 'm3', kind: 'material', subkind: 'consumo', at: '2026-03-04T11:40:00Z', title: 'Lámpara NP-M403', qty: -1, by_user: 'u-luis', who: 'Luis Gil' }),
    evento({ ref_id: 'rev', kind: 'revision_ok', subkind: 'completa', at: '2026-02-10T08:00:00Z', title: 'Revisión completa sin incidencias' }),
    // Material apuntado a la sala sin incidencia: cuenta como material, no como de la avería.
    evento({ ref_id: 'm4', kind: 'material', subkind: 'consumo', at: '2026-05-01T10:00:00Z', title: 'Pilas AA', qty: -4 }),
  ],
  incidencias: [incidencia({})],
  incidenciaDeMovimiento: { m1: 'i1', m2: 'i1', m3: 'i1' },
  salas: { r17: '1.7' },
  deEdificio: false,
}

const columna = (hoja: { filas: unknown[][] }, cabecera: string): unknown[] => {
  const i = hoja.filas[0]!.indexOf(cabecera)
  expect(i, `falta la columna «${cabecera}»`).toBeGreaterThanOrEqual(0)
  return hoja.filas.slice(1).map((f) => f[i])
}

describe('el material de una incidencia', () => {
  it('es el neto por artículo: lo devuelto no cuenta como gastado', () => {
    // Dos cables consumidos y uno devuelto son UN cable puesto.
    expect(materialPorIncidencia(DATOS).get('i1')).toBe('1 × Cable HDMI 2 m; 1 × Lámpara NP-M403')
  })

  it('si todo se devolvió, la incidencia no gastó nada', () => {
    const datos: DatosDelHistorial = {
      ...DATOS,
      eventos: [
        evento({ ref_id: 'a', kind: 'material', subkind: 'consumo', title: 'Cable', qty: -1 }),
        evento({ ref_id: 'b', kind: 'material', subkind: 'devolucion', title: 'Cable', qty: 1 }),
      ],
      incidenciaDeMovimiento: { a: 'i1', b: 'i1' },
    }
    expect(materialPorIncidencia(datos).has('i1')).toBe(false)
  })
})

describe('la hoja de intervenciones', () => {
  const hoja = hojaDeIntervenciones(DATOS)

  it('va del más antiguo al más reciente, con el día y la hora en columnas aparte', () => {
    const dias = columna(hoja, 'Fecha').map((n) => excelAFecha(n as number))
    expect(dias).toEqual([...dias].sort())
    expect(dias[0]).toBe('2026-02-10')
    // La hora es texto «HH:MM», no parte de la fecha.
    for (const h of columna(hoja, 'Hora')) expect(h).toMatch(/^\d{2}:\d{2}$/)
  })

  it('el material gastado va en la fila del cierre, no en la de apertura', () => {
    const tipo = columna(hoja, 'Estado')
    const material = columna(hoja, 'Material usado')
    const cierre = tipo.indexOf('Resuelta')
    const apertura = tipo.indexOf('Abierta')
    expect(material[cierre]).toBe('1 × Cable HDMI 2 m; 1 × Lámpara NP-M403')
    expect(material[apertura]).toBeNull()
  })

  it('la cantidad de un movimiento va en positivo: el estado dice si salió o volvió', () => {
    const cantidades = columna(hoja, 'Cantidad').filter((c) => c !== null)
    expect(cantidades).toEqual([2, 1, 1, 4])
    expect(columna(hoja, 'Estado')).toContain('Devuelto')
  })

  it('una fila de datos por evento, y un tinte por fila', () => {
    expect(hoja.filas.length - 1).toBe(DATOS.eventos.length)
    expect(hoja.tintes?.length).toBe(DATOS.eventos.length)
  })
})

describe('la hoja de incidencias', () => {
  const hoja = hojaDeIncidencias(DATOS, new Date('2026-06-01T00:00:00Z'))

  it('una fila por incidencia, con su apertura, su cierre, su solución y su material', () => {
    expect(hoja.filas.length).toBe(2)
    expect(columna(hoja, 'Estado')).toEqual(['Resuelta'])
    expect(columna(hoja, 'Solución')).toEqual(['Sustituida la lámpara'])
    expect(columna(hoja, 'Material usado')).toEqual(['1 × Cable HDMI 2 m; 1 × Lámpara NP-M403'])
    expect(columna(hoja, 'EasyVista')).toEqual(['EV-4471'])
    expect(columna(hoja, 'Días abierta')).toEqual([2])
  })

  it('los nombres salen de la línea de tiempo: quién la abrió y quién la cerró', () => {
    expect(columna(hoja, 'Abierta por')).toEqual(['Ana Ruiz'])
    expect(columna(hoja, 'Resuelta por')).toEqual(['Luis Gil'])
  })

  it('una abierta cuenta los días hasta hoy, y una solicitud no lleva gravedad', () => {
    const datos: DatosDelHistorial = {
      ...DATOS,
      incidencias: [
        incidencia({ id: 'i2', state: 'abierta', resolved_at: null, resolved_by: null, resolution: null, opened_at: '2026-05-22T00:00:00Z' }),
        incidencia({ id: 'i3', kind: 'solicitud', state: 'abierta', resolved_at: null, opened_at: '2026-05-30T00:00:00Z' }),
      ],
    }
    const h = hojaDeIncidencias(datos, new Date('2026-06-01T00:00:00Z'))
    expect(columna(h, 'Días abierta')).toEqual([10, 2])
    expect(columna(h, 'Gravedad')).toEqual(['Alta', null])
    expect(columna(h, 'Resuelta el')).toEqual([null, null])
  })
})

describe('la hoja de material usado', () => {
  const hoja = hojaDeMaterialUsado(DATOS)

  it('solo los movimientos de almacén, cada uno con su incidencia si la tiene', () => {
    expect(columna(hoja, 'Artículo')).toEqual(['Cable HDMI 2 m', 'Lámpara NP-M403', 'Cable HDMI 2 m', 'Pilas AA'])
    expect(columna(hoja, 'Movimiento')).toEqual(['Consumido', 'Consumido', 'Devuelto', 'Consumido'])
    expect(columna(hoja, 'Referencia')).toEqual(['I260302_0007', 'I260302_0007', 'I260302_0007', null])
  })
})

describe('el documento', () => {
  it('el de una sala no lleva la columna «Sala»; el de un edificio, en las tres hojas', () => {
    for (const { hoja } of hojasDelHistorial(DATOS)) expect(hoja.filas[0]).not.toContain('Sala')

    const edificio = hojasDelHistorial({ ...DATOS, deEdificio: true })
    for (const { hoja, pdf } of edificio) {
      expect(hoja.filas[0]).toContain('Sala')
      expect(pdf?.columnas).toContain('Sala')
      expect(columna(hoja, 'Sala').every((s) => s === '1.7')).toBe(true)
      // Anchos y formatos se mueven con la columna: uno por cada una.
      expect(hoja.anchos?.length).toBe(hoja.filas[0]!.length)
      expect(hoja.formatos?.length).toBe(hoja.filas[0]!.length)
    }
  })

  it('las columnas que van al PDF existen todas en su hoja', () => {
    for (const d of [DATOS, { ...DATOS, deEdificio: true }]) {
      for (const { hoja, pdf } of hojasDelHistorial(d)) {
        for (const c of pdf?.columnas ?? []) expect(hoja.filas[0]).toContain(c)
      }
    }
  })

  it('el resumen dice cuánto hay, y cuántas incidencias siguen sin resolver', () => {
    expect(resumenDelHistorial(DATOS)).toBe('7 intervenciones · 1 incidencia · 4 movimientos de material')
    const conAbierta = { ...DATOS, incidencias: [incidencia({}), incidencia({ id: 'i9', state: 'abierta' as const })] }
    expect(resumenDelHistorial(conAbierta)).toContain('2 incidencias (1 sin resolver)')
  })

  it('sin nada que contar, salen las tres hojas con su cabecera y ninguna fila', () => {
    const vacio: DatosDelHistorial = { eventos: [], incidencias: [], incidenciaDeMovimiento: {}, salas: {}, deEdificio: false }
    for (const { hoja } of hojasDelHistorial(vacio)) expect(hoja.filas.length).toBe(1)
  })
})

describe('lo que se elige antes de descargar', () => {
  const HOY = '2026-11-17'

  it('los periodos de un toque acaban hoy y empiezan donde dicen', () => {
    expect(fechasDelPeriodo('mes', undefined, HOY)).toEqual({ desde: '2026-10-17', hasta: HOY })
    expect(fechasDelPeriodo('trimestre', undefined, HOY)).toEqual({ desde: '2026-08-17', hasta: HOY })
    expect(fechasDelPeriodo('doce', undefined, HOY)).toEqual({ desde: '2025-11-17', hasta: HOY })
    expect(fechasDelPeriodo('anyo', undefined, HOY)).toEqual({ desde: '2026-01-01', hasta: HOY })
    expect(fechasDelPeriodo('todo', undefined, HOY)).toEqual({ desde: null, hasta: null })
  })

  it('un mes atrás desde el 31 no se sale del mes', () => {
    // Del 31 de marzo, un mes atrás es el 28 de febrero, no el 3 de marzo.
    expect(fechasDelPeriodo('mes', undefined, '2026-03-31').desde).toBe('2026-02-28')
    expect(fechasDelPeriodo('doce', undefined, '2024-02-29').desde).toBe('2023-02-28')
  })

  it('con fechas a mano, un extremo vacío es un extremo abierto', () => {
    expect(fechasDelPeriodo('fechas', { desde: '2026-03-01', hasta: '' }, HOY)).toEqual({ desde: '2026-03-01', hasta: null })
    expect(fechasDelPeriodo('fechas', { desde: '', hasta: '' }, HOY)).toEqual({ desde: null, hasta: null })
  })

  it('el periodo se dice con palabras, de qué día a qué día', () => {
    expect(periodoLegible({ desde: '2026-03-01', hasta: '2026-06-30' })).toBe('Del 01/03/2026 al 30/06/2026')
    expect(periodoLegible({ desde: '2026-03-01', hasta: null })).toBe('Desde el 01/03/2026')
    expect(periodoLegible({ desde: null, hasta: '2026-06-30' })).toBe('Hasta el 30/06/2026')
    expect(periodoLegible({ desde: null, hasta: null })).toBe('Todo el historial')
  })

  it('no deja descargar sin nada marcado ni con las fechas al revés', () => {
    expect(problemaDeLasOpciones(TODO_EL_HISTORIAL)).toBeNull()
    expect(problemaDeLasOpciones({ ...TODO_EL_HISTORIAL, familias: [] })).toMatch(/al menos una/)
    expect(problemaDeLasOpciones({ ...TODO_EL_HISTORIAL, desde: '2026-06-01', hasta: '2026-03-01' })).toMatch(/posterior/)
  })
})

describe('recortar el historial', () => {
  it('«hasta el 4» incluye todo el día 4, en la hora del campus', () => {
    // El cierre es del 4 de marzo a las 12:40 de Madrid.
    const hasta4 = recortarHistorial(DATOS, { ...TODO_EL_HISTORIAL, hasta: '2026-03-04' })
    expect(hasta4.eventos.some((e) => e.subkind === 'resuelta')).toBe(true)
    const hasta3 = recortarHistorial(DATOS, { ...TODO_EL_HISTORIAL, hasta: '2026-03-03' })
    expect(hasta3.eventos.some((e) => e.subkind === 'resuelta')).toBe(false)
    // Y «desde el 4» también lo trae, pero deja fuera la apertura del día 2.
    const desde4 = recortarHistorial(DATOS, { ...TODO_EL_HISTORIAL, desde: '2026-03-04' })
    expect(desde4.eventos.some((e) => e.subkind === 'resuelta')).toBe(true)
    expect(desde4.eventos.some((e) => e.subkind === 'abierta')).toBe(false)
  })

  it('una incidencia entra si estuvo viva en el periodo, aunque se abriera antes', () => {
    const datos: DatosDelHistorial = {
      ...DATOS,
      incidencias: [
        incidencia({ id: 'vieja', opened_at: '2025-01-10T09:00:00Z', resolved_at: null, state: 'abierta' }),
        incidencia({ id: 'cerrada-antes', opened_at: '2025-01-10T09:00:00Z', resolved_at: '2025-02-01T09:00:00Z' }),
        incidencia({ id: 'posterior', opened_at: '2026-12-01T09:00:00Z', resolved_at: null, state: 'abierta' }),
      ],
    }
    const r = recortarHistorial(datos, { ...TODO_EL_HISTORIAL, desde: '2026-10-17', hasta: '2026-11-17' })
    expect(r.incidencias.map((i) => i.id)).toEqual(['vieja'])
  })

  it('quitar una familia quita sus filas, y las observaciones van con las solicitudes', () => {
    const sinMaterial = recortarHistorial(DATOS, { ...TODO_EL_HISTORIAL, familias: ['revision', 'incidencia'] })
    expect(sinMaterial.eventos.some((e) => e.kind === 'material')).toBe(false)
    expect(sinMaterial.eventos.length).toBe(3)

    const datos = { ...DATOS, incidencias: [incidencia({}), incidencia({ id: 'o', kind: 'observacion' as const })] }
    expect(recortarHistorial(datos, { ...TODO_EL_HISTORIAL, familias: ['solicitud'] }).incidencias.map((i) => i.id)).toEqual(['o'])
  })
})

describe('el documento, con lo elegido', () => {
  const nombres = (o: Parameters<typeof hojasDelHistorial>[2]): string[] =>
    hojasDelHistorial(DATOS, new Date('2026-06-01T00:00:00Z'), o).map((h) => h.hoja.nombre)

  it('las familias deciden qué hojas hay: no sale una hoja que nadie ha pedido', () => {
    expect(nombres(TODO_EL_HISTORIAL)).toEqual(['Intervenciones', 'Incidencias', 'Material usado'])
    expect(nombres({ ...TODO_EL_HISTORIAL, familias: ['revision'] })).toEqual(['Intervenciones'])
    expect(nombres({ ...TODO_EL_HISTORIAL, familias: ['incidencia'] })).toEqual(['Intervenciones', 'Incidencias'])
    expect(nombres({ ...TODO_EL_HISTORIAL, familias: ['material'] })).toEqual(['Intervenciones', 'Material usado'])
  })

  it('sin «Material» marcado, la incidencia sigue diciendo qué se gastó en ella', () => {
    const hojas = hojasDelHistorial(DATOS, new Date('2026-06-01T00:00:00Z'), { ...TODO_EL_HISTORIAL, familias: ['incidencia'] })
    const incidencias = hojas.find((h) => h.hoja.nombre === 'Incidencias')!.hoja
    expect(columna(incidencias, 'Material usado')).toEqual(['1 × Cable HDMI 2 m; 1 × Lámpara NP-M403'])
    // Y los nombres siguen saliendo, aunque la fila de quien cerró no esté a la vista.
    expect(columna(incidencias, 'Resuelta por')).toEqual(['Luis Gil'])
  })

  it('el resumen lleva el periodo delante y solo cuenta lo incluido', () => {
    expect(resumenDelHistorial(DATOS, { ...TODO_EL_HISTORIAL, desde: '2026-03-01', hasta: '2026-03-31' })).toBe(
      'Del 01/03/2026 al 31/03/2026 · 5 intervenciones · 1 incidencia · 3 movimientos de material',
    )
    expect(resumenDelHistorial(DATOS, { ...TODO_EL_HISTORIAL, familias: ['revision'] })).toBe('1 intervención')
  })

  it('las solicitudes constan en el resumen cuando las hay', () => {
    const datos = { ...DATOS, incidencias: [incidencia({}), incidencia({ id: 's', kind: 'solicitud' as const, state: 'abierta' as const })] }
    expect(resumenDelHistorial(datos)).toBe('7 intervenciones · 1 incidencia · 1 solicitud · 4 movimientos de material')
  })

  it('sabe decir cuándo no queda nada que exportar', () => {
    expect(hayAlgoQueExportar(DATOS, TODO_EL_HISTORIAL)).toBe(true)
    expect(hayAlgoQueExportar(DATOS, { ...TODO_EL_HISTORIAL, desde: '2030-01-01' })).toBe(false)
  })
})
