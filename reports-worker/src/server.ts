/**
 * Worker de informes.
 *
 * Lo despierta `pg_cron` a través de `pg_net`, por el nombre de servicio en la
 * red interna de Compose — nunca por localhost, porque desde el contenedor de
 * la base de datos localhost es ella misma.
 *
 * Cadena: Postgres → ECharts SSR a SVG → HTML → WeasyPrint → Storage.
 */

import { createServer } from 'node:http'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'
import { loadReportData, periodFor } from './data.js'
import { renderReport } from './template.js'
import { htmlToPdf } from './pdf.js'
import { createHash } from 'node:crypto'

const PORT = Number(process.env['PORT'] ?? 8080)
const TOKEN = process.env['WORKER_TOKEN'] ?? ''
const DATABASE_URL = process.env['DATABASE_URL'] ?? ''
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? ''
const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? ''

if (!DATABASE_URL) throw new Error('Falta DATABASE_URL')

const sql = postgres(DATABASE_URL, { max: 2 })
const storage =
  SUPABASE_URL && SERVICE_KEY ? createClient(SUPABASE_URL, SERVICE_KEY) : null

export async function generate(
  kind: string,
  range?: { start: string; end: string },
): Promise<{ path: string; bytes: number }> {
  const period = range ?? periodFor(kind)
  const data = await loadReportData(sql, kind, period.start, period.end)

  const generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const html = renderReport(data, generatedAt)
  const pdf = await htmlToPdf(html)

  const hash = createHash('sha256').update(pdf).digest('hex').slice(0, 12)
  const path = `${kind}/${period.start}_${period.end}_${hash}.pdf`

  if (storage) {
    const { error } = await storage.storage
      .from('reports')
      .upload(path, pdf, { contentType: 'application/pdf', upsert: false })
    // Un informe ya emitido no se regenera: si el hash coincide, es el mismo
    // documento y volver a subirlo sería reescribir el registro.
    if (error && !/exists/i.test(error.message)) throw error
  }

  await sql`
    insert into reports (kind, period_start, period_end, storage_path, content_hash, generated_by)
    values (${kind}, ${period.start}, ${period.end}, ${path}, ${hash}, null)
    on conflict do nothing
  `

  return { path, bytes: pdf.length }
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.method !== 'POST' || !req.url?.startsWith('/generate')) {
      res.writeHead(404).end('No encontrado')
      return
    }

    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end('No autorizado')
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)

    let body: { kind?: string; start?: string; end?: string } = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    } catch {
      res.writeHead(400).end('JSON no válido')
      return
    }

    const kind = body.kind ?? 'diario'
    try {
      const result = await generate(
        kind,
        body.start && body.end ? { start: body.start, end: body.end } : undefined,
      )
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...result }))
    } catch (err) {
      console.error('Fallo generando el informe:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(err) }))
    }
  })()
})

if (process.env['NODE_ENV'] !== 'test') {
  server.listen(PORT, () => console.log(`Worker de informes escuchando en :${PORT}`))
}
