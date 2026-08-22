import { describe, expect, it } from 'vitest'
import { lecturaCalculada, senales } from './analisis'
import { SECCIONES, leerOpciones } from './opciones'
import { renderReport } from './plantilla'
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
      { code: 'H', name: 'EDIFICIO H', salas: 39, revisadas: 9, abiertas: 6, pendientes: 11 },
      { code: 'CRAI', name: 'CRAI', salas: 12, revisadas: 4, abiertas: 3, pendientes: 4 },
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
    expect(html).not.toMatch(/<img\s/i)
    // Ni fuentes, ni hojas de estilo, ni imágenes externas. El único `http` que
    // queda es el espacio de nombres del SVG, que no es una petición.
    expect(html).not.toMatch(/\ssrc=/i)
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
    }
    const lectura = lecturaCalculada(vacio)
    expect(lectura.titular).toBeTruthy()
    expect(lectura.entradilla).toBeTruthy()
    const salida = renderReport(vacio, lectura, opcionesCompletas, { emitido: '31/07/2026, 9:14' })
    expect(salida).toContain('Ningún movimiento registrado en el periodo')
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
