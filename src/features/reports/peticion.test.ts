import { describe, expect, it } from 'vitest'
import { construirPeticion, motivoParaNoPedir, type Eleccion } from './peticion'
import { PRESETS, diasDelRango, nombrePeriodo, semanaLaboral } from './periodos'

/**
 * El informe que se pide tiene que ser el informe que sale.
 *
 * Estas dos piezas —el rango y la petición— son las que ya fallaron una vez: la
 * pantalla recogía las fechas y no las mandaba, así que quien pedía marzo
 * recibía los datos de ayer con una etiqueta que decía otra cosa. Un PDF
 * equivocado que parece correcto se archiva y se cita.
 */

const base: Eleccion = {
  kind: 'semanal',
  rango: { start: '2026-07-27', end: '2026-07-31' },
  secciones: ['resumen', 'analisis'],
  fotosFuera: [],
  comparar: true,
  ia: true,
  audiencia: 'direccion',
  enfoque: '',
  nota: '',
}

describe('construirPeticion', () => {
  it('manda las fechas elegidas, no las deja por el camino', () => {
    const p = construirPeticion(base)
    expect(p.p_start).toBe('2026-07-27')
    expect(p.p_end).toBe('2026-07-31')
    expect(p.kind).toBe('semanal')
  })

  it('lleva las secciones y las opciones de redacción', () => {
    const p = construirPeticion({ ...base, ia: false, comparar: false, audiencia: 'equipo' })
    expect(p.p_params.secciones).toEqual(['resumen', 'analisis'])
    expect(p.p_params.ia).toBe(false)
    expect(p.p_params.comparar).toBe(false)
    expect(p.p_params.audiencia).toBe('equipo')
  })

  it('los textos en blanco no viajan', () => {
    // Un enfoque vacío sería una instrucción vacía para la IA, y una nota vacía
    // imprimiría una caja con nada dentro en la portada.
    const p = construirPeticion({ ...base, enfoque: '   ', nota: '' })
    expect(p.p_params).not.toHaveProperty('enfoque')
    expect(p.p_params).not.toHaveProperty('nota')
  })

  it('las fotos quitadas viajan, y solo si se quitó alguna', () => {
    // Por defecto entran todas: una lista vacía en el expediente del informe se
    // leería como una decisión que nadie tomó.
    expect(construirPeticion(base).p_params).not.toHaveProperty('fotos_fuera')
    const p = construirPeticion({
      ...base,
      secciones: ['resumen', 'fotos'],
      fotosFuera: ['adj-1', 'adj-2', 'adj-1'],
    })
    expect(p.p_params.fotos_fuera).toEqual(['adj-1', 'adj-2'])
  })

  it('sin la sección de fotos no viajan, aunque queden marcadas de antes', () => {
    // Lo que se marcó en una rejilla que no va a salir no describe el documento
    // que se está pidiendo.
    const p = construirPeticion({ ...base, secciones: ['resumen'], fotosFuera: ['adj-1'] })
    expect(p.p_params).not.toHaveProperty('fotos_fuera')
  })

  it('y los que hay van recortados', () => {
    const p = construirPeticion({ ...base, enfoque: '  mira el CRAI  ', nota: ' Para el lunes ' })
    expect(p.p_params.enfoque).toBe('mira el CRAI')
    expect(p.p_params.nota).toBe('Para el lunes')
  })
})

describe('motivoParaNoPedir', () => {
  it('con todo puesto, no hay impedimento', () => {
    expect(motivoParaNoPedir(base, 5)).toBeNull()
  })

  it('sin fechas, lo dice', () => {
    expect(motivoParaNoPedir({ ...base, rango: { start: '', end: '' } }, 0)).toMatch(/fechas/)
  })

  it('con el rango al revés, también', () => {
    expect(
      motivoParaNoPedir({ ...base, rango: { start: '2026-07-31', end: '2026-07-01' } }, 1),
    ).toMatch(/anterior a la inicial/)
  })

  it('más de un año no se pide: sería cargar el histórico entero', () => {
    expect(motivoParaNoPedir(base, 400)).toMatch(/un año/)
  })

  it('sin ninguna sección marcada, tampoco', () => {
    expect(motivoParaNoPedir({ ...base, secciones: [] }, 5)).toMatch(/sección/)
  })
})

/**
 * Y los periodos, que son gemelos de los del worker: la pantalla enseña qué va a
 * cubrir el informe antes de pedirlo, y si los dos cálculos se separan, lo que
 * se anuncia deja de ser lo que sale.
 */
describe('semanaLaboral', () => {
  it('el viernes cubre de lunes a viernes', () => {
    expect(semanaLaboral('2026-07-31')).toEqual({ start: '2026-07-27', end: '2026-07-31' })
  })

  it('a mitad de semana, hasta hoy', () => {
    expect(semanaLaboral('2026-07-29')).toEqual({ start: '2026-07-27', end: '2026-07-29' })
  })

  it('el lunes se entiende como la semana pasada', () => {
    // Un semanal pedido un lunes por la mañana no puede ser el de una jornada
    // que aún no ha empezado.
    expect(semanaLaboral('2026-07-27')).toEqual({ start: '2026-07-20', end: '2026-07-24' })
  })

  it('el domingo, la semana que acaba de terminar', () => {
    expect(semanaLaboral('2026-08-02')).toEqual({ start: '2026-07-27', end: '2026-07-31' })
  })
})

describe('presets', () => {
  it('el mes pasado es el mes entero, no los últimos treinta días', () => {
    const p = PRESETS.find((x) => x.id === 'mes-pasado')!
    expect(p.rango('2026-07-15')).toEqual({ start: '2026-06-01', end: '2026-06-30' })
  })

  it('en enero, el mes pasado es diciembre del año anterior', () => {
    const p = PRESETS.find((x) => x.id === 'mes-pasado')!
    expect(p.rango('2026-01-09')).toEqual({ start: '2025-12-01', end: '2025-12-31' })
  })

  it('el mes en curso llega hasta hoy y no hasta fin de mes', () => {
    // Los días que aún no han pasado saldrían en el gráfico diario como
    // jornadas sin actividad.
    const p = PRESETS.find((x) => x.id === 'mes')!
    expect(p.rango('2026-07-15')).toEqual({ start: '2026-07-01', end: '2026-07-15' })
  })

  it('ayer es ayer aunque sea el día 1', () => {
    const p = PRESETS.find((x) => x.id === 'ayer')!
    expect(p.rango('2026-03-01')).toEqual({ start: '2026-02-28', end: '2026-02-28' })
  })
})

describe('nombrePeriodo', () => {
  it('no repite el mes cuando es el mismo', () => {
    expect(nombrePeriodo({ start: '2026-07-27', end: '2026-07-31' })).toBe(
      'del 27 al 31 de julio de 2026',
    )
  })

  it('un solo día lleva su día de la semana', () => {
    expect(nombrePeriodo({ start: '2026-07-30', end: '2026-07-30' })).toBe(
      'jueves 30 de julio de 2026',
    )
  })

  it('a caballo entre dos años, dice los dos', () => {
    expect(nombrePeriodo({ start: '2025-12-29', end: '2026-01-02' })).toBe(
      'del 29 de diciembre de 2025 al 2 de enero de 2026',
    )
  })

  it('sin fechas no inventa nada', () => {
    expect(nombrePeriodo({ start: '', end: '' })).toBe('')
  })
})

describe('diasDelRango', () => {
  it('cuenta los dos extremos', () => {
    expect(diasDelRango({ start: '2026-07-27', end: '2026-07-31' })).toBe(5)
  })

  it('la semana del cambio de hora sigue teniendo siete días', () => {
    // El domingo del cambio de hora de marzo dura 23 horas: contando en
    // milisegundos sobre la medianoche local, el séptimo día se pierde.
    expect(diasDelRango({ start: '2026-03-23', end: '2026-03-29' })).toBe(7)
  })

  it('y la de octubre, que tiene un día de 25, también', () => {
    expect(diasDelRango({ start: '2026-10-19', end: '2026-10-25' })).toBe(7)
  })
})
