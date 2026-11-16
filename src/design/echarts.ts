/**
 * ECharts, solo con lo que se usa.
 *
 * `import * as echarts from 'echarts'` se trae la librería ENTERA: mapas,
 * velas, radar, sankey, árboles, 3D… más de un megabyte para una aplicación que
 * dibuja barras y líneas. Era el fichero más grande del despliegue, más que
 * todo lo demás junto, y lo bajaba cada persona que abría el Panel.
 *
 * ECharts está hecho para que se le registre a mano lo que se va a usar, y esto
 * es ese registro. La lista es corta porque lo que se dibuja es poco:
 *
 *  - Barras y líneas (el área bajo la línea es de la propia serie de líneas).
 *  - La rejilla con sus ejes, la leyenda del informe y el globo del panel.
 *  - Los dos lienzos: SVG para el informe —que se imprime y tiene que salir
 *    nítido a cualquier tamaño— y canvas para el panel.
 *
 * SI SE AÑADE UN GRÁFICO NUEVO —una tarta, una línea de referencia con
 * `markLine`, un `dataZoom`— hay que registrarlo aquí. ECharts no falla si
 * falta: lo dice en la consola y deja el hueco, así que se ve solo si se mira.
 * `npm run smoke` falla con cualquier error de consola, que es la red.
 *
 * El `reports-worker` tiene su propio `echarts` y no pasa por aquí: corre en el
 * servidor, donde el peso no viaja por ninguna cobertura.
 */

import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers'

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
  SVGRenderer,
])

export { echarts }
