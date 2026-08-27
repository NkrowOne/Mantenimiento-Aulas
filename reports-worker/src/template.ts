/**
 * La plantilla del informe.
 *
 * Restricciones que impone no tener navegador, y que aquí se respetan:
 *  - Nada de JavaScript. Los gráficos entran ya como SVG.
 *  - Maquetación con `table` y cajas simples. Nada de Grid: WeasyPrint lo
 *    soporta a medias según la versión y un informe no es sitio para averiguar
 *    cuál está instalada.
 *  - Los saltos de página se controlan a mano, bloque por bloque.
 *
 * LAS DECISIONES DE DISEÑO, que son el motivo de que este fichero sea largo:
 *
 *  · **Dos familias con dos oficios.** Serif para lo que se lee seguido —la
 *    entradilla, el análisis, los motivos—; sans para lo que se consulta a
 *    saltos —rótulos, tablas, cifras—. Es lo que separa un documento de un
 *    volcado: el ojo sabe, sin pensarlo, qué es texto y qué es dato.
 *  · **Una sola columna de lectura, estrecha.** La entradilla no ocupa los
 *    178 mm de la caja: ocupa 110. Un párrafo de línea larga no se lee, se
 *    escanea, y justo ese párrafo es el que tiene que leerse.
 *  · **Los indicadores a la derecha, no arriba.** La tira de cuatro cubos
 *    horizontales es la forma canónica del panel generado a máquina. En vertical,
 *    al lado del texto, el documento se lee como un informe y no como una
 *    plantilla rellenada.
 *  · **Ni un emoji, ni una negrita de énfasis, ni un signo de exclamación.** El
 *    énfasis se hace con jerarquía y con aire, que es lo que se ha hecho siempre
 *    en un documento impreso.
 *  · **Las secciones vacías no se imprimen** cuando no dicen nada, y sí cuando
 *    lo que dicen es una buena noticia. «Ninguna lámpara por debajo del umbral»
 *    informa; «Sin datos» no.
 */

import { ANCHO_MEDIO, ANCHO_TOTAL, actividadDiaria, barrasHorizontales, tendencia } from './charts.js'
import type { ReportData } from './data.js'
import { type Indicador, type Lectura, dias as textoDias, indicadores, plural, porcentaje } from './analisis.js'
import { SECCIONES_POR_DEFECTO, type Opciones, type Seccion, tiene } from './opciones.js'
import { etiquetaDia, nombreDia } from './periods.js'

// La paleta de la aplicación, para que el PDF y la pantalla sean el mismo producto.
const ACENTO = '#046A78'
const INK = '#12171C'
const INK2 = '#3C4A4E'
const MUTED = '#5C6875'
const LINE = '#D9DFE3'
const HAIR = '#EAEEF0'
const PAPEL = '#F7F7F5'
const OK = '#137A47'
const WARN = '#8A5A00'
const CRIT = '#B02318'

const TONOS: Record<string, string> = { neutro: INK, ok: OK, aviso: WARN, critico: CRIT }

const TITULO_TIPO: Record<string, string> = {
  diario: 'Parte diario',
  semanal: 'Informe semanal',
  personalizado: 'Informe del periodo',
}

/**
 * El nombre del edificio, sin repetir su código.
 *
 * Los datos traen `code = 'H'` y `name = 'EDIFICIO H'`, así que lo obvio
 * —código y nombre pegados— imprimía «H H». Y los nombres vienen del Excel en
 * mayúsculas: «SIMULACION CLINICA AV.» en versalitas grita, así que se pasa a
 * capitales de palabra dejando en paz las siglas cortas (CRAI, DOT, MSI).
 */
export function nombreEdificio(code: string, name: string): string {
  const limpio = name.replace(/^EDIFICIO\s+/i, '').trim()
  if (!limpio || limpio.toUpperCase() === code.toUpperCase()) return ''
  return limpio
    .split(/\s+/)
    .map((w) =>
      w.length <= 4 && w === w.toUpperCase()
        ? w
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join(' ')
}

/** Igual con las salas: en muchas, el código ES el nombre. */
function nombreSala(code: string, name: string): string {
  return name.trim().toUpperCase() === code.trim().toUpperCase() ? '' : name.trim()
}

/** Corta por palabra entera y avisa con puntos suspensivos. */
function recorta(t: string, n: number): string {
  const limpio = t.trim().replace(/\s+/g, ' ')
  if (limpio.length <= n) return limpio
  const corte = limpio.slice(0, n - 1)
  const ultimo = corte.lastIndexOf(' ')
  return `${ultimo > n * 0.6 ? corte.slice(0, ultimo) : corte}…`
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface Pie {
  /** Fecha y hora de emisión, ya formateada en hora de Madrid. */
  emitido: string
  /** Quién lo pidió, si lo pidió alguien. El automático del viernes no tiene solicitante. */
  solicitante?: string | undefined
}

// ── Piezas ───────────────────────────────────────────────────────────────────

/**
 * La variación, con su flecha.
 *
 * El triángulo se dibuja con bordes CSS y no con el carácter ▲: si la fuente
 * del contenedor no trae ese glifo —y ninguna de las tres IBM Plex garantiza
 * los símbolos geométricos— WeasyPrint imprime un rectángulo vacío. Un cuadrito
 * negro en medio de una cifra es exactamente el tipo de detalle que hace que un
 * documento parezca roto.
 */
function variacion(ind: Indicador): string {
  const d = ind.delta
  if (!d || d.valor === 0) {
    return `<div class="var neutra">sin cambio</div>`
  }
  const sube = d.valor > 0
  const bueno = sube === d.subirEsBueno
  const clase = `${sube ? 'sube' : 'baja'} ${bueno ? 'bien' : 'mal'}`
  const cifra = `${sube ? '+' : '−'}${Math.abs(d.valor)}`
  const rel = d.pct === null ? '' : ` <span class="var-pct">(${d.pct > 0 ? '+' : ''}${d.pct} %)</span>`
  return `<div class="var ${clase}"><i class="flecha"></i>${cifra}${rel}</div>`
}

/**
 * Los cuatro indicadores, en dos por dos.
 *
 * En una sola columna el panel medía trece líneas y la entradilla cinco: el
 * lado izquierdo de la primera página quedaba medio vacío y la página se leía
 * como una cosa mal cuadrada. En dos por dos los dos lados terminan a la misma
 * altura, que es la razón por la que existe la retícula.
 */
function panelIndicadores(inds: Indicador[], comparar: boolean, comparacion: string): string {
  const celda = (i: Indicador | undefined): string =>
    i
      ? `<div class="panel-et">${esc(i.etiqueta)}</div>
      <div class="panel-val" style="color:${TONOS[i.tono] ?? INK}">${esc(i.valor)}</div>
      <div class="panel-det">${esc(i.detalle)}</div>
      ${comparar && i.delta ? variacion(i) : ''}`
      : ''

  return `
  <div class="panel">
    <div class="panel-t">El periodo en cuatro cifras</div>
    <table class="panel-rej">
      <tr>
        <td class="panel-c">${celda(inds[0])}</td>
        <td class="panel-c">${celda(inds[1])}</td>
      </tr>
      <tr>
        <td class="panel-c panel-c2">${celda(inds[2])}</td>
        <td class="panel-c panel-c2">${celda(inds[3])}</td>
      </tr>
    </table>
    ${comparar ? `<div class="panel-nota">La variación compara con ${esc(comparacion)}.</div>` : ''}
  </div>`
}

/** Rótulo de sección: filete fino, versalita y nada más. */
function rotulo(texto: string, apunte?: string): string {
  return `<div class="rotulo"><span>${esc(texto)}</span>${
    apunte ? `<span class="rotulo-apunte">${esc(apunte)}</span>` : ''
  }</div>`
}

function figura(titulo: string, nota: string, svg: string): string {
  return `
  <figure class="fig">
    <figcaption>
      <span class="fig-t">${esc(titulo)}</span>
      <span class="fig-n">${esc(nota)}</span>
    </figcaption>
    ${svg}
  </figure>`
}

/** Barra de proporción: la parte-del-todo se lee mejor así que en un anillo. */
function franja(partes: Array<{ nombre: string; valor: number; color: string }>): string {
  const total = partes.reduce((a, b) => a + b.valor, 0)
  if (!total) return ''
  return `
  <div class="franja">
    ${partes
      .filter((p) => p.valor > 0)
      .map(
        (p) =>
          `<span style="width:${((p.valor / total) * 100).toFixed(2)}%;background:${p.color}"></span>`,
      )
      .join('')}
  </div>
  <div class="franja-pie">
    ${partes
      .filter((p) => p.valor > 0)
      .map(
        (p) =>
          `<span class="lg"><i style="background:${p.color}"></i>${esc(p.nombre)} <b>${p.valor}</b></span>`,
      )
      .join('')}
  </div>`
}

/** Medidor de una razón contra su límite. Mismo tono en pista y relleno. */
function medidor(parte: number, total: number, tono = ACENTO): string {
  const pct = total ? Math.min(100, Math.round((parte / total) * 100)) : 0
  return `<span class="med"><span style="width:${Math.max(pct === 0 ? 0 : 2, pct)}%;background:${tono}"></span></span>`
}

/**
 * Saca la primera letra a un elemento propio para poder hacerla capitular.
 *
 * Si el párrafo empieza por algo que no sea una letra —una cifra, un signo— se
 * deja como está: una capitular sobre un «3» parece una errata.
 */
function capitular(texto: string): string {
  const limpio = texto.trim()
  const primera = limpio.charAt(0)
  if (!/\p{L}/u.test(primera)) return esc(limpio)
  return `<span class="capitular">${esc(primera)}</span>${esc(limpio.slice(1))}`
}

function vacio(texto: string): string {
  return `<p class="vacio">${esc(texto)}</p>`
}

interface Columna<T> {
  cab: string
  /** Alineado a la derecha y en mono: es una cifra. */
  num?: boolean
  ancho?: string
  celda: (fila: T) => string
}

function tabla<T>(filas: T[], cols: Array<Columna<T>>): string {
  return `
  <table class="datos">
    <thead><tr>${cols
      .map((c) => `<th${c.num ? ' class="num"' : ''}${c.ancho ? ` style="width:${c.ancho}"` : ''}>${esc(c.cab)}</th>`)
      .join('')}</tr></thead>
    <tbody>
      ${filas
        .map(
          (f) =>
            `<tr>${cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.celda(f)}</td>`).join('')}</tr>`,
        )
        .join('')}
    </tbody>
  </table>`
}

// ── Secciones ────────────────────────────────────────────────────────────────

function seccionActividad(d: ReportData): string {
  if (d.serieDiaria.length < 2) return ''
  const total = d.serieDiaria.reduce((a, x) => a + x.revisiones + x.abiertas + x.resueltas, 0)

  return `
  <section class="bloque">
    ${rotulo('Actividad', d.dias === 1 ? 'la jornada' : `los ${d.dias} días del periodo`)}
    ${
      total === 0
        ? vacio('Ningún movimiento registrado en el periodo: ni revisiones, ni altas, ni cierres.')
        : figura(
            'Día a día',
            'Revisiones completadas, registros abiertos y cerrados',
            actividadDiaria(
              d.serieDiaria.map((x) => etiquetaDia(x.dia)),
              [
                { nombre: 'Revisiones', datos: d.serieDiaria.map((x) => x.revisiones) },
                { nombre: 'Abiertas', datos: d.serieDiaria.map((x) => x.abiertas) },
                { nombre: 'Cerradas', datos: d.serieDiaria.map((x) => x.resueltas) },
              ],
              { width: ANCHO_TOTAL, height: 212 },
            ),
          )
    }
  </section>`
}

function seccionAnalisis(l: Lectura): string {
  if (!l.hallazgos.length) return ''

  // De dos en dos: cuatro notas seguidas en una columna se leen como una lista
  // de avisos, y en dos columnas como las notas al margen de un informe.
  const pares: Array<[typeof l.hallazgos[number], typeof l.hallazgos[number] | undefined]> = []
  for (let i = 0; i < l.hallazgos.length; i += 2) {
    pares.push([l.hallazgos[i]!, l.hallazgos[i + 1]])
  }

  const nota = (h: { titulo: string; cuerpo: string }, n: number): string => `
    <div class="nota">
      <div class="nota-n">${String(n).padStart(2, '0')}</div>
      <div class="nota-t">${esc(h.titulo)}</div>
      <div class="nota-c">${esc(h.cuerpo)}</div>
    </div>`

  return `
  <section class="bloque">
    ${rotulo('Lo que dicen los datos')}
    <table class="notas">
      ${pares
        .map(
          ([a, b], fila) => `
      <tr>
        <td class="col-nota">${nota(a, fila * 2 + 1)}</td>
        <td class="col-nota">${b ? nota(b, fila * 2 + 2) : ''}</td>
      </tr>`,
        )
        .join('')}
    </table>
  </section>`
}

function seccionEdificios(d: ReportData, conTendencia: boolean): string {
  const conActividad = d.porEdificio.filter((b) => b.abiertas > 0)
  const top = conActividad.slice(0, 8)

  const izquierda = top.length
    ? figura(
        'Registros abiertos por edificio',
        'En el periodo, sin contar borradores',
        barrasHorizontales(
          top.map((b) => b.code),
          top.map((b) => b.abiertas),
          { width: ANCHO_MEDIO, height: Math.max(120, 24 + top.length * 22) },
        ),
      )
    : vacio('Ningún registro nuevo asignado a un edificio en el periodo.')

  const derecha =
    conTendencia && d.porMes.length > 1
      ? figura(
          'Aperturas por mes',
          'Últimos doce meses, todo el campus',
          tendencia(
            d.porMes.map((m) => m.month.slice(2)),
            d.porMes.map((m) => m.total),
            { width: ANCHO_MEDIO, height: 190 },
          ),
        )
      : ''

  // Con un solo tipo, la franja es una barra al 100 % que no compara nada.
  const composicion = d.porTipo.filter((t) => t.total > 0).length > 1
    ? `
    <div class="sub">
      <div class="sub-t">Composición de lo abierto</div>
      ${franja([
        {
          nombre: 'Incidencias',
          valor: d.porTipo.find((t) => t.tipo === 'incidencia')?.total ?? 0,
          color: '#4A78D4',
        },
        {
          nombre: 'Solicitudes',
          valor: d.porTipo.find((t) => t.tipo === 'solicitud')?.total ?? 0,
          color: '#12A396',
        },
        {
          nombre: 'Observaciones',
          valor: d.porTipo.find((t) => t.tipo === 'observacion')?.total ?? 0,
          color: '#B063D6',
        },
      ])}
      <p class="apunte">Una solicitud no es una avería: es trabajo pedido. Una observación
      es una nota de seguimiento. Solo las incidencias penalizan la fiabilidad de la sala.</p>
    </div>`
    : ''

  /*
   * Solo los edificios con algo que contar. Con diecisiete filas, once de ellas
   * a cero, la tabla ocupaba dos páginas para decir que no se pasó por allí. Los
   * que se quedan fuera se cuentan al pie: quitar filas sin avisar es esconder.
   */
  const conDatos = d.porEdificio.filter(
    (b) => b.salas > 0 && (b.revisadas > 0 || b.abiertas > 0 || b.pendientes > 0),
  )
  const cobertura = conDatos.slice(0, 12)
  // Los dos recortes por separado, porque el pie los nombra y no son lo mismo:
  // llamar «sin actividad» a un edificio que se quedó fuera por el tope de doce
  // filas TENIENDO datos es mentirle al lector en la línea que existe para no
  // esconderle nada.
  const recortados = conDatos.length - cobertura.length
  const sinActividad = d.porEdificio.filter((b) => b.salas > 0).length - conDatos.length

  return `
  <section class="bloque">
    ${rotulo('Dónde está el trabajo')}
    ${
      derecha
        ? `<table class="dos"><tr>
      <td class="col-mitad">${izquierda}</td>
      <td class="col-mitad">${derecha}</td>
    </tr></table>`
        : izquierda
    }
    ${composicion}
    ${
      cobertura.length
        ? `<div class="sub">
      <div class="sub-t">Cobertura y cola por edificio</div>
      ${tabla(cobertura, [
        {
          cab: 'Edificio',
          ancho: '30%',
          celda: (b) => {
            const n = nombreEdificio(b.code, b.name)
            return `<span class="mono">${esc(b.code)}</span>${n ? ` <span class="tenue">${esc(n)}</span>` : ''}`
          },
        },
        { cab: 'Salas', num: true, celda: (b) => String(b.salas) },
        {
          cab: 'Revisadas',
          ancho: '26%',
          // `esc()` también aquí: `porcentaje()` puede devolver «<1 %», y un `<`
          // seguido de dígito es un error de parseo HTML que hoy tolera el
          // parser de WeasyPrint y mañana rompe la celda en cualquier otro.
          celda: (b) =>
            `${medidor(b.revisadas, b.salas)}<span class="med-n">${b.revisadas} · ${esc(porcentaje(b.revisadas, b.salas))}</span>`,
        },
        { cab: 'Abiertas', num: true, celda: (b) => (b.abiertas ? String(b.abiertas) : '—') },
        {
          cab: 'Pendientes hoy',
          num: true,
          celda: (b) =>
            b.pendientes
              ? `<span style="color:${b.pendientes > 3 ? CRIT : INK}">${b.pendientes}</span>`
              : '—',
        },
      ])}
      ${
        recortados > 0 || sinActividad > 0
          ? `<p class="apunte">${[
              recortados > 0
                ? `${plural(recortados, 'edificio')} con actividad fuera de la tabla por sitio`
                : '',
              sinActividad > 0
                ? `${plural(sinActividad, 'edificio')} sin actividad en el periodo`
                : '',
            ]
              .filter(Boolean)
              .join(' · ')}.</p>`
          : ''
      }
    </div>`
        : ''
    }
  </section>`
}

/**
 * Las revisiones del periodo, una por línea.
 *
 * El día se escribe solo cuando cambia, como en un libro de registro. Repetirlo
 * treinta y una veces convierte la primera columna en un muro y hace más difícil
 * ver dónde empieza cada jornada, que es justo lo que se viene a mirar.
 */
function seccionRevisiones(d: ReportData): string {
  if (!d.revisiones.length) {
    return `
  <section class="bloque evitar">
    ${rotulo('Revisiones del periodo')}
    ${vacio('No se ha completado ninguna revisión en el periodo.')}
  </section>`
  }

  /*
   * El histórico importado no trae autor: sin esto, la tabla de una semana de
   * datos antiguos era una columna entera de guiones. Se enseña cuando hay algo
   * que enseñar, que es la misma regla que con las secciones vacías.
   */
  const conAutor = d.revisiones.some((r) => r.quien)

  let diaAnterior = ''
  const filas = d.revisiones
    .map((r) => {
      const nuevoDia = r.dia !== diaAnterior
      diaAnterior = r.dia
      const n = nombreSala(r.room, r.name)
      const salida =
        r.resultado === 'ok'
          ? '<span class="tenue">sin incidencias</span>'
          : `<span style="color:${WARN}">${
              r.fallos ? plural(r.fallos, 'fallo') : 'con incidencias'
            }</span>${r.aperturas ? ` · ${plural(r.aperturas, 'registro')} abierto${r.aperturas === 1 ? '' : 's'}` : ''}`

      return `<tr${nuevoDia ? ' class="jornada"' : ''}>
      <td class="mono tenue">${nuevoDia ? esc(etiquetaDia(r.dia)) : ''}</td>
      <td class="mono tenue">${esc(r.hora)}</td>
      <td><span class="mono">${esc(r.building)} ${esc(r.room)}</span>${
        n ? ` <span class="tenue">${esc(n)}</span>` : ''
      }</td>
      ${conAutor ? `<td>${r.quien ? esc(r.quien) : '<span class="tenue">—</span>'}</td>` : ''}
      <td>${salida}</td>
    </tr>`
    })
    .join('')

  const fuera = d.revisionesTotal - d.revisiones.length

  return `
  <section class="bloque">
    ${rotulo('Revisiones del periodo', plural(d.revisionesTotal, 'revisión', 'revisiones'))}
    <table class="datos">
      <thead><tr>
        <th style="width:8%">Día</th><th style="width:8%">Hora</th>
        <th style="width:${conAutor ? '34' : '52'}%">Sala</th>
        ${conAutor ? '<th style="width:24%">Quién</th>' : ''}
        <th>Resultado</th>
      </tr></thead>
      <tbody>${filas}</tbody>
    </table>
    ${
      fuera > 0
        ? `<p class="apunte">Y ${plural(fuera, 'revisión', 'revisiones')} más, fuera de la tabla.
           El listado completo está en el histórico de cada sala.</p>`
        : ''
    }
  </section>`
}

/** Cómo se llama cada cosa que pasa, en la columna del diario. */
function etiquetaEvento(tipo: string, subtipo: string): string {
  if (tipo === 'apertura') {
    if (subtipo === 'solicitud') return 'Solicitud'
    if (subtipo === 'observacion') return 'Observación'
    return 'Incidencia'
  }
  if (tipo === 'cierre') return 'Cierre'
  if (tipo === 'material') {
    if (subtipo === 'consumo') return 'Material'
    if (subtipo === 'compra') return 'Compra'
    if (subtipo === 'devolucion') return 'Devolución'
    return 'Ajuste'
  }
  if (tipo === 'inventario') return 'Inventario'
  return 'Equipo'
}

/**
 * El diario del periodo: qué pasó, en orden y por días.
 *
 * Las revisiones no se repiten aquí —tienen su tabla— pero sí se cuentan en la
 * cabecera de cada jornada, para que un día con seis revisiones y ningún evento
 * no aparezca como un día en blanco.
 *
 * Va agrupado por día y no como una sola tabla de cien filas porque la pregunta
 * que se le hace a un diario es «¿qué pasó el miércoles?», y para responderla en
 * una tabla plana hay que buscar dónde cambia la fecha.
 */
function seccionEventos(d: ReportData, conRevisiones: boolean): string {
  const porDia = new Map<string, ReportData['eventos']>()
  for (const e of d.eventos) {
    const lista = porDia.get(e.dia) ?? []
    lista.push(e)
    porDia.set(e.dia, lista)
  }

  // Todos los días del periodo con algo que contar: eventos o revisiones.
  const dias = d.serieDiaria
    .filter((s) => porDia.has(s.dia) || s.revisiones > 0)
    .map((s) => s.dia)

  if (!dias.length) {
    return `
  <section class="bloque evitar">
    ${rotulo('Diario del periodo')}
    ${vacio('Ni un movimiento registrado en el periodo.')}
  </section>`
  }

  /*
   * Con el listado recortado, «Solo revisiones: ningún registro nuevo…» pasa a
   * ser una afirmación que no se puede hacer: los eventos van en orden y el
   * tope de filas corta por el final, así que del último día listado en
   * adelante puede haber movimientos que simplemente no caben. Los días
   * ANTERIORES al corte sí están completos y conservan la frase.
   */
  const truncado = d.eventosTotal > d.eventos.length
  const ultimoDiaListado = d.eventos.length ? d.eventos[d.eventos.length - 1]!.dia : ''

  const jornada = (dia: string): string => {
    const s = d.serieDiaria.find((x) => x.dia === dia)
    const resumen = [
      s?.revisiones ? plural(s.revisiones, 'revisión', 'revisiones') : '',
      s?.abiertas ? plural(s.abiertas, 'abierta') : '',
      s?.resueltas ? plural(s.resueltas, 'cerrada') : '',
    ]
      .filter(Boolean)
      .join(' · ')

    const eventos = porDia.get(dia) ?? []

    return `
    <div class="dia">
      <div class="dia-cab">
        <span class="dia-fecha">${esc(nombreDia(dia))}</span>
        ${resumen ? `<span class="dia-res">${esc(resumen)}</span>` : ''}
      </div>
      ${
        eventos.length
          ? `<table class="datos diario">
        <tbody>
          ${eventos
            .map((e) => {
              // El detalle importado repite el título tal cual en muchas filas:
              // imprimirlo dos veces solo gasta papel.
              const detalle =
                e.detalle && e.detalle.trim() !== e.titulo.trim() ? e.detalle.trim() : ''
              // Sin el separador colgando: con cantidad y sin autor salía «1 ud ·».
              const cola = [
                e.cantidad !== null && e.cantidad !== 0 ? `${Math.abs(e.cantidad)} ud` : '',
                e.quien ?? '',
              ]
                .filter(Boolean)
                .join(' · ')
              return `<tr>
            <td class="mono tenue" style="width:7%">${esc(e.hora)}</td>
            <td style="width:13%"><span class="tag">${esc(etiquetaEvento(e.tipo, e.subtipo))}</span></td>
            <td class="mono" style="width:14%">${esc(`${e.building} ${e.room}`.trim())}</td>
            <td>${esc(recorta(e.titulo, 90))}${
              detalle ? `<span class="ev-det">${esc(recorta(detalle, 110))}</span>` : ''
            }</td>
            <td class="tenue" style="width:16%">${esc(cola)}</td>
          </tr>`
            })
            .join('')}
        </tbody>
      </table>`
          : truncado && dia >= ultimoDiaListado
            ? `<p class="vacio">Los movimientos de este día no caben en el listado recortado.</p>`
            : `<p class="vacio">Solo revisiones: ningún registro nuevo ni consumo de material.</p>`
      }
    </div>`
  }

  const fuera = d.eventosTotal - d.eventos.length

  return `
  <section class="bloque">
    ${rotulo('Diario del periodo', `${plural(d.eventosTotal, 'movimiento')}${conRevisiones ? ', aparte de las revisiones' : ''}`)}
    ${dias.map(jornada).join('')}
    ${
      fuera > 0
        ? `<p class="apunte">Y ${plural(fuera, 'movimiento')} más, fuera del diario: se ha cortado
           al ${d.eventos.length} para que el informe siga siendo un informe. Están todos en el
           histórico de cada sala.</p>`
        : ''
    }
  </section>`
}

/** La tendencia por su cuenta, cuando se pide sin el reparto por edificio. */
function seccionTendencia(d: ReportData): string {
  if (d.porMes.length < 2) return ''
  return `
  <section class="bloque evitar">
    ${rotulo('Tendencia', 'últimos doce meses')}
    ${figura(
      'Aperturas por mes',
      'Todo el campus, sin contar borradores',
      tendencia(
        d.porMes.map((m) => m.month.slice(2)),
        d.porMes.map((m) => m.total),
        { width: ANCHO_TOTAL, height: 200 },
      ),
    )}
  </section>`
}

function seccionSalas(d: ReportData): string {
  if (!d.topSalas.length && !d.reincidentes.length) return ''

  return `
  <section class="bloque">
    ${rotulo('Salas señaladas')}
    ${
      d.topSalas.length
        ? tabla(d.topSalas, [
            {
              cab: 'Sala',
              ancho: '46%',
              celda: (r) => {
                const n = nombreSala(r.room, r.name)
                return `<span class="mono">${esc(r.building)} ${esc(r.room)}</span>${n ? ` <span class="tenue">${esc(n)}</span>` : ''}`
              },
            },
            { cab: 'Incidencias', num: true, celda: (r) => String(r.total) },
            {
              cab: 'Fiabilidad',
              ancho: '26%',
              celda: (r) =>
                r.hayDatos && r.fiabilidad !== null
                  ? `${medidor(r.fiabilidad, 100, r.fiabilidad < 50 ? CRIT : r.fiabilidad < 75 ? WARN : OK)}<span class="med-n">${r.fiabilidad}/100</span>`
                  : '<span class="tenue">datos insuficientes</span>',
            },
          ])
        : vacio('Ninguna sala ha acumulado incidencias en el periodo.')
    }
    ${
      d.reincidentes.length
        ? `<div class="sub">
      <div class="sub-t">Mismo repuesto, misma sala</div>
      <p class="apunte">Tres veces la misma pieza en seis meses no es mala suerte. Se agrupa por
      artículo consumido y no por el texto del parte, que cada uno escribe distinto.</p>
      ${tabla(d.reincidentes, [
        { cab: 'Sala', celda: (r) => `<span class="mono">${esc(r.building)} ${esc(r.room)}</span>` },
        { cab: 'Repuesto', ancho: '50%', celda: (r) => esc(r.item) },
        { cab: 'Veces', num: true, celda: (r) => `<span style="color:${CRIT}">${r.veces}</span>` },
      ])}
    </div>`
        : ''
    }
  </section>`
}

function seccionLamparas(d: ReportData): string {
  return `
  <section class="bloque evitar">
    ${rotulo('Lámparas al límite', 'por debajo del 20 % de vida')}
    ${
      d.lamparas.length
        ? tabla(d.lamparas, [
            { cab: 'Sala', ancho: '34%', celda: (r) => `<span class="mono">${esc(r.building)} ${esc(r.room)}</span>` },
            { cab: 'Horas de proyector', num: true, celda: (r) => (r.horas === null ? '—' : String(r.horas)) },
            {
              cab: 'Vida restante',
              ancho: '30%',
              celda: (r) =>
                `${medidor(Math.round(r.pct * 100), 100, CRIT)}<span class="med-n" style="color:${CRIT}">${Math.round(r.pct * 100)} %</span>`,
            },
          ])
        : vacio('Ninguna lámpara por debajo del umbral. Nada que pedir esta semana.')
    }
  </section>`
}

function seccionEstancadas(d: ReportData): string {
  return `
  <section class="bloque">
    ${rotulo('Sin cerrar', 'más de siete días abiertas')}
    ${
      d.estancadas.length
        ? tabla(d.estancadas, [
            { cab: 'Referencia', ancho: '15%', celda: (r) => `<span class="mono tenue">${esc(r.ref ?? '—')}</span>` },
            { cab: 'Qué pasa', ancho: '45%', celda: (r) => esc(r.titulo.slice(0, 78)) },
            { cab: 'Sala', celda: (r) => `<span class="mono">${esc(`${r.building} ${r.room}`.trim())}</span>` },
            { cab: 'Gravedad', celda: (r) => `<span class="tenue">${esc(r.gravedad)}</span>` },
            {
              cab: 'Días',
              num: true,
              celda: (r) => `<span style="color:${r.dias > 30 ? CRIT : WARN}">${r.dias}</span>`,
            },
          ])
        : vacio('Ninguna incidencia lleva más de una semana abierta.')
    }
  </section>`
}

function seccionMateriales(d: ReportData): string {
  const conCierres = d.resolucion.resueltas > 0
  // Sin `evitar`: es un bloque alto, y prohibirle partirse lo empujaba entero a
  // la página siguiente dejando media en blanco.
  return `
  <section class="bloque">
    ${rotulo('Material y tiempos')}
    <table class="dos"><tr>
      <td class="col-mitad">
        <div class="sub-t">Más consumido en el periodo</div>
        ${
          d.materiales.length
            ? tabla(d.materiales, [
                { cab: 'Artículo', ancho: '58%', celda: (m) => esc(m.name) },
                { cab: 'Unidades', num: true, celda: (m) => String(m.consumido) },
                { cab: 'Partes', num: true, celda: (m) => (m.incidencias ? String(m.incidencias) : '—') },
              ])
            : vacio('Sin consumo de almacén registrado en el periodo.')
        }
      </td>
      <td class="col-mitad">
        <div class="sub-t">Cuánto se tarda en cerrar</div>
        ${
          conCierres
            ? `<table class="cifras">
          <tr><td>La mitad se cierra en</td><td class="num">${esc(textoDias(d.resolucion.medianaDias))}</td></tr>
          ${
            // Si la media dice lo mismo que la mediana, la fila solo repite.
            textoDias(d.resolucion.mediaDias) !== textoDias(d.resolucion.medianaDias)
              ? `<tr><td>Media, arrastrando las antiguas</td><td class="num">${esc(textoDias(d.resolucion.mediaDias))}</td></tr>`
              : ''
          }
          <tr><td>Cerradas en menos de 48 h</td><td class="num">${d.resolucion.enMenosDe48h} de ${d.resolucion.resueltas}</td></tr>
        </table>
        <p class="apunte">La mediana va primero porque la media la mueve cualquier
        parte antiguo que se cierre esta semana.</p>`
            : vacio('No se ha cerrado nada en el periodo.')
        }
      </td>
    </tr></table>
  </section>`
}

function seccionEquipo(d: ReportData): string {
  if (!d.equipo.length) return ''
  return `
  <section class="bloque evitar">
    ${rotulo('Reparto del trabajo')}
    <p class="apunte">No es un ranking. Una revisión rutinaria y una botonera desmontada
    cuentan igual aquí y no cuestan lo mismo.</p>
    ${tabla(d.equipo, [
      { cab: 'Persona', ancho: '52%', celda: (p) => esc(p.nombre) },
      { cab: 'Revisiones', num: true, celda: (p) => String(p.revisiones) },
      { cab: 'Registros abiertos', num: true, celda: (p) => String(p.registros) },
    ])}
  </section>`
}

function seccionRecomendaciones(l: Lectura): string {
  if (!l.recomendaciones.length) return ''
  return `
  <section class="bloque evitar">
    ${rotulo('Qué conviene hacer')}
    <ol class="acciones">
      ${l.recomendaciones
        .map(
          (r) => `<li>
        <div class="acc-t">${esc(r.accion)}</div>
        <div class="acc-p">${esc(r.porque)}</div>
      </li>`,
        )
        .join('')}
    </ol>
  </section>`
}

/**
 * La procedencia de los DATOS. Nada más.
 *
 * Aquí iba una línea que decía con qué se había redactado el análisis. Se ha
 * quitado, y es una decisión del que firma el informe, no un descuido: este
 * documento sale del servicio de mantenimiento y habla del estado del campus.
 * Cómo se preparó por dentro es asunto de la herramienta, igual que no se
 * imprime qué versión de Postgres contó las incidencias ni qué motor maquetó
 * las páginas.
 *
 * El rastro NO se pierde: queda en `reports.params` con cada informe, y la
 * pantalla de Informes lo enseña junto a cada entrada del archivo. Quien tenga
 * que auditarlo lo tiene; quien lea el PDF, no lo necesita.
 */
function colofon(d: ReportData, o: Opciones, pie: Pie): string {
  const partes = [
    `Datos leídos de la base el ${esc(pie.emitido)}, en hora de Madrid.`,
    `Periodo ${esc(d.period.start)} a ${esc(d.period.end)}, comparado con ${esc(d.anterior.start)} a ${esc(d.anterior.end)}.`,
    pie.solicitante ? `Solicitado por ${esc(pie.solicitante)}.` : 'Emisión automática programada.',
  ]
  if (d.situacion.salasNuncaRevisadas > 0) {
    partes.push(
      `${d.situacion.salasNuncaRevisadas} de las ${d.situacion.salasTotal} salas activas no tienen ninguna revisión registrada: no aparecen en ningún indicador de este informe.`,
    )
  }
  if (d.sinSala > 0) {
    partes.push(
      `${plural(d.sinSala, 'registro')} del periodo no tienen sala asignada, así que cuentan en los totales y no en el desglose por edificio.`,
    )
  }
  // Contra el conjunto por defecto, no contra un número escrito a mano: al
  // añadir dos secciones nuevas, el «< 10» de antes habría marcado como parcial
  // hasta el informe completo.
  if (o.secciones.length < SECCIONES_POR_DEFECTO.length) {
    partes.push('Informe parcial: se han pedido solo algunas secciones.')
  }

  return `
  <section class="colofon">
    ${rotulo('Procedencia')}
    <p>${partes.join(' ')}</p>
    <p class="tenue">Un informe emitido no se regenera: si los datos cambian, se emite otro. Este
    documento sigue diciendo lo que decía el día que se firmó.</p>
  </section>`
}

// ── El documento ─────────────────────────────────────────────────────────────

export function renderReport(
  d: ReportData,
  l: Lectura,
  o: Opciones,
  pie: Pie,
): string {
  const titulo = TITULO_TIPO[d.kind] ?? 'Informe'
  const inds = indicadores(d)
  // Comparar con un tramo anterior vacío es comparar con nada: la flecha diría
  // «+2 (sin dato antes)» y ocuparía sitio para no informar.
  const comparar =
    o.comparar && d.antes.revisiones + d.antes.registros + d.antes.resueltas > 0

  /*
   * La tendencia de doce meses vive dentro de «Dónde está el trabajo», que es
   * donde tiene sentido leerla. Si alguien pide la tendencia SIN los edificios,
   * se imprime sola en vez de desaparecer: una sección marcada que no sale es un
   * informe incompleto sin avisar.
   */
  const tendenciaSola = tiene(o, 'tendencia') && !tiene(o, 'edificios')

  const secciones: Array<[Seccion, string]> = [
    ['actividad', seccionActividad(d)],
    ['analisis', seccionAnalisis(l)],
    ['revisiones', seccionRevisiones(d)],
    ['eventos', seccionEventos(d, tiene(o, 'revisiones'))],
    ['edificios', seccionEdificios(d, tiene(o, 'tendencia'))],
    ['tendencia', tendenciaSola ? seccionTendencia(d) : ''],
    ['salas', seccionSalas(d)],
    ['lamparas', seccionLamparas(d)],
    ['estancadas', seccionEstancadas(d)],
    ['materiales', seccionMateriales(d)],
    ['equipo', seccionEquipo(d)],
    ['recomendaciones', seccionRecomendaciones(l)],
  ]

  const cuerpo = secciones
    .filter(([clave, html]) => tiene(o, clave) && html)
    .map(([, html]) => html)
    .join('\n')

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${esc(titulo)} · ${esc(d.periodoTexto)}</title>
<style>
  @page {
    size: A4;
    margin: 18mm 16mm 16mm;
    @top-right {
      content: string(cabecera);
      font-family: "IBM Plex Sans", sans-serif; font-size: 7.5pt; color: ${MUTED};
      vertical-align: bottom; padding-bottom: 3mm;
    }
    @bottom-left {
      content: "Mantenimiento de aulas";
      font-family: "IBM Plex Sans", sans-serif; font-size: 7.5pt; color: ${MUTED};
      vertical-align: top; padding-top: 4mm;
    }
    @bottom-right {
      content: counter(page) " / " counter(pages);
      font-family: "IBM Plex Mono", monospace; font-size: 7.5pt; color: ${MUTED};
      vertical-align: top; padding-top: 4mm;
    }
  }
  /* La primera página lleva la cabecera impresa en grande: repetirla arriba
     sobraría. */
  @page :first { @top-right { content: none } }

  body {
    font-family: "IBM Plex Sans", sans-serif;
    font-size: 9.5pt; line-height: 1.45; color: ${INK}; margin: 0;
  }
  p { margin: 0 0 2.5mm; }

  /* ── Cabecera ── */
  .masthead { string-set: cabecera "${esc(titulo)} · ${esc(d.periodoTexto)}"; }
  .kicker {
    font-size: 7.5pt; letter-spacing: .14em; text-transform: uppercase;
    color: ${ACENTO}; font-weight: 600;
  }
  h1 {
    font-family: "IBM Plex Serif", Georgia, serif;
    font-size: 21pt; line-height: 1.16; font-weight: 600;
    letter-spacing: -0.01em; color: ${INK};
    margin: 2.5mm 0 0; max-width: 150mm;
  }
  .sumario {
    margin-top: 2mm; font-size: 8.5pt; color: ${MUTED};
  }
  .sumario .mono { font-variant-numeric: tabular-nums; }
  .filete { height: 2.4pt; width: 22mm; background: ${ACENTO}; margin: 4mm 0 0; }
  .nota-pedido {
    margin-top: 4mm; padding: 2.5mm 3mm; background: ${PAPEL};
    border-left: 2pt solid ${LINE}; font-family: "IBM Plex Serif", Georgia, serif;
    font-size: 9pt; color: ${INK2};
  }

  /* ── Entrada: texto a la izquierda, cifras a la derecha ── */
  .entrada { width: 100%; border-collapse: collapse; margin-top: 6mm; }
  /* Sin selector de hijo directo a propósito: el navegador —y WeasyPrint—
     insertan un tbody que no está escrito, así que un ".entrada > tr" no casa
     con nada y la maquetación se cae a una sola columna. De ahí las clases. */
  .col-texto { width: 62%; padding-right: 10mm; vertical-align: top; }
  .col-panel { width: 38%; vertical-align: top; }

  .entradilla {
    font-family: "IBM Plex Serif", Georgia, serif;
    font-size: 10.5pt; line-height: 1.62; color: ${INK2};
    text-align: justify; hyphens: auto;
  }
  /*
   * La capitular, en un span y no en ::first-letter.
   *
   * Con ::first-letter, WeasyPrint flota la letra pero NO retira su hueco del
   * flujo: la primera línea empezaba por la segunda letra colocada debajo de la
   * primera, y se leía «S han hecho» con la «e» tapada. Con un elemento propio
   * se controlan alto de línea, ancho y sangría, y se comprueba mirando el PDF.
   */
  .capitular {
    float: left; font-size: 25pt; line-height: 0.82; font-weight: 600;
    color: ${ACENTO}; margin: 1.2mm 1.8mm 0 0;
  }

  .panel { background: ${PAPEL}; padding: 3mm; page-break-inside: avoid; }
  .panel-t {
    font-size: 7pt; font-weight: 600; text-transform: uppercase; letter-spacing: .1em;
    color: ${MUTED}; margin-bottom: 2.5mm;
  }
  .panel-rej { width: 100%; border-collapse: collapse; }
  .panel-c { width: 50%; vertical-align: top; padding: 0 3mm 0 0; }
  .panel-c2 { padding-top: 4mm; }
  .panel-et {
    font-size: 6.8pt; text-transform: uppercase; letter-spacing: .07em; color: ${MUTED};
    line-height: 1.3;
  }
  .panel-val {
    font-family: "IBM Plex Mono", monospace; font-size: 17pt; font-weight: 600;
    font-variant-numeric: tabular-nums; line-height: 1.05; margin: 0.8mm 0 0.6mm;
  }
  .panel-det { font-size: 7.5pt; color: ${MUTED}; line-height: 1.35; }
  .panel-nota {
    font-size: 7pt; color: ${MUTED}; line-height: 1.35;
    border-top: 0.5pt solid ${LINE}; margin-top: 3.5mm; padding-top: 2mm;
  }

  .var { font-size: 7.5pt; margin-top: 1.2mm; color: ${MUTED}; }
  .var-pct { color: ${MUTED}; }
  .var .flecha {
    display: inline-block; width: 0; height: 0; margin-right: 1.2mm;
    border-left: 2.4pt solid transparent; border-right: 2.4pt solid transparent;
  }
  .var.sube .flecha { border-bottom: 3.6pt solid currentColor; }
  .var.baja .flecha { border-top: 3.6pt solid currentColor; }
  .var.bien { color: ${OK}; }
  .var.mal { color: ${WARN}; }
  .var.neutra { color: ${MUTED}; }

  /* ── Secciones ── */
  .bloque { margin-top: 9mm; }
  .bloque.evitar { page-break-inside: avoid; }
  .rotulo {
    display: flex; align-items: baseline; gap: 3mm;
    border-bottom: 0.75pt solid ${INK}; padding-bottom: 1.4mm; margin-bottom: 4mm;
    /* Un rótulo suelto al pie de una página, con su sección en la siguiente, es
       el fallo de maquetación que más delata a un documento generado. */
    page-break-after: avoid;
  }
  .rotulo > span:first-child {
    font-size: 8pt; font-weight: 600; text-transform: uppercase; letter-spacing: .1em;
  }
  .rotulo-apunte { font-size: 8pt; color: ${MUTED}; letter-spacing: 0; }
  .sub { margin-top: 6mm; }
  .sub-t { font-size: 9pt; font-weight: 600; margin-bottom: 2mm; page-break-after: avoid; }
  .apunte {
    font-family: "IBM Plex Serif", Georgia, serif;
    font-size: 8.5pt; line-height: 1.5; color: ${MUTED}; margin: 2mm 0 0; max-width: 130mm;
  }
  .vacio { font-size: 9pt; color: ${MUTED}; font-style: italic; }
  .tenue { color: ${MUTED}; }
  .mono { font-family: "IBM Plex Mono", monospace; }

  /* ── Dos columnas de igual peso ── */
  .dos { width: 100%; border-collapse: collapse; }
  .col-mitad { width: 50%; vertical-align: top; padding-right: 6mm; }
  .col-mitad:last-child { padding-right: 0; }

  /* ── Figuras ── */
  .fig { margin: 0; page-break-inside: avoid; }
  .fig figcaption { margin-bottom: 2mm; page-break-after: avoid; }
  .fig-t { font-size: 9pt; font-weight: 600; display: block; }
  .fig-n { font-size: 8pt; color: ${MUTED}; display: block; }
  .fig svg { display: block; max-width: 100%; }

  /* ── Notas del análisis ── */
  .notas { width: 100%; border-collapse: collapse; }
  .col-nota {
    width: 50%; vertical-align: top; padding: 0 8mm 6mm 0;
    page-break-inside: avoid;
  }
  .col-nota:last-child { padding-right: 0; }
  .nota-n {
    font-family: "IBM Plex Mono", monospace; font-size: 8pt; color: ${ACENTO};
    letter-spacing: .05em; margin-bottom: 1.2mm;
  }
  .nota-t { font-size: 9.5pt; font-weight: 600; line-height: 1.3; margin-bottom: 1.4mm; }
  .nota-c {
    font-family: "IBM Plex Serif", Georgia, serif;
    font-size: 9pt; line-height: 1.55; color: ${INK2};
  }

  /* ── Tablas ── */
  table.datos { width: 100%; border-collapse: collapse; font-size: 8.8pt; }
  table.datos thead { display: table-header-group; }
  table.datos th {
    text-align: left; font-weight: 500; color: ${MUTED}; font-size: 7pt;
    text-transform: uppercase; letter-spacing: .07em; line-height: 1.25;
    border-bottom: 0.5pt solid ${INK}; padding: 0 4mm 1.4mm 0;
  }
  /* Sin sangría por la izquierda, dos rótulos contiguos se leían como uno:
     «SALASREVISADAS». La calle va por la izquierda de la columna numérica, que
     es la que la necesita. */
  table.datos th.num, table.datos td.num {
    text-align: right; padding-right: 0; padding-left: 5mm;
  }
  table.datos td {
    padding: 1.7mm 4mm 1.7mm 0; border-bottom: 0.5pt solid ${HAIR};
    vertical-align: baseline;
  }
  table.datos th:last-child, table.datos td:last-child { padding-right: 0; }
  /* La calle entre columnas se pone SIEMPRE por la izquierda de la segunda, no
     por la derecha de la primera: una columna numérica termina pegada a su
     borde derecho —es lo que la hace legible— y sin esto el rótulo siguiente se
     le juntaba encima. Se leía «SALASREVISADAS» y «1datos insuficientes». */
  table.datos th + th, table.datos td + td { padding-left: 3.5mm; }
  table.datos td.num {
    font-family: "IBM Plex Mono", monospace; font-variant-numeric: tabular-nums;
  }
  table.datos tr { page-break-inside: avoid; }

  table.cifras { width: 100%; border-collapse: collapse; font-size: 8.8pt; }
  table.cifras td { padding: 1.7mm 0; border-bottom: 0.5pt solid ${HAIR}; }
  table.cifras td.num {
    text-align: right; font-variant-numeric: tabular-nums; font-weight: 600;
  }

  /* ── Diario y revisiones ── */
  /* Un filete fino donde empieza cada jornada: separa el bloque del día sin
     necesidad de dejar aire, que en una tabla de treinta filas se come media
     página. */
  table.datos tr.jornada td { border-top: 0.5pt solid ${LINE}; padding-top: 2.6mm; }
  table.datos tr.jornada:first-child td { border-top: 0; }

  /* La jornada SÍ se puede partir. Prohibirlo empujaba el día entero a la
     página siguiente y dejaba media en blanco. Lo que no se parte es la
     cabecera de su primera fila: un «miércoles 19» al pie de una página, con
     sus movimientos en la siguiente, es peor que el corte. */
  .dia { margin-bottom: 5mm; }
  .dia-cab {
    display: flex; align-items: baseline; gap: 3mm;
    border-bottom: 0.5pt solid ${LINE}; padding-bottom: 1.2mm; margin-bottom: 1.5mm;
    page-break-after: avoid;
  }
  .dia-fecha { font-size: 9pt; font-weight: 600; }
  .dia-res { font-size: 8pt; color: ${MUTED}; }
  table.diario td { padding-top: 1.4mm; padding-bottom: 1.4mm; border-bottom: 0; }
  table.diario tr:not(:last-child) td { border-bottom: 0.5pt solid ${HAIR}; }
  .tag {
    display: inline-block; font-size: 6.8pt; text-transform: uppercase;
    letter-spacing: .07em; color: ${MUTED}; border: 0.5pt solid ${LINE};
    border-radius: 2px; padding: 0.3mm 1.2mm; white-space: nowrap;
  }
  .ev-det {
    display: block; font-family: "IBM Plex Serif", Georgia, serif;
    font-size: 8pt; color: ${MUTED}; line-height: 1.4; margin-top: 0.4mm;
  }

  /* ── Medidor ── */
  .med {
    display: inline-block; width: 14mm; height: 1.4mm; background: ${HAIR};
    margin-right: 2mm; vertical-align: middle; overflow: hidden;
  }
  .med > span { display: block; height: 100%; }
  .med-n {
    font-family: "IBM Plex Mono", monospace; font-size: 8pt;
    font-variant-numeric: tabular-nums; color: ${MUTED};
  }

  /* ── Franja de composición ── */
  .franja {
    height: 3.4mm; width: 100%; overflow: hidden; background: ${HAIR};
    margin-bottom: 2mm;
  }
  .franja > span {
    display: inline-block; height: 3.4mm; vertical-align: top;
    /* 2 px de papel entre tramos: separa sin dibujar un borde. */
    box-shadow: inset -2px 0 0 #FFFFFF;
  }
  .franja-pie { font-size: 8pt; color: ${MUTED}; }
  .lg { margin-right: 5mm; white-space: nowrap; }
  .lg > i {
    display: inline-block; width: 2.2mm; height: 2.2mm; margin-right: 1.4mm;
    vertical-align: middle;
  }
  .lg b { font-family: "IBM Plex Mono", monospace; color: ${INK}; font-weight: 600; }

  /* ── Acciones ── */
  .acciones { margin: 0; padding: 0; list-style: none; counter-reset: acc; }
  .acciones li {
    counter-increment: acc; position: relative;
    padding: 0 0 3.5mm 9mm; page-break-inside: avoid;
  }
  .acciones li::before {
    content: counter(acc, decimal-leading-zero);
    position: absolute; left: 0; top: 0.2mm;
    font-family: "IBM Plex Mono", monospace; font-size: 9pt; color: ${ACENTO};
  }
  .acc-t { font-size: 9.5pt; font-weight: 600; line-height: 1.35; }
  .acc-p {
    font-family: "IBM Plex Serif", Georgia, serif;
    font-size: 9pt; color: ${INK2}; line-height: 1.5; margin-top: 0.8mm;
  }

  /* ── Colofón ── */
  .colofon {
    margin-top: 10mm; padding-top: 0; font-size: 8pt; color: ${MUTED};
    page-break-inside: avoid; line-height: 1.5;
  }
  .colofon .rotulo { border-bottom-color: ${LINE}; }
  .colofon p { max-width: 150mm; }
</style>
</head>
<body>

<header class="masthead">
  <div class="kicker">Mantenimiento de aulas · ${esc(titulo)}</div>
  <h1>${esc(l.titular)}</h1>
  <div class="sumario">
    <span class="mono">${esc(d.periodoTexto)}</span> · emitido el
    <span class="mono">${esc(pie.emitido)}</span>${
      pie.solicitante ? ` · a petición de ${esc(pie.solicitante)}` : ''
    }
  </div>
  <div class="filete"></div>
  ${o.nota ? `<div class="nota-pedido">${esc(o.nota)}</div>` : ''}
</header>

${
  tiene(o, 'resumen')
    ? `<table class="entrada"><tr>
  <td class="col-texto">
    <p class="entradilla">${capitular(l.entradilla)}</p>
  </td>
  <td class="col-panel">
    ${panelIndicadores(inds, comparar, d.comparacionTexto)}
  </td>
</tr></table>`
    : ''
}

${cuerpo}

${colofon(d, o, pie)}

</body>
</html>`
}
