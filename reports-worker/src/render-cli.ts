/**
 * Render de un informe a fichero, sin servidor ni Storage.
 *
 *   DATABASE_URL=... npm run render -- semanal salida.pdf
 *   DATABASE_URL=... npm run render -- semanal salida.html   (sin WeasyPrint)
 *
 * Sirve para revisar la plantilla en cada cambio: la fidelidad de WeasyPrint
 * hay que mirarla en un PDF de verdad, no suponerla.
 */

import { writeFileSync } from 'node:fs'
import { conectar } from './db.js'
import { loadReportData } from './data.js'
import { periodFor } from './periods.js'
import { renderReport } from './template.js'
import { htmlToPdf } from './pdf.js'

const kind = process.argv[2] ?? 'semanal'
const out = process.argv[3] ?? 'informe.pdf'
const start = process.argv[4]
const end = process.argv[5]

const DATABASE_URL = process.env['DATABASE_URL']
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL')
  process.exit(1)
}

const sql = conectar(DATABASE_URL, 1)

try {
  const period = start && end ? { start, end } : periodFor(kind)
  const data = await loadReportData(sql, kind, period.start, period.end)
  const html = renderReport(data, new Date().toISOString().slice(0, 16).replace('T', ' '))

  if (out.endsWith('.html')) {
    writeFileSync(out, html)
    console.log(`HTML escrito en ${out} (${html.length} bytes)`)
  } else {
    const pdf = await htmlToPdf(html)
    writeFileSync(out, pdf)
    console.log(`PDF escrito en ${out} (${pdf.length} bytes)`)
  }

  console.log(
    `  periodo ${period.start} → ${period.end}\n` +
      `  ${data.summary.inspections} revisiones · ${data.summary.incidentsOpen} incidencias abiertas\n` +
      `  ${data.byBuilding.length} edificios · ${data.lampRows.length} lámparas al límite · ` +
      `${data.topMaterials.length} materiales`,
  )
} finally {
  await sql.end()
}
