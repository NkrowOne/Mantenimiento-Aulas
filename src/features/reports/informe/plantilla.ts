/**
 * La plantilla del informe.
 *
 * Devuelve un documento HTML **autocontenido**: los gráficos van dentro como
 * SVG, no hay una sola petición a la red al abrirlo y no hay una sola línea de
 * JavaScript. Eso es lo que permite archivarlo tal cual, abrirlo dentro de la
 * aplicación en un iframe aislado y convertirlo a PDF en el servidor —con
 * WeasyPrint— o, si el servidor no está, con «Guardar como PDF» del navegador.
 *
 * Restricciones que se respetan, porque el documento lo componen DOS motores
 * —WeasyPrint y el navegador— y tiene que salir igual de los dos:
 *  - Nada de JavaScript. Los gráficos entran ya como SVG.
 *  - Maquetación con `table` y cajas simples. Ni Grid ni Flex: cada motor de
 *    impresión los trata a su manera. El rótulo de sección iba en flex, y
 *    WeasyPrint lo partía en dos líneas —«Dónde está el / trabajo»— en todos
 *    los informes; nadie lo veía porque en la vista previa del navegador salía
 *    bien.
 *  - Sin `box-shadow`, que WeasyPrint no pinta: lo que antes separaba los
 *    tramos de una franja con una sombra interior ahora es un hueco de verdad,
 *    dibujado en el SVG.
 *  - Los saltos de página se controlan a mano, bloque por bloque.
 *  - Las cajas de margen de `@page` (`@top-right`, `counter(pages)`) son de
 *    CSS Paged Media: WeasyPrint las imprime y un navegador las ignora y pone
 *    su propia cabecera. Se dejan porque no estorban donde no se entienden, y
 *    porque nada del contenido del informe depende de ellas: lo que hay que
 *    leer está en el flujo del documento.
 *
 * LAS DECISIONES DE DISEÑO, que son el motivo de que este fichero sea largo:
 *
 *  · **La primera página se sostiene sola.** Quien no pasa de ella se lleva el
 *    titular, las cuatro cifras, el párrafo que las cuenta y lo más destacado.
 *    Todo lo demás es para quien quiere saber por qué.
 *  · **Las cuatro cifras, arriba y a todo lo ancho.** Iban en un recuadro al
 *    lado de la entradilla, en dos por dos y a 16 puntos: eran lo que más se
 *    mira del documento y había que buscarlas. Ahora son lo primero que se ve
 *    después del titular, cada una en su casilla y con su variación.
 *  · **Dos familias con dos oficios.** Serif para lo que se lee seguido —el
 *    titular, la entradilla, los motivos—; sans para lo que se consulta a
 *    saltos —rótulos, tablas, cifras—. Es lo que separa un documento de un
 *    volcado: el ojo sabe, sin pensarlo, qué es texto y qué es dato.
 *  · **El color es del dato y de lo conseguido, no del adorno.** Un tono de
 *    marca para los rótulos y las figuras, verde donde algo ha salido bien, y
 *    el rojo guardado para lo único que urge. Ni un semáforo.
 *  · **Ni un emoji, ni una negrita de énfasis, ni un signo de exclamación.** El
 *    énfasis se hace con jerarquía y con aire, que es lo que se ha hecho siempre
 *    en un documento impreso.
 *  · **Las secciones vacías no se imprimen** cuando no dicen nada, y sí cuando
 *    lo que dicen es una buena noticia. «Ninguna lámpara por debajo del umbral»
 *    informa; «No se ha hecho ninguna revisión» no: la ronda de revisión es de
 *    campaña, y una semana sin ella es una semana normal.
 */

import {
  ANCHO_MEDIO,
  ANCHO_TOTAL,
  RAMPA_DE_TIEMPOS,
  TONO_DE_SERIE,
  type Tramo,
  actividadDiaria,
  barraDeTramos,
  barrasHorizontales,
  franjaDeTramos,
  tendencia,
} from './graficos'
import type { ReportData } from './tipos'
import { type Indicador, type Lectura, dias as textoDias, indicadores, plural } from './analisis'
import { type Audiencia, type Opciones, type Seccion, tiene } from './opciones'
import { diaDeLaSemana, etiquetaDia, nombreDia } from '../periodos'
import { bandaDeMarcas } from './marcas'

/*
 * La paleta de la aplicación, para que el PDF y la pantalla sean el mismo
 * producto, con el papel un punto más cálido que la pantalla.
 *
 * Un informe de mantenimiento no da malas noticias: cuenta cómo va el trabajo,
 * y casi siempre va bien. Los tonos de estado siguen ahí —hacen falta para
 * distinguir de un vistazo lo que urge—, solo que dichos en voz normal.
 *
 * Todos pasan 4,5:1 sobre el blanco Y sobre el crema del papel, que es donde de
 * verdad se leen. El más justo es MUTED, que es además el que más letra pequeña
 * lleva: 5,9 sobre blanco y 5,4 sobre crema.
 */
const ACENTO = '#0B6B70'
/** El acento aguado, para fondos teñidos: marcas de hallazgo, pistas de medidor. */
const TINTE = '#E9F1F0'
const INK = '#1A2226'
const INK2 = '#42525A'
const MUTED = '#57676E'
const LINE = '#DEE2E0'
const HAIR = '#EDEFEC'
const PAPEL = '#F6F5F1'
const OK = '#1B6E4B'
/** El verde aguado: el fondo de la marca de «hecho». */
const OK_TINTE = '#E2F1E9'
const WARN = '#8A5B14'
const CRIT = '#A33529'
/** El rojo aguado: la pista de un medidor que va en rojo. */
const CRIT_TINTE = '#F6E4E1'

const SANS = '"IBM Plex Sans", "Instrument Sans Variable", system-ui, sans-serif'
const SERIF = '"IBM Plex Serif", Georgia, serif'
const MONO = '"IBM Plex Mono", ui-monospace, monospace'

/*
 * Cómo se llama cada informe, que es también cómo se llama el fichero PDF y lo
 * primero que se lee de la portada.
 *
 * El de fechas elegidas a mano se llamaba «Informe a medida». Es lenguaje de
 * folleto —lo «a medida» es el traje, no el documento— y encima no dice nada:
 * quien lo abre seis meses después necesita saber DE QUÉ periodo es, y eso ya
 * va al lado en todos los sitios donde aparece el título. «Informe del periodo»
 * no promete nada y no estorba.
 */
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

/**
 * Los días escritos enteros, para justificar y no para resumir.
 *
 * `dias()` de `analisis.ts` redondea porque va en una cifra de cabecera: allí,
 * «3,5 días» es exactamente lo que hace falta. Aquí no. Cuando alguien pregunta
 * por qué una incidencia concreta llevó lo que llevó, «3,5 días» invita a la
 * siguiente pregunta y «3 días y 12 h» la cierra. Y por debajo de un día se
 * cuenta en horas, que es como lo cuenta quien estuvo allí.
 */
export function diasLargo(dias: number): string {
  const horasTotales = dias * 24
  if (horasTotales < 1) return `${Math.max(1, Math.round(horasTotales * 60))} min`
  if (horasTotales < 24) return `${Math.round(horasTotales)} h`
  const enteros = Math.floor(dias)
  const horas = Math.round((dias - enteros) * 24)
  // 24 h de resto son un día más, no «3 días y 24 h».
  if (horas === 24) return plural(enteros + 1, 'día')
  if (horas === 0) return plural(enteros, 'día')
  return `${plural(enteros, 'día')} y ${horas} h`
}

/** Igual con las salas: en muchas, el código ES el nombre. */
function nombreSala(code: string, name: string): string {
  return name.trim().toUpperCase() === code.trim().toUpperCase() ? '' : name.trim()
}

/**
 * La primera en mayúscula, para cuando el texto abre una línea.
 *
 * `periodoTexto` se escribe en minúscula porque casi siempre va detrás de algo
 * —«Informe semanal · del 27 al 31»—, y en la portada abre el renglón él solo.
 */
function mayuscula(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/**
 * El titular, partido por donde mejor queda.
 *
 * Un titular que no cabe en un renglón lo parte el motor por donde se le acaba
 * el sitio, y lo normal es que deje una palabra sola abajo: «…8 de ellos el
 * mismo / día». Ni WeasyPrint ni Safari saben todavía equilibrar renglones, así
 * que se hace a mano: si el texto va a ocupar dos, se corta por el espacio más
 * cercano a la mitad. Más corto cabe en uno y no se toca; más largo ocupa tres
 * y ahí ya no hay viuda que evitar.
 *
 * Y con preferencia por donde la frase ya respira: una coma cerca de la mitad
 * gana a un espacio justo en la mitad. «13 partes resueltos, 10 / de ellos el
 * mismo día» está equilibrado y se lee a trompicones; «13 partes resueltos, /
 * 10 de ellos el mismo día» son dos renglones que dicen cada uno una cosa.
 *
 * Devuelve HTML: el texto escapado y, si acaso, un `<br>`.
 */
const CABE_EN_UN_RENGLON = 40
const CABE_EN_DOS = 78
/** Cuántos caracteres de desequilibrio compensa cortar detrás de una pausa. */
const VALE_UNA_PAUSA = 9

export function titularEnDosRenglones(texto: string): string {
  const t = texto.trim().replace(/\s+/g, ' ')
  if (t.length <= CABE_EN_UN_RENGLON || t.length > CABE_EN_DOS) return esc(t)
  const mitad = t.length / 2
  let corte = -1
  let mejor = Infinity
  for (let i = 1; i < t.length; i++) {
    if (t[i] !== ' ') continue
    const coste = Math.abs(i - mitad) - (/[,;:]/.test(t[i - 1]!) ? VALE_UNA_PAUSA : 0)
    if (coste < mejor) {
      mejor = coste
      corte = i
    }
  }
  if (corte < 0) return esc(t)
  return `${esc(t.slice(0, corte))}<br>${esc(t.slice(corte + 1))}`
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
 *
 * Lo que sube para bien va en verde. Lo que baja, o lo que sube sin ser ni
 * bueno ni malo —los partes que entran—, va en gris: está dicho, con su cifra,
 * y no se le pone color de alarma a una semana con dos cierres menos.
 */
function variacion(ind: Indicador): string {
  const d = ind.delta
  if (!d || d.valor === 0) {
    return `<div class="var">sin cambio</div>`
  }
  const sube = d.valor > 0
  const bueno = !d.neutra && sube === d.subirEsBueno
  const clase = `${sube ? 'sube' : 'baja'}${bueno ? ' bien' : ''}`
  const cifra = `${sube ? '+' : '−'}${Math.abs(d.valor)}`
  const rel = d.pct === null ? '' : ` (${d.pct > 0 ? '+' : ''}${d.pct} %)`
  return `<div class="var ${clase}"><i class="flecha"></i>${cifra}${rel}</div>`
}

/**
 * Las cuatro cifras, en una tira a todo lo ancho.
 *
 * Cada una en su casilla, con la raya de marca por arriba: son lo que más se
 * mira del documento y tienen que encontrarse sin leer. La cifra va en la sans
 * del resto —no en una letra de exhibición— y con sus números de ancho
 * natural: los de ancho fijo son para alinear columnas, y a este tamaño dejan
 * un «121» con huecos.
 *
 * Solo se pinta de rojo la que urge. Cuando todo está coloreado, el color deja
 * de decir nada y la tira parece una alarma incluso en una semana buena.
 */
function tiraDeCifras(inds: Indicador[], comparar: boolean, comparacion: string): string {
  const casilla = (i: Indicador): string => `
      <td class="cifra">
        <div class="cifra-et">${esc(i.etiqueta)}</div>
        <div class="cifra-val"${i.tono === 'critico' ? ` style="color:${CRIT}"` : ''}>${esc(i.valor)}</div>
        <div class="cifra-det">${esc(i.detalle)}</div>
        ${comparar && i.delta ? variacion(i) : ''}
      </td>`

  return `
  <div class="tira-caja">
    <table class="tira"><tr>${inds.map(casilla).join('')}
    </tr></table>
  </div>
  ${comparar ? `<p class="tira-nota">La variación compara con ${esc(comparacion)}.</p>` : ''}`
}

/**
 * Rótulo de sección: el filete de marca a la izquierda, el título y su apunte.
 *
 * Los dos textos van como bloques en línea y no en flex. En flex, WeasyPrint
 * encogía el título hasta partirlo en dos renglones aunque sobrara medio folio
 * a su derecha.
 */
function rotulo(texto: string, apunte?: string): string {
  return `<div class="rotulo"><span class="rotulo-t">${esc(texto)}</span>${
    apunte ? `<span class="rotulo-a">${esc(apunte)}</span>` : ''
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

/** La leyenda de una barra de tramos: el color, el nombre y —si no cupo dentro— la cifra. */
function leyenda(tramos: Tramo[], conCifra: (t: Tramo) => boolean): string {
  return `<div class="leyenda">${tramos
    .filter((t) => t.valor > 0)
    .map(
      (t) =>
        `<span class="lg"><i style="background:${t.color}"></i>${esc(t.nombre)}${
          conCifra(t) ? ` <b>${t.valor}</b>` : ''
        }</span>`,
    )
    .join('')}</div>`
}

/**
 * Medidor de una razón contra su límite.
 *
 * La pista es el mismo tono, aguado: así la barra entera dice de qué color es
 * el estado y no solo el trozo relleno, que con un 8 % son dos milímetros.
 */
function medidor(parte: number, total: number, tono = ACENTO, pista = TINTE): string {
  const pct = total ? Math.min(100, Math.round((parte / total) * 100)) : 0
  return `<span class="med" style="background:${pista}"><span style="width:${Math.max(pct === 0 ? 0 : 3, pct)}%;background:${tono}"></span></span>`
}

function vacio(texto: string): string {
  return `<p class="vacio">${esc(texto)}</p>`
}

/** Una buena noticia que ocupa el sitio de una tabla: con su marca de hecho. */
function enOrden(texto: string): string {
  return `<p class="en-orden">${MARCA_HECHO}<span>${esc(texto)}</span></p>`
}

/*
 * Las dos marcas de un hallazgo, dibujadas. No son emojis ni un semáforo: un
 * visto para lo que ha salido y una flecha para lo que sigue su curso. En SVG
 * para que salgan igual de los dos motores y a cualquier tamaño.
 */
const MARCA_HECHO =
  `<svg xmlns="http://www.w3.org/2000/svg" class="marca" width="5.4mm" height="5.4mm" viewBox="0 0 20 20" aria-hidden="true">` +
  `<circle cx="10" cy="10" r="10" fill="${OK_TINTE}"/>` +
  `<path d="M5.7 10.5l2.9 2.9 5.7-6.3" fill="none" stroke="${OK}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`

const MARCA_EN_CURSO =
  `<svg xmlns="http://www.w3.org/2000/svg" class="marca" width="5.4mm" height="5.4mm" viewBox="0 0 20 20" aria-hidden="true">` +
  `<circle cx="10" cy="10" r="10" fill="${TINTE}"/>` +
  `<path d="M5.6 10h8M10.4 6.6l3.4 3.4-3.4 3.4" fill="none" stroke="${ACENTO}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`

interface Columna<T> {
  cab: string
  /** Alineado a la derecha y en mono: es una cifra. */
  num?: boolean
  ancho?: string
  celda: (fila: T) => string
}

function tabla<T>(filas: T[], cols: Array<Columna<T>>, pie?: string[]): string {
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
      ${
        pie
          ? `<tr class="total">${cols.map((c, i) => `<td${c.num ? ' class="num"' : ''}>${pie[i] ?? ''}</td>`).join('')}</tr>`
          : ''
      }
    </tbody>
  </table>`
}

// ── La primera página ────────────────────────────────────────────────────────

/**
 * De qué son los partes que han entrado: la franja y su lista.
 *
 * Va al lado de la entradilla, que es donde se pregunta —«catorce partes, ¿de
 * qué?»—. Con una sola clase no se imprime: una barra al 100 % no compara nada.
 */
function composicion(d: ReportData): string {
  const partes: Tramo[] = [
    {
      nombre: 'Incidencias',
      valor: d.porTipo.find((t) => t.tipo === 'incidencia')?.total ?? 0,
      color: TONO_DE_SERIE.primero,
    },
    {
      nombre: 'Solicitudes',
      valor: d.porTipo.find((t) => t.tipo === 'solicitud')?.total ?? 0,
      color: TONO_DE_SERIE.segundo,
    },
    {
      nombre: 'Observaciones',
      valor: d.porTipo.find((t) => t.tipo === 'observacion')?.total ?? 0,
      color: TONO_DE_SERIE.tercero,
    },
  ]
  if (partes.filter((p) => p.valor > 0).length < 2) return ''

  const QUE_ES: Record<string, string> = {
    Incidencias: 'algo que falla',
    Solicitudes: 'trabajo pedido',
    Observaciones: 'notas de seguimiento',
  }

  return `
    <div class="lateral">
      <div class="lateral-t">De qué son los partes</div>
      ${franjaDeTramos(partes, { width: 232, alto: 8 })}
      <table class="lista">
        ${partes
          .filter((p) => p.valor > 0)
          .map(
            (p) => `<tr>
          <td><i class="pastilla" style="background:${p.color}"></i>${esc(p.nombre)} <span class="tenue">· ${esc(QUE_ES[p.nombre] ?? '')}</span></td>
          <td class="num">${p.valor}</td>
        </tr>`,
          )
          .join('')}
      </table>
    </div>`
}

/**
 * Lo más destacado: los hallazgos, cada uno con su marca.
 *
 * De dos en dos: cuatro notas seguidas en una columna se leen como una lista de
 * avisos, y en dos columnas como las notas al margen de un informe. Lo
 * conseguido lleva el visto; lo que sigue su curso, la flecha.
 */
function seccionAnalisis(l: Lectura): string {
  if (!l.hallazgos.length) return ''

  const pares: Array<[typeof l.hallazgos[number], typeof l.hallazgos[number] | undefined]> = []
  for (let i = 0; i < l.hallazgos.length; i += 2) {
    pares.push([l.hallazgos[i]!, l.hallazgos[i + 1]])
  }

  const nota = (h: Lectura['hallazgos'][number]): string => `
        <table class="nota"><tr>
          <td class="nota-m">${h.clase === 'seguimiento' ? MARCA_EN_CURSO : MARCA_HECHO}</td>
          <td>
            <div class="nota-t">${esc(h.titulo)}</div>
            <div class="nota-c">${esc(h.cuerpo)}</div>
          </td>
        </tr></table>`

  // Sin clase —un informe redactado antes de que la hubiera— no se le pone
  // marca de «hecho» a lo que quizá no lo es: va la flecha, que no afirma nada.
  const conMarca = (h: Lectura['hallazgos'][number]): Lectura['hallazgos'][number] =>
    h.clase ? h : { ...h, clase: 'seguimiento' }

  return `
  <section class="bloque">
    ${rotulo('Lo más destacado')}
    <table class="notas">
      ${pares
        .map(
          ([a, b]) => `
      <tr>
        <td class="col-nota">${nota(conMarca(a))}</td>
        <td class="col-nota">${b ? nota(conMarca(b)) : ''}</td>
      </tr>`,
        )
        .join('')}
    </table>
  </section>`
}

// ── Secciones ────────────────────────────────────────────────────────────────

/**
 * La actividad del periodo, día a día: lo que entra y lo que se resuelve.
 *
 * Las revisiones solo se dibujan si las hubo. Con la ronda fuera de campaña,
 * una tercera serie a cero era una leyenda que no señalaba a nada y un hueco en
 * cada jornada.
 *
 * Los sábados y domingos EN BLANCO no se dibujan. El servicio trabaja de lunes
 * a viernes: en un periodo de cinco semanas son diez columnas a cero que
 * estrechan a las demás y dan al gráfico un aspecto de parón que no ha
 * existido. No se esconde nada —el total de la sección se cuenta sobre el
 * periodo entero— y el fin de semana CON movimiento sí se dibuja: es
 * precisamente el dato que hay que ver, y su etiqueta lo dice sola, «S 1».
 */
function seccionActividad(d: ReportData): string {
  if (d.serieDiaria.length < 2) return ''
  const total = d.serieDiaria.reduce((a, x) => a + x.revisiones + x.abiertas + x.resueltas, 0)
  const serie = d.serieDiaria.filter(
    (x) => diaDeLaSemana(x.dia) < 6 || x.revisiones + x.abiertas + x.resueltas > 0,
  )
  const fuera = d.serieDiaria.length - serie.length
  const conRevisiones = d.serieDiaria.some((x) => x.revisiones > 0)

  return `
  <section class="bloque evitar">
    ${rotulo('Actividad', d.dias === 1 ? 'la jornada' : `los ${d.dias} días del periodo`)}
    ${
      total === 0
        ? vacio('Ningún movimiento registrado en el periodo: ni partes nuevos ni cierres.')
        : figura(
            'Día a día',
            `Partes que entran y partes que se resuelven${conRevisiones ? ', y revisiones completadas' : ''}${
              fuera > 0 ? ' · fines de semana sin actividad, fuera del gráfico' : ''
            }`,
            actividadDiaria(
              serie.map((x) => etiquetaDia(x.dia)),
              [
                { nombre: 'Entran', datos: serie.map((x) => x.abiertas) },
                { nombre: 'Se resuelven', datos: serie.map((x) => x.resueltas) },
                // La tercera, y siempre en su sitio: el color es de la serie,
                // no del orden en que le toque salir.
                ...(conRevisiones
                  ? [{ nombre: 'Revisiones', datos: serie.map((x) => x.revisiones) }]
                  : []),
              ],
              { width: ANCHO_TOTAL, height: 184 },
            ),
          )
    }
  </section>`
}

/**
 * Con qué rapidez se resuelve. Sección propia, y se puede quitar.
 *
 * Los cierres, repartidos por lo que llevaron, en una sola barra: de un
 * vistazo se ve cuántos se resolvieron el mismo día. Al lado, las tres cifras
 * que se citan.
 *
 * Para dirección son tres tramos y no cuatro —el mismo día, en 48 horas,
 * después— y no sale la media: la media la arrastra cualquier parte antiguo
 * que se cierre esta semana, y «después» no necesita desglosarse para decir lo
 * que hay que decir. El equipo lleva los cuatro y la media con su explicación,
 * porque es con lo que trabaja.
 */
function seccionTiempos(d: ReportData, audiencia: Audiencia): string {
  const r = d.resolucion
  // Sin cierres no hay rapidez que medir, y una sección para decirlo no informa.
  if (r.resueltas === 0) return ''

  const dir = audiencia === 'direccion'
  const t = r.tramos
  const tramos: Tramo[] = dir
    ? [
        { nombre: 'El mismo día', valor: t.mismoDia, color: RAMPA_DE_TIEMPOS[1] },
        { nombre: 'En menos de 48 h', valor: t.hasta48h, color: RAMPA_DE_TIEMPOS[2] },
        { nombre: 'Después', valor: t.hastaUnaSemana + t.mas, color: RAMPA_DE_TIEMPOS[3] },
      ]
    : [
        { nombre: 'El mismo día', valor: t.mismoDia, color: RAMPA_DE_TIEMPOS[0] },
        { nombre: 'En menos de 48 h', valor: t.hasta48h, color: RAMPA_DE_TIEMPOS[1] },
        { nombre: 'En la semana', valor: t.hastaUnaSemana, color: RAMPA_DE_TIEMPOS[2] },
        { nombre: 'Más de una semana', valor: t.mas, color: RAMPA_DE_TIEMPOS[3] },
      ]
  const barra = barraDeTramos(tramos, { width: 380, alto: 28 })

  return `
  <section class="bloque evitar">
    ${rotulo('Con qué rapidez se resuelve', plural(r.resueltas, 'cierre'))}
    <table class="dos"><tr>
      <td class="col-ancha">
        <div class="fig-t">Cuánto llevó cada cierre</div>
        <div class="fig-n">Desde que entra el aviso hasta que se da por resuelto</div>
        <div class="barra">${barra.svg}</div>
        ${leyenda(tramos, (x) => barra.sinCifra.has(x.nombre))}
      </td>
      <td class="col-estrecha">
        <table class="cifras">
          <tr><td>La mitad se cierra en</td><td class="num">${esc(textoDias(r.medianaDias))}</td></tr>
          <tr><td>En menos de 48 h</td><td class="num">${r.enMenosDe48h} de ${r.resueltas}</td></tr>
          <tr><td>El mismo día</td><td class="num">${t.mismoDia} de ${r.resueltas}</td></tr>
          ${
            // Solo para el equipo, y solo si dice algo distinto de la mediana.
            !dir && textoDias(r.mediaDias) !== textoDias(r.medianaDias)
              ? `<tr><td>Media, arrastrando las antiguas</td><td class="num">${esc(textoDias(r.mediaDias))}</td></tr>`
              : ''
          }
        </table>
      </td>
    </tr></table>
    ${
      dir
        ? ''
        : `<p class="apunte">La mediana va primero porque la media la mueve cualquier
    parte antiguo que se cierre esta semana.</p>`
    }
  </section>`
}

/**
 * Dónde se ha trabajado: el reparto por edificio y la tendencia.
 *
 * La tabla cuenta lo que el edificio pidió y lo que recibió —aulas atendidas,
 * partes que entraron, partes resueltos— y lo que queda en curso. La columna de
 * salas revisadas solo sale si en el periodo se revisó alguna: fuera de
 * campaña era una columna entera de «0 · 0 %» que hacía parecer desatendido un
 * edificio en el que se habían cerrado seis partes.
 */
function seccionEdificios(d: ReportData, conTendencia: boolean, audiencia: Audiencia): string {
  const conPartes = d.porEdificio.filter((b) => b.abiertas > 0)
  const top = conPartes.slice(0, 8)
  const hayAlgo = d.porEdificio.some(
    (b) => b.abiertas > 0 || b.cerradas > 0 || b.atendidas > 0 || b.revisadas > 0 || b.pendientes > 0,
  )
  // Un periodo sin nada en ningún edificio: el reparto no tiene qué repartir.
  // La tendencia, si se pidió, sale sola —es de doce meses, no del periodo—.
  if (!hayAlgo) return conTendencia ? seccionTendencia(d) : ''

  const izquierda = top.length
    ? figura(
        'Partes atendidos por edificio',
        'Los que entraron en el periodo, sin contar borradores',
        barrasHorizontales(
          top.map((b) => b.code),
          top.map((b) => b.abiertas),
          { width: ANCHO_MEDIO, height: Math.max(96, 20 + top.length * 22) },
        ),
      )
    : vacio('Ningún parte nuevo asignado a un edificio en el periodo.')

  const derecha =
    conTendencia && d.porMes.length > 1
      ? figura(
          'Partes por mes',
          'Últimos doce meses, todo el campus',
          tendencia(
            d.porMes.map((m) => m.month.slice(2)),
            d.porMes.map((m) => m.total),
            { width: ANCHO_MEDIO, height: 166 },
          ),
        )
      : ''

  /*
   * Solo los edificios con algo que contar. Con diecisiete filas, once de ellas
   * a cero, la tabla ocupaba dos páginas para decir que no se pasó por allí. Los
   * que se quedan fuera se cuentan al pie: quitar filas sin avisar es esconder.
   *
   * El criterio es LO QUE PASÓ, no si el edificio sigue en la lista de trabajo:
   * un edificio archivado —el que se manda a la papelera cuando se reorganiza el
   * campus— sale con todo lo que se hizo en él, y marcado.
   */
  const conDatos = d.porEdificio.filter(
    (b) => b.abiertas > 0 || b.cerradas > 0 || b.atendidas > 0 || b.revisadas > 0 || b.pendientes > 0,
  )
  const filas = conDatos.slice(0, 12)
  // Los dos recortes por separado, porque el pie los nombra y no son lo mismo:
  // llamar «sin actividad» a un edificio que se quedó fuera por el tope de doce
  // filas TENIENDO datos es mentirle al lector en la línea que existe para no
  // esconderle nada.
  const recortados = conDatos.length - filas.length
  const sinActividad = d.porEdificio.length - conDatos.length
  const archivados = filas.filter((b) => b.archivado).length
  const conRevisiones = conDatos.some((b) => b.revisadas > 0)
  const suma = (campo: 'atendidas' | 'abiertas' | 'cerradas' | 'pendientes' | 'revisadas'): number =>
    d.porEdificio.reduce((a, b) => a + b[campo], 0)
  const cifra = (n: number): string => (n ? String(n) : '—')

  const columnas: Array<Columna<ReportData['porEdificio'][number]>> = [
    {
      cab: 'Edificio',
      ancho: conRevisiones ? '32%' : '38%',
      celda: (b) => {
        const n = nombreEdificio(b.code, b.name)
        // La marca va pegada al nombre y no en una columna aparte: es lo que
        // explica que esa fila no tenga cola de hoy.
        const marca = b.archivado ? ' <span class="tenue">· archivado</span>' : ''
        return `<span class="mono">${esc(b.code)}</span>${n ? ` <span class="tenue">${esc(n)}</span>` : ''}${marca}`
      },
    },
    { cab: 'Aulas atendidas', num: true, celda: (b) => cifra(b.atendidas) },
    { cab: 'Entraron', num: true, celda: (b) => cifra(b.abiertas) },
    { cab: 'Resueltos', num: true, celda: (b) => cifra(b.cerradas) },
    ...(conRevisiones
      ? [{ cab: 'Aulas revisadas', num: true, celda: (b: ReportData['porEdificio'][number]) => cifra(b.revisadas) }]
      : []),
    {
      cab: 'En seguimiento hoy',
      num: true,
      celda: (b) =>
        b.pendientes
          ? `<span style="color:${b.pendientes > 3 && audiencia !== 'direccion' ? CRIT : INK}">${b.pendientes}</span>`
          : '—',
    },
  ]

  const totales = [
    'Todo el campus',
    cifra(suma('atendidas')),
    cifra(suma('abiertas')),
    cifra(suma('cerradas')),
    ...(conRevisiones ? [cifra(suma('revisadas'))] : []),
    cifra(suma('pendientes')),
  ]

  return `
  <section class="bloque">
    ${rotulo('Dónde se ha trabajado')}
    ${
      derecha
        ? `<table class="dos"><tr>
      <td class="col-mitad">${izquierda}</td>
      <td class="col-mitad">${derecha}</td>
    </tr></table>`
        : izquierda
    }
    ${
      filas.length
        ? `<div class="sub">
      <div class="sub-t">Lo atendido y lo que queda en curso, por edificio</div>
      ${tabla(filas, columnas, filas.length > 1 ? totales : undefined)}
      ${
        recortados > 0 || sinActividad > 0 || archivados > 0
          ? `<p class="apunte">${[
              recortados > 0
                ? `${plural(recortados, 'edificio')} con actividad fuera de la tabla por sitio${filas.length > 1 ? ', dentro del total' : ''}`
                : '',
              sinActividad > 0
                ? `${plural(sinActividad, 'edificio')} sin partes en el periodo`
                : '',
              // Que se sepa por qué esa fila no tiene cola: el edificio está en
              // la papelera y su trabajo del periodo se cuenta igual.
              archivados > 0
                ? `${plural(archivados, 'edificio')} archivado${archivados === 1 ? '' : 's'}: fuera de la lista de trabajo, con lo que pasó en el periodo`
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

/** La tendencia por su cuenta, cuando se pide sin el reparto por edificio. */
function seccionTendencia(d: ReportData): string {
  if (d.porMes.length < 2) return ''
  return `
  <section class="bloque evitar">
    ${rotulo('Tendencia', 'últimos doce meses')}
    ${figura(
      'Partes por mes',
      'Todo el campus, sin contar borradores',
      tendencia(
        d.porMes.map((m) => m.month.slice(2)),
        d.porMes.map((m) => m.total),
        { width: ANCHO_TOTAL, height: 190 },
      ),
    )}
  </section>`
}

/**
 * Material y almacén: lo que se ha servido y cómo queda.
 *
 * A la izquierda, lo que salió del almacén y lo que queda de cada cosa, que es
 * la pregunta que viene detrás de «se han gastado seis cables»: ¿y quedan? A la
 * derecha, el almacén de hoy en cuatro líneas. El detalle —cada movimiento con
 * su saldo, el stock al abrir y al cerrar el periodo y el de hoy— no cabe en un
 * papel ni tiene por qué: va en el Excel que acompaña al informe, y aquí se
 * dice.
 */
function seccionMateriales(d: ReportData): string {
  const s = d.situacion
  const hayAlmacen = s.articulosEnAlmacen > 0
  const nada = !d.materiales.length && !hayAlmacen && d.almacen.movimientos === 0
  if (nada) {
    return `
  <section class="bloque evitar">
    ${rotulo('Material y almacén')}
    ${vacio('Sin movimientos de almacén en el periodo.')}
  </section>`
  }

  const usado = d.materiales.length
    ? tabla(d.materiales, [
        { cab: 'Artículo', ancho: '46%', celda: (m) => esc(m.name) },
        { cab: 'Servidas', num: true, celda: (m) => `${m.consumido} ${esc(m.unidad)}` },
        { cab: 'Partes', num: true, celda: (m) => (m.incidencias ? String(m.incidencias) : '—') },
        {
          cab: 'Quedan',
          num: true,
          celda: (m) =>
            m.quedan === null
              ? '<span class="tenue">—</span>'
              : m.minimo > 0 && m.quedan <= m.minimo
                ? `<span style="color:${WARN}">${m.quedan}</span>`
                : String(m.quedan),
        },
      ])
    : vacio('No ha salido material del almacén en el periodo.')

  const lineas: Array<[string, string]> = []
  if (hayAlmacen) {
    lineas.push([
      'Artículos con existencias',
      `<span class="junto">${medidor(s.articulosConExistencias, s.articulosEnAlmacen)}<b>${s.articulosConExistencias}</b> de ${s.articulosEnAlmacen}</span>`,
    ])
    lineas.push([
      'Por debajo de su mínimo',
      s.articulosBajoMinimo > 0 ? `<b style="color:${WARN}">${s.articulosBajoMinimo}</b>` : '<b>ninguno</b>',
    ])
  }
  if (s.pcsDeRepuesto > 0) lineas.push(['Ordenadores de repuesto', `<b>${s.pcsDeRepuesto}</b>`])
  lineas.push(['Salidas en el periodo', `<b>${d.almacen.salidas}</b> ud`])
  if (d.almacen.entradas > 0) lineas.push(['Entradas en el periodo', `<b>${d.almacen.entradas}</b> ud`])

  return `
  <section class="bloque">
    ${rotulo('Material y almacén', plural(d.almacen.movimientos, 'movimiento') + ' en el periodo')}
    <table class="dos"><tr>
      <td class="col-ancha">
        <div class="sub-t">Lo que se ha servido</div>
        ${usado}
        ${
          d.materiales.some((m) => m.quedan !== null && m.minimo > 0 && m.quedan <= m.minimo)
            ? `<p class="apunte">En ámbar, lo que queda por debajo de su mínimo.</p>`
            : ''
        }
      </td>
      <td class="col-estrecha">
        <div class="lateral">
          <div class="lateral-t">El almacén, hoy</div>
          <table class="lista">
            ${lineas.map(([que, cuanto]) => `<tr><td>${esc(que)}</td><td class="num">${cuanto}</td></tr>`).join('')}
          </table>
        </div>
        ${
          // Al lado y no debajo: es una lista corta, y en una tabla a todo lo
          // ancho ocupaba media página para dos artículos.
          d.almacen.porReponer.length
            ? `<div class="lateral lateral-2">
          <div class="lateral-t">Para reponer</div>
          <table class="lista">
            ${d.almacen.porReponer
              .map(
                (x) =>
                  `<tr><td>${esc(x.name)}</td><td class="num"><b>${x.quedan}</b> de ${x.minimo} ${esc(x.unidad)}</td></tr>`,
              )
              .join('')}
          </table>
          <div class="lateral-n">Lo que queda, de su mínimo.</div>
        </div>`
            : ''
        }
      </td>
    </tr></table>
    <p class="apunte">El detalle va en el Excel que acompaña a este informe: el stock al
    abrir y al cerrar el periodo, cada movimiento con su saldo, el consumo por aula y el
    stock que hay hoy en el almacén.</p>
  </section>`
}

function seccionSalas(d: ReportData, audiencia: Audiencia): string {
  /*
   * Para dirección solo sale la pieza repetida —una mejora concreta, con su
   * sala y su ahorro—. El ranking de salas con más incidencias y su
   * fiabilidad en rojo es exactamente el «aula difícil» que este documento no
   * señala: hay aulas que dan más trabajo, y eso no es noticia para el
   * cliente.
   */
  const conRanking = audiencia !== 'direccion' && d.topSalas.length > 0
  if (!conRanking && !d.reincidentes.length) return ''

  return `
  <section class="bloque">
    ${rotulo(audiencia === 'direccion' ? 'Dónde hay una mejora clara' : 'Salas señaladas')}
    ${
      conRanking
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
                  ? `<span class="junto">${medidor(r.fiabilidad, 100, r.fiabilidad < 50 ? CRIT : r.fiabilidad < 75 ? WARN : OK, HAIR)}<span class="med-n">${r.fiabilidad}/100</span></span>`
                  : '<span class="tenue">datos insuficientes</span>',
            },
          ])
        : ''
    }
    ${
      d.reincidentes.length
        ? `<div class="sub">
      <div class="sub-t">Mismo repuesto, misma sala</div>
      <p class="apunte antes">Tres veces la misma pieza en seis meses no es mala suerte.${
        // Cómo se cuenta le sirve a quien va a ir al aula; a dirección le basta
        // con el dato.
        audiencia === 'direccion'
          ? ''
          : ` Se agrupa por
      artículo consumido y no por el texto del parte, que cada uno escribe distinto.`
      }</p>
      ${tabla(d.reincidentes, [
        { cab: 'Sala', celda: (r) => `<span class="mono">${esc(r.building)} ${esc(r.room)}</span>` },
        { cab: 'Repuesto', ancho: '50%', celda: (r) => esc(r.item) },
        // En rojo para el equipo, que es un aviso; en tinta para dirección, que
        // es una mejora con nombre y no una alarma.
        { cab: 'Veces', num: true, celda: (r) => `<span style="color:${audiencia === 'direccion' ? INK : CRIT}">${r.veces}</span>` },
      ])}
    </div>`
        : ''
    }
  </section>`
}

/**
 * Las lámparas por debajo del 20 % de vida.
 *
 * `enPareja` es la versión de media anchura, para cuando va al lado de la pieza
 * repetida: el rótulo se queda con el nombre y lo que antes era su apunte baja
 * a un subtítulo, que es lo que lleva la sección de al lado. Así las dos tablas
 * empiezan a la misma altura.
 */
function seccionLamparas(d: ReportData, audiencia: Audiencia, enPareja = false): string {
  const dir = audiencia === 'direccion'
  const titulo = dir ? 'Lámparas para cambiar' : 'Lámparas al límite'
  const contenido = d.lamparas.length
    ? tabla(d.lamparas, [
        { cab: 'Sala', ancho: enPareja ? '30%' : '34%', celda: (r) => `<span class="mono">${esc(r.building)} ${esc(r.room)}</span>` },
        {
          cab: enPareja ? 'Horas' : 'Horas de proyector',
          num: true,
          celda: (r) => (r.horas === null ? '—' : String(r.horas)),
        },
        {
          cab: 'Vida restante',
          ancho: enPareja ? '42%' : '30%',
          celda: (r) =>
            // En rojo para el equipo, que tiene que ir a cambiarla; para
            // dirección es un cambio programado y va en el tono de marca.
            `<span class="junto">${medidor(Math.round(r.pct * 100), 100, dir ? ACENTO : CRIT, dir ? TINTE : CRIT_TINTE)}<span class="med-n"${dir ? '' : ` style="color:${CRIT}"`}>${Math.round(r.pct * 100)} %</span></span>`,
        },
      ])
    : enOrden('Ninguna lámpara por debajo del umbral. Nada que pedir esta semana.')

  if (enPareja) {
    return `
  <section class="bloque evitar">
    ${rotulo(titulo)}
    <div class="sub">
      <div class="sub-t">Por debajo del 20 % de vida</div>
      <p class="apunte antes">Cambiarlas antes de que se fundan no interrumpe una clase.</p>
      ${contenido}
    </div>
  </section>`
  }

  return `
  <section class="bloque evitar">
    ${rotulo(titulo, 'por debajo del 20 % de vida')}
    ${contenido}
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
        : enOrden('Ninguna incidencia lleva más de una semana abierta.')
    }
  </section>`
}

function seccionEquipo(d: ReportData): string {
  if (!d.equipo.length) return ''
  // La columna de revisiones, solo en campaña: fuera de ella es una columna de
  // ceros al lado de un nombre, que se lee justo como lo que no es.
  const conRevisiones = d.equipo.some((p) => p.revisiones > 0)
  return `
  <section class="bloque evitar">
    ${rotulo('Reparto del trabajo')}
    <p class="apunte antes">No es un ranking. Una consulta de un minuto y una botonera desmontada
    cuentan igual aquí y no cuestan lo mismo.</p>
    ${tabla(d.equipo, [
      { cab: 'Persona', ancho: '52%', celda: (p) => esc(p.nombre) },
      { cab: 'Partes abiertos', num: true, celda: (p) => String(p.registros) },
      ...(conRevisiones
        ? [{ cab: 'Revisiones', num: true, celda: (p: ReportData['equipo'][number]) => String(p.revisiones) }]
        : []),
    ])}
  </section>`
}

function seccionRecomendaciones(l: Lectura, audiencia: Audiencia): string {
  if (!l.recomendaciones.length) return ''
  return `
  <section class="bloque evitar">
    ${rotulo(audiencia === 'direccion' ? 'Propuestas de mejora' : 'Qué conviene hacer')}
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

// ── Los listados ─────────────────────────────────────────────────────────────

/**
 * Las revisiones del periodo, una por línea.
 *
 * Solo si las hubo. Fuera de campaña no hay ninguna, y una sección entera para
 * decir «no se ha completado ninguna revisión» era el documento insistiendo en
 * lo que no tocaba hacer.
 *
 * El día se escribe solo cuando cambia, como en un libro de registro. Repetirlo
 * treinta y una veces convierte la primera columna en un muro y hace más difícil
 * ver dónde empieza cada jornada, que es justo lo que se viene a mirar.
 */
function seccionRevisiones(d: ReportData): string {
  if (!d.revisiones.length) return ''

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

  /*
   * Todos los días del periodo con algo que contar: eventos o revisiones, del
   * más reciente al más antiguo.
   *
   * `serieDiaria` va en orden de calendario porque es lo que dibuja el gráfico
   * de actividad —un eje de tiempo al revés no lo lee nadie—, así que aquí se
   * copia y se le da la vuelta en vez de tocarla. El diario es un registro de
   * trabajo, y un registro de trabajo se abre por lo último.
   */
  const dias = [...d.serieDiaria]
    .reverse()
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
   * ser una afirmación que no se puede hacer: los eventos vienen de lo más
   * reciente a lo más antiguo y el tope de filas corta por el final, así que
   * del día más viejo listado hacia atrás puede haber movimientos que
   * simplemente no caben. Los días POSTERIORES a ese sí están completos y
   * conservan la frase.
   */
  const truncado = d.eventosTotal > d.eventos.length
  const diaMasViejoListado = d.eventos.length ? d.eventos[d.eventos.length - 1]!.dia : ''
  // Si de verdad se revisó algo en el periodo: lo que justifica nombrarlo en la
  // cabecera de la sección y en las jornadas sin apuntes.
  const huboRevisiones = d.serieDiaria.some((s) => s.revisiones > 0)

  const jornada = (dia: string): string => {
    const s = d.serieDiaria.find((x) => x.dia === dia)
    const resumen = [
      s?.abiertas ? plural(s.abiertas, 'parte nuevo', 'partes nuevos') : '',
      s?.resueltas ? plural(s.resueltas, 'resuelto', 'resueltos') : '',
      s?.revisiones ? plural(s.revisiones, 'revisión', 'revisiones') : '',
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
              // Una incidencia y su cierre se leen enteros: cortados a media
              // frase, «Se le indica al usuario por teléfono cómo…» no dice
              // qué se hizo. El resto de filas sigue con su tope.
              const entero = e.tipo === 'apertura' || e.tipo === 'cierre'
              const titulo = entero ? e.titulo.trim() : recorta(e.titulo, 90)
              const det = entero ? detalle : recorta(detalle, 110)
              // Sin el separador colgando: con cantidad y sin autor salía «1 ud ·».
              const cola = [
                e.cantidad !== null && e.cantidad !== 0 ? `${Math.abs(e.cantidad)} ud` : '',
                e.quien ?? '',
              ]
                .filter(Boolean)
                .join(' · ')
              return `<tr>
            <td class="mono tenue" style="width:7%">${esc(e.hora)}</td>
            <td style="width:13%"><span class="tag${e.tipo === 'cierre' ? ' tag-ok' : ''}">${esc(etiquetaEvento(e.tipo, e.subtipo))}</span></td>
            <td class="mono" style="width:14%">${esc(`${e.building} ${e.room}`.trim())}</td>
            <td>${esc(titulo)}${det ? `<span class="ev-det">${esc(det)}</span>` : ''}</td>
            <td class="tenue" style="width:16%">${esc(cola)}</td>
          </tr>`
            })
            .join('')}
        </tbody>
      </table>`
          : truncado && dia <= diaMasViejoListado
            ? `<p class="vacio">Jornada recortada por extensión: el detalle está en el histórico de cada sala.</p>`
            : `<p class="vacio">Solo revisiones: ningún registro nuevo ni consumo de material.</p>`
      }
    </div>`
  }

  const fuera = d.eventosTotal - d.eventos.length

  return `
  <section class="bloque">
    ${rotulo('Diario del periodo', `${plural(d.eventosTotal, 'movimiento')}${conRevisiones && huboRevisiones ? ', aparte de las revisiones' : ''} · lo último primero`)}
    ${dias.map(jornada).join('')}
    ${
      fuera > 0
        ? `<p class="apunte">Y ${plural(fuera, 'movimiento')} más, anteriores a los que salen: la
           lista se corta en ${d.eventos.length} empezando por lo más reciente. El detalle completo
           está en el histórico de cada sala.</p>`
        : ''
    }
  </section>`
}

/**
 * Cada cierre, con sus dos fechas y sus días escritos enteros.
 *
 * Esta es la sección que se lleva a una reunión donde hay que justificar un
 * tiempo. Un promedio no justifica nada: lo que justifica es «se abrió el 27 de
 * julio a las 09:12, se cerró el 20 de agosto a las 11:40, veinticuatro días y
 * dos horas, y lo que se hizo fue cambiar la lámpara —que hubo que pedirla—».
 * De ahí que estén las dos horas y el texto del cierre, y de ahí el orden: la
 * que más tardó primero, que es por la que se pregunta.
 */
function seccionCierres(d: ReportData): string {
  if (!d.cierres.length) {
    return `
  <section class="bloque evitar">
    ${rotulo('Cada cierre, con sus días')}
    ${vacio('No se ha cerrado ningún registro en el periodo.')}
  </section>`
  }

  const conAutor = d.cierres.some((c) => c.quien)
  const fuera = d.cierresTotal - d.cierres.length

  return `
  <section class="bloque">
    ${rotulo('Cada cierre, con sus días', plural(d.cierresTotal, 'cierre'))}
    <table class="datos">
      <thead><tr>
        <th style="width:24%">Qué se cerró</th>
        <th style="width:9%">Sala</th>
        <th style="width:11%">Se abrió</th>
        <th style="width:11%">Se cerró</th>
        <th class="num" style="width:13%">Llevó</th>
        <th>Qué se hizo${conAutor ? ' y quién' : ''}</th>
      </tr></thead>
      <tbody>
        ${d.cierres
          .map(
            (c) => `<tr>
        <td>${esc(c.titulo.trim())}${
          c.ref ? `<span class="ev-det mono">${esc(c.ref)}</span>` : ''
        }</td>
        <td class="mono tenue">${esc(c.building)} ${esc(c.room)}</td>
        <td class="mono tenue">${esc(etiquetaDia(c.abierta))} ${esc(c.horaAbierta)}</td>
        <td class="mono tenue">${esc(etiquetaDia(c.cerrada))} ${esc(c.horaCerrada)}</td>
        <td class="num prosa">${esc(diasLargo(c.dias))}</td>
        <td>${
          c.resolucion
            ? esc(c.resolucion.trim())
            : '<span class="tenue">no se apuntó qué se hizo</span>'
        }${c.quien ? `<span class="ev-det">${esc(c.quien)}</span>` : ''}</td>
      </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    ${
      fuera > 0
        ? `<p class="apunte">Y ${plural(fuera, 'cierre')} más, fuera de la tabla por sitio.
           Están todos en el histórico de cada sala.</p>`
        : ''
    }
  </section>`
}

/**
 * De qué momento es cada foto, escrito en el pie.
 *
 * Sin esto, tres fotos de la misma aula se leen como tres fotos de la misma
 * aula. Con esto, la primera es el problema encontrado, la última es el aula
 * arreglada, y entre las dos hay un trabajo hecho — que es exactamente lo que
 * un informe tiene que poder demostrar.
 */
const MOMENTO: Record<ReportData['fotos'][number]['momento'], string> = {
  revision: 'En la revisión',
  apertura: 'Incidencia abierta',
  cierre: 'Al resolverla',
}

/**
 * Las fotos, dentro del documento.
 *
 * Tres por fila y con su pie: sala, día y de qué incidencia es. Una foto sin
 * saber de dónde salió no prueba nada — y este documento se archiva justamente
 * para poder volver a él.
 *
 * `page-break-inside: avoid` en cada una: una foto partida entre dos páginas no
 * se lee, y en un informe que alguien firma queda como un descuido.
 */
function seccionFotos(d: ReportData): string {
  if (!d.fotos.length) {
    // Sin fotos no se imprime la sección: «no hay fotos» no informa de nada.
    return ''
  }

  const filas: Array<ReportData['fotos']> = []
  for (let i = 0; i < d.fotos.length; i += 3) filas.push(d.fotos.slice(i, i + 3))
  const fuera = d.fotosTotal - d.fotos.length

  const cuantas = (m: ReportData['fotos'][number]['momento']): number =>
    d.fotos.filter((f) => f.momento === m).length
  const reparto = (
    [
      [cuantas('revision'), 'de revisiones'],
      [cuantas('apertura'), 'de incidencias abiertas'],
      [cuantas('cierre'), 'de incidencias resueltas'],
    ] as Array<[number, string]>
  )
    .filter(([n]) => n > 0)
    .map(([n, que]) => `${n} ${que}`)
    .join(', ')

  return `
  <section class="bloque">
    ${rotulo('Fotos del periodo', plural(d.fotos.length, 'foto'))}
    <p class="apunte antes">Cada foto dice de cuándo es: ${esc(reparto)}. Las de una misma
    incidencia van seguidas, de cómo se encontró a cómo quedó.</p>
    <table class="fotos">
      ${filas
        .map(
          (fila) => `<tr>${[0, 1, 2]
            .map((i) => {
              const f = fila[i]
              if (!f) return '<td class="col-foto"></td>'
              return `<td class="col-foto">
        <figure class="foto">
          <img src="${f.datos}" alt="">
          <figcaption>
            <span class="momento${f.momento === 'cierre' ? ' momento-ok' : ''}">${esc(MOMENTO[f.momento])}</span>
            <span class="mono">${esc(f.building)} ${esc(f.room)}</span>
            <span class="tenue"> · ${esc(etiquetaDia(f.dia))} ${esc(f.hora)}</span>
            <span class="foto-de">${esc(recorta(f.titulo, 54))}</span>
          </figcaption>
        </figure>
      </td>`
            })
            .join('')}</tr>`,
        )
        .join('')}
    </table>
    ${
      fuera > 0
        ? `<p class="apunte">Hay ${plural(fuera, 'foto')} más del periodo que no caben en el
           documento. Están en la ficha de cada aula y de cada incidencia.</p>`
        : ''
    }
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
  const inds = indicadores(d, o.audiencia, { tiempos: tiene(o, 'tiempos') })
  // Comparar con un tramo anterior vacío es comparar con nada: la flecha diría
  // «+2 (sin dato antes)» y ocuparía sitio para no informar.
  const comparar =
    o.comparar && d.antes.registros + d.antes.resueltas + d.antes.revisiones > 0

  /*
   * La tendencia de doce meses vive dentro de «Dónde se ha trabajado», que es
   * donde tiene sentido leerla. Si alguien pide la tendencia SIN los edificios,
   * se imprime sola en vez de desaparecer: una sección marcada que no sale es un
   * informe incompleto sin avisar.
   */
  const tendenciaSola = tiene(o, 'tendencia') && !tiene(o, 'edificios')

  /*
   * EL ORDEN DEL DOCUMENTO, en dos mitades.
   *
   * Primero lo que se lee, y en el orden en que se cuenta: lo más destacado,
   * cómo ha ido cada día, con qué rapidez se resuelve, dónde se ha trabajado,
   * con qué material y cómo queda el almacén; después lo que conviene mirar y
   * lo que se propone. Y detrás de un corte, los listados completos —cada
   * movimiento, cada cierre, cada revisión y las fotos—, que es material de
   * consulta y no de lectura.
   *
   * Un informe se lee en el orden en que argumenta, y los anexos van detrás. Que
   * es además como se lee cualquier informe que alguien firma.
   */
  const analisisDelPeriodo: Array<[Seccion, string]> = [
    ['analisis', seccionAnalisis(l)],
    ['actividad', seccionActividad(d)],
    ['tiempos', seccionTiempos(d, o.audiencia)],
    ['edificios', seccionEdificios(d, tiene(o, 'tendencia'), o.audiencia)],
    ['tendencia', tendenciaSola ? seccionTendencia(d) : ''],
    ['materiales', seccionMateriales(d)],
    ['lamparas', seccionLamparas(d, o.audiencia)],
    ['salas', seccionSalas(d, o.audiencia)],
    // Vetada para dirección ya al leer las opciones; aquí otra vez, porque es
    // el documento el que no puede decir «lleva N días», se pida como se pida.
    ['estancadas', o.audiencia === 'direccion' ? '' : seccionEstancadas(d)],
    ['equipo', seccionEquipo(d)],
    ['recomendaciones', seccionRecomendaciones(l, o.audiencia)],
  ]

  /** Los listados largos: se consultan, no se leen de seguido. */
  const detalleDelPeriodo: Array<[Seccion, string]> = [
    ['eventos', seccionEventos(d, tiene(o, 'revisiones'))],
    ['cierres', seccionCierres(d)],
    ['revisiones', seccionRevisiones(d)],
    ['fotos', seccionFotos(d)],
  ]

  const pedidas = (lista: Array<[Seccion, string]>): string[] =>
    lista.filter(([clave, html]) => tiene(o, clave) && html).map(([, html]) => html)

  /*
   * Dos secciones cortas, lado a lado.
   *
   * Las lámparas y la pieza repetida son, en el informe de dirección, dos tablas
   * de tres columnas y un puñado de filas: una debajo de otra y a todo lo ancho
   * se comían media página de aire para seis líneas de datos. En pareja caben
   * en un tercio y se leen como lo que son, las dos cosas que conviene mirar.
   *
   * Solo cuando las dos son de verdad cortas y solo para dirección: en el parte
   * del equipo la segunda lleva además el ranking de salas, que necesita su
   * ancho.
   */
  const enPareja =
    o.audiencia === 'direccion' &&
    tiene(o, 'lamparas') &&
    tiene(o, 'salas') &&
    d.lamparas.length <= 8 &&
    d.reincidentes.length > 0 &&
    d.reincidentes.length <= 8
  if (enPareja) {
    const i = analisisDelPeriodo.findIndex(([clave]) => clave === 'lamparas')
    const j = analisisDelPeriodo.findIndex(([clave]) => clave === 'salas')
    const lamparas = seccionLamparas(d, o.audiencia, true)
    const salas = analisisDelPeriodo[j]![1]
    analisisDelPeriodo[i] = [
      'lamparas',
      `
  <table class="dos pareja"><tr>
    <td class="col-mitad">${lamparas}</td>
    <td class="col-mitad">${salas}</td>
  </tr></table>`,
    ]
    analisisDelPeriodo[j] = ['salas', '']
  }

  const arriba = pedidas(analisisDelPeriodo)
  const abajo = pedidas(detalleDelPeriodo)

  /*
   * El corte solo si hay algo detrás, y sin salto de página forzado: en un parte
   * diario los listados son cuatro filas, y una página en blanco para separar
   * cuatro filas es peor que no separarlas. El rótulo con su regla ya dice
   * dónde acaba lo que se lee.
   */
  const cuerpo = [
    ...arriba,
    ...(abajo.length
      ? [
          `
  <section class="detalle-cab">
    <h2>Detalle del periodo</h2>
    <p>Los listados completos, para consultar: cada movimiento, cada cierre y cada foto.</p>
  </section>`,
          ...abajo,
        ]
      : []),
  ].join('\n')

  const lateral = tiene(o, 'resumen') ? composicion(d) : ''

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=800">
<title>${esc(titulo)} · ${esc(d.periodoTexto)}</title>
<style>
  @page {
    size: A4;
    margin: 17mm 16mm 16mm;
    @top-right {
      content: string(cabecera);
      font-family: ${SANS}; font-size: 7.5pt; color: ${MUTED};
      vertical-align: bottom; padding-bottom: 3mm;
    }
    @bottom-left {
      content: "Grupo Oesia · Mantenimiento de aulas UFV";
      font-family: ${SANS}; font-size: 7.5pt; color: ${MUTED};
      vertical-align: top; padding-top: 4mm;
    }
    @bottom-right {
      content: counter(page) " / " counter(pages);
      font-family: ${MONO}; font-size: 7.5pt; color: ${MUTED};
      vertical-align: top; padding-top: 4mm;
    }
  }
  /* La primera página lleva la cabecera impresa en grande: repetirla arriba
     sobraría. */
  @page :first { @top-right { content: none } }

  body {
    font-family: ${SANS};
    font-size: 9.5pt; line-height: 1.45; color: ${INK}; margin: 0;
  }
  p { margin: 0 0 2.5mm; }
  table { border-spacing: 0; }

  /*
   * La vista previa dentro de la aplicación, y el documento abierto en una
   * pestaña. Solo en pantalla.
   *
   * El documento está maquetado para la caja de texto de un A4 —178 mm, que es
   * también el ancho al que se dibujan los gráficos—. En pantalla se enseña
   * como lo que es: una hoja, con su margen y sobre un fondo gris, y no un
   * texto estirado hasta donde llegue el navegador con las figuras en su
   * tamaño real.
   *
   * Y color-scheme en claro porque esto es papel: con el tema oscuro del
   * sistema puesto, el navegador se toma la libertad de invertir los colores
   * del marco.
   */
  @media screen {
    :root { color-scheme: light; }
    html { background: #E9EBE8; }
    body {
      width: 178mm; margin: 6mm auto; padding: 15mm 16mm 16mm;
      background: #FFFFFF; border-radius: 1.5mm;
    }
  }

  /* ── Las dos marcas de la primera página ──
     La del servicio a la izquierda, la del campus a la derecha, y nada más en
     la banda: un logotipo compitiendo con el titular no es imagen corporativa,
     es ruido con colores. */
  .marcas { width: 100%; border-collapse: collapse; margin: 0 0 6mm; }
  .marca-emisor { text-align: left; vertical-align: middle; }
  .marca-cliente { text-align: right; vertical-align: middle; }
  .marcas svg { display: inline-block; vertical-align: middle; }

  /* ── Portada ──
     Una caja de papel con el titular dentro: separa el documento de las dos
     marcas de arriba y le da a la primera página un sitio por el que empezar.
     Sin versalitas y sin tracking de cartel: la línea de arriba dice de quién
     es el documento y de qué tipo es, y para eso no hace falta levantar la voz. */
  .portada {
    string-set: cabecera "${esc(titulo)} · ${esc(d.periodoTexto)}";
    background: ${PAPEL}; border-radius: 0 3mm 3mm 0; padding: 6.5mm 7.5mm 6.5mm;
    border-left: 2.6pt solid ${ACENTO};
  }
  .kicker { font-size: 8.8pt; color: ${MUTED}; font-weight: 500; }
  .kicker b { color: ${ACENTO}; font-weight: 600; }
  h1 {
    font-family: ${SERIF};
    font-size: 21pt; line-height: 1.2; font-weight: 600;
    letter-spacing: -0.005em; color: ${INK};
    margin: 2.6mm 0 0; max-width: 150mm;
  }
  .sumario {
    margin-top: 3mm; font-size: 8.8pt; color: ${MUTED};
    font-variant-numeric: tabular-nums;
  }
  .nota-pedido {
    margin-top: 4mm; padding-top: 3mm; border-top: 0.5pt solid ${LINE};
    font-family: ${SERIF}; font-size: 9pt; color: ${INK2};
  }

  /* ── La tira de las cuatro cifras ──
     Cuatro casillas iguales, con calle entre ellas. La calle la pone
     border-spacing, que también deja medio hueco por fuera; la caja de
     alrededor se lo come con un margen negativo para que la tira cuadre con el
     resto de la página. */
  .tira-caja { margin: 4.5mm -2.4mm 0; }
  .tira { width: 100%; border-collapse: separate; border-spacing: 2.4mm 0; table-layout: fixed; }
  /* Sin anchura en la casilla: con bordes separados, la anchura de una celda es
     la de su contenido, y un 25 % más el relleno sacaba la cuarta de la página.
     El reparto a partes iguales lo hace table-layout. */
  .cifra {
    vertical-align: top; padding: 3.4mm 3.6mm 3.2mm;
    border: 0.6pt solid ${LINE}; border-top: 2pt solid ${ACENTO};
    border-radius: 0 0 2mm 2mm;
  }
  .cifra-et { font-size: 8pt; font-weight: 500; color: ${INK2}; line-height: 1.25; }
  .cifra-val {
    font-size: 23pt; font-weight: 600; line-height: 1.05; color: ${INK};
    letter-spacing: -0.015em; margin: 1.6mm 0 1.2mm;
  }
  .cifra-det { font-size: 7.6pt; color: ${MUTED}; line-height: 1.35; }
  .tira-nota { font-size: 7.2pt; color: ${MUTED}; margin: 1.6mm 0 0; text-align: right; }

  .var { font-size: 7.6pt; margin-top: 1.4mm; color: ${MUTED}; font-variant-numeric: tabular-nums; }
  .var .flecha {
    display: inline-block; width: 0; height: 0; margin-right: 1.2mm;
    border-left: 2.4pt solid transparent; border-right: 2.4pt solid transparent;
  }
  .var.sube .flecha { border-bottom: 3.6pt solid currentColor; }
  .var.baja .flecha { border-top: 3.6pt solid currentColor; }
  .var.bien { color: ${OK}; }

  /* ── Entrada: texto a la izquierda, de qué son los partes a la derecha ── */
  .entrada { width: 100%; border-collapse: collapse; margin-top: 6mm; }
  /* Sin selector de hijo directo a propósito: el navegador —y WeasyPrint—
     insertan un tbody que no está escrito, así que un ".entrada > tr" no casa
     con nada y la maquetación se cae a una sola columna. De ahí las clases. */
  .col-texto { vertical-align: top; padding-right: 9mm; }
  .col-lateral { width: 68mm; vertical-align: top; }

  /*
   * La entradilla, en bandera y sin partir palabras.
   *
   * Justificar abre ríos entre palabras, y partir «acumu-lado» al final de la
   * línea obliga a montar la palabra en la cabeza. En bandera se lee más
   * rápido y suena a alguien contando algo, que es de lo que va este párrafo.
   */
  .entradilla {
    font-family: ${SERIF};
    font-size: 10.5pt; line-height: 1.66; color: ${INK2};
    text-align: left; hyphens: none; max-width: 128mm;
  }

  /* La caja lateral: una lista corta con su título, sobre papel. */
  .lateral {
    background: ${PAPEL}; border-radius: 2mm; padding: 3.6mm 4mm 2.6mm;
    page-break-inside: avoid;
  }
  .lateral-2 { margin-top: 3mm; }
  .lateral-t { font-size: 8.5pt; font-weight: 600; color: ${INK2}; margin-bottom: 2.6mm; }
  .lateral-n { font-size: 7.4pt; color: ${MUTED}; margin: 1mm 0 0.6mm; }
  .lateral svg { display: block; max-width: 100%; margin-bottom: 1.6mm; }
  table.lista { width: 100%; border-collapse: collapse; font-size: 8.4pt; }
  table.lista td { padding: 1.3mm 0; border-top: 0.5pt solid ${LINE}; vertical-align: baseline; }
  table.lista tr:first-child td { border-top: 0; }
  table.lista td.num {
    text-align: right; white-space: nowrap; padding-left: 3mm;
    font-variant-numeric: tabular-nums; color: ${INK2};
  }
  table.lista td.num b { color: ${INK}; font-weight: 600; }
  .pastilla {
    display: inline-block; width: 2.2mm; height: 2.2mm; border-radius: 0.6mm;
    margin-right: 1.6mm; vertical-align: 0;
  }

  /* ── Secciones ──
     El rótulo, en caja normal y con la serif del texto: catorce rótulos en
     versalitas son catorce veces que alguien te habla en mayúsculas. El filete
     de marca a la izquierda hace de señal sin levantar la voz. */
  .bloque { margin-top: 8.5mm; }
  .bloque.evitar, .sub.evitar { page-break-inside: avoid; }

  .rotulo {
    border-bottom: 0.6pt solid ${LINE}; padding: 0.4mm 0 1.6mm 3mm; margin-bottom: 4.2mm;
    border-left: 2.2pt solid ${ACENTO};
    /* Un rótulo suelto al pie de una página, con su sección en la siguiente, es
       el fallo de maquetación que más delata a un documento generado. */
    page-break-after: avoid;
  }
  /* En línea, y sin tracking. Como bloque en línea con un tracking negativo,
     WeasyPrint le calcula al título una anchura un pelo más corta que el texto
     y lo parte en dos renglones con medio folio libre a la derecha. */
  .rotulo-t {
    font-family: ${SERIF};
    font-size: 12.5pt; font-weight: 600; color: ${INK};
    line-height: 1.25;
  }
  .rotulo-a { margin-left: 3mm; font-size: 8.5pt; color: ${MUTED}; }
  .sub { margin-top: 5.5mm; }
  .sub-t { font-size: 9.2pt; font-weight: 600; margin-bottom: 2.2mm; page-break-after: avoid; }
  /* El apunte que explica una tabla necesita aire por abajo: sin él, la frase y
     la cabecera de la tabla se leían como un bloque de texto con una línea en
     negrita en medio. */
  .apunte {
    font-family: ${SERIF};
    font-size: 8.5pt; line-height: 1.5; color: ${MUTED}; margin: 2.2mm 0 3.2mm;
    max-width: 136mm;
    /* Pegado a lo que explica: la nota de una tabla sola en lo alto de la
       página siguiente no se sabe de qué habla. */
    page-break-before: avoid;
  }
  /* Y el que presenta una tabla, pegado también a ella. */
  .apunte.antes { page-break-after: avoid; }
  /* Sin cursiva: en un documento generado, la cursiva de «sin datos» se lee
     como una disculpa del programa. Es una frase normal, y se dice normal. */
  .vacio { font-size: 8.8pt; color: ${MUTED}; }
  .en-orden { font-size: 9pt; color: ${INK2}; margin: 0; }
  .en-orden .marca { vertical-align: middle; margin-right: 2.2mm; }
  .en-orden span { vertical-align: middle; }
  .tenue { color: ${MUTED}; }
  .mono { font-family: ${MONO}; }

  /* ── El corte entre lo que se lee y lo que se consulta ──
     Sin salto de página forzado, y con page-break-after evitado para que el
     rótulo no se quede solo al pie de una página con su listado en la
     siguiente, que es la forma más tonta de perder un encabezado. */
  .detalle-cab {
    margin-top: 13mm; padding: 4mm 5mm; background: ${PAPEL}; border-radius: 2mm;
    page-break-after: avoid; page-break-inside: avoid;
  }
  .detalle-cab h2 {
    margin: 0; font-family: ${SERIF};
    font-size: 14pt; font-weight: 600; color: ${INK}; letter-spacing: -0.01em;
  }
  .detalle-cab p { margin: 1mm 0 0; font-size: 8.8pt; color: ${MUTED}; }

  /* ── Dos columnas ── */
  .dos { width: 100%; border-collapse: collapse; }
  .col-mitad { width: 50%; vertical-align: top; padding-right: 6mm; }
  .col-mitad:last-child { padding-right: 0; padding-left: 2mm; }
  /* Dos secciones en una fila: el aire de arriba lo pone la fila, no cada una. */
  .pareja { margin-top: 8.5mm; page-break-inside: avoid; }
  .pareja .bloque { margin-top: 0; }
  .pareja .sub { margin-top: 0; }
  .col-ancha { vertical-align: top; padding-right: 8mm; }
  .col-estrecha { width: 70mm; vertical-align: top; }

  /* ── Figuras ── */
  .fig { margin: 0; page-break-inside: avoid; }
  .fig figcaption { margin-bottom: 2mm; page-break-after: avoid; }
  .fig-t { font-size: 9pt; font-weight: 600; display: block; }
  .fig-n { font-size: 8pt; color: ${MUTED}; display: block; }
  .fig svg { display: block; max-width: 100%; }
  .barra { margin: 3mm 0 2.2mm; }
  .barra svg { display: block; max-width: 100%; }
  .leyenda { font-size: 8pt; color: ${MUTED}; line-height: 1.7; }
  .lg { margin-right: 4.5mm; white-space: nowrap; }
  .lg > i {
    display: inline-block; width: 2.2mm; height: 2.2mm; border-radius: 0.6mm;
    margin-right: 1.4mm; vertical-align: 0;
  }
  .lg b { color: ${INK}; font-weight: 600; font-variant-numeric: tabular-nums; }

  /* ── Lo más destacado ── */
  .notas { width: 100%; border-collapse: collapse; }
  .col-nota {
    width: 50%; vertical-align: top; padding: 0 7mm 5mm 0;
    page-break-inside: avoid;
  }
  .col-nota:last-child { padding-right: 0; }
  table.nota { border-collapse: collapse; width: 100%; }
  table.nota td { vertical-align: top; padding: 0; }
  .nota-m { width: 8mm; }
  .nota-m svg { display: block; }
  .nota-t { font-size: 9.6pt; font-weight: 600; line-height: 1.3; margin: 0.5mm 0 1.2mm; }
  .nota-c {
    font-family: ${SERIF};
    font-size: 9pt; line-height: 1.55; color: ${INK2};
  }

  /* ── Tablas ── */
  table.datos { width: 100%; border-collapse: collapse; font-size: 8.8pt; }
  table.datos thead { display: table-header-group; }
  /* Las cabeceras, en caja normal: «En seguimiento hoy» es más rápido de leer
     que «EN SEGUIMIENTO HOY», y la raya que las separa de los datos no necesita
     ser negra para separar. */
  table.datos th {
    text-align: left; font-weight: 600; color: ${MUTED}; font-size: 8pt;
    line-height: 1.25;
    border-bottom: 0.6pt solid ${LINE}; padding: 0 4mm 1.6mm 0;
  }
  /* Sin sangría por la izquierda, dos rótulos contiguos se leían como uno. La
     calle va por la izquierda de la columna numérica, que es la que la
     necesita. */
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
     le juntaba encima. */
  table.datos th + th, table.datos td + td { padding-left: 3.5mm; }
  table.datos td.num {
    font-family: ${MONO}; font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* Una cifra con palabras —«15 días y 2 h»— va en la sans: en mono, cada
     espacio mide lo que una letra y la frase se lee deletreada. */
  table.datos td.num.prosa { font-family: ${SANS}; }
  table.datos tr { page-break-inside: avoid; }
  /* La fila de totales: la raya por arriba y el peso, y nada más. Y pegada a
     la fila de encima: un total solo en la página siguiente, debajo de una
     cabecera repetida, es una suma sin sumandos. */
  table.datos tr.total { page-break-before: avoid; }
  table.datos tr.total td {
    border-top: 0.6pt solid ${LINE}; border-bottom: 0; font-weight: 600;
    padding-top: 2mm;
  }

  table.cifras { width: 100%; border-collapse: collapse; font-size: 8.8pt; }
  table.cifras td { padding: 1.9mm 0; border-bottom: 0.5pt solid ${HAIR}; color: ${INK2}; }
  table.cifras tr:first-child td { padding-top: 0; }
  table.cifras td.num {
    text-align: right; font-variant-numeric: tabular-nums; font-weight: 600;
    color: ${INK}; white-space: nowrap; padding-left: 3mm;
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
    border-bottom: 0.5pt solid ${LINE}; padding-bottom: 1.2mm; margin-bottom: 1.5mm;
    page-break-after: avoid;
  }
  .dia-fecha { font-family: ${SERIF}; font-size: 9.5pt; font-weight: 600; }
  .dia-res { margin-left: 3mm; font-size: 8pt; color: ${MUTED}; }
  table.diario td { padding-top: 1.4mm; padding-bottom: 1.4mm; border-bottom: 0; }
  table.diario tr:not(:last-child) td { border-bottom: 0.5pt solid ${HAIR}; }
  .tag {
    display: inline-block; font-size: 7.5pt; color: ${MUTED};
    background: ${PAPEL}; border: 0.5pt solid ${LINE};
    border-radius: 3mm; padding: 0.4mm 1.8mm; white-space: nowrap;
  }
  /* El cierre, en verde: en un diario de cien filas es la que se busca. */
  .tag-ok { color: ${OK}; background: ${OK_TINTE}; border-color: #C9E3D5; }
  .ev-det {
    display: block; font-family: ${SERIF};
    font-size: 8pt; color: ${MUTED}; line-height: 1.4; margin-top: 0.4mm;
  }

  /* ── Fotos ──
     Tres por fila, con su pie debajo. El salto se prohíbe en la CELDA y no en
     la fila: prohibirlo en la fila entera empuja las tres a la página siguiente
     y deja media en blanco. */
  table.fotos { width: 100%; border-collapse: collapse; }
  .col-foto {
    width: 33.33%; vertical-align: top; padding: 0 4mm 5mm 0;
    page-break-inside: avoid;
  }
  .col-foto:last-child { padding-right: 0; }
  .foto { margin: 0; }
  .foto img {
    display: block; width: 100%; height: 42mm; object-fit: cover;
    background: ${HAIR}; border: 0.5pt solid ${LINE}; border-radius: 1.5mm;
  }
  .foto figcaption { font-size: 7.5pt; color: ${MUTED}; margin-top: 1.2mm; line-height: 1.35; }
  /* El momento, encima de todo: es lo primero que hay que leer de una foto en
     un informe. La del aula ya arreglada, en verde. */
  .momento {
    display: block; font-size: 7.5pt; font-weight: 600; color: ${ACENTO};
    margin-bottom: 0.4mm;
  }
  .momento-ok { color: ${OK}; }
  .foto-de {
    display: block; font-family: ${SERIF};
    font-size: 8pt; color: ${INK2}; line-height: 1.35; margin-top: 0.4mm;
  }

  /* ── Medidor ── */
  .lateral .med { width: 9mm; }
  .med {
    display: inline-block; width: 14mm; height: 1.7mm;
    border-radius: 0.85mm; margin-right: 2mm; vertical-align: middle; overflow: hidden;
  }
  .med > span { display: block; height: 100%; border-radius: 0.85mm; }
  .med-n {
    font-family: ${MONO}; font-size: 8pt;
    font-variant-numeric: tabular-nums; color: ${MUTED};
  }
  /* El medidor y su cifra no se separan: partidos en dos renglones, el «%» se
     quedaba solo debajo de la barra. */
  .junto { white-space: nowrap; }

  /* ── Acciones ── */
  .acciones { margin: 0; padding: 0; list-style: none; counter-reset: acc; }
  .acciones li {
    counter-increment: acc; position: relative;
    padding: 0 0 4mm 10mm; page-break-inside: avoid;
  }
  .acciones li:last-child { padding-bottom: 0; }
  /* El número dentro de un disco teñido: la lista de lo que hay que hacer es lo
     único del documento que pide algo a alguien, y se agradece que no lo pida
     con una cifra a palo seco. */
  .acciones li::before {
    content: counter(acc);
    position: absolute; left: 0; top: -0.2mm;
    width: 6.4mm; height: 6.4mm; border-radius: 50%;
    background: ${TINTE}; color: ${ACENTO};
    font-size: 8.5pt; font-weight: 600; text-align: center; line-height: 6.4mm;
  }
  .acc-t { font-size: 9.5pt; font-weight: 600; line-height: 1.35; }
  .acc-p {
    font-family: ${SERIF};
    font-size: 9pt; color: ${INK2}; line-height: 1.5; margin-top: 0.8mm;
  }

  /* ── El pie de la última página ──
     Una línea y se acabó. El navegador ignora las cajas de margen de @page y
     pone su propia cabecera, así que sin esto el documento impreso desde la
     aplicación no llevaría en ninguna página quién lo firma ni para quién es.
     Va en el flujo, que es lo único que imprimen los dos motores. */
  .pie-marca {
    margin-top: 9mm; padding-top: 2.5mm; border-top: 0.5pt solid ${LINE};
    font-size: 7.5pt; color: ${MUTED}; letter-spacing: 0.01em;
    /*
     * Y donde las cajas de margen SÍ existen, fuera del flujo. «running()» es
     * de CSS Paged Media: WeasyPrint saca el elemento de la página —ya imprime
     * esa misma línea al pie de todas con @bottom-left— y un navegador, que no
     * entiende el valor, descarta la declaración y lo deja donde está. Sin
     * esto, cuando la última sección llenaba la página, el PDF salía con una
     * hoja más en la que no había nada salvo esta línea.
     */
    position: running(pie-del-flujo);
  }
</style>
</head>
<body>

${bandaDeMarcas()}

<header class="portada">
  <div class="kicker"><b>Mantenimiento de aulas</b> · ${esc(titulo)} · ${
    o.audiencia === 'direccion' ? 'para dirección' : 'para el equipo técnico'
  }</div>
  <h1>${titularEnDosRenglones(l.titular)}</h1>
  <div class="sumario">
    ${esc(mayuscula(d.periodoTexto))} · emitido el ${esc(pie.emitido)}${
      pie.solicitante ? ` · lo pidió ${esc(pie.solicitante)}` : ''
    }
  </div>
  ${o.nota ? `<div class="nota-pedido">${esc(o.nota)}</div>` : ''}
</header>

${
  tiene(o, 'resumen')
    ? `${tiraDeCifras(inds, comparar, d.comparacionTexto)}
<table class="entrada"><tr>
  <td class="col-texto">
    <p class="entradilla">${esc(l.entradilla.trim())}</p>
  </td>
  ${lateral ? `<td class="col-lateral">${lateral}</td>` : ''}
</tr></table>`
    : ''
}

${cuerpo}

<footer class="pie-marca">Grupo Oesia · Servicio de mantenimiento de aulas ·
Universidad Francisco de Vitoria</footer>

</body>
</html>`
}
