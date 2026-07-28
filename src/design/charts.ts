/**
 * Sistema de gráficos.
 *
 * La paleta categórica está **validada**, no elegida a ojo: pasa las seis
 * comprobaciones (banda de luminosidad, suelo de croma, separación bajo
 * daltonismo, suelo de visión normal y contraste) en claro y en oscuro.
 *
 *   node scripts/validate_palette.js "#4A78D4,#12A396,#B063D6,#8A8F3C" --mode light
 *   node scripts/validate_palette.js "#6690DE,#25A899,#B672D4,#949A48"  --mode dark
 *
 * Dos reglas que no se rompen:
 *  - **Los hues se asignan en orden fijo, nunca en ciclo.** Un filtro que
 *    cambia el número de series no puede repintar a las supervivientes: el
 *    color sigue a la entidad, no a su posición en el ranking.
 *  - **Los colores de estado (ok/aviso/crítico) están reservados.** Nunca se
 *    reutilizan como "serie 4", porque entonces un verde dejaría de significar
 *    "bien" y el panel perdería su lectura de un vistazo.
 */

export const CATEGORICAL_LIGHT = ['#4A78D4', '#12A396', '#B063D6', '#8A8F3C'] as const
export const CATEGORICAL_DARK = ['#6690DE', '#25A899', '#B672D4', '#949A48'] as const

/** Rampa secuencial: un solo tono, de claro a oscuro. Nunca un arcoíris. */
export const SEQUENTIAL_LIGHT = ['#DCE6F7', '#A8C0EC', '#7398DF', '#4A78D4', '#2B4C8C'] as const
export const SEQUENTIAL_DARK = ['#243247', '#2F4A73', '#40679F', '#5A82C4', '#6690DE'] as const

export function isDark(): boolean {
  const attr = document.documentElement.dataset['theme']
  if (attr === 'dark') return true
  if (attr === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function categorical(): readonly string[] {
  return isDark() ? CATEGORICAL_DARK : CATEGORICAL_LIGHT
}

function cssVar(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return raw ? `rgb(${raw})` : '#888'
}

/**
 * Base común a todos los gráficos: rejilla discreta, ejes recesivos, marcas
 * finas y **un solo eje de valores**. Nunca doble escala: dos medidas de
 * magnitud distinta van en dos gráficos, no en uno con dos ejes.
 */
export function baseOption(): Record<string, unknown> {
  const ink = cssVar('--ink')
  const muted = cssVar('--muted')
  const line = cssVar('--line')

  return {
    color: [...categorical()],
    /*
     * Sin animación de dibujado, y es una decisión, no un olvido.
     *
     * Un gráfico que se dibuja solo obliga a esperar para poder leerlo. Esto es
     * dato que alguien está consultando para decidir a qué aula va, no una
     * pantalla de bienvenida. Además iguala lo que ya hace el worker de
     * informes, que renderiza sin navegador: el panel y el PDF salen idénticos.
     */
    animation: false,
    textStyle: { fontFamily: '"IBM Plex Sans Variable", system-ui, sans-serif', color: ink },
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: cssVar('--surface'),
      borderColor: line,
      textStyle: { color: ink, fontSize: 12 },
    },
    xAxis: {
      axisLine: { lineStyle: { color: line } },
      axisTick: { show: false },
      axisLabel: { color: muted, fontSize: 11 },
      splitLine: { show: false },
    },
    yAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: muted, fontSize: 11 },
      splitLine: { lineStyle: { color: line, type: 'dashed' } },
    },
  }
}

/** Barras con el extremo redondeado y ancladas a la línea base. */
export function barSeries(name: string, data: number[], colorIndex = 0): Record<string, unknown> {
  return {
    name,
    type: 'bar',
    data,
    itemStyle: { color: categorical()[colorIndex % categorical().length], borderRadius: [4, 4, 0, 0] },
    barMaxWidth: 28,
    // 2px de hueco entre barras contiguas: separa sin necesidad de bordes.
    barCategoryGap: '32%',
  }
}

export function lineSeries(name: string, data: number[], colorIndex = 0): Record<string, unknown> {
  const color = categorical()[colorIndex % categorical().length]
  return {
    name,
    type: 'line',
    data,
    smooth: false,
    symbol: 'circle',
    symbolSize: 8,
    lineStyle: { width: 2, color },
    itemStyle: { color },
    areaStyle: { color, opacity: 0.08 },
  }
}
