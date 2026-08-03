/**
 * Worker de informes.
 *
 * Lo despierta `pg_cron` a través de `pg_net`, por el nombre de servicio en la
 * red interna de Compose — nunca por localhost, porque desde el contenedor de
 * la base de datos localhost es ella misma.
 *
 * Cadena: Postgres → análisis (reglas + Gemini) → ECharts SSR a SVG → HTML →
 * WeasyPrint → Storage.
 */

import { createServer } from 'node:http'
import { createClient } from '@supabase/supabase-js'
import { conectar } from './db.js'
import { loadReportData } from './data.js'
import { ZONA, periodFor } from './periods.js'
import { renderReport } from './template.js'
import { htmlToPdf } from './pdf.js'
import { lecturaCalculada, senales } from './analisis.js'
import { configurarIA, redactar } from './ia.js'
import { leerOpciones } from './opciones.js'
import { canjearAlta, leerCuerpoPequeno } from './alta.js'
import { createHash, timingSafeEqual } from 'node:crypto'
import type postgres from 'postgres'

const PORT = Number(process.env['PORT'] ?? 8080)
const TOKEN = process.env['WORKER_TOKEN'] ?? ''
const DATABASE_URL = process.env['DATABASE_URL'] ?? ''
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? ''
const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? ''

/**
 * Cuerpo máximo de una petición.
 *
 * Ya no es solo `{kind, start, end}`: ahora caben las secciones elegidas y dos
 * textos libres (el enfoque para la IA y la nota impresa). Sigue siendo un tope
 * pequeño porque nadie tiene por qué mandar más que eso, y `leerOpciones`
 * recorta los textos por su cuenta.
 */
const MAX_BODY = 16 * 1024

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

// Con tope por consulta: ninguna query del informe puede quedarse colgada
// reteniendo una de las dos conexiones con el healthcheck en verde.
const sql = conectar(DATABASE_URL, 2, undefined, { statementTimeoutMs: 120_000 })
const storage =
  SUPABASE_URL && SERVICE_KEY ? createClient(SUPABASE_URL, SERVICE_KEY) : null

/**
 * Los ajustes de IA guardados en la base.
 *
 * Existen para que activar la IA no exija reconstruir el contenedor: un
 * administrador pega la clave desde la propia aplicación y el siguiente informe
 * ya sale redactado. `GEMINI_API_KEY` en el entorno sigue teniendo prioridad
 * (ver `configurarIA`), que es lo correcto: manda quien controla el servidor.
 *
 * Si la consulta falla —tabla aún sin migrar, permisos— no se cae nada: se
 * devuelve vacío y el informe sale con la redacción calculada.
 */
async function ajustesIA(): Promise<{ clave?: string; modelo?: string; thinking?: string }> {
  try {
    const filas = await sql<Array<{ key: string; value: string }>>`
      select key, value from app_config
      where key in ('ia_api_key', 'ia_modelo', 'ia_thinking')
    `
    const m = new Map(filas.map((f) => [f.key, f.value.trim()]))
    return {
      ...(m.get('ia_api_key') ? { clave: m.get('ia_api_key')! } : {}),
      ...(m.get('ia_modelo') ? { modelo: m.get('ia_modelo')! } : {}),
      ...(m.get('ia_thinking') ? { thinking: m.get('ia_thinking')! } : {}),
    }
  } catch {
    return {}
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function nombreDe(id: string | undefined): Promise<string | undefined> {
  if (!id || !UUID.test(id)) return undefined
  try {
    const [p] = await sql<Array<{ full_name: string }>>`
      select full_name from profiles where id = ${id}
    `
    return p?.full_name
  } catch {
    return undefined
  }
}

export interface Resultado {
  path: string
  bytes: number
  /** Qué redactó el análisis. Va al archivo para que el histórico lo diga. */
  analisis: string
}

export async function generate(
  kind: string,
  range?: { start: string; end: string },
  params?: unknown,
  solicitadoPor?: string,
): Promise<Resultado> {
  const period = range ?? periodFor(kind)
  const opciones = leerOpciones(params)
  const data = await loadReportData(sql, kind, period.start, period.end)
  const se = senales(data)

  /*
   * El orden importa: primero la redacción calculada, siempre. Si Gemini
   * contesta, se sustituye; si no contesta, si no hay clave o si quien pide el
   * informe ha desmarcado la casilla, ya hay un texto completo esperando. Nunca
   * hay un momento en el que el informe pueda quedarse sin análisis.
   */
  let lectura = lecturaCalculada(data)
  let conIA = false

  if (opciones.ia) {
    const cfg = configurarIA({
      ...(await ajustesIA()),
      audiencia: opciones.audiencia,
      ...(opciones.enfoque ? { enfoque: opciones.enfoque } : {}),
    })
    if (cfg) {
      const redactada = await redactar(data, se, cfg)
      if (redactada) {
        lectura = redactada
        conIA = true
      }
    } else {
      console.log('Sin GEMINI_API_KEY ni clave en app_config: análisis calculado.')
    }
  }

  // El pie del informe daba la hora UTC sin decirlo: un PDF emitido a las 09:00
  // de Madrid ponía «07:00», y quien lo archivara lo fecharía mal.
  const emitido = new Intl.DateTimeFormat('es-ES', {
    timeZone: ZONA,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date())

  const solicitante = await nombreDe(solicitadoPor)
  const html = renderReport(data, lectura, opciones, { emitido, solicitante })
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

  /*
   * En `params` se guarda cómo se hizo, no lo que se pidió: las secciones que
   * de verdad salieron y quién redactó el análisis. Así el archivo puede decir
   * «este de marzo salió sin IA» sin abrir el PDF, y la pantalla puede marcarlo.
   */
  const huella = {
    secciones: opciones.secciones,
    comparar: opciones.comparar,
    audiencia: opciones.audiencia,
    ia: conIA,
    analisis: lectura.origen,
    ...(opciones.enfoque ? { enfoque: opciones.enfoque } : {}),
    ...(opciones.nota ? { nota: opciones.nota } : {}),
  }

  await sql`
    insert into reports (kind, period_start, period_end, storage_path, content_hash, params, generated_by)
    values (${kind}, ${period.start}, ${period.end}, ${path}, ${hash},
            ${sql.json(huella) as unknown as postgres.Parameter},
            ${solicitadoPor && UUID.test(solicitadoPor) ? solicitadoPor : null})
    on conflict do nothing
  `

  return { path, bytes: pdf.length, analisis: lectura.origen }
}

const server = createServer((req, res) => {
  void (async () => {
    // Sin token: solo dice que el proceso responde, nada más.
    if (req.method === 'GET' && req.url?.startsWith('/salud')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
      return
    }

    /*
     * El canje del código de alta. SIN token: quien llama es un dispositivo
     * que todavía no tiene sesión, y Caddy solo enruta hasta aquí `/alta/*` —
     * `/generate` sigue siendo interno y con token. La validación del código
     * y el cupo de dispositivos viven en `alta.ts`.
     */
    if (req.method === 'POST' && req.url?.startsWith('/alta/canjear')) {
      const cuerpo = await leerCuerpoPequeno(req, res)
      if (cuerpo === null) return
      await canjearAlta(req, res, cuerpo)
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

    /*
     * El cuerpo, con tope y sin dejar el socket a medias.
     *
     * Dos cosas que hay que hacer a la vez y que se estorban:
     *
     *  1. NO acumular en memoria lo que le manden. De ahí el tope: pasado
     *     `MAX_BODY` se sigue leyendo pero ya no se guarda nada.
     *  2. NO matar el socket. Antes se respondía 413 y se salía del `for await`,
     *     y salir antes de tiempo de un iterador de un `Readable` lo DESTRUYE:
     *     Node cierra la conexión de golpe. Con `keep-alive` —lo que da por
     *     hecho cualquier cliente moderno— la siguiente petición ya iba encolada
     *     en ese mismo socket y moría con un «fetch failed» que no tenía nada
     *     que ver con ella. En `npm run worker:test` fallaba una de cada tres
     *     veces, siempre la prueba de después, y siempre parecía otra cosa.
     *
     * Así que se drena el cuerpo entero descartándolo y se contesta al final,
     * con `Connection: close` para que el cliente no reutilice esta conexión.
     * El corte a lo bruto se reserva para quien insista de verdad: a partir de
     * diez veces el tope ya no es un cliente torpe, y ahí sí se corta.
     */
    const TOPE_DURO = MAX_BODY * 10
    const chunks: Buffer[] = []
    let bytes = 0
    let excedido = false

    /*
     * Y el bucle entero dentro de un try, porque el flujo de entrada es del
     * CLIENTE: si corta la conexión a mitad del cuerpo —un curl interrumpido,
     * pg_net cancelando su espera, una red que se cae— el iterador del
     * `Readable` revienta con ECONNRESET. Sin recogerlo, esa excepción subía
     * por el `void (async …)()` del handler como un unhandled rejection y
     * tumbaba EL PROCESO ENTERO del worker: cualquiera que alcanzara el puerto
     * podía apagar los informes cortando una petición a medias. Reproducido,
     * no supuesto.
     */
    try {
      for await (const chunk of req) {
        bytes += (chunk as Buffer).length
        if (bytes > MAX_BODY) {
          excedido = true
          if (bytes > TOPE_DURO) {
            res.writeHead(413, { Connection: 'close' }).end('Cuerpo demasiado grande')
            req.destroy()
            return
          }
          continue
        }
        chunks.push(chunk as Buffer)
      }
    } catch {
      // El cliente se fue: no hay a quién contestar y no hay nada que hacer.
      res.destroy()
      return
    }

    if (excedido) {
      res.writeHead(413, { Connection: 'close' }).end('Cuerpo demasiado grande')
      return
    }

    let body: {
      kind?: string
      start?: string
      end?: string
      params?: unknown
      solicitado_por?: string
    } = {}
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
        body.params,
        body.solicitado_por,
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
