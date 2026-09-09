/**
 * El PDF del informe que arma el navegador.
 *
 * El informe se genera entero en la aplicación —los datos, el análisis y el
 * documento— y de ahí salía un HTML y un diálogo de imprimir. Un diálogo de
 * imprimir no es un fichero: en el iPad hay que tocar «Imprimir», luego
 * «Compartir», luego «Guardar en Archivos», y quien pide un informe para
 * mandarlo por correo acaba mandando el HTML, que en el correo del cliente se
 * abre como código o no se abre.
 *
 * Aquí se cierra ese hueco con la pieza que ya estaba: el mismo WeasyPrint que
 * lleva años haciendo los PDF de los informes programados. El navegador manda
 * el documento que acaba de componer y recibe el PDF. Ni un dato más viaja: el
 * HTML es autocontenido —los gráficos son SVG y las fotos van en `data:`— así
 * que el worker no consulta la base ni necesita saber de qué informe se trata.
 *
 * **Quién puede pedirlo.** `/generate` va con el token del worker, que es un
 * secreto del servidor y no puede vivir en un navegador. Así que este endpoint
 * valida la sesión del usuario: el mismo JWT con el que la aplicación habla con
 * la base, comprobado contra Supabase, y con el perfil activo y de personal. Un
 * token caducado o de alguien dado de baja no imprime nada.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { PdfError, htmlToPdf } from './pdf.js'

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? ''
const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? ''

/**
 * El tope del cuerpo.
 *
 * Un informe sin fotos son doscientos kilobytes; con las fotos del periodo
 * dentro, en `data:`, se va a varios megas. Veinticuatro es holgado para lo
 * segundo y sigue siendo pequeño para lo que un navegador puede mandar por
 * error o a propósito.
 */
const MAX_HTML = 24 * 1024 * 1024

const ROLES = new Set(['tecnico', 'supervisor', 'admin'])

let admin: SupabaseClient | null = null
function cliente(): SupabaseClient | null {
  if (!SUPABASE_URL || !SERVICE_KEY) return null
  admin ??= createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  return admin
}

function responder(res: ServerResponse, codigo: number, cuerpo: unknown): void {
  const texto = JSON.stringify(cuerpo)
  res
    .writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8' })
    .end(texto)
}

/**
 * Lee el cuerpo con tope, sin acumular de más y sin matar el socket.
 *
 * Es la misma cortesía que `/generate` y por el mismo motivo, explicado allí:
 * salir antes de tiempo del iterador destruye el `Readable`, Node cierra la
 * conexión de golpe y la siguiente petición del mismo `keep-alive` muere con un
 * «fetch failed» que no tiene nada que ver con ella.
 */
async function leerCuerpo(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
  const trozos: Buffer[] = []
  let bytes = 0
  let excedido = false
  try {
    for await (const trozo of req) {
      bytes += (trozo as Buffer).length
      if (bytes > MAX_HTML) {
        excedido = true
        continue
      }
      trozos.push(trozo as Buffer)
    }
  } catch {
    res.destroy()
    return null
  }
  if (excedido) {
    res
      .writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' })
      .end(JSON.stringify({ ok: false, error: 'El informe pasa del tamaño máximo.' }))
    return null
  }
  return Buffer.concat(trozos)
}

/** El perfil de quien llama, si su sesión vale y sigue siendo del personal. */
async function quienPide(
  autorizacion: string | undefined,
): Promise<{ ok: true; id: string } | { ok: false; codigo: number; error: string }> {
  const supabase = cliente()
  if (!supabase) {
    return { ok: false, codigo: 503, error: 'El PDF no está configurado en este despliegue.' }
  }
  const jwt = (autorizacion ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!jwt) return { ok: false, codigo: 401, error: 'Hace falta iniciar sesión.' }

  const { data, error } = await supabase.auth.getUser(jwt)
  if (error || !data.user) return { ok: false, codigo: 401, error: 'La sesión no vale o ha caducado.' }

  // Y el perfil, no solo el token: una cuenta dada de baja conserva su JWT
  // hasta que caduca, y ese rato no puede seguir sacando documentos del campus.
  const { data: perfil } = await supabase
    .from('profiles')
    .select('role, active')
    .eq('id', data.user.id)
    .maybeSingle()

  if (!perfil?.active || !ROLES.has(String(perfil.role))) {
    return { ok: false, codigo: 403, error: 'Esta cuenta no puede generar informes.' }
  }
  return { ok: true, id: data.user.id }
}

/**
 * `POST /informe/pdf` — recibe el HTML del informe y devuelve el PDF.
 *
 * El nombre del fichero lo pone quien llama y se sanea aquí: viaja en una
 * cabecera y una comilla suelta en `filename` rompe la descarga en Safari.
 */
export async function informePdf(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const quien = await quienPide(req.headers.authorization)
  if (!quien.ok) {
    responder(res, quien.codigo, { ok: false, error: quien.error })
    return
  }

  const cuerpo = await leerCuerpo(req, res)
  if (cuerpo === null) return

  let datos: { html?: unknown; nombre?: unknown } = {}
  try {
    datos = JSON.parse(cuerpo.toString('utf8') || '{}') as typeof datos
  } catch {
    responder(res, 400, { ok: false, error: 'JSON no válido' })
    return
  }

  const html = typeof datos.html === 'string' ? datos.html : ''
  if (html.trim().length < 100) {
    responder(res, 400, { ok: false, error: 'No ha llegado ningún informe que imprimir.' })
    return
  }

  /*
   * Solo ASCII, y no por gusto: una cabecera HTTP es latin-1, y `writeHead` con
   * una eñe dentro lanza `ERR_INVALID_CHAR` y tumba la respuesta entera. El
   * nombre que ve la persona lo pone el navegador al guardar el fichero; este
   * es el de reserva, y más vale que sea feo a que reviente.
   */
  const nombre =
    String(datos.nombre ?? '')
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 120)
      .replace(/^-|-$/g, '') || 'informe.pdf'

  try {
    const pdf = await htmlToPdf(html)
    res
      .writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdf.length),
        'Content-Disposition': `attachment; filename="${nombre}"`,
        // El documento lleva dentro nombres de aulas y de personas: ni el
        // navegador ni un intermediario tienen por qué guardarlo.
        'Cache-Control': 'no-store',
      })
      .end(pdf)
  } catch (e) {
    const motivo = e instanceof PdfError ? e.message : 'fallo al convertir el informe'
    console.error('[informe-pdf]', motivo)
    responder(res, 502, { ok: false, error: 'No se ha podido convertir el informe a PDF.' })
  }
}
