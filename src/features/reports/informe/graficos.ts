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

import * as echarts from 'echarts'

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

const TIPO = '"IBM Plex Sans", "Instrument Sans Variable", system-ui, sans-serif'
const MONO = '"IBM Plex Mono", ui-monospace, monospace'

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
          borderRadius: [3, 3, 0, 0],
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
            borderRadius: [2, 2, 2, 2],
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
      grid: { left: 2, right: 16, top: 14, bottom: 2, containLabel: true },
      xAxis: { ...ejeCategoria, data: etiquetas, boundaryGap: false },
      yAxis: ejeValor,
      series: [
        {
          type: 'line',
          data: valores,
          symbol: 'circle',
          symbolSize: 6,
          lineStyle: { width: 2, color: tono },
          itemStyle: { color: tono },
          areaStyle: { color: tono, opacity: 0.09 },
          label: {
            show: true,
            position: 'top',
            color: INK,
            fontSize: 9,
            fontFamily: MONO,
            formatter: (p: { dataIndex: number; value: number }) =>
              p.dataIndex === ultimo ? String(p.value) : '',
          },
        },
      ],
    },
    width,
    height,
  )
}
