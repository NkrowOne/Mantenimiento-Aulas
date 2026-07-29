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
import { createHash, timingSafeEqual } from 'node:crypto'

const PORT = Number(process.env['PORT'] ?? 8080)
const TOKEN = process.env['WORKER_TOKEN'] ?? ''
const DATABASE_URL = process.env['DATABASE_URL'] ?? ''
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? ''
const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? ''

/** Cuerpo máximo de una petición. Nadie manda más que `{kind, start, end}`. */
const MAX_BODY = 8 * 1024

if (!DATABASE_URL) throw new Error('Falta DATABASE_URL')

/*
 * Sin token no se arranca.
 *
 * Antes la comprobación era `if (TOKEN && …)`: con `WORKER_TOKEN` vacío el
 * `if` no entraba nunca y el endpoint quedaba abierto a cualquiera que
 * alcanzase el contenedor. Un fallo de autenticación que se abre en vez de
 * cerrarse es peor que no tenerla, porque nadie se entera.
 *
 * El compose ya exige que la variable exista, pero exigir que exista no es lo
 * mismo que exigir que valga algo.
 */
if (process.env['NODE_ENV'] !== 'test' && TOKEN.length < 16) {
  throw new Error('Falta WORKER_TOKEN, o es demasiado corto (mínimo 16 caracteres)')
}

/**
 * Comparación en tiempo constante.
 *
 * Un `!==` sobre cadenas sale en cuanto encuentra el primer byte distinto, así
 * que el tiempo de respuesta filtra cuántos caracteres del token se han
 * acertado. Es un secreto de larga vida en una red donde ya hay varios
 * contenedores: no cuesta nada compararlo bien.
 */
function tokenValido(cabecera: string | undefined): boolean {
  const esperado = Buffer.from(`Bearer ${TOKEN}`)
  const recibido = Buffer.from(cabecera ?? '')
  if (esperado.length !== recibido.length) return false
  return timingSafeEqual(esperado, recibido)
}

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
    // Sin token: solo dice que el proceso responde, nada más.
    if (req.method === 'GET' && req.url?.startsWith('/salud')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
      return
    }

    if (req.method !== 'POST' || !req.url?.startsWith('/generate')) {
      res.writeHead(404).end('No encontrado')
      return
    }

    if (!tokenValido(req.headers.authorization)) {
      res.writeHead(401).end('No autorizado')
      return
    }

    // Con tope: `for await` sin límite acumula en memoria lo que le manden.
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of req) {
      bytes += (chunk as Buffer).length
      if (bytes > MAX_BODY) {
        res.writeHead(413).end('Cuerpo demasiado grande')
        req.destroy()
        return
      }
      chunks.push(chunk as Buffer)
    }

    let body: { kind?: string; start?: string; end?: string } = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    } catch {
      res.writeHead(400).end('JSON no válido')
      return
    }

    const kind = body.kind ?? 'diario'
    if (!['diario', 'semanal', 'personalizado'].includes(kind)) {
      res.writeHead(400).end('Tipo de informe no válido')
      return
    }

    // Las fechas van a un `::date` en SQL: sin comprobarlas aquí, un texto
    // cualquiera se convierte en un 500 con la traza de Postgres dentro.
    const FECHA = /^\d{4}-\d{2}-\d{2}$/
    if ((body.start && !FECHA.test(body.start)) || (body.end && !FECHA.test(body.end))) {
      res.writeHead(400).end('Las fechas deben ir en formato AAAA-MM-DD')
      return
    }

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
      // Sin la traza: el que llama es pg_cron y no la lee, y devolverla expone
      // nombres de tabla y de fichero a quien acierte el token.
      res.end(JSON.stringify({ ok: false, error: 'No se pudo generar el informe' }))
    }
  })()
})

if (process.env['NODE_ENV'] !== 'test') {
  server.listen(PORT, () => console.log(`Worker de informes escuchando en :${PORT}`))
}
