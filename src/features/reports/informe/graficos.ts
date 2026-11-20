/**
 * Gráficos del informe, como SVG dentro del propio documento.
 *
 * ECharts sabe renderizar a una cadena SVG sin pintar nada en la pantalla
 * (`ssr: true`), y eso es exactamente lo que hace falta aquí: el informe es un
 * HTML autocontenido que se archiva y se imprime, así que sus gráficos tienen
 * que ser marcas dentro del fichero, no un `<div>` que alguien tendría que
 * volver a rellenar con JavaScript al abrirlo.
 *
 * Hay una segunda vía por si la primera no está disponible —un `<div>` suelto,
 * fuera del documento, del que se saca el `<svg>` ya pintado—. No es paranoia
 * gratuita: `renderToSVGString` es una API pensada para Node y el mismo código
 * corre aquí en un navegador. Si algún día deja de funcionar en uno de los dos
 * sitios, el informe sigue saliendo con gráficos en vez de con huecos.
 *
 * DOS COSAS QUE EN PANTALLA SE HACEN AL REVÉS:
 *
 *  1. **Los valores van escritos sobre la marca.** En la aplicación eso sería
 *     ruido, porque el dato exacto se consigue pasando el ratón por encima. En un
 *     papel no hay ratón: si la cifra no está impresa, no está. Y de paso resuelve
 *     el otro problema — el par verde/violeta de la paleta queda en el margen
 *     bajo de separación para el daltonismo tritán, y una etiqueta directa es
 *     exactamente la codificación secundaria que ese margen exige.
 *  2. **Se dibuja al tamaño real de impresión.** Un píxel CSS es 1/96 de
 *     pulgada, así que 672 px son 178 mm justos: el ancho útil de un A4 con
 *     estos márgenes. Renderizar a 500 px y estirar el SVG al 100 % agrandaría
 *     también la tipografía de los ejes, que dejaría de casar con la del texto
 *     de al lado.
 */

import { echarts } from '@/design/echarts'

/*
 * La misma paleta validada que usa la aplicación, y en el mismo orden fijo. Los
 * colores de estado (ok/aviso/crítico) quedan fuera a propósito: están
 * reservados para decir «bien» o «mal» y no se reutilizan como serie, porque
 * entonces un verde dejaría de significar nada.
 *
 * Es la variante clara y no la del tema del usuario: el informe se imprime sobre
 * papel blanco, y quien lo genera con el tema oscuro puesto no tiene por qué
 * llevarse un PDF con los colores de la pantalla.
 *
 * Comprobada sobre papel blanco:
 *   node scripts/validate_palette.js "#4A78D4,#12A396,#B063D6,#8A8F3C" \
 *        --mode light --surface "#FFFFFF"
 */
const CATEGORICAL = ['#4A78D4', '#12A396', '#B063D6', '#8A8F3C'] as const

/**
 * Los tres primeros tonos, con nombre, para lo que se pinta fuera de ECharts:
 * la franja de «de qué son los partes» y su lista. El color sigue a la cosa y
 * no al sitio que ocupa: una incidencia es azul en la franja, en la leyenda y
 * donde vuelva a salir.
 */
export const TONO_DE_SERIE = {
  primero: CATEGORICAL[0],
  segundo: CATEGORICAL[1],
  tercero: CATEGORICAL[2],
} as const

/**
 * La rampa de un solo tono para lo que tiene ORDEN —los tramos de tiempo de un
 * cierre: el mismo día, en 48 horas, en la semana, más—. No es la paleta de
 * series: allí cada color es una cosa distinta, y aquí el color tiene que decir
 * que una viene detrás de otra. Del más oscuro —lo más rápido, que es lo que
 * se quiere ver— al más claro.
 *
 * Comprobada como rampa ordinal sobre papel blanco (pasos visibles, un solo
 * tono y el extremo claro por encima de 2:1):
 *   node scripts/validate_palette.js "#084F53,#0B6B70,#3D9499,#8ABFC2" \
 *        --ordinal --mode light --surface "#FFFFFF"
 */
export const RAMPA_DE_TIEMPOS = ['#084F53', '#0B6B70', '#3D9499', '#8ABFC2'] as const
/* Los mismos grises que la plantilla, para que el gráfico no venga de otro
   documento: la tinta tira un punto al cálido y la rejilla es más suave. */
const INK = '#1A2226'
const MUTED = '#57676E'
const LINE = '#DEE2E0'
const REJILLA = '#EDEFEC'

/** Ancho útil de la caja de texto del A4, en píxeles CSS. 178 mm exactos. */
export const ANCHO_TOTAL = 672
/** Media caja, descontando la calle central de 6 mm. */
export const ANCHO_MEDIO = 326

/*
 * Las familias, con comillas SIMPLES por dentro, y no por gusto.
 *
 * ECharts escribe el estilo de cada texto en un atributo entre comillas dobles
 * —`style="font-size:10px;font-family:…"`— y no escapa lo que le llega. Con
 * `"IBM Plex Sans"` dentro, el atributo se cerraba en la primera comilla:
 * quedaba `font-family:` sin valor, y los ejes y las cifras de todos los
 * gráficos salían con la letra por defecto del visor en vez de con la del
 * documento. No fallaba nada; WeasyPrint lo decía en un aviso que nadie leía.
 */
const TIPO = "'IBM Plex Sans', 'Instrument Sans Variable', system-ui, sans-serif"
const MONO = "'IBM Plex Mono', ui-monospace, monospace"

function render(option: Record<string, unknown>, width: number, height: number): string {
  const completa = {
    // Sin esto la animación sale como CSS incrustado en el SVG y el documento
    // congela un fotograma intermedio: barras a media altura.
    animation: false,
    textStyle: { fontFamily: TIPO, color: INK, fontSize: 11 },
    ...option,
  }

  try {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height })
    chart.setOption(completa)
    const svg = chart.renderToSVGString()
    chart.dispose()
    return svg
  } catch {
    return renderEnUnDiv(completa, width, height)
  }
}

/**
 * La vía de respaldo: pintar en un `<div>` que no está en la página.
 *
 * Fuera del documento a propósito. Adjuntarlo aunque fuera un instante provoca
 * un reflujo de toda la página y, con el tamaño ya dado por `width`/`height`,
 * no hace ninguna falta: ECharts no necesita medir nada.
 */
function renderEnUnDiv(option: Record<string, unknown>, width: number, height: number): string {
  if (typeof document === 'undefined') return ''
  const caja = document.createElement('div')
  caja.style.width = `${width}px`
  caja.style.height = `${height}px`
  const chart = echarts.init(caja, null, { renderer: 'svg', width, height })
  chart.setOption(option)
  const svg = caja.querySelector('svg')?.outerHTML ?? ''
  chart.dispose()
  return svg
}

/** Ejes recesivos: están para situar, no para leerse. */
const ejeCategoria = {
  type: 'category' as const,
  axisLine: { lineStyle: { color: LINE } },
  axisTick: { show: false },
  axisLabel: { color: MUTED, fontSize: 10 },
  splitLine: { show: false },
}

const ejeValor = {
  type: 'value' as const,
  axisLine: { show: false },
  axisTick: { show: false },
  axisLabel: { color: MUTED, fontSize: 10 },
  splitLine: { lineStyle: { color: REJILLA } },
  // Sin decimales: se cuentan revisiones e incidencias, no litros.
  minInterval: 1,
}

const etiquetaValor = {
  show: true,
  position: 'top' as const,
  color: MUTED,
  fontSize: 9,
  fontFamily: MONO,
  // Los ceros no se escriben: quince ceros impresos en una semana tranquila
  // llenan el gráfico de tinta para decir que no pasó nada.
  formatter: (p: { value: number }) => (p.value ? String(p.value) : ''),
}

/**
 * Actividad día a día: lo que se revisó, lo que entró y lo que se cerró.
 *
 * Tres series de la misma unidad en un solo eje. Nunca dos escalas: si algún día
 * hay que cruzar dos medidas de magnitud distinta, van en dos gráficos.
 *
 * Columnas agrupadas y no apiladas porque la pregunta que se le hace a este
 * gráfico es «¿se cerró más de lo que se abrió?», y eso se responde comparando
 * alturas contiguas. Apiladas habría que restar de cabeza.
 */
export function actividadDiaria(
  dias: string[],
  series: Array<{ nombre: string; datos: number[] }>,
  opts: { width?: number; height?: number } = {},
): string {
  const { width = ANCHO_TOTAL, height = 220 } = opts

  /*
   * La cifra escrita sobre cada barra deja de ayudar cuando deja de caber. Con
   * un mes por delante son noventa columnas en 178 mm: las etiquetas se pisan
   * unas a otras y lo que se lee es «22», «111», que no es ningún dato. Por
   * debajo del umbral se imprimen —en papel no hay ratón que consultar—; por
   * encima se leen del eje, que para eso está y que ahí sí se lee limpio.
   */
  const cifras = dias.length * series.length <= 36

  return render(
    {
      color: [...CATEGORICAL],
      legend: {
        show: true,
        top: 0,
        left: 0,
        itemWidth: 9,
        itemHeight: 9,
        itemGap: 16,
        icon: 'roundRect',
        textStyle: { color: MUTED, fontSize: 10, fontFamily: TIPO },
      },
      grid: { left: 2, right: 4, top: 32, bottom: 2, containLabel: true },
      xAxis: { ...ejeCategoria, data: dias },
      yAxis: ejeValor,
      series: series.map((s, i) => ({
        name: s.nombre,
        type: 'bar',
        data: s.datos,
        barMaxWidth: 22,
        // 2 px de calle entre columnas contiguas: separa sin necesidad de borde.
        barGap: '12%',
        barCategoryGap: '34%',
        itemStyle: {
          color: CATEGORICAL[i % CATEGORICAL.length],
          // Redondeado donde acaba el dato y a escuadra en la base, que es de
          // donde crece la columna.
          borderRadius: [4, 4, 0, 0],
        },
        label: cifras ? etiquetaValor : { show: false },
      })),
    },
    width,
    height,
  )
}

/**
 * Ranking por edificio. Barras horizontales y un solo color.
 *
 * Horizontal porque los nombres se leen en horizontal —y con doce edificios, en
 * vertical se giran o se cortan— y porque la comparación es de longitud, que es
 * lo que mejor se mide. Un solo color porque hay una sola serie: pintar cada
 * barra de un tono distinto gastaría el único canal libre en repetir lo que la
 * longitud ya dice.
 */
export function barrasHorizontales(
  etiquetas: string[],
  valores: number[],
  opts: { width?: number; height?: number; color?: number } = {},
): string {
  const { width = ANCHO_MEDIO, height = 200, color = 0 } = opts

  return render(
    {
      grid: { left: 2, right: 26, top: 4, bottom: 2, containLabel: true },
      // `inverse` para que el mayor quede arriba: la lista llega ordenada de
      // más a menos y en un eje de categorías el primer elemento cae abajo.
      yAxis: { ...ejeCategoria, data: etiquetas, inverse: true, axisLine: { show: false } },
      xAxis: { ...ejeValor, axisLabel: { show: false }, splitLine: { show: false } },
      series: [
        {
          type: 'bar',
          data: valores,
          barMaxWidth: 14,
          barCategoryGap: '38%',
          itemStyle: {
            color: CATEGORICAL[color % CATEGORICAL.length],
            borderRadius: [0, 4, 4, 0],
          },
          // El valor al final de la barra: sin eje de valores, es el único sitio
          // donde puede estar la cifra.
          label: { ...etiquetaValor, position: 'right', color: INK },
        },
      ],
    },
    width,
    height,
  )
}

/**
 * Tendencia larga. Una línea, un tono, y el último punto etiquetado.
 *
 * Solo el último: doce cifras impresas sobre doce puntos convierten una tendencia
 * en una tabla mal maquetada. La que interesa de una serie temporal es dónde
 * está ahora.
 */
export function tendencia(
  etiquetas: string[],
  valores: number[],
  opts: { width?: number; height?: number; color?: number } = {},
): string {
  const { width = ANCHO_MEDIO, height = 200, color = 0 } = opts
  const tono = CATEGORICAL[color % CATEGORICAL.length]!
  const ultimo = valores.length - 1

  return render(
    {
      grid: { left: 2, right: 18, top: 16, bottom: 2, containLabel: true },
      xAxis: { ...ejeCategoria, data: etiquetas, boundaryGap: false },
      yAxis: ejeValor,
      series: [
        {
          type: 'line',
          data: valores,
          showSymbol: false,
          lineStyle: { width: 2, color: tono, join: 'round', cap: 'round' },
          itemStyle: { color: tono },
          areaStyle: { color: tono, opacity: 0.1 },
        },
        /*
         * El último punto, en una serie aparte que solo lo tiene a él. Es el
         * único que lleva marca y cifra: doce puntos gordos sobre una línea de
         * doce meses son doce cosas que mirar. Con su anillo de papel, para que
         * no se funda con la línea.
         *
         * Aparte, y no con un tamaño de símbolo por punto: un símbolo de tamaño
         * cero sigue dibujándose en el SVG, y dejaba una mota en la esquina del
         * gráfico.
         */
        {
          type: 'line',
          data: valores.map((v, i) => (i === ultimo ? v : null)),
          symbol: 'circle',
          symbolSize: 9,
          lineStyle: { width: 0 },
          itemStyle: { color: tono, borderColor: '#FFFFFF', borderWidth: 2 },
          label: {
            show: true,
            position: 'top',
            color: INK,
            fontSize: 9,
            fontFamily: MONO,
            formatter: (p: { value: number | null }) => (p.value === null ? '' : String(p.value)),
          },
        },
      ],
    },
    width,
    height,
  )
}

// ── Las figuras que no son un gráfico ────────────────────────────────────────

/**
 * Lo que ocupa un texto, a ojo y por lo alto.
 *
 * Aquí no hay lienzo con el que medir —el documento se compone en una cadena—,
 * así que se cuenta por caracteres con la anchura media de la sans a ese
 * cuerpo. Por lo alto a propósito: lo que se decide con esto es si una cifra
 * cabe DENTRO de su tramo, y la que no cabe se va a la leyenda. Equivocarse
 * hacia «no cabe» cuesta una cifra un poco más lejos; hacia «cabe», una cifra
 * cortada.
 */
function anchoDeTexto(texto: string, cuerpo: number): number {
  return texto.length * cuerpo * 0.62
}

/** La luminancia relativa de un color, la de la fórmula de contraste de WCAG. */
function luminancia(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const canal = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * canal((n >> 16) & 255) + 0.7152 * canal((n >> 8) & 255) + 0.0722 * canal(n & 255)
}

/**
 * ¿Va el texto en blanco o en tinta sobre este fondo? El que más contraste dé.
 *
 * Calculado y no por un umbral a ojo: el tono intermedio de la rampa queda
 * justo donde un umbral se equivoca —con blanco no llega a 3,6:1 y con tinta
 * pasa de 4,5:1—, y es una cifra de once puntos impresa en papel.
 */
export function tintaSobre(hex: string): string {
  const fondo = luminancia(hex)
  const conBlanco = 1.05 / (fondo + 0.05)
  const conTinta = (fondo + 0.05) / (luminancia(INK) + 0.05)
  return conTinta > conBlanco ? INK : '#FFFFFF'
}

export interface Tramo {
  nombre: string
  valor: number
  color: string
}

/**
 * Un todo partido en tramos, en una sola barra.
 *
 * Es la forma de enseñar un reparto que se lee de un vistazo —de doce cierres,
 * ocho el mismo día—: una barra alta, cada tramo con su cifra dentro donde
 * cabe, y dos píxeles de papel entre tramo y tramo, que es lo que los separa
 * sin dibujarles un borde. Los nombres van en la leyenda, que pinta la
 * plantilla debajo; un tramo demasiado estrecho para su cifra no la lleva, y la
 * leyenda se la pone al lado del nombre.
 *
 * Se dibuja a mano y no con ECharts: es una figura, no un gráfico con ejes, y
 * así mide exactamente lo que tiene que medir.
 *
 * `devuelve.sinCifra` dice qué tramos se han quedado sin su número dentro.
 */
export function barraDeTramos(
  tramos: Tramo[],
  opts: { width?: number; alto?: number } = {},
): { svg: string; sinCifra: Set<string> } {
  const { width = ANCHO_MEDIO, alto = 28 } = opts
  const vivos = tramos.filter((t) => t.valor > 0)
  const total = vivos.reduce((a, t) => a + t.valor, 0)
  const sinCifra = new Set<string>()
  if (!total) return { svg: '', sinCifra }

  const HUECO = 2
  const util = width - HUECO * (vivos.length - 1)
  const CUERPO = 11
  let x = 0
  const piezas = vivos
    .map((t) => {
      const w = (t.valor / total) * util
      const cifra = String(t.valor)
      const cabe = anchoDeTexto(cifra, CUERPO) + 14 <= w
      if (!cabe) sinCifra.add(t.nombre)
      const pieza =
        `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${alto}" rx="4" fill="${t.color}"/>` +
        (cabe
          ? `<text x="${(x + 8).toFixed(2)}" y="${alto / 2}" dominant-baseline="central" ` +
            `font-family="${MONO}" font-size="${CUERPO}" font-weight="600" fill="${tintaSobre(t.color)}">${cifra}</text>`
          : '')
      x += w + HUECO
      return pieza
    })
    .join('')

  return {
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${alto}" viewBox="0 0 ${width} ${alto}" role="img" ` +
      `aria-label="${vivos.map((t) => `${t.nombre}: ${t.valor}`).join(', ')}">${piezas}</svg>`,
    sinCifra,
  }
}

/**
 * El mismo reparto, en fino y sin texto.
 *
 * Para cuando la barra va ENCIMA de una lista que ya da el nombre y la cifra de
 * cada parte: repetir los números dentro no añade nada. Extremos redondos y los
 * mismos dos píxeles de papel entre tramos.
 */
export function franjaDeTramos(tramos: Tramo[], opts: { width?: number; alto?: number } = {}): string {
  const { width = ANCHO_MEDIO, alto = 8 } = opts
  const vivos = tramos.filter((t) => t.valor > 0)
  const total = vivos.reduce((a, t) => a + t.valor, 0)
  if (!total) return ''

  const HUECO = 2
  const util = width - HUECO * (vivos.length - 1)
  let x = 0
  const piezas = vivos
    .map((t) => {
      const w = Math.max(2, (t.valor / total) * util)
      const pieza = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${alto}" rx="${alto / 2}" fill="${t.color}"/>`
      x += w + HUECO
      return pieza
    })
    .join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${alto}" viewBox="0 0 ${width} ${alto}" role="img" ` +
    `aria-label="${vivos.map((t) => `${t.nombre}: ${t.valor}`).join(', ')}">${piezas}</svg>`
  )
}
