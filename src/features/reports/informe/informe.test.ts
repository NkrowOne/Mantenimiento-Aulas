import { describe, expect, it } from 'vitest'
import { lecturaCalculada, senales } from './analisis'
import { SECCIONES, leerOpciones } from './opciones'
import { diasLargo, renderReport } from './plantilla'
import { actividadDiaria } from './graficos'
import { cifrasInventadas, configurarIA, expediente, formulasDelatoras } from './ia'
import { etiquetaDia, nombreComparacion, periodoAnterior } from '../periodos'
import { inicioDelDia } from '@/domain/fechas'
import type { ReportData } from './tipos'

/**
 * El informe se arma ahora dentro de la aplicación, así que lo que antes se
 * probaba en el worker se prueba aquí. Y lo que se comprueba no es que «no
 * lance»: es que el documento salga ENTERO. El fallo que este fichero existe
 * para impedir es un informe con la maquetación bien y un hueco donde iba el
 * gráfico —o donde iba el análisis—, porque ese sale, se imprime y se archiva
 * sin que nadie note nada hasta que alguien lo lee en una reunión.
 */

function expedienteDePrueba(): ReportData {
  return {
    kind: 'semanal',
    period: { start: '2026-07-27', end: '2026-07-31' },
    anterior: { start: '2026-07-20', end: '2026-07-24' },
    periodoTexto: 'del 27 al 31 de julio de 2026',
    comparacionTexto: 'la semana anterior',
    dias: 5,
    ahora: {
      revisiones: 18,
      salasRevisadas: 16,
      registros: 11,
      incidencias: 7,
      solicitudes: 3,
      observaciones: 1,
      gravedadAlta: 2,
      resueltas: 9,
      materialConsumido: 24,
    },
    antes: {
      revisiones: 31,
      salasRevisadas: 27,
      registros: 14,
      incidencias: 9,
      solicitudes: 4,
      observaciones: 1,
      gravedadAlta: 1,
      resueltas: 12,
      materialConsumido: 30,
    },
    situacion: {
      salasTotal: 276,
      incidenciasAbiertas: 23,
      estancadas: 4,
      lamparasAlLimite: 3,
      salasSinRevisarHace6Meses: 12,
      salasNuncaRevisadas: 5,
      articulosBajoMinimo: 2,
    },
    serieDiaria: [
      { dia: '2026-07-27', revisiones: 5, abiertas: 3, resueltas: 1 },
      { dia: '2026-07-28', revisiones: 4, abiertas: 2, resueltas: 3 },
      { dia: '2026-07-29', revisiones: 3, abiertas: 1, resueltas: 2 },
      { dia: '2026-07-30', revisiones: 4, abiertas: 4, resueltas: 2 },
      { dia: '2026-07-31', revisiones: 2, abiertas: 1, resueltas: 1 },
    ],
    porEdificio: [
      { code: 'H', name: 'EDIFICIO H', salas: 39, revisadas: 9, abiertas: 6, pendientes: 11, archivado: false },
      { code: 'CRAI', name: 'CRAI', salas: 12, revisadas: 4, abiertas: 3, pendientes: 4, archivado: false },
      // Un edificio que ya no está en la lista de trabajo y en el que, aun así,
      // se trabajó durante el periodo: sin salas en servicio y con revisiones.
      { code: 'TM', name: 'TOMÁS MORO', salas: 0, revisadas: 5, abiertas: 2, pendientes: 1, archivado: true },
    ],
    porTipo: [
      { tipo: 'incidencia', total: 7 },
      { tipo: 'solicitud', total: 3 },
      { tipo: 'observacion', total: 1 },
    ],
    porGravedad: [
      { gravedad: 'alta', total: 2 },
      { gravedad: 'media', total: 5 },
    ],
    porMes: [
      { month: '2026-06', total: 41 },
      { month: '2026-07', total: 38 },
    ],
    topSalas: [
      { building: 'H', room: 'H-102', name: 'AULA 102', total: 3, fiabilidad: 62, hayDatos: true },
    ],
    resolucion: { resueltas: 9, medianaDias: 1.4, mediaDias: 6.2, enMenosDe48h: 6 },
    lamparas: [{ building: 'H', room: 'H-104', horas: 3200, pct: 0.08 }],
    estancadas: [
      {
        ref: 'INC-4412',
        titulo: 'Proyector sin señal en el aula 102',
        building: 'H',
        room: 'H-102',
        dias: 19,
        gravedad: 'alta',
      },
    ],
    materiales: [{ name: 'Cable HDMI 3 m', unidad: 'ud', consumido: 9, incidencias: 5 }],
    cierres: [
      {
        ref: 'INC-4390',
        titulo: 'Lámpara fundida en el aula 104',
        building: 'H',
        room: 'H-104',
        abierta: '2026-07-06',
        horaAbierta: '08:40',
        cerrada: '2026-07-30',
        horaCerrada: '10:50',
        dias: 24.09,
        resolucion: 'Cambiada la lámpara. Hubo que pedirla: llegó el día 28.',
        quien: 'Luis Martín',
      },
      {
        ref: null,
        titulo: 'Persiana atascada',
        building: 'CRAI',
        room: 'CRAI-01',
        abierta: '2026-07-28',
        horaAbierta: '09:00',
        cerrada: '2026-07-28',
        horaCerrada: '13:00',
        dias: 4 / 24,
        resolucion: null,
        quien: null,
      },
    ],
    cierresTotal: 9,
    fotos: [
      // El antes y el después de la misma incidencia, y una revisión que no
      // abrió ninguna: los tres momentos que el documento tiene que distinguir.
      {
        dia: '2026-07-27',
        hora: '09:12',
        building: 'H',
        room: 'H-102',
        titulo: 'Proyector sin señal en el aula 102',
        ref: 'INC-4412',
        momento: 'revision',
        datos: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=',
      },
      {
        dia: '2026-07-27',
        hora: '09:41',
        building: 'H',
        room: 'H-102',
        titulo: 'Proyector sin señal en el aula 102',
        ref: 'INC-4412',
        momento: 'cierre',
        datos: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=',
      },
      {
        dia: '2026-07-28',
        hora: '11:05',
        building: 'CRAI',
        room: 'CRAI-01',
        titulo: 'Persiana atascada',
        ref: null,
        momento: 'apertura',
        datos: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=',
      },
    ],
    fotosTotal: 5,
    reincidentes: [{ building: 'H', room: 'H-102', item: 'Cable HDMI 3 m', veces: 4 }],
    olvidadas: [{ building: 'CRAI', room: 'CRAI-01', dias: 240 }],
    equipo: [{ nombre: 'Ana Pérez', revisiones: 11, registros: 6 }],
    revisiones: [
      {
        dia: '2026-07-27',
        hora: '09:12',
        building: 'H',
        room: 'H-102',
        name: 'AULA 102',
        quien: 'Ana Pérez',
        resultado: 'con_incidencias',
        fallos: 2,
        aperturas: 1,
      },
    ],
    revisionesTotal: 18,
    eventos: [
      {
        dia: '2026-07-27',
        hora: '09:40',
        tipo: 'apertura',
        subtipo: 'incidencia',
        titulo: 'Proyector sin señal en el aula 102',
        detalle: 'No engancha por HDMI',
        cantidad: null,
        ref: 'INC-4412',
        building: 'H',
        room: 'H-102',
        quien: 'Ana Pérez',
      },
    ],
    eventosTotal: 27,
    sinSala: 2,
    salasArchivadas: 3,
  }
}

const opcionesCompletas = leerOpciones({ secciones: [...SECCIONES] })

describe('el documento sale entero', () => {
  const d = expedienteDePrueba()
  const html = renderReport(d, lecturaCalculada(d), opcionesCompletas, {
    emitido: '31/07/2026, 9:14',
  })

  it('es un documento HTML completo', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
  })

  it('trae los gráficos dentro, como SVG', () => {
    // Es la comprobación que más importa de todo el fichero: si ECharts no
    // renderiza en este entorno, el informe sale con la maquetación perfecta y
    // los gráficos en blanco, y eso no se ve hasta que alguien abre el PDF.
    expect(html).toContain('<svg')
    expect(html.match(/<svg/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('no pide nada a la red: se archiva y se abre tal cual', () => {
    expect(html).not.toMatch(/<script/i)
    // Ni fuentes, ni hojas de estilo, ni imágenes externas. Lo único que puede
    // llevar `src` son las fotos, y solo como `data:` — que es contenido dentro
    // del fichero, no una petición. Un enlace firmado de Storage caduca en un
    // minuto: el documento de dentro de un año tendría un hueco donde hoy hay
    // una prueba.
    for (const src of html.match(/\ssrc="[^"]*"/gi) ?? []) {
      expect(src).toMatch(/\ssrc="data:image\//i)
    }
    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/@import/i)
    expect(html).not.toMatch(/url\(\s*['"]?https?:/i)
  })

  it('imprime el periodo, los indicadores y las tablas', () => {
    expect(html).toContain('del 27 al 31 de julio de 2026')
    expect(html).toContain('Informe semanal')
    // Los cuatro indicadores de cabecera, con sus cifras.
    expect(html).toContain('Revisiones')
    expect(html).toContain('Pendientes hoy')
    // Y el detalle que solo puede venir de los datos.
    expect(html).toContain('Proyector sin señal en el aula 102')
    expect(html).toContain('Cable HDMI 3 m')
  })

  it('no dice en ninguna parte cómo se preparó el análisis', () => {
    // El documento es del servicio de mantenimiento: el rastro va a
    // `reports.params` y a la pantalla, no al papel de una reunión.
    expect(html).not.toMatch(/gemini|inteligencia artificial/i)
    // `IA` en mayúsculas y como palabra suelta. Sin distinguir mayúsculas, esto
    // casaría con la mitad de «incidencia».
    expect(html).not.toMatch(/\bIA\b/)
  })

  it('un periodo vacío sigue siendo un informe, no un esqueleto', () => {
    const vacio: ReportData = {
      ...d,
      ahora: {
        revisiones: 0,
        salasRevisadas: 0,
        registros: 0,
        incidencias: 0,
        solicitudes: 0,
        observaciones: 0,
        gravedadAlta: 0,
        resueltas: 0,
        materialConsumido: 0,
      },
      serieDiaria: d.serieDiaria.map((x) => ({ ...x, revisiones: 0, abiertas: 0, resueltas: 0 })),
      revisiones: [],
      revisionesTotal: 0,
      eventos: [],
      eventosTotal: 0,
      topSalas: [],
      materiales: [],
      cierres: [],
      cierresTotal: 0,
      fotos: [],
      fotosTotal: 0,
    }
    const lectura = lecturaCalculada(vacio)
    expect(lectura.titular).toBeTruthy()
    expect(lectura.entradilla).toBeTruthy()
    const salida = renderReport(vacio, lectura, opcionesCompletas, { emitido: '31/07/2026, 9:14' })
    expect(salida).toContain('Ningún movimiento registrado en el periodo')
  })
})

/**
 * La cabecera corporativa y el fin de la «Procedencia».
 *
 * Las dos cosas que un informe que sale del servicio y llega al cliente tiene
 * que cumplir: llevar las marcas de quién lo emite y para quién, y no repetir
 * al pie lo que ya ha dicho en la portada.
 */
describe('la imagen del documento', () => {
  const d = expedienteDePrueba()
  const html = renderReport(d, lecturaCalculada(d), opcionesCompletas, {
    emitido: '31/07/2026, 9:14',
    solicitante: 'Eduardo Rubio',
  })

  it('lleva las dos marcas dentro del fichero, no enlazadas', () => {
    expect(html).toContain('aria-label="Grupo Oesia"')
    expect(html).toContain('aria-label="Universidad Francisco de Vitoria"')
    // Trazadas, no enlazadas: un <img> a un logotipo sería un hueco blanco el
    // día que la carpeta cambie de sitio, y este documento se archiva.
    expect(html).not.toMatch(/<img[^>]+aria-label="Grupo Oesia"/)
  })

  it('las marcas van arriba del todo, antes del titular', () => {
    const marcas = html.indexOf('aria-label="Grupo Oesia"')
    const titular = html.indexOf('<h1>')
    expect(marcas).toBeGreaterThan(-1)
    expect(marcas).toBeLessThan(titular)
  })

  it('no repite al pie la fecha, el periodo ni quién lo pidió', () => {
    // Estaban en «Procedencia», a cuatro dedos de la cabecera que ya las dice.
    expect(html).not.toContain('Procedencia')
    expect(html).not.toContain('Datos leídos de la base')
    expect(html).not.toContain('Solicitado por')
    expect(html).not.toContain('Un informe emitido no se regenera')
    // Y siguen dichas una vez, donde tocaba.
    expect(html.match(/Eduardo Rubio/g)?.length).toBe(1)
    expect(html.match(/31\/07\/2026, 9:14/g)?.length).toBe(1)
  })

  it('el alcance solo sale cuando hay algo que advertir', () => {
    const limpio: ReportData = {
      ...d,
      situacion: { ...d.situacion, salasNuncaRevisadas: 0 },
      sinSala: 0,
      salasArchivadas: 0,
    }
    const salida = renderReport(limpio, lecturaCalculada(limpio), opcionesCompletas, {
      emitido: '31/07/2026, 9:14',
    })
    expect(salida).not.toContain('Alcance de los datos')
    // Y con salvedades, sí.
    expect(html).toContain('Alcance de los datos')
  })
})

/**
 * El fin de semana en el gráfico diario.
 *
 * El servicio trabaja de lunes a viernes: un sábado a cero es una columna en
 * blanco que estrecha a las demás. Pero un sábado CON movimiento es justo lo
 * que hay que ver, y ese no se toca.
 */
describe('los fines de semana del gráfico diario', () => {
  const d = expedienteDePrueba()
  // La semana del fixture es de lunes a viernes; se le añade su fin de semana.
  const conFinde = (sabado: { revisiones: number; abiertas: number; resueltas: number }): string => {
    const ampliado: ReportData = {
      ...d,
      period: { start: '2026-07-27', end: '2026-08-02' },
      dias: 7,
      serieDiaria: [
        ...d.serieDiaria,
        { dia: '2026-08-01', ...sabado },
        { dia: '2026-08-02', revisiones: 0, abiertas: 0, resueltas: 0 },
      ],
    }
    return renderReport(ampliado, lecturaCalculada(ampliado), opcionesCompletas, {
      emitido: '03/08/2026, 9:14',
    })
  }

  it('un fin de semana en blanco no se dibuja', () => {
    const html = conFinde({ revisiones: 0, abiertas: 0, resueltas: 0 })
    // «S 1» y «D 2» son las etiquetas del eje del SVG: sin ellas, no hay columnas.
    expect(html).not.toContain('>S 1</text>')
    expect(html).not.toContain('>D 2</text>')
    expect(html).toContain('fines de semana sin actividad, fuera del gráfico')
  })

  it('un sábado con trabajo sí se dibuja, que es el dato que se busca', () => {
    const html = conFinde({ revisiones: 2, abiertas: 1, resueltas: 0 })
    expect(html).toContain('>S 1</text>')
    // El domingo vacío se sigue cayendo: no es todo o nada.
    expect(html).not.toContain('>D 2</text>')
  })

  it('los días laborables en blanco se quedan: un hueco entre semana informa', () => {
    const parado: ReportData = {
      ...d,
      serieDiaria: d.serieDiaria.map((x, i) =>
        i === 2 ? { ...x, revisiones: 0, abiertas: 0, resueltas: 0 } : x,
      ),
    }
    const html = renderReport(parado, lecturaCalculada(parado), opcionesCompletas, {
      emitido: '31/07/2026, 9:14',
    })
    expect(html).toContain('>X 29</text>')
    expect(html).not.toContain('fines de semana sin actividad')
  })
})

describe('lo que se pinta sin IA', () => {
  it('la redacción calculada trae titular, entradilla y acciones', () => {
    const l = lecturaCalculada(expedienteDePrueba())
    expect(l.titular).toMatch(/incidencias llevan más de una semana abiertas/)
    expect(l.entradilla.length).toBeGreaterThan(80)
    expect(l.hallazgos.length).toBeGreaterThan(0)
    expect(l.recomendaciones.length).toBeGreaterThan(0)
    expect(l.origen).toMatch(/sin IA/)
  })

  it('las señales salen ordenadas por peso, lo grave primero', () => {
    const se = senales(expedienteDePrueba())
    expect(se[0]?.clave).toBe('estancadas')
    expect(se.map((s) => s.peso)).toEqual([...se.map((s) => s.peso)].sort((a, b) => a - b))
  })
})

describe('el expediente que sale hacia Gemini', () => {
  const d = expedienteDePrueba()
  const texto = expediente(d, senales(d))

  it('lleva las cifras del periodo y las de hoy', () => {
    expect(texto).toContain('revisiones completadas: 18 (antes 31)')
    expect(texto).toContain('incidencias abiertas en total: 23')
  })

  it('no lleva nombres de personas', () => {
    // Al informe sí van, porque es interno. A un servicio de terceros no tienen
    // por qué ir.
    expect(texto).not.toContain('Ana Pérez')
    expect(texto).toContain('persona 1')
  })
})

describe('el filtro de lo que devuelve el modelo', () => {
  it('caza una cifra de tres dígitos que no está en los datos', () => {
    expect(cifrasInventadas('Se han revisado 412 salas', 'salas revisadas: 16 de 276')).toEqual([
      '412',
    ])
  })

  it('deja pasar las de una y dos cifras, que salen de dividir', () => {
    expect(cifrasInventadas('tres de cada 4', 'no hay nada')).toEqual([])
  })

  it('reconoce las fórmulas de relleno', () => {
    expect(formulasDelatoras('Es importante destacar que, en resumen, todo va bien')).toHaveLength(2)
    expect(formulasDelatoras('El edificio H concentra las averías de la semana')).toEqual([])
  })
})

describe('la configuración de la IA', () => {
  it('sin clave no hay configuración, y el informe sale igual', () => {
    expect(configurarIA({})).toBeNull()
    expect(configurarIA({ clave: '   ' })).toBeNull()
  })

  it('un nivel de razonamiento inventado no llega a la API', () => {
    // Devolvería 400 en cada informe, y siempre por el mismo motivo.
    expect(configurarIA({ clave: 'AIza-x', thinking: 'muchísimo' })?.thinking).toBe('high')
  })

  it('respeta el modelo y el nivel guardados', () => {
    const o = configurarIA({ clave: 'AIza-x', modelo: 'gemini-3.6-pro', thinking: 'low' })
    expect(o?.modelo).toBe('gemini-3.6-pro')
    expect(o?.thinking).toBe('low')
  })
})

describe('los gráficos', () => {
  it('devuelven un SVG con las barras dentro', () => {
    const svg = actividadDiaria(
      ['L 27', 'M 28'],
      [
        { nombre: 'Revisiones', datos: [5, 4] },
        { nombre: 'Abiertas', datos: [3, 2] },
      ],
    )
    expect(svg).toMatch(/^<svg/)
    expect(svg).toContain('</svg>')
    // Con animación, las barras salen a media altura: el SVG congela el
    // fotograma en el que estuviera el dibujado.
    expect(svg).not.toContain('<animate')
    // Y los valores van escritos sobre la marca: en un papel no hay ratón, así
    // que la cifra que no está impresa no está.
    expect(svg).toContain('>5</text>')
    expect(svg).toContain('>L 27</text>')
  })
})

describe('los periodos que se comparan', () => {
  it('una semana laboral se compara con la semana laboral anterior', () => {
    expect(periodoAnterior({ start: '2026-07-27', end: '2026-07-31' })).toEqual({
      start: '2026-07-20',
      end: '2026-07-24',
    })
  })

  it('un mes completo, con el mes anterior entero', () => {
    // Los treinta días anteriores al 1 de junio empiezan el 2 de mayo y dejarían
    // fuera el día 1: mayo tendría una incidencia menos de las que tuvo.
    expect(periodoAnterior({ start: '2026-06-01', end: '2026-06-30' })).toEqual({
      start: '2026-05-01',
      end: '2026-05-31',
    })
  })

  it('cualquier otro rango, con el tramo de igual duración que termina antes', () => {
    expect(periodoAnterior({ start: '2026-07-15', end: '2026-07-23' })).toEqual({
      start: '2026-07-06',
      end: '2026-07-14',
    })
  })

  it('el tramo comparado se llama por su nombre, no por sus fechas', () => {
    expect(nombreComparacion({ start: '2026-07-30', end: '2026-07-30' })).toBe('el día anterior')
    expect(nombreComparacion({ start: '2026-07-27', end: '2026-07-31' })).toBe('la semana anterior')
    expect(nombreComparacion({ start: '2026-06-01', end: '2026-06-30' })).toBe('el mes anterior')
  })

  it('la etiqueta del eje diario cabe en un gráfico', () => {
    expect(etiquetaDia('2026-07-27')).toBe('L 27')
    expect(etiquetaDia('2026-07-29')).toBe('X 29')
  })
})

describe('los límites del periodo son medianoche de Madrid', () => {
  it('en verano, dos horas antes que en UTC', () => {
    expect(inicioDelDia('2026-07-27').toISOString()).toBe('2026-07-26T22:00:00.000Z')
  })

  it('en invierno, una', () => {
    expect(inicioDelDia('2026-01-15').toISOString()).toBe('2026-01-14T23:00:00.000Z')
  })

  it('el día del cambio de hora no se desplaza', () => {
    expect(inicioDelDia('2026-03-29').toISOString()).toBe('2026-03-28T23:00:00.000Z')
  })
})

describe('los días escritos para justificar', () => {
  it('un día largo se dice con sus horas, no redondeado', () => {
    // «3,5 días» invita a la siguiente pregunta; «3 días y 12 h» la cierra.
    expect(diasLargo(3.5)).toBe('3 días y 12 h')
    expect(diasLargo(24.09)).toBe('24 días y 2 h')
  })

  it('por debajo de un día se cuenta en horas, como lo cuenta quien estuvo allí', () => {
    expect(diasLargo(4 / 24)).toBe('4 h')
    expect(diasLargo(0.5)).toBe('12 h')
  })

  it('y por debajo de una hora, en minutos', () => {
    expect(diasLargo(20 / 1440)).toBe('20 min')
  })

  it('no dice nunca «3 días y 24 h»', () => {
    expect(diasLargo(2.999)).toBe('3 días')
    expect(diasLargo(3)).toBe('3 días')
  })

  it('un solo día no es «1 días»', () => {
    expect(diasLargo(1)).toBe('1 día')
  })
})

describe('las secciones que se pueden quitar y las que se pueden añadir', () => {
  const d = expedienteDePrueba()
  const lectura = lecturaCalculada(d)
  const con = (secciones: string[]): string =>
    renderReport(d, lectura, leerOpciones({ secciones }), { emitido: '31/07/2026, 9:14' })

  it('sin «tiempos», el informe no da la mediana', () => {
    // Es el motivo de que sea una sección aparte: una cifra que describe bien y
    // justifica mal, y a veces no se quiere dar.
    const todo = con([...SECCIONES])
    expect(todo).toContain('La mitad se cierra en')
    expect(con([...SECCIONES].filter((x) => x !== 'tiempos'))).not.toContain('La mitad se cierra en')
  })

  it('«cierres» pone cada uno con sus dos fechas y sus días', () => {
    const html = con(['cierres'])
    expect(html).toContain('Lámpara fundida en el aula 104')
    expect(html).toContain('24 días y 2 h')
    expect(html).toContain('Hubo que pedirla')
    // La que más tardó, primero: es por la que se pregunta.
    expect(html.indexOf('Lámpara fundida')).toBeLessThan(html.indexOf('Persiana atascada'))
  })

  it('un cierre sin explicación lo dice, en vez de dejar la celda en blanco', () => {
    expect(con(['cierres'])).toContain('no se apuntó qué se hizo')
  })

  it('«fotos» mete la imagen dentro del documento, no un enlace', () => {
    const html = con(['fotos'])
    expect(html).toContain('src="data:image/png;base64,')
    // Con su pie: una foto sin saber de dónde salió no prueba nada.
    expect(html).toContain('Proyector sin señal en el aula 102')
    // Y lo que no cabe se cuenta, en vez de recortar en silencio.
    expect(html).toMatch(/2 fotos más del periodo/)
  })

  /*
   * La misma imagen vale para «así estaba» y para «así lo dejamos». Sin decir
   * de cuándo es, una foto en un informe no demuestra nada — y son justo estas
   * tres palabras las que convierten dos fotos del mismo proyector en la prueba
   * de un trabajo hecho.
   */
  it('cada foto dice de qué momento es', () => {
    const html = con(['fotos'])
    expect(html).toContain('En la revisión')
    expect(html).toContain('Al resolverla')
    expect(html).toContain('Incidencia abierta')
  })

  it('la sección dice cuántas hay de cada momento', () => {
    const html = con(['fotos'])
    expect(html).toContain('1 de revisiones')
    expect(html).toContain('1 de incidencias abiertas')
    expect(html).toContain('1 de incidencias resueltas')
  })

  it('no nombra un momento del que no hay ninguna foto', () => {
    const soloRevision = renderReport(
      { ...d, fotos: d.fotos.filter((f) => f.momento === 'revision'), fotosTotal: 1 },
      lectura,
      leerOpciones({ secciones: ['fotos'] }),
      { emitido: '31/07/2026, 9:14' },
    )
    expect(soloRevision).toContain('1 de revisiones')
    expect(soloRevision).not.toContain('de incidencias resueltas')
  })

  /*
   * El edificio que se manda a la papelera al reorganizar el campus. Su trabajo
   * del periodo tiene que seguir contándose y verse marcado: un edificio
   * archivado con cinco revisiones no es un edificio sin revisar, y borrarlo de
   * la tabla dejaba el total de arriba sin cuadrar con la suma de las filas.
   */
  it('un edificio archivado sale en la cobertura, marcado y sin inventarse salas', () => {
    const html = con(['edificios'])
    // Con su marca, y con un guion donde iría el número de salas: un cero ahí
    // se leería como «este edificio no tiene aulas».
    expect(html).toContain('<span class="tenue">· archivado</span></td><td class="num">—</td>')
    expect(html).toContain('1 edificio archivado')
  })

  it('el alcance dice que hubo salas fuera de la lista de trabajo', () => {
    const html = con(['edificios'])
    expect(html).toContain('3 salas fuera de la lista de trabajo')
  })

  it('sin fotos no se imprime la sección: «no hay fotos» no informa', () => {
    const sinFotos = renderReport(
      { ...d, fotos: [], fotosTotal: 0 },
      lectura,
      leerOpciones({ secciones: ['fotos'] }),
      { emitido: '31/07/2026, 9:14' },
    )
    expect(sinFotos).not.toContain('Fotos del periodo')
  })
})

/**
 * La portada, que es lo único que lee mucha gente.
 *
 * Y el nombre del documento, que es además el nombre del fichero PDF: sale del
 * `<title>` cuando el navegador lo guarda.
 */
describe('cómo se presenta el informe', () => {
  const d = expedienteDePrueba()
  const portada = (kind: ReportData['kind']): string => {
    const x = { ...d, kind }
    return renderReport(x, lecturaCalculada(x), opcionesCompletas, {
      emitido: '31/07/2026, 9:14',
      solicitante: 'Eduardo Rubio',
    })
  }

  it('el de fechas elegidas a mano no es un traje: es el informe del periodo', () => {
    const html = portada('personalizado')
    expect(html).toContain('<title>Informe del periodo · del 27 al 31 de julio de 2026</title>')
    expect(html).not.toMatch(/a medida/i)
  })

  it('el periodo abre la línea, y una línea abre en mayúscula', () => {
    // El texto se guarda en minúscula porque casi siempre va detrás de algo.
    expect(d.periodoTexto).toBe('del 27 al 31 de julio de 2026')
    expect(portada('semanal')).toContain('Del 27 al 31 de julio de 2026 · emitido el')
  })

  it('quien lo pidió se dice como se dice hablando', () => {
    expect(portada('semanal')).toContain('lo pidió Eduardo Rubio')
  })

  it('no grita: ni versalitas de cartel ni párrafos justificados', () => {
    const html = portada('semanal')
    expect(html).not.toContain('text-transform: uppercase')
    expect(html).not.toContain('text-align: justify')
  })
})
