/**
 * Gráficos para el PDF, renderizados a SVG **sin navegador**.
 *
 * ECharts sabe hacer SSR desde la 5.3 sin jsdom ni node-canvas. Como los
 * gráficos salen ya como SVG, la plantilla del informe no necesita ejecutar
 * JavaScript, y eso permite que el PDF lo genere WeasyPrint en vez de un
 * Chromium: ~300MB de imagen en lugar de ~1,5GB y ningún proceso de navegador
 * que vigilar.
 */

import * as echarts from 'echarts'

// La misma paleta validada que usa la aplicación. Los colores de estado
// (ok/aviso/crítico) quedan fuera a propósito: están reservados y no se
// reutilizan como serie.
const CATEGORICAL = ['#4A78D4', '#12A396', '#B063D6', '#8A8F3C']
const INK = '#12171C'
const MUTED = '#5C6875'
const LINE = '#DBE0E6'

function render(option: Record<string, unknown>, width: number, height: number): string {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height })
  chart.setOption({
    // Sin esto la animación sale como CSS incrustado en el SVG y el PDF
    // congela un fotograma intermedio: barras a media altura.
    animation: false,
    textStyle: { fontFamily: 'IBM Plex Sans, sans-serif', color: INK, fontSize: 11 },
    ...option,
  })
  const svg = chart.renderToSVGString()
  chart.dispose()
  return svg
}

const axisBase = {
  axisLine: { lineStyle: { color: LINE } },
  axisTick: { show: false },
  axisLabel: { color: MUTED, fontSize: 10 },
}

export function barChart(
  categories: string[],
  values: number[],
  opts: { width?: number; height?: number; color?: number } = {},
): string {
  const { width = 520, height = 220, color = 0 } = opts

  return render(
    {
      color: CATEGORICAL,
      grid: { left: 8, right: 12, top: 12, bottom: 8, containLabel: true },
      xAxis: { ...axisBase, type: 'category', data: categories, splitLine: { show: false } },
      yAxis: {
        ...axisBase,
        type: 'value',
        axisLine: { show: false },
        splitLine: { lineStyle: { color: LINE, type: 'dashed' } },
      },
      series: [
        {
          type: 'bar',
          data: values,
          barMaxWidth: 26,
          barCategoryGap: '32%',
          itemStyle: { color: CATEGORICAL[color % CATEGORICAL.length], borderRadius: [4, 4, 0, 0] },
        },
      ],
    },
    width,
    height,
  )
}

export function lineChart(
  categories: string[],
  values: number[],
  opts: { width?: number; height?: number; color?: number } = {},
): string {
  const { width = 520, height = 220, color = 1 } = opts
  const hue = CATEGORICAL[color % CATEGORICAL.length]!

  return render(
    {
      color: CATEGORICAL,
      grid: { left: 8, right: 12, top: 12, bottom: 8, containLabel: true },
      xAxis: { ...axisBase, type: 'category', data: categories, splitLine: { show: false } },
      yAxis: {
        ...axisBase,
        type: 'value',
        axisLine: { show: false },
        splitLine: { lineStyle: { color: LINE, type: 'dashed' } },
      },
      series: [
        {
          type: 'line',
          data: values,
          symbol: 'circle',
          symbolSize: 7,
          lineStyle: { width: 2, color: hue },
          itemStyle: { color: hue },
          areaStyle: { color: hue, opacity: 0.1 },
        },
      ],
    },
    width,
    height,
  )
}
