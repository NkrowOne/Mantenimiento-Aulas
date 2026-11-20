import { describe, expect, it } from 'vitest'
import { enPalabras, indicadores, lecturaCalculada, senales, titular } from './analisis'
import { SECCIONES, TOPE_ENFOQUE, leerOpciones } from './opciones'
import { diasLargo, renderReport, titularEnDosRenglones } from './plantilla'
import { RAMPA_DE_TIEMPOS, actividadDiaria, barraDeTramos, franjaDeTramos, tendencia, tintaSobre } from './graficos'
import { cifrasInventadas, configurarIA, encargo, expediente, formulasDelatoras, instruccion } from './ia'
import { MARCO_DEL_SERVICIO, NIVELES, fueraDeAlcance, insisteEnLaRonda, sinPedirPermiso } from './contrato'
import { etiquetaDia, nombreComparacion, nombreDia, periodoAnterior } from '../periodos'
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
      revisionesSinIncidencias: 12,
      registros: 11,
      incidencias: 7,
      solicitudes: 3,
      observaciones: 1,
      gravedadAlta: 2,
      // Una de las dos de gravedad alta sigue en curso: es el problema de
      // verdad que el informe tiene que seguir diciendo, sea para quien sea.
      gravedadAltaResueltas: 1,
      resueltas: 9,
      resueltasEnElDia: 4,
      salasAtendidas: 9,
      edificiosAtendidos: 3,
      materialConsumido: 24,
      articulosConsumidos: 4,
      salasConMaterial: 6,
      materialEntrado: 10,
    },
    antes: {
      revisiones: 31,
      salasRevisadas: 27,
      revisionesSinIncidencias: 25,
      registros: 14,
      incidencias: 9,
      solicitudes: 4,
      observaciones: 1,
      gravedadAlta: 1,
      gravedadAltaResueltas: 1,
      resueltas: 12,
      resueltasEnElDia: 6,
      salasAtendidas: 11,
      edificiosAtendidos: 3,
      materialConsumido: 30,
      articulosConsumidos: 5,
      salasConMaterial: 8,
      materialEntrado: 0,
    },
    situacion: {
      salasTotal: 276,
      incidenciasAbiertas: 23,
      estancadas: 4,
      lamparasAlLimite: 3,
      articulosBajoMinimo: 2,
      articulosEnAlmacen: 40,
      articulosConExistencias: 37,
      pcsDeRepuesto: 2,
    },
    serieDiaria: [
      { dia: '2026-07-27', revisiones: 5, abiertas: 3, resueltas: 1 },
      { dia: '2026-07-28', revisiones: 4, abiertas: 2, resueltas: 3 },
      { dia: '2026-07-29', revisiones: 3, abiertas: 1, resueltas: 2 },
      { dia: '2026-07-30', revisiones: 4, abiertas: 4, resueltas: 2 },
      { dia: '2026-07-31', revisiones: 2, abiertas: 1, resueltas: 1 },
    ],
    porEdificio: [
      { code: 'H', name: 'EDIFICIO H', salas: 39, revisadas: 9, abiertas: 6, cerradas: 5, atendidas: 5, pendientes: 11, archivado: false },
      { code: 'CRAI', name: 'CRAI', salas: 12, revisadas: 4, abiertas: 3, cerradas: 3, atendidas: 2, pendientes: 4, archivado: false },
      // Un edificio que ya no está en la lista de trabajo y en el que, aun así,
      // se trabajó durante el periodo: sin salas en servicio y con revisiones.
      { code: 'TM', name: 'TOMÁS MORO', salas: 0, revisadas: 5, abiertas: 2, cerradas: 1, atendidas: 2, pendientes: 1, archivado: true },
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
    resolucion: {
      resueltas: 9,
      medianaDias: 1.4,
      mediaDias: 6.2,
      enMenosDe48h: 6,
      tramos: { mismoDia: 4, hasta48h: 2, hastaUnaSemana: 2, mas: 1 },
    },
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
    materiales: [{ name: 'Cable HDMI 3 m', unidad: 'ud', consumido: 9, incidencias: 5, quedan: 3, minimo: 5 }],
    almacen: {
      movimientos: 12,
      salidas: 24,
      entradas: 10,
      porReponer: [
        { name: 'Cable HDMI 3 m', unidad: 'ud', quedan: 3, minimo: 5 },
        { name: 'Pilas AAA', unidad: 'ud', quedan: 2, minimo: 8 },
      ],
    },
    inventario: { confirmados: 2, equipos: 5 },
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

// El documento entero y sin filtro de audiencia: el parte del equipo.
const opcionesCompletas = leerOpciones({ secciones: [...SECCIONES], audiencia: 'equipo' })

/**
 * El orden del documento: primero lo que se argumenta, después lo que se consulta.
 *
 * Los listados largos —cada revisión, el diario, cada cierre y las fotos— iban
 * mezclados con el análisis, y con un periodo largo son trescientas filas entre
 * la entradilla y la primera conclusión. Ahora van al final, detrás de un corte.
 */
describe('los listados van al final, detrás del análisis', () => {
  const d = expedienteDePrueba()
  const html = renderReport(d, lecturaCalculada(d, 'equipo'), opcionesCompletas, {
    emitido: '31/07/2026, 9:14',
  })
  const donde = (texto: string): number => {
    const i = html.indexOf(texto)
    expect(i, `no está «${texto}»`).toBeGreaterThan(-1)
    return i
  }

  it('el análisis y las conclusiones van antes que las tablas', () => {
    expect(donde('Lo más destacado')).toBeLessThan(donde('Detalle del periodo'))
    expect(donde('Dónde se ha trabajado')).toBeLessThan(donde('Detalle del periodo'))
    expect(donde('Qué conviene hacer')).toBeLessThan(donde('Detalle del periodo'))
  })

  it('y las tablas largas, después del corte', () => {
    const corte = donde('Detalle del periodo')
    expect(donde('Revisiones del periodo')).toBeGreaterThan(corte)
    expect(donde('Diario del periodo')).toBeGreaterThan(corte)
    expect(donde('Cada cierre, con sus días')).toBeGreaterThan(corte)
  })

  it('sin ningún listado pedido no se imprime el corte, que no separaría nada', () => {
    const soloAnalisis = renderReport(
      d,
      lecturaCalculada(d, 'equipo'),
      leerOpciones({ secciones: ['resumen', 'analisis', 'edificios'], audiencia: 'equipo' }),
      { emitido: '31/07/2026, 9:14' },
    )
    expect(soloAnalisis).toContain('Dónde se ha trabajado')
    expect(soloAnalisis).not.toContain('Detalle del periodo')
  })

  it('con un solo listado el corte sí sale: dice dónde acaba lo que se lee', () => {
    const conDiario = renderReport(
      d,
      lecturaCalculada(d, 'equipo'),
      leerOpciones({ secciones: ['resumen', 'analisis', 'eventos'], audiencia: 'equipo' }),
      { emitido: '31/07/2026, 9:14' },
    )
    expect(conDiario.indexOf('Detalle del periodo')).toBeLessThan(
      conDiario.indexOf('Diario del periodo'),
    )
  })
})

/**
 * El orden del trabajo: lo último, primero.
 *
 * Un informe de un trimestre no cabe entero —el diario se corta a ciento
 * cincuenta apuntes— y lo que se caía era el final de la lista, que ordenada
 * por calendario es justo la semana pasada. Se pedía un informe largo para ver
 * lo último y lo último era lo que no salía.
 *
 * Los gráficos siguen el calendario: un eje de tiempo al revés no lo lee nadie.
 * Las listas de trabajo, no.
 */
describe('las listas de trabajo se leen por lo último', () => {
  const d = expedienteDePrueba()
  const html = renderReport(d, lecturaCalculada(d, 'equipo'), opcionesCompletas, {
    emitido: '31/07/2026, 9:14',
  })

  it('el diario abre por el día más reciente y cierra por el más antiguo', () => {
    const diario = html.slice(html.indexOf('Diario del periodo'))
    const primero = diario.indexOf(nombreDia('2026-07-31'))
    const ultimo = diario.indexOf(nombreDia('2026-07-27'))
    expect(primero).toBeGreaterThan(-1)
    expect(ultimo).toBeGreaterThan(-1)
    expect(primero).toBeLessThan(ultimo)
  })

  it('y lo dice en la cabecera de la sección, para que nadie lo dé por un error', () => {
    expect(html).toContain('lo último primero')
  })

  it('el gráfico de actividad sigue yendo del primer día al último', () => {
    const grafico = html.slice(html.indexOf('Actividad'), html.indexOf('Diario del periodo'))
    expect(grafico.indexOf('>L 27</text>')).toBeLessThan(grafico.indexOf('>V 31</text>'))
  })

  it('lo que no cabe son los movimientos ANTERIORES, y se dice cuáles', () => {
    // 27 movimientos en total y 1 en la lista: el resto no cabe.
    expect(html).toContain('anteriores a los que salen')
    expect(html).toContain('empezando por lo más reciente')
  })

  /*
   * Un día del que no sale ningún apunte no es lo mismo antes del corte que
   * después. Después —más reciente que el más viejo listado— es verdad que no
   * hubo nada. Antes, solo es que no cabía.
   */
  it('un día anterior al corte se marca recortado, y uno posterior no', () => {
    const diario = html.slice(html.indexOf('Diario del periodo'))
    const jornadaDe = (dia: string): string => {
      const i = diario.indexOf(nombreDia(dia))
      return diario.slice(i, i + 600)
    }
    // El único apunte del expediente es del 27, el día más viejo: del 28 en
    // adelante no hay nada que enseñar y eso es cierto, no un recorte.
    expect(jornadaDe('2026-07-31')).toContain('Solo revisiones')
    expect(jornadaDe('2026-07-31')).not.toContain('recortada por extensión')
  })
})

describe('el documento sale entero', () => {
  const d = expedienteDePrueba()
  const html = renderReport(d, lecturaCalculada(d, 'equipo'), opcionesCompletas, {
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
    expect(html).toContain('Partes atendidos')
    expect(html).toContain('Resueltos')
    expect(html).toContain('En menos de 48 h')
    expect(html).toContain('En seguimiento hoy')
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
        revisionesSinIncidencias: 0,
        registros: 0,
        incidencias: 0,
        solicitudes: 0,
        observaciones: 0,
        gravedadAlta: 0,
        gravedadAltaResueltas: 0,
        resueltas: 0,
        resueltasEnElDia: 0,
        salasAtendidas: 0,
        edificiosAtendidos: 0,
        materialConsumido: 0,
        articulosConsumidos: 0,
        salasConMaterial: 0,
        materialEntrado: 0,
      },
      resolucion: {
        resueltas: 0,
        medianaDias: null,
        mediaDias: null,
        enMenosDe48h: 0,
        tramos: { mismoDia: 0, hasta48h: 0, hastaUnaSemana: 0, mas: 0 },
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
    const lectura = lecturaCalculada(vacio, 'equipo')
    expect(lectura.titular).toBe('Periodo tranquilo, sin avisos nuevos')
    expect(lectura.entradilla).toBeTruthy()
    const salida = renderReport(vacio, lectura, opcionesCompletas, { emitido: '31/07/2026, 9:14' })
    expect(salida).toContain('Ningún movimiento registrado en el periodo')
    /*
     * Y no rellena con secciones que solo dicen que no hay nada: sin cierres no
     * hay rapidez que medir, y sin revisiones no hay tabla de revisiones. La
     * ronda es de campaña; una semana sin ella es una semana normal.
     */
    expect(salida).not.toContain('Con qué rapidez se resuelve')
    expect(salida).not.toContain('Revisiones del periodo')
    expect(salida).not.toMatch(/ninguna revisi[oó]n/i)
    // Un cero no se celebra: ninguna cifra de la cabecera va en verde ni en rojo.
    for (const i of indicadores(vacio, 'equipo').slice(0, 3)) expect(i.tono).toBe('neutro')
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
  const html = renderReport(d, lecturaCalculada(d, 'equipo'), opcionesCompletas, {
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

  /*
   * El colofón se quitó entero. Decía qué se quedaba fuera de la cuenta —salas
   * nunca revisadas, registros sin sala, salas archivadas—, y lo decía al final
   * de un documento que ya lo cuenta donde toca: las salas sin revisar están en
   * su sección, los registros sin sala en el desglose y las archivadas en el
   * maestro. Cerrar un informe de dirección con una lista de reparos es acabar
   * pidiendo disculpas por los datos que se acaban de presentar.
   */
  /*
   * La línea del pie va en el flujo para el navegador, que no imprime las cajas
   * de margen. WeasyPrint sí las imprime, así que allí se saca de la página:
   * dentro, cuando la última sección llenaba la hoja, el PDF salía con una
   * página más que no llevaba nada salvo esa línea.
   */
  it('el pie no puede quedarse solo en una página de más', () => {
    expect(html).toContain('<footer class="pie-marca">')
    expect(html).toMatch(/\.pie-marca \{[^}]*position: running\(pie-del-flujo\)/)
    expect(html).toContain('@bottom-left')
  })

  it('no cierra el documento con una lista de reparos', () => {
    expect(html).not.toContain('Alcance de los datos')
    expect(html).not.toContain('no entran en ningún indicador')
    expect(html).not.toContain('Informe parcial')
    expect(html).not.toContain('class="colofon"')
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
    return renderReport(ampliado, lecturaCalculada(ampliado, 'equipo'), opcionesCompletas, {
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
    const html = renderReport(parado, lecturaCalculada(parado, 'equipo'), opcionesCompletas, {
      emitido: '31/07/2026, 9:14',
    })
    expect(html).toContain('>X 29</text>')
    expect(html).not.toContain('fines de semana sin actividad')
  })
})

/**
 * El informe de dirección.
 *
 * Es el que llega al cliente, y se escribe para dar cuenta del trabajo con
 * buena imagen sin faltar a los datos. Lo que estas pruebas vigilan es la
 * regla en las dos direcciones: que no diga cuántos días lleva abierta nada ni
 * señale un aula, Y que los problemas de verdad sigan saliendo con su cifra.
 * Un informe que solo cumpliera la primera mitad sería un folleto.
 */
describe('el informe para dirección', () => {
  const d = expedienteDePrueba()
  const opcionesDireccion = leerOpciones({ secciones: [...SECCIONES], audiencia: 'direccion' })
  const pie = { emitido: '31/07/2026, 9:14' }

  it('el titular no es un reproche: abre por lo hecho, no por lo que falta', () => {
    const l = lecturaCalculada(d, 'direccion')
    expect(l.titular).not.toMatch(/semana abierta|días|sin cerrar/i)
    expect(l.titular).toBe('Nueve partes resueltos, 6 de ellos en menos de 48 horas')
    // Y el del equipo, igual: lo que sigue abierto tiene su cifra, su hallazgo y
    // su lista, pero no titula la semana en la que se han resuelto nueve partes.
    expect(lecturaCalculada(d, 'equipo').titular).toBe(l.titular)
  })

  it('y si se ha resuelto más de lo que ha entrado, el titular es ese', () => {
    const bueno: ReportData = {
      ...d,
      ahora: { ...d.ahora, resueltas: 14, gravedadAlta: 0, gravedadAltaResueltas: 0 },
    }
    const l = lecturaCalculada(bueno, 'direccion')
    expect(l.titular).toBe('14 partes resueltos, 3 más de los que entraron')
    // Las buenas noticias abren los hallazgos, con su cifra.
    expect(l.hallazgos[0]?.titulo).toBe('Se resuelve más de lo que entra')
    expect(l.hallazgos[0]?.cuerpo).toContain('14 partes resueltos por 11 nuevos')
    expect(l.hallazgos[0]?.clase).toBe('logro')
    // Y no tapan lo que pide una decisión: las lámparas siguen ahí.
    const lamparas = l.hallazgos.find((h) => h.titulo === '3 lámparas para cambiar antes de que se fundan')
    expect(lamparas?.clase).toBe('seguimiento')
    // Tres logros como mucho cuando hay tres cosas que decidir, aunque haya más.
    const se = senales(bueno, 'direccion')
    expect(se.filter((x) => x.tono === 'ok').length).toBeGreaterThan(3)
    expect(l.hallazgos.slice(0, 3).every((h) => h.clase === 'logro')).toBe(true)
    expect(l.hallazgos[3]?.clase).toBe('seguimiento')
  })

  it('no dice cuántos días lleva abierta nada, ni en la entradilla ni en los hallazgos', () => {
    const l = lecturaCalculada(d, 'direccion')
    const todo = [l.titular, l.entradilla, ...l.hallazgos.flatMap((h) => [h.titulo, h.cuerpo])].join(' ')
    expect(todo).not.toMatch(/más de una semana|sin cerrar|estancad|más antiguas|de más de 7 días/i)
    // Pero el saldo de hoy sí: es un dato, no un reproche.
    expect(l.entradilla).toContain('A día de hoy hay 23 incidencias en seguimiento.')
    expect(lecturaCalculada(d, 'equipo').entradilla).toContain('4 de ellas con más de una semana')
  })

  it('los problemas de verdad se dicen igual, con su cifra', () => {
    const se = senales(d, 'direccion')
    const claves = se.map((x) => x.clave)
    expect(claves).not.toContain('estancadas')
    expect(claves).not.toContain('sin-sala')
    expect(claves).toContain('gravedad')
    expect(claves).toContain('reincidencia')
    expect(claves).toContain('lamparas')
    expect(claves).toContain('concentracion')
    expect(se.find((x) => x.clave === 'gravedad')?.tono).toBe('critico')
    expect(se.map((s) => s.peso)).toEqual([...se.map((s) => s.peso)].sort((a, b) => a - b))
  })

  /*
   * De conjunto, y en la voz de quien hace el trabajo. Decían «Aprobar la
   * compra de lámparas» —el informe pidiéndole permiso al cliente por algo que
   * es literalmente nuestro encargo— y ahora dicen lo que vamos a hacer.
   */
  it('las recomendaciones son de conjunto y no piden permiso', () => {
    const l = lecturaCalculada(d, 'direccion')
    const acciones = l.recomendaciones.map((r) => r.accion)
    expect(acciones.some((a) => /Pedir las lámparas de repuesto/.test(a))).toBe(true)
    expect(acciones.some((a) => /Repasar la lista/.test(a))).toBe(false)
    // El parte del equipo sí la lleva, y la primera.
    expect(lecturaCalculada(d, 'equipo').recomendaciones[0]?.accion).toMatch(/Repasar la lista/)
    expect(acciones.some((a) => /^(Autorizar|Aprobar|Validar|Solicitar autorizaci)/.test(a))).toBe(false)
  })

  it('«En seguimiento hoy» da el saldo y no los días', () => {
    const dir = indicadores(d, 'direccion')[3]!
    const eq = indicadores(d, 'equipo')[3]!
    expect(dir.etiqueta).toBe('En seguimiento hoy')
    expect(dir.valor).toBe('23')
    expect(dir.detalle).toBe('trabajo en curso')
    expect(dir.tono).toBe('neutro')
    expect(eq.detalle).toBe('4 de más de 7 días')
    expect(eq.tono).toBe('critico')
  })

  it('«Sin cerrar» no se puede pedir para dirección, y las secciones por defecto son otras', () => {
    expect(leerOpciones({ secciones: ['estancadas', 'resumen'], audiencia: 'direccion' }).secciones).toEqual(['resumen'])
    // Solo la vetada: se cae al conjunto por defecto de dirección, no a un informe en blanco.
    const solo = leerOpciones({ secciones: ['estancadas'], audiencia: 'direccion' }).secciones
    expect(solo).not.toContain('estancadas')
    expect(solo).toContain('resumen')
    const defecto = leerOpciones({ audiencia: 'direccion' }).secciones
    for (const fuera of ['estancadas', 'revisiones', 'eventos', 'cierres', 'equipo']) {
      expect(defecto).not.toContain(fuera)
    }
    for (const dentro of ['resumen', 'analisis', 'edificios', 'fotos', 'tiempos', 'recomendaciones']) {
      expect(defecto).toContain(dentro)
    }
    // El equipo sí puede pedirla.
    expect(leerOpciones({ secciones: ['estancadas'], audiencia: 'equipo' }).secciones).toEqual(['estancadas'])
  })

  it('el documento no imprime días abiertos ni salas señaladas, y dice para quién es', () => {
    const html = renderReport(d, lecturaCalculada(d, 'direccion'), opcionesDireccion, pie)
    expect(html).toContain('para dirección')
    expect(html).not.toContain('Sin cerrar')
    expect(html).not.toContain('más de siete días')
    expect(html).not.toContain('de más de 7 días')
    expect(html).not.toContain('arrastrando las antiguas')
    expect(html).not.toContain('Salas señaladas')
    expect(html).toContain('Propuestas de mejora')
    // La pieza repetida sí: es una mejora concreta, con su sala.
    expect(html).toContain('Dónde hay una mejora clara')
    expect(html).toContain('Mismo repuesto, misma sala')
    expect(html).toContain('Cable HDMI 3 m')
    // Y gravedad alta también.
    expect(html).toContain('de gravedad alta')
  })

  it('el parte del equipo sigue diciéndolo todo', () => {
    const html = renderReport(d, lecturaCalculada(d, 'equipo'), opcionesCompletas, pie)
    expect(html).toContain('para el equipo técnico')
    expect(html).toContain('Sin cerrar')
    expect(html).toContain('Salas señaladas')
    expect(html).toContain('Qué conviene hacer')
    expect(html).toContain('4 de más de 7 días')
  })

  it('al modelo no se le dan los datos que el documento no dice', () => {
    const dir = expediente(d, senales(d, 'direccion'), 'direccion')
    expect(dir).not.toContain('LAS MÁS ANTIGUAS SIN CERRAR')
    expect(dir).not.toContain('de ellas con más de 7 días')
    expect(dir).not.toContain('SALAS CON MÁS INCIDENCIAS')
    // Los datos que sí se cuentan viajan igual.
    expect(dir).toContain('de gravedad alta: 2')
    expect(dir).toContain('LÁMPARAS AL LÍMITE')
    const eq = expediente(d, senales(d, 'equipo'), 'equipo')
    expect(eq).toContain('LAS MÁS ANTIGUAS SIN CERRAR')
    expect(eq).toContain('de ellas con más de 7 días: 4')
  })

  it('la instrucción del sistema lleva la regla escrita', () => {
    expect(instruccion('direccion')).toContain('No se dice cuántos días lleva abierta una incidencia')
    expect(instruccion('direccion')).toContain('Los problemas reales sí se dicen')
    expect(instruccion('equipo')).not.toContain('No se dice cuántos días')
    expect(instruccion('equipo')).toContain('lo grave primero')
  })

})

/**
 * De qué habla el informe: de lo que el servicio hace todos los días.
 *
 * Medía el servicio por la ronda de revisión —«revisiones» era la primera cifra
 * y «reforzar la ronda» la primera recomendación—, y la revisión de aulas es de
 * campaña: antes del comienzo de curso, en Navidad y en Semana Santa. Una semana
 * normal, con sus partes atendidos y resueltos, se titulaba «Cero salas
 * revisadas». Estas pruebas vigilan las dos mitades: que una semana sin
 * revisiones no las nombre, y que la semana de la campaña sí las cuente.
 */
describe('las revisiones son de campaña, no de todas las semanas', () => {
  const d = expedienteDePrueba()
  const sinRonda: ReportData = {
    ...d,
    ahora: { ...d.ahora, revisiones: 0, salasRevisadas: 0, revisionesSinIncidencias: 0 },
    serieDiaria: d.serieDiaria.map((x) => ({ ...x, revisiones: 0 })),
    porEdificio: d.porEdificio.map((b) => ({ ...b, revisadas: 0 })),
    equipo: d.equipo.map((p) => ({ ...p, revisiones: 0 })),
    revisiones: [],
    revisionesTotal: 0,
  }
  // «Plantear una revisión de conjunto del edificio H» no es la ronda, y pasa.
  const QUEJA = /revisad|revisiones|ronda|del campus|cobertura|sin revisar/i

  it('una semana sin revisiones no las nombra: ni en el texto ni en las cifras', () => {
    for (const audiencia of ['direccion', 'equipo'] as const) {
      const l = lecturaCalculada(sinRonda, audiencia)
      const todo = [
        l.titular,
        l.entradilla,
        ...l.hallazgos.flatMap((h) => [h.titulo, h.cuerpo]),
        ...l.recomendaciones.flatMap((r) => [r.accion, r.porque]),
        ...indicadores(sinRonda, audiencia).flatMap((i) => [i.etiqueta, i.detalle]),
        ...senales(sinRonda, audiencia).flatMap((x) => [x.titulo, x.cuerpo, x.accion ?? '']),
      ].join(' ')
      expect(todo, audiencia).not.toMatch(QUEJA)
    }
  })

  it('ni el documento: sin columna de revisadas, sin serie a cero y sin sección vacía', () => {
    const html = renderReport(sinRonda, lecturaCalculada(sinRonda, 'equipo'), opcionesCompletas, {
      emitido: '31/07/2026, 9:14',
    })
    // El cuerpo, sin la hoja de estilos, que tiene sus propios comentarios.
    const cuerpo = html.slice(html.indexOf('<body>'))
    expect(cuerpo).not.toContain('Revisiones')
    expect(cuerpo).not.toContain('Aulas revisadas')
    expect(cuerpo).not.toContain('Revisiones del periodo')
    expect(cuerpo).not.toMatch(/del campus|sin revisar|ninguna revisi/i)
    // El gráfico sigue, con sus dos series.
    expect(cuerpo).toContain('Entran')
    expect(cuerpo).toContain('Se resuelven')
  })

  it('la semana de la campaña sí las cuenta, como una puesta a punto hecha', () => {
    const se = senales(d, 'direccion')
    const puesta = se.find((x) => x.clave === 'puesta-a-punto')
    expect(puesta?.titulo).toBe('Puesta a punto: 16 aulas revisadas')
    expect(puesta?.cuerpo).toBe('18 revisiones completadas en el periodo, 12 de ellas sin ninguna incidencia.')
    expect(puesta?.tono).toBe('ok')
    // Sin denominador: ni porcentaje del campus ni vuelta pendiente.
    expect(`${puesta?.titulo} ${puesta?.cuerpo}`).not.toMatch(/%|campus|faltan|pendiente/i)
    expect(lecturaCalculada(d, 'direccion').entradilla).toContain(
      'Además, se han revisado 16 aulas dentro de la puesta a punto.',
    )
    const html = renderReport(d, lecturaCalculada(d, 'equipo'), opcionesCompletas, { emitido: '31/07/2026, 9:14' })
    expect(html).toContain('Aulas revisadas')
    expect(html).toContain('Revisiones del periodo')
  })

  it('ya no hay aviso de cobertura ni de salas sin revisar, para nadie', () => {
    for (const audiencia of ['direccion', 'equipo'] as const) {
      const claves = senales(d, audiencia).map((x) => x.clave)
      expect(claves).not.toContain('cobertura')
      expect(claves).not.toContain('nunca-revisadas')
    }
  })

  it('al modelo tampoco se le da de dónde sacarlo', () => {
    const texto = expediente(sinRonda, senales(sinRonda, 'direccion'), 'direccion')
    expect(texto).not.toMatch(/revisi|nunca revisadas|sin revisar/i)
    // Y con campaña, el dato viaja como lo que es.
    expect(expediente(d, senales(d, 'direccion'), 'direccion')).toContain(
      'revisiones de aula completadas (campaña de puesta a punto): 18, en 16 aulas; 12 sin ninguna incidencia',
    )
  })

  it('la instrucción lleva la regla, y el marco dice cuándo se revisa', () => {
    for (const audiencia of ['direccion', 'equipo'] as const) {
      expect(instruccion(audiencia)).toContain('La ronda de revisión se hace por campañas')
      expect(instruccion(audiencia)).toContain('Nunca se habla de la cobertura del campus')
    }
    expect(MARCO_DEL_SERVICIO).toContain('La revisión de las aulas se hace en esas campañas y no todas las semanas')
  })

  it('y si aun así el texto lo cuenta como una falta, se caza', () => {
    expect(insisteEnLaRonda('Conviene reforzar la ronda del edificio P')).toBe('reforzar la ronda')
    expect(insisteEnLaRonda('La cobertura del campus es baja')).toBe('cobertura del campus')
    expect(insisteEnLaRonda('Quedan 41 salas sin revisar')).toMatch(/salas sin revisar/)
    expect(insisteEnLaRonda('No se ha hecho ninguna revisión en el periodo')).toBeTruthy()
    // Contar una revisión hecha sí es del informe.
    expect(insisteEnLaRonda('Se han revisado 16 aulas dentro de la puesta a punto')).toBeNull()
    expect(insisteEnLaRonda('Revisar la instalación de H 2.1 en vez de reponer el cable')).toBeNull()
  })
})

/**
 * El titular y las cuatro cifras: lo que se lee aunque no se lea nada más.
 */
describe('el titular dice lo hecho, con su cifra', () => {
  const d = expedienteDePrueba()
  const con = (ahora: Partial<ReportData['ahora']>, resolucion?: Partial<ReportData['resolucion']>): ReportData => ({
    ...d,
    ahora: { ...d.ahora, ...ahora },
    resolucion: { ...d.resolucion, ...resolucion },
  })

  it('más cierres que entradas: el saldo', () => {
    expect(titular(con({ resueltas: 12, registros: 9 }))).toBe('Doce partes resueltos, 3 más de los que entraron')
  })

  it('la mitad o más el mismo día: lo dice', () => {
    const t = { mismoDia: 5, hasta48h: 1, hastaUnaSemana: 2, mas: 1 }
    expect(titular(con({}, { tramos: t }))).toBe('Nueve partes resueltos, 5 de ellos el mismo día')
    const todos = { mismoDia: 9, hasta48h: 0, hastaUnaSemana: 0, mas: 0 }
    expect(titular(con({}, { tramos: todos, enMenosDe48h: 9 }))).toBe('Nueve partes resueltos, todos el mismo día')
  })

  it('con dos cierres no presume de ritmo: es una anécdota', () => {
    const pocos = con(
      { resueltas: 2 },
      { resueltas: 2, enMenosDe48h: 2, tramos: { mismoDia: 2, hasta48h: 0, hastaUnaSemana: 0, mas: 0 } },
    )
    expect(titular(pocos)).toBe('Once partes atendidos y 2 resueltos')
  })

  it('sin cierres, lo atendido y dónde; sin nada, lo dice sin dramatismo', () => {
    expect(titular(con({ resueltas: 0 }))).toBe('Once partes atendidos en 9 aulas de 3 edificios')
    expect(titular(con({ resueltas: 0, registros: 0, revisiones: 0 }))).toBe('Periodo tranquilo, sin avisos nuevos')
    expect(titular(con({ resueltas: 3, registros: 0 }))).toBe('Tres partes resueltos y ningún aviso nuevo')
    // Solo campaña: las aulas revisadas son la noticia.
    expect(titular(con({ resueltas: 0, registros: 0 }))).toBe('16 aulas revisadas en la puesta a punto')
  })

  it('el número del principio va en letra, y el uno concuerda', () => {
    expect(enPalabras('1 parte resuelto', 'm')).toBe('Un parte resuelto')
    expect(enPalabras('1 incidencia de gravedad alta')).toBe('Una incidencia de gravedad alta')
    expect(enPalabras('12 partes resueltos', 'm')).toBe('Doce partes resueltos')
    // Más allá de doce, la cifra se lee mejor que la palabra.
    expect(enPalabras('13 partes resueltos', 'm')).toBe('13 partes resueltos')
  })

  it('un titular de dos renglones se parte por la mitad, no deja una palabra sola', () => {
    expect(titularEnDosRenglones('Periodo tranquilo, sin avisos nuevos')).toBe('Periodo tranquilo, sin avisos nuevos')
    expect(titularEnDosRenglones('Doce partes resueltos, 8 de ellos el mismo día')).toBe(
      'Doce partes resueltos,<br>8 de ellos el mismo día',
    )
    // Una coma cerca de la mitad gana al espacio que cae justo en la mitad: el
    // «10» no se queda colgando del primer renglón.
    expect(titularEnDosRenglones('13 partes resueltos, 10 de ellos el mismo día')).toBe(
      '13 partes resueltos,<br>10 de ellos el mismo día',
    )
    // Sin pausa cerca, por el espacio más próximo a la mitad.
    expect(titularEnDosRenglones('Once partes atendidos en 9 aulas de 3 edificios')).toBe(
      'Once partes atendidos en<br>9 aulas de 3 edificios',
    )
    // Y lo que llega se escapa: el titular puede venir de un modelo.
    expect(titularEnDosRenglones('Más cierres <b>que</b> la semana anterior, y todos en plazo')).not.toContain('<b>')
  })

  it('las cuatro cifras son las de un servicio de soporte, y no hay revisiones entre ellas', () => {
    const inds = indicadores(d, 'direccion')
    expect(inds.map((i) => i.etiqueta)).toEqual([
      'Partes atendidos',
      'Resueltos',
      'En menos de 48 h',
      'En seguimiento hoy',
    ])
    expect(inds[0]?.valor).toBe('11')
    expect(inds[0]?.detalle).toBe('en 9 aulas de 3 edificios')
    // Que entren más o menos partes no es ni bueno ni malo: va sin color.
    expect(inds[0]?.delta?.neutra).toBe(true)
    expect(inds[1]?.valor).toBe('9')
    expect(inds[1]?.detalle).toBe('82 % de lo que entró')
    expect(inds[2]?.valor).toBe('67 %')
    expect(inds[2]?.detalle).toBe('6 de 9 cierres · la mitad, en 1,4 días o menos')
  })

  it('sin «tiempos», ni la cabecera ni el análisis dan cuánto se tarda', () => {
    const sin = { tiempos: false }
    const inds = indicadores(d, 'direccion', sin)
    expect(inds.map((i) => i.etiqueta)).toContain('Aulas atendidas')
    expect(inds.map((i) => i.etiqueta)).not.toContain('En menos de 48 h')
    const l = lecturaCalculada(d, 'direccion', sin)
    const todo = [l.titular, l.entradilla, ...l.hallazgos.flatMap((h) => [h.titulo, h.cuerpo])].join(' ')
    expect(todo).not.toMatch(/48 h|mismo día|la mitad/i)
    expect(expediente(d, senales(d, 'direccion', sin), 'direccion', sin)).not.toMatch(
      /mediana|48 h|resueltos el mismo día/,
    )
  })
})

describe('lo que se pinta sin IA', () => {
  it('la redacción calculada trae titular, entradilla y acciones', () => {
    const l = lecturaCalculada(expedienteDePrueba(), 'equipo')
    expect(l.titular).toMatch(/partes resueltos/)
    expect(l.entradilla).toBe(
      'Se han atendido 11 partes —7 incidencias, 3 solicitudes y 1 observación— en 9 aulas de 3 edificios. ' +
        'Se han resuelto 9, 6 de ellos en menos de 48 horas. ' +
        'Del almacén han salido 24 unidades de material para 6 aulas. ' +
        'Además, se han revisado 16 aulas dentro de la puesta a punto. ' +
        'A día de hoy hay 23 incidencias en seguimiento, 4 de ellas con más de una semana.',
    )
    // Para el equipo, primero lo que hay que hacer; los logros, detrás.
    expect(l.hallazgos[0]?.clase).toBe('seguimiento')
    expect(l.hallazgos[0]?.titulo).toMatch(/sin cerrar desde hace más de una semana/)
    expect(l.hallazgos[l.hallazgos.length - 1]?.clase).toBe('logro')
    expect(l.hallazgos.length).toBeGreaterThan(0)
    expect(l.recomendaciones.length).toBeGreaterThan(0)
    expect(l.origen).toMatch(/sin IA/)
  })

  it('las señales salen ordenadas por peso, lo grave primero', () => {
    const se = senales(expedienteDePrueba(), 'equipo')
    expect(se[0]?.clave).toBe('estancadas')
    expect(se.map((s) => s.peso)).toEqual([...se.map((s) => s.peso)].sort((a, b) => a - b))
  })
})

describe('el expediente que sale hacia Gemini', () => {
  const d = expedienteDePrueba()
  const texto = expediente(d, senales(d, 'equipo'), 'equipo')

  it('lleva las cifras del periodo y las de hoy', () => {
    expect(texto).toContain('partes atendidos (los que entraron): 11 (antes 14)')
    expect(texto).toContain('partes resueltos (cerrados): 9 (antes 12)')
    expect(texto).toContain('incidencias abiertas en total, en seguimiento: 23')
    // El almacén también viaja: lo que se sirvió, lo que queda y lo que falta.
    expect(texto).toContain('unidades de material servidas desde el almacén: 24 (antes 30); 4 artículos distintos, para 6 aulas')
    expect(texto).toContain('- Cable HDMI 3 m: 9 ud; quedan 3')
    expect(texto).toContain('- Pilas AAA: quedan 2 ud, mínimo 8')
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

  /*
   * ECharts escribe el estilo de cada texto en un atributo entre comillas
   * dobles y no escapa lo que le llega. Con la familia entre comillas dobles,
   * el atributo se cerraba en la primera: `font-family:` quedaba sin valor y
   * los ejes de todos los gráficos salían con la letra por defecto del visor.
   */
  it('la letra de los ejes llega entera al SVG', () => {
    for (const svg of [
      actividadDiaria(['L 27'], [{ nombre: 'Entran', datos: [5] }]),
      tendencia(['26-06', '26-07'], [41, 38]),
    ]) {
      expect(svg).toContain("font-family:'IBM Plex Sans'")
      expect(svg).not.toMatch(/font-family:"/)
      expect(svg).not.toMatch(/font-family:;|font-family:"\s/)
    }
  })

  it('la tendencia solo marca el último punto, que es el que lleva cifra', () => {
    const svg = tendencia(['26-05', '26-06', '26-07'], [30, 41, 38])
    expect(svg).toContain('>38</text>')
    expect(svg).not.toContain('>41</text>')
  })

  it('una barra de tramos reparte el ancho y deja su hueco entre tramo y tramo', () => {
    const { svg, sinCifra } = barraDeTramos(
      [
        { nombre: 'El mismo día', valor: 8, color: '#0B6B70' },
        { nombre: 'En menos de 48 h', valor: 2, color: '#3D9499' },
        { nombre: 'Después', valor: 0, color: '#8ABFC2' },
      ],
      { width: 302, alto: 28 },
    )
    // Dos tramos vivos: 300 px de dato y 2 de papel entre ellos.
    expect(svg.match(/<rect /g)).toHaveLength(2)
    expect(svg).toContain('width="240.00"')
    expect(svg).toContain('x="242.00"')
    // Un tramo a cero no dibuja nada, y las cifras que caben van dentro.
    expect(svg).toContain('>8</text>')
    expect(svg).toContain('>2</text>')
    expect(sinCifra.size).toBe(0)
  })

  it('la cifra que no cabe en su tramo no se corta: se queda fuera y se dice cuál', () => {
    const { svg, sinCifra } = barraDeTramos(
      [
        { nombre: 'El mismo día', valor: 98, color: '#0B6B70' },
        { nombre: 'Después', valor: 2, color: '#8ABFC2' },
      ],
      { width: 300, alto: 28 },
    )
    expect(svg).toContain('>98</text>')
    expect(svg).not.toContain('>2</text>')
    expect([...sinCifra]).toEqual(['Después'])
  })

  /*
   * La cifra de dentro de un tramo va en blanco o en tinta, la que más
   * contraste dé. Un umbral a ojo fallaba justo en el tono intermedio de la
   * rampa: blanco sobre él no llega a 3,6:1.
   */
  it('la cifra de cada tramo va en la tinta que mejor se lee sobre su fondo', () => {
    expect(RAMPA_DE_TIEMPOS.map(tintaSobre)).toEqual(['#FFFFFF', '#FFFFFF', '#1A2226', '#1A2226'])
  })

  it('sin nada que repartir no hay figura, ni una barra gris de adorno', () => {
    expect(barraDeTramos([{ nombre: 'x', valor: 0, color: '#000000' }]).svg).toBe('')
    expect(franjaDeTramos([])).toBe('')
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
  const lectura = lecturaCalculada(d, 'equipo')
  const con = (secciones: string[]): string =>
    renderReport(d, lectura, leerOpciones({ secciones }), { emitido: '31/07/2026, 9:14' })

  it('sin «tiempos», el informe no da la mediana', () => {
    // Es el motivo de que sea una sección aparte: una cifra que describe bien y
    // justifica mal, y a veces no se quiere dar.
    const todo = con([...SECCIONES])
    expect(todo).toContain('La mitad se cierra en')
    expect(todo).toContain('Con qué rapidez se resuelve')
    const sin = con([...SECCIONES].filter((x) => x !== 'tiempos'))
    expect(sin).not.toContain('La mitad se cierra en')
    expect(sin).not.toContain('Con qué rapidez se resuelve')
    // Ni en la cabecera: la tercera cifra pasa a ser dónde se ha trabajado.
    expect(sin).not.toContain('En menos de 48 h')
    expect(sin).toContain('Aulas atendidas')
  })

  /*
   * Los cierres, repartidos por lo que llevaron. El equipo ve los cuatro
   * tramos; dirección, tres —«después» no necesita desglosarse— y sin la
   * media, que la arrastra cualquier parte antiguo que se cierre esta semana.
   */
  it('«tiempos» reparte los cierres por tramos, y dirección no lleva los días', () => {
    const equipo = renderReport(
      d,
      lecturaCalculada(d, 'equipo'),
      leerOpciones({ secciones: ['tiempos'], audiencia: 'equipo' }),
      { emitido: '31/07/2026, 9:14' },
    )
    for (const tramo of ['El mismo día', 'En menos de 48 h', 'En la semana', 'Más de una semana']) {
      expect(equipo).toContain(tramo)
    }
    expect(equipo).toContain('Media, arrastrando las antiguas')
    const direccion = renderReport(
      d,
      lecturaCalculada(d, 'direccion'),
      leerOpciones({ secciones: ['tiempos'], audiencia: 'direccion' }),
      { emitido: '31/07/2026, 9:14' },
    )
    expect(direccion).toContain('Después')
    expect(direccion).not.toContain('Más de una semana')
    expect(direccion).not.toContain('arrastrando las antiguas')
  })

  /*
   * El almacén, en el documento: lo que se ha servido con lo que queda al lado,
   * el almacén de hoy y lo que hay que reponer. Y la remisión al Excel, que es
   * donde va el detalle.
   */
  it('«materiales» cuenta lo servido, lo que queda y lo que hay que reponer', () => {
    const html = con(['materiales'])
    expect(html).toContain('Material y almacén')
    expect(html).toContain('Lo que se ha servido')
    expect(html).toContain('El almacén, hoy')
    expect(html).toContain('<b>37</b> de 40')
    expect(html).toContain('Para reponer')
    expect(html).toContain('<b>2</b> de 8 ud')
    expect(html).toContain('El detalle va en el Excel que acompaña a este informe')
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

  it('la incidencia y su cierre salen enteros en el diario, sin «…» a media frase', () => {
    const largo =
      'No se proyecta la pantalla del ordenador del aula aunque el cable HDMI está conectado y el proyector enciende'
    const solucion =
      'Se le indica al usuario por teléfono cómo duplicar la pantalla con Windows y P, y se comprueba que ya proyecta'
    const html = renderReport(
      {
        ...d,
        eventos: [
          { ...d.eventos[0]!, tipo: 'cierre', titulo: largo, detalle: solucion },
          { ...d.eventos[0]!, tipo: 'apertura', titulo: largo, detalle: null },
        ],
      },
      lectura,
      leerOpciones({ secciones: ['eventos'] }),
      { emitido: '31/07/2026, 9:14' },
    )
    expect(html.split(largo).length - 1).toBe(2)
    expect(html).toContain(solucion)
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
  it('un edificio archivado sale en la tabla, marcado y con lo que se hizo en él', () => {
    const html = con(['edificios'])
    // Con su marca, y con sus cifras del periodo: dos aulas atendidas, dos
    // partes que entraron y uno resuelto.
    expect(html).toContain(
      '<span class="tenue">· archivado</span></td><td class="num">2</td><td class="num">2</td><td class="num">1</td>',
    )
    expect(html).toContain('1 edificio archivado')
    // Y el total cuenta el campus entero, archivados incluidos.
    expect(html).toContain('Todo el campus</td><td class="num">9</td><td class="num">11</td><td class="num">9</td>')
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
    return renderReport(x, lecturaCalculada(x, 'equipo'), opcionesCompletas, {
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

/**
 * El encargo, delante del que redacta.
 *
 * La IA se tomaba libertades: sin saber dónde acaba el contrato, recomendaba
 * implantar una herramienta de tickets —que la pone la universidad y ya está en
 * uso—, renegociar los plazos o reforzar la plantilla. Eso no lo decide este
 * servicio, y el informe se lo entregaba al cliente como si fuera nuestro.
 */
describe('el informe se escribe dentro del contrato', () => {
  it('el marco del servicio viaja en la instrucción, sea para quien sea', () => {
    for (const audiencia of ['direccion', 'equipo'] as const) {
      const i = instruccion(audiencia)
      expect(i).toContain('EL SERVICIO DEL QUE HABLA ESTE INFORME')
      expect(i).toContain('Qué NO es este servicio')
      // Y sigue llevando lo suyo: el marco se suma, no sustituye.
      expect(i).toContain('Prohibido, sin excepciones')
    }
  })

  it('dice los plazos del pliego, y que son un porcentaje de casos y no un siempre', () => {
    expect(MARCO_DEL_SERVICIO).toContain('se atiende en 5 minutos y se resuelve en 10, en el 96 %')
    expect(MARCO_DEL_SERVICIO).toContain('2 horas para resolver, en el 93 %')
    expect(MARCO_DEL_SERVICIO).toContain('26 horas para resolver, en el 92 %')
    expect(MARCO_DEL_SERVICIO).toContain('porcentaje de casos al mes, no un «siempre»')
    // Y la tabla que sostiene esas frases dice lo mismo.
    expect(NIVELES.map((n) => n.criticidad)).toEqual(['Crítica', 'Alta', 'Media', 'Baja'])
    expect(NIVELES.every((n) => n.respuesta === '5 minutos')).toBe(true)
  })

  it('caza lo que se sale del encargo, y dice qué era', () => {
    const casos: Array<[string, string]> = [
      ['Renegociar el SLA de criticidad alta con la universidad', 'el contrato'],
      ['Conviene reforzar la plantilla del servicio en septiembre', 'la plantilla'],
      ['Implantar una herramienta de ticketing que centralice las peticiones', 'herramientas'],
      ['Revisar la infraestructura de red del campus', 'la red'],
      ['Acometer la reforma del aula 1.7 y su instalación eléctrica', 'obra'],
    ]
    for (const [texto, esperado] of casos) {
      const fuera = fueraDeAlcance(texto)
      expect(fuera.length, texto).toBeGreaterThan(0)
      expect(fuera[0]!.que).toContain(esperado)
      expect(texto).toContain(fuera[0]!.dice)
    }
  })

  /*
   * Y no muerde lo que sí es del servicio, que es la mitad del trabajo: un
   * guardián que tumba las recomendaciones buenas deja el informe sin ninguna.
   */
  it('deja pasar lo que sí decide el servicio', () => {
    const buenas = [
      'Reponer las lámparas por debajo del 20 % antes del comienzo de curso',
      'Sustituir el proyector del aula 1.7, que ha dado tres avisos en el mes',
      'Adelantar la ronda del edificio H, que concentra lo abierto',
      'Pasar la puesta a punto de los laboratorios antes de Semana Santa',
      'Aprobar la compra de cuatro lámparas NP30, que quedan dos en almacén',
      'Revisar el aula 2.1 tras el cambio de ordenador',
    ]
    for (const b of buenas) expect(fueraDeAlcance(b), b).toEqual([])
  })
})

/*
 * Y en la voz de quien hace el trabajo.
 *
 * «Autorizar la sustitución de las seis lámparas» es lo que sale cuando al
 * modelo se le dice que el informe lo lee la dirección de la universidad:
 * deduce que quien lee es quien decide y convierte nuestro encargo en una
 * petición de permiso. El cliente lo lee y entiende que nos está bloqueando.
 */
describe('las recomendaciones no piden permiso para el trabajo propio', () => {
  it('endereza la frase y deja la acción en infinitivo', () => {
    const casos: Array<[string, string]> = [
      [
        'Autorizar la sustitución de las 6 lámparas de proyector por debajo del 20 %',
        'Sustituir las 6 lámparas de proyector por debajo del 20 %',
      ],
      ['Aprobar la reposición de lo que está por debajo del mínimo', 'Reponer lo que está por debajo del mínimo'],
      ['Autorizar la compra de 12 cables HDMI de 3 m', 'Pedir 12 cables HDMI de 3 m'],
      ['Validar el cambio de los proyectores del edificio H', 'Cambiar los proyectores del edificio H'],
      [
        'Solicitar autorización para sustituir el proyector del aula 1.7',
        'Sustituir el proyector del aula 1.7',
      ],
      ['Dar el visto bueno a reforzar la ronda del edificio P', 'Reforzar la ronda del edificio P'],
    ]
    for (const [antes, despues] of casos) {
      expect(sinPedirPermiso(antes), antes).toBe(despues)
    }
  })

  /*
   * Y no toca lo que ya está bien, que es la mitad del trabajo: una acción
   * recortada de más dice otra cosa, y aquí se está reescribiendo un informe
   * que va al cliente.
   */
  it('deja intacto lo que ya está en voz de quien hace', () => {
    const buenas = [
      'Sustituir las 6 lámparas de proyector por debajo del 20 % de vida',
      'Priorizar el cierre de las 8 incidencias pendientes en el edificio P',
      'Programar la revisión inicial de las 31 salas sin inspección registrada',
      'Reponer lo que está por debajo del mínimo antes del próximo lunes',
      'Repasar la lista de estancadas y cerrar o reasignar cada una.',
    ]
    for (const b of buenas) expect(sinPedirPermiso(b), b).toBe(b)
  })

  // Una fórmula que no está en la tabla sale tal cual: una frase rara con
  // sentido es mejor que una recortada sin él.
  it('no inventa cuando no entiende la fórmula del todo', () => {
    const raro = 'Autorizar el despliegue de una segunda ronda semanal'
    expect(sinPedirPermiso(raro)).toBe(raro)
  })

  it('la instrucción de dirección lo dice, y el marco también', () => {
    const i = instruccion('direccion')
    expect(i).toContain('en la voz de quien hace el trabajo')
    expect(i).toContain('Nunca «Autorizar»')
    expect(MARCO_DEL_SERVICIO).toContain('El servicio no se pide permiso a sí mismo')
  })
})

/*
 * La instrucción de quien pide el informe, que ahora cabe entera.
 *
 * Era una línea de 400 caracteres y ahora son 1500 en una caja de siete
 * líneas, porque el contexto que no está en ninguna tabla —la obra del
 * edificio H, lo que se habló el lunes— es media página y no una frase.
 */
describe('lo que se le cuenta a la IA cabe y llega entero', () => {
  it('el tope es uno solo y no se recorta lo que la caja deja escribir', () => {
    const largo = 'a'.repeat(TOPE_ENFOQUE)
    const o = leerOpciones({ secciones: [...SECCIONES], audiencia: 'equipo', enfoque: largo })
    expect(o.enfoque).toHaveLength(TOPE_ENFOQUE)
    // Y lo que pasa del tope sí se recorta, que para eso está.
    const pasado = leerOpciones({ secciones: [...SECCIONES], enfoque: 'a'.repeat(TOPE_ENFOQUE + 500) })
    expect(pasado.enfoque).toHaveLength(TOPE_ENFOQUE)
  })

  /*
   * Y sangrada. La instrucción vive dentro de una lista de condiciones con
   * guiones: sin sangrar, la segunda línea de lo que escribió una persona
   * parece una condición más del sistema.
   */
  it('las varias líneas van sangradas bajo su guion', () => {
    const d = expedienteDePrueba()
    const texto = encargo(d, senales(d, 'equipo'), {
      clave: 'x',
      modelo: 'm',
      thinking: 'low',
      audiencia: 'equipo',
      enfoque: 'El edificio H arrastra la obra.\nEl cable HDMI subió por la planta 2.',
    })
    expect(texto).toContain('- Instrucción de quien pide el informe, que va por delante de lo anterior:\n')
    expect(texto).toContain('  El edificio H arrastra la obra.\n  El cable HDMI subió por la planta 2.')
    // Ninguna línea suya empieza por guion: no se confunde con las nuestras.
    expect(texto).not.toContain('\n- El cable HDMI')
  })
})
