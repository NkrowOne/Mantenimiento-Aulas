/**
 * `POST /alta/codigo` — un código de alta nuevo, pedido desde la aplicación.
 *
 * Hasta ahora esto solo se podía hacer entrando al servidor: `alta codigo
 * <email>`. La pantalla de Usuarios lo decía y explicaba por qué —«exige la
 * clave de servicio de Supabase, que salta RLS entera; meterla en el navegador
 * convertiría cualquier sesión robada en el control del sistema completo»—, y
 * el razonamiento es correcto. Lo que estaba de más era la conclusión: la clave
 * no tiene que ir al navegador para que el botón exista.
 *
 * Es el mismo reparto que ya usa `/informe/pdf`: la clave se queda aquí, el
 * navegador manda **su propia sesión**, y aquí se comprueba quién es y si puede.
 * Con una diferencia que lo hace más estricto que aquel: el PDF lo puede pedir
 * cualquiera del personal y esto **solo un administrador activo**, porque un
 * código de alta es una llave de la casa.
 *
 * Va bajo `/alta/*` y no bajo `/informe/*` a propósito: son las dos rutas que
 * el proxy expone, y `/alta/*` es la que se sabe que funciona —el canje de
 * dispositivos entra por ahí todos los días—. Estrenar endpoint en la ruta que
 * ahora mismo está devolviendo un 401 de alguien que no es este worker sería
 * añadir una incógnita a otra.
 *
 * Lo que NO hace, y no es un olvido: **crear usuarios**. Dar de alta a alguien
 * que no existe decide su email y su rol de partida, y eso no es lo que pide
 * quien pulsa un botón junto a una fila que ya está en la lista. Sigue siendo
 * `alta crear`.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { emitirCodigo, CODE_TTL_HOURS } from './codigos.js'
import { apiQueResponde, deQuienEsLaSesion, noSeHaPodidoPreguntar } from './api.js'

const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? ''

/** El cuerpo son un email y poco más: no hay motivo para aceptar más de esto. */
const MAX_CUERPO = 4 * 1024

/** El cliente contra la dirección de la API que de verdad responde. */
async function cliente(): Promise<
  { ok: true; admin: SupabaseClient } | { ok: false; motivo: string }
> {
  if (!SERVICE_KEY) return { ok: false, motivo: 'falta SUPABASE_SERVICE_ROLE_KEY' }
  const r = await apiQueResponde((url) =>
    createClient(url, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
  )
  return r.ok ? { ok: true, admin: r.admin } : { ok: false, motivo: r.motivo }
}

function responder(res: ServerResponse, codigo: number, cuerpo: unknown): void {
  res
    .writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8' })
    .end(JSON.stringify(cuerpo))
}

/** Lee un cuerpo pequeño sin dejar el socket a medias. */
async function leerCuerpo(req: IncomingMessage): Promise<string | null> {
  const trozos: Buffer[] = []
  let bytes = 0
  let excedido = false
  try {
    for await (const trozo of req) {
      bytes += (trozo as Buffer).length
      if (bytes > MAX_CUERPO) {
        excedido = true
        continue
      }
      trozos.push(trozo as Buffer)
    }
  } catch {
    return null
  }
  return excedido ? null : Buffer.concat(trozos).toString('utf8')
}

/**
 * Quién pide el código, y si puede pedirlo.
 *
 * Tres comprobaciones y ninguna sobra: que el token valga, que la cuenta siga
 * activa —un JWT sobrevive a dar de baja a alguien hasta que caduca— y que el
 * rol sea `admin`. El rol se lee de `profiles` y no del token: el que viaja
 * dentro del JWT es el de cuando se emitió, y degradar a alguien no debería
 * tardar una hora en surtir efecto justo para esto.
 */
async function quienPide(
  supabase: SupabaseClient,
  autorizacion: string | undefined,
): Promise<{ ok: true; id: string } | { ok: false; codigo: number; error: string }> {
  const jwt = (autorizacion ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!jwt) return { ok: false, codigo: 401, error: 'Hace falta iniciar sesión.' }

  // «No vale» y «no he podido preguntar» son dos problemas distintos y se
  // arreglan en sitios distintos. Lo explica entero `api.ts`.
  const sesion = await deQuienEsLaSesion(supabase, jwt)
  if (sesion.que === 'sin respuesta') {
    return { ok: false, codigo: 503, error: noSeHaPodidoPreguntar(sesion.motivo) }
  }
  if (sesion.que === 'no vale') {
    return { ok: false, codigo: 401, error: 'La sesión no vale o ha caducado.' }
  }

  const { data: perfil, error: fallo } = await supabase
    .from('profiles')
    .select('role, active')
    .eq('id', sesion.id)
    .maybeSingle()

  // Sin poder leer el perfil nadie es administrador, y decirle «no puedes» a
  // quien sí puede es mandarlo a pelearse con sus permisos para nada.
  if (fallo) return { ok: false, codigo: 503, error: noSeHaPodidoPreguntar(fallo.message) }

  if (!perfil?.active || String(perfil.role) !== 'admin') {
    return { ok: false, codigo: 403, error: 'Solo un administrador puede dar códigos de alta.' }
  }
  return { ok: true, id: sesion.id }
}

/** El perfil al que se le va a dar el código, buscado por email. */
async function perfilPorEmail(
  supabase: SupabaseClient,
  email: string,
): Promise<{ id: string; role: string; active: boolean; full_name: string | null } | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, role, active, full_name')
    .ilike('email', email)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as { id: string; role: string; active: boolean; full_name: string | null }) ?? null
}

export async function altaCodigo(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const conexion = await cliente()
  if (!conexion.ok) {
    responder(res, 503, { ok: false, error: noSeHaPodidoPreguntar(conexion.motivo) })
    return
  }
  const supabase = conexion.admin

  const quien = await quienPide(supabase, req.headers.authorization)
  if (!quien.ok) {
    responder(res, quien.codigo, { ok: false, error: quien.error })
    return
  }

  const crudo = await leerCuerpo(req)
  if (crudo === null) {
    responder(res, 400, { ok: false, error: 'La petición no se ha podido leer.' })
    return
  }

  let datos: { email?: unknown } = {}
  try {
    datos = JSON.parse(crudo || '{}') as typeof datos
  } catch {
    responder(res, 400, { ok: false, error: 'JSON no válido' })
    return
  }

  const email = typeof datos.email === 'string' ? datos.email.trim() : ''
  if (!email) {
    responder(res, 400, { ok: false, error: 'Falta el email de quien recibe el código.' })
    return
  }

  try {
    const perfil = await perfilPorEmail(supabase, email)
    if (!perfil) {
      responder(res, 404, {
        ok: false,
        error: `No hay ningún usuario con ${email}. Crearlo sigue siendo «alta crear» en el servidor.`,
      })
      return
    }
    if (!perfil.active) {
      // Un código para alguien de baja es una llave que no debería existir: la
      // pantalla puede reactivarlo primero, que es una decisión consciente.
      responder(res, 409, {
        ok: false,
        error: 'Esa persona está de baja. Vuelve a darle de alta antes de darle un código.',
      })
      return
    }

    const emitido = await emitirCodigo(supabase, perfil.id)
    console.log(`[alta-codigo] ${quien.id} ha emitido un código para ${email}`)
    responder(res, 200, { ok: true, horas: CODE_TTL_HOURS, ...emitido })
  } catch (e) {
    const motivo = e instanceof Error ? e.message : String(e)
    console.error('[alta-codigo]', motivo)
    responder(res, 500, { ok: false, error: `No se ha podido generar el código: ${motivo}` })
  }
}
