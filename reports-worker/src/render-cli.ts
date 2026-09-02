/**
 * Render de un informe a fichero, sin servidor ni Storage.
 *
 *   DATABASE_URL=... npm run render -- semanal salida.pdf
 *   DATABASE_URL=... npm run render -- semanal salida.html            (sin WeasyPrint)
 *   DATABASE_URL=... npm run render -- personalizado x.html 2026-03-01 2026-03-31
 *   DATABASE_URL=... npm run render -- semanal x.html --sin-ia
 *   DATABASE_URL=... npm run render -- semanal x.html --secciones=resumen,actividad,analisis
 *   DATABASE_URL=... npm run render -- semanal x.html --audiencia=equipo --enfoque="mira el CRAI"
 *
 * Sirve para revisar la plantilla en cada cambio: la fidelidad de WeasyPrint hay
 * que mirarla en un PDF de verdad, no suponerla. Y para probar la redacción con
 * IA sin esperar al viernes ni tocar el archivo de informes.
 */

import { writeFileSync } from 'node:fs'
import { conectar } from './db.js'
import { loadReportData } from './data.js'
import { periodFor } from './periods.js'
import { renderReport } from './template.js'
import { htmlToPdf } from './pdf.js'
import { lecturaCalculada, senales } from './analisis.js'
import { configurarIA, redactar } from './ia.js'
import { leerOpciones } from './opciones.js'

const args = process.argv.slice(2)
const opcion = (nombre: string): string | undefined =>
  args.find((a) => a.startsWith(`--${nombre}=`))?.split('=').slice(1).join('=')
const bandera = (nombre: string): boolean => args.includes(`--${nombre}`)
const suelto = args.filter((a) => !a.startsWith('--'))

const kind = suelto[0] ?? 'semanal'
const out = suelto[1] ?? 'informe.pdf'
const start = suelto[2]
const end = suelto[3]

const DATABASE_URL = process.env['DATABASE_URL']
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL')
  process.exit(1)
}

const sql = conectar(DATABASE_URL, 1)

try {
  const period = start && end ? { start, end } : periodFor(kind)
  const opciones = leerOpciones({
    ia: !bandera('sin-ia'),
    comparar: !bandera('sin-comparar'),
    ...(opcion('secciones') ? { secciones: opcion('secciones')!.split(',') } : {}),
    ...(opcion('audiencia') ? { audiencia: opcion('audiencia') } : {}),
    ...(opcion('enfoque') ? { enfoque: opcion('enfoque') } : {}),
    ...(opcion('nota') ? { nota: opcion('nota') } : {}),
  })

  const data = await loadReportData(sql, kind, period.start, period.end)
  const se = senales(data, opciones.audiencia)

  let lectura = lecturaCalculada(data, opciones.audiencia)
  if (opciones.ia) {
    const cfg = configurarIA({
      audiencia: opciones.audiencia,
      ...(opciones.enfoque ? { enfoque: opciones.enfoque } : {}),
    })
    if (!cfg) {
      console.log('· sin GEMINI_API_KEY: se usa la redacción calculada')
    } else {
      const r = await redactar(data, se, cfg)
      if (r) lectura = r
    }
  }

  const html = renderReport(data, lectura, opciones, {
    // En hora de Madrid, como el servidor: `toISOString()` es UTC, y el pie del
    // informe jura estar en hora local — dos horas de mentira en verano.
    emitido: new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid',
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date()),
  })

  if (out.endsWith('.html')) {
    writeFileSync(out, html)
    console.log(`HTML escrito en ${out} (${html.length} bytes)`)
  } else {
    const pdf = await htmlToPdf(html)
    writeFileSync(out, pdf)
    console.log(`PDF escrito en ${out} (${pdf.length} bytes)`)
  }

  console.log(
    `  periodo ${period.start} → ${period.end} (${data.periodoTexto})\n` +
      `  ${data.ahora.revisiones} revisiones · ${data.ahora.registros} registros · ` +
      `${data.situacion.incidenciasAbiertas} pendientes\n` +
      `  ${data.porEdificio.length} edificios · ${data.lamparas.length} lámparas al límite · ` +
      `${data.materiales.length} materiales\n` +
      `  análisis: ${lectura.origen}\n` +
      `  secciones: ${opciones.secciones.join(', ')}`,
  )
} finally {
  await sql.end()
}
