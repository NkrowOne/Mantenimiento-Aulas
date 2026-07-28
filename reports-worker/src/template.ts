/**
 * Plantilla del informe en HTML, pensada para WeasyPrint.
 *
 * Restricciones que impone no tener navegador, y que aquí se respetan:
 *  - Nada de JavaScript. Los gráficos entran ya como SVG.
 *  - Nada de Grid moderno. Maquetación con `table` y `flex` básico.
 *  - Los saltos de página se controlan con `page-break-inside: avoid`.
 */

import { barChart, lineChart } from './charts.js'
import type { ReportData } from './data.js'

const ACCENT = '#2B4C8C'
const INK = '#12171C'
const MUTED = '#5C6875'
const LINE = '#DBE0E6'
const OK = '#2E7D4F'
const WARN = '#B4741A'
const CRIT = '#B3261E'

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const KIND_TITLE: Record<string, string> = {
  diario: 'Informe diario',
  semanal: 'Informe semanal',
  personalizado: 'Informe a medida',
}

function tile(label: string, value: string | number, detail: string, tone = INK): string {
  return `
    <td class="tile">
      <div class="tile-label">${esc(label)}</div>
      <div class="tile-value" style="color:${tone}">${esc(value)}</div>
      <div class="tile-detail">${esc(detail)}</div>
    </td>`
}

/** `1 sala` / `2 salas`. Un informe serio no dice "1 salas". */
function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`
}

/**
 * Redondear a entero convierte un 0,4% en "0%", que se lee como "nada" cuando
 * en realidad sí hubo trabajo. Por debajo del 1% se dice así.
 */
function pct(part: number, whole: number): string {
  if (!whole) return '—'
  const value = (part / whole) * 100
  if (value === 0) return '0%'
  if (value < 1) return '<1%'
  return `${Math.round(value)}%`
}

export function renderReport(d: ReportData, generatedAt: string): string {
  const s = d.summary
  const coverageValue = s.roomsTotal ? (s.roomsInspected / s.roomsTotal) * 100 : 0
  const net = s.incidentsResolved - s.incidentsOpened

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${esc(KIND_TITLE[d.kind] ?? 'Informe')} · ${esc(d.periodStart)}</title>
<style>
  @page {
    size: A4;
    margin: 18mm 16mm 20mm;
    @bottom-center {
      content: "Mantenimiento de Aulas · página " counter(page) " de " counter(pages);
      font-family: "IBM Plex Sans", sans-serif; font-size: 8pt; color: ${MUTED};
    }
  }
  body { font-family: "IBM Plex Sans", sans-serif; color: ${INK}; font-size: 10pt; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 2mm; }
  h2 { font-size: 12pt; margin: 8mm 0 3mm; padding-bottom: 1.5mm; border-bottom: 1px solid ${LINE}; }
  .eyebrow { font-size: 8pt; letter-spacing: .08em; text-transform: uppercase; color: ${MUTED}; }
  .rule { height: 3px; background: ${ACCENT}; width: 28mm; margin: 3mm 0 6mm; }

  table.tiles { width: 100%; border-collapse: separate; border-spacing: 3mm 0; margin-left: -3mm; }
  .tile { width: 25%; border: 1px solid ${LINE}; border-radius: 3px; padding: 3mm; vertical-align: top; }
  .tile-label { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .06em; color: ${MUTED}; }
  .tile-value { font-family: "IBM Plex Mono", monospace; font-size: 18pt; font-weight: 600;
                font-variant-numeric: tabular-nums; margin: 1mm 0 .5mm; }
  .tile-detail { font-size: 8pt; color: ${MUTED}; }

  table.data { width: 100%; border-collapse: collapse; font-size: 9pt; }
  table.data th { text-align: left; font-weight: 500; color: ${MUTED}; font-size: 8pt;
                  text-transform: uppercase; letter-spacing: .05em;
                  border-bottom: 1px solid ${LINE}; padding: 2mm 1mm; }
  table.data td { padding: 1.8mm 1mm; border-bottom: 1px solid ${LINE}; }
  table.data td.num { font-family: "IBM Plex Mono", monospace; text-align: right;
                      font-variant-numeric: tabular-nums; }
  .mono { font-family: "IBM Plex Mono", monospace; }

  .charts { width: 100%; }
  .charts td { width: 50%; vertical-align: top; padding-right: 4mm; }
  .chart-title { font-size: 9.5pt; font-weight: 600; margin-bottom: 1mm; }
  .chart-note { font-size: 8pt; color: ${MUTED}; margin-bottom: 2mm; }

  section { page-break-inside: avoid; }
  .empty { color: ${MUTED}; font-size: 9pt; font-style: italic; }
</style>
</head>
<body>

<div class="eyebrow">Mantenimiento de aulas</div>
<h1>${esc(KIND_TITLE[d.kind] ?? 'Informe')}</h1>
<div class="eyebrow">${
    d.periodStart === d.periodEnd
      ? esc(d.periodStart)
      : `${esc(d.periodStart)} — ${esc(d.periodEnd)}`
  } · emitido el ${esc(generatedAt)}</div>
<div class="rule"></div>

<section>
  <table class="tiles"><tr>
    ${tile('Revisiones', s.inspections, `${plural(s.roomsInspected, 'sala')} · ${pct(s.roomsInspected, s.roomsTotal)} del total`, coverageValue >= 25 ? OK : WARN)}
    ${tile('Abiertas en el periodo', s.incidentsOpened, `${s.incidentsResolved} resueltas`, net >= 0 ? OK : WARN)}
    ${tile('Pendientes en total', s.incidentsOpen, `${s.staleIncidents} de más de 7 días`, s.staleIncidents > 0 ? CRIT : OK)}
    ${tile('Lámparas al límite', s.lampAlerts, 'por debajo del 20%', s.lampAlerts > 0 ? CRIT : OK)}
  </tr></table>
</section>

<section>
  <h2>Distribución</h2>
  <table class="charts"><tr>
    <td>
      <div class="chart-title">Incidencias por edificio</div>
      <div class="chart-note">Histórico acumulado${
        d.unassignedIncidents
          ? ` · ${d.unassignedIncidents} sin sala identificada, fuera del gráfico`
          : ''
      }</div>
      ${d.byBuilding.length ? barChart(d.byBuilding.map((r) => r.code), d.byBuilding.map((r) => r.total), { width: 250, height: 170 }) : '<p class="empty">Sin datos.</p>'}
    </td>
    <td>
      <div class="chart-title">Aperturas por mes</div>
      <div class="chart-note">Últimos 12 meses</div>
      ${d.byMonth.length ? lineChart(d.byMonth.map((r) => r.month.slice(2)), d.byMonth.map((r) => r.total), { width: 250, height: 170 }) : '<p class="empty">Sin datos.</p>'}
    </td>
  </tr></table>
</section>

<section>
  <h2>Lámparas que van a fundirse</h2>
  ${
    d.lampRows.length
      ? `<table class="data">
    <thead><tr><th>Sala</th><th style="text-align:right">Horas</th><th style="text-align:right">Vida restante</th></tr></thead>
    <tbody>
      ${d.lampRows
        .map(
          (r) => `<tr>
        <td class="mono">${esc(r.building)} ${esc(r.room)}</td>
        <td class="num">${r.hours ?? '—'}</td>
        <td class="num" style="color:${CRIT}">${Math.round(r.pct * 100)}%</td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table>`
      : '<p class="empty">Ninguna lámpara por debajo del umbral.</p>'
  }
</section>

<section>
  <h2>Incidencias estancadas</h2>
  ${
    d.staleRows.length
      ? `<table class="data">
    <thead><tr><th>Referencia</th><th>Descripción</th><th>Edificio</th><th style="text-align:right">Días</th></tr></thead>
    <tbody>
      ${d.staleRows
        .map(
          (r) => `<tr>
        <td class="mono">${esc(r.ref ?? '—')}</td>
        <td>${esc(r.title.slice(0, 70))}</td>
        <td class="mono">${esc(r.building)}</td>
        <td class="num" style="color:${r.days > 30 ? CRIT : WARN}">${r.days}</td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table>`
      : '<p class="empty">Ninguna incidencia lleva más de 7 días abierta.</p>'
  }
</section>

<section>
  <h2>Material más consumido</h2>
  ${
    d.topMaterials.length
      ? `<table class="data">
    <thead><tr><th>Artículo</th><th style="text-align:right">Unidades</th></tr></thead>
    <tbody>
      ${d.topMaterials
        .map(
          (r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.consumed}</td></tr>`,
        )
        .join('')}
    </tbody>
  </table>`
      : '<p class="empty">Sin consumo registrado en el periodo.</p>'
  }
</section>

</body>
</html>`
}
