/**
 * Canje del código de alta por una sesión, sin tocar la contraseña.
 *
 * Existe por un hecho verificado en el código de GoTrue (v2.177.0): cambiar la
 * contraseña de un usuario revoca sus sesiones — TODAS con el cambio de admin
 * (`updateUserById`), todas menos la propia con el del usuario. Y en el flujo
 * original el código de alta ERA la contraseña: generarle un código a alguien
 * para su segundo iPad mataba la sesión del primero, y el alta del segundo
 * remataba lo que quedara al rotar la contraseña. Una cuenta solo podía tener
 * un dispositivo vivo, por mucho que la tabla `devices` listara tres.
 *
 * Aquí el código se valida contra su hash en `enrollment_codes` y la sesión se
 * emite con un pase de un solo uso (`generateLink` + `verifyOtp` en el
 * cliente), que no toca ninguna credencial: los dispositivos ya conectados ni
 * se enteran. La contraseña se quema una única vez —en el primer alta de la
 * cuenta, cuando no hay ninguna sesión que perder— y desde entonces es una
 * aleatoria que no conoce nadie.
 *
 * La ruta es pública a propósito: quien llama todavía no tiene sesión. La
 * protección es el propio código —12 caracteres de un alfabeto de 29, unos 58
 * bits, con caducidad y un solo uso— más una pausa fija en cada rechazo para
 * que probar a ciegas no salga gratis.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { apiQueResponde } from './api.js'

const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? ''

/**
 * Cuántos dispositivos puede tener conectados una cuenta a la vez.
 *
 * Se cuenta por `user_agent`, no por fila: en iOS, Safari, la PWA instalada y
 * los demás navegadores del MISMO aparato comparten user-agent, y tratarlos
 * como dispositivos distintos gastaría el cupo entero en un solo iPhone. Es el
 * aparato lo que se limita, no el navegador.
 */
export const MAX_DISPOSITIVOS = 3

const RECHAZO = 'Email o código incorrectos, o el código ha caducado.'
const PAUSA_RECHAZO_MS = 300

/*
 * Contra la dirección de la API que de verdad responde, como el resto del
 * worker. Esto se quedó mirando solo `SUPABASE_URL` cuando lo demás pasó a
 * probar también `SUPABASE_UPSTREAM`, y el efecto fue el peor posible: dar el
 * código funcionaba y canjearlo no, porque cada mitad hablaba con una
 * dirección distinta y una de las dos no llegaba. Lo explica `api.ts`.
 */
async function cliente(): Promise<SupabaseClient | null> {
  if (!SERVICE_KEY) return null
  const r = await apiQueResponde((url) =>
    createClient(url, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  )
  if (!r.ok) {
    console.error('[alta] No se llega a Supabase:', r.motivo)
    return null
  }
  return r.admin
}

/*
 * Lo que se le dice a quien intenta canjear cuando el fallo es del servidor.
 *
 * Genérico a propósito: esta ruta es pública —quien llama todavía no tiene
 * sesión— y el detalle (qué dirección, qué variable) no le sirve de nada a
 * quien está delante de la pantalla de alta y sí a quien esté tanteando. El
 * detalle va al registro del contenedor.
 *
 * Lo que NO puede es decir «código incorrecto», que es lo que decía: la
 * persona vuelve a teclearlo, pide otro, y el problema sigue sin ser el código.
 */
const SIN_SERVIDOR =
  'El servidor no puede comprobar el código ahora mismo. No es tu código: vuelve a intentarlo en un rato, y si se repite, avisa a quien administra la aplicación.'

function responder(res: ServerResponse, status: number, cuerpo: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(cuerpo))
}

function pausa(ms: number): Promise<void> {
  return new Promise((listo) => setTimeout(listo, ms))
}

async function rechazar(res: ServerResponse): Promise<void> {
  await pausa(PAUSA_RECHAZO_MS)
  // El mismo mensaje exista o no el email: distinguirlos regalaría un oráculo
  // de qué cuentas hay.
  responder(res, 400, { ok: false, error: RECHAZO })
}

/**
 * Lee un cuerpo pequeño con las mismas cortesías que el de `/generate`: sin
 * acumular de más y sin matar el socket (ver allí el porqué del drenado).
 */
export async function leerCuerpoPequeno(
  req: IncomingMessage,
  res: ServerResponse,
  tope = 4096,
): Promise<Buffer | null> {
  const trozos: Buffer[] = []
  let bytes = 0
  try {
    for await (const trozo of req) {
      bytes += (trozo as Buffer).length
      if (bytes > tope * 10) {
        res.writeHead(413, { Connection: 'close' }).end('Cuerpo demasiado grande')
        req.destroy()
        return null
      }
      if (bytes <= tope) trozos.push(trozo as Buffer)
    }
  } catch {
    res.destroy()
    return null
  }
  if (bytes > tope) {
    res.writeHead(413, { Connection: 'close' }).end('Cuerpo demasiado grande')
    return null
  }
  return Buffer.concat(trozos)
}

export async function canjearAlta(
  req: IncomingMessage,
  res: ServerResponse,
  cuerpo: Buffer,
): Promise<void> {
  const supabase = await cliente()
  if (!supabase) {
    responder(res, 503, { ok: false, error: SIN_SERVIDOR })
    return
  }

  let datos: { email?: unknown; code?: unknown } = {}
  try {
    datos = JSON.parse(cuerpo.toString() || '{}') as typeof datos
  } catch {
    responder(res, 400, { ok: false, error: 'JSON no válido' })
    return
  }

  const email = String(datos.email ?? '').trim().toLowerCase()
  // El alfabeto del código es todo mayúsculas; lo que teclee la gente, no
  // necesariamente. Normalizar aquí evita un rechazo por una minúscula.
  const code = String(datos.code ?? '').trim().toUpperCase()
  if (!email.includes('@') || code.length < 8) {
    await rechazar(res)
    return
  }

  /*
   * Las dos consultas miran su `error`, y no por limpieza.
   *
   * Antes se leía solo `data`, y una consulta que no llegaba a la base
   * devolvía `data: null` — exactamente lo mismo que un email que no existe o
   * un código que no coincide. Así que un servidor sin conexión contestaba
   * «Email o código incorrectos»: la persona volvía a teclearlo, pedía otro
   * código, y nada de eso podía funcionar porque el código estaba bien. Pasó.
   */
  const { data: perfil, error: falloPerfil } = await supabase
    .from('profiles')
    .select('id')
    .ilike('email', email)
    .maybeSingle()
  if (falloPerfil) {
    console.error('[alta] No se pudo leer el perfil:', falloPerfil.message)
    responder(res, 503, { ok: false, error: SIN_SERVIDOR })
    return
  }

  const hash = createHash('sha256').update(code).digest('hex')
  let codigo: { id: string } | null = null
  if (perfil) {
    const { data, error: falloCodigo } = await supabase
      .from('enrollment_codes')
      .select('id')
      .eq('profile_id', perfil.id)
      .eq('code_hash', hash)
      .is('consumed_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    if (falloCodigo) {
      console.error('[alta] No se pudo leer el código:', falloCodigo.message)
      responder(res, 503, { ok: false, error: SIN_SERVIDOR })
      return
    }
    codigo = data as { id: string } | null
  }

  if (!perfil || !codigo) {
    await rechazar(res)
    return
  }

  // El cupo. `user_agent` mide aparatos, no navegadores (ver MAX_DISPOSITIVOS);
  // un aparato que ya está dentro siempre puede volver a darse de alta.
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 300)
  const { data: dispositivos } = await supabase
    .from('devices')
    .select('user_agent')
    .eq('profile_id', perfil.id)
    .is('revoked_at', null)
  const aparatos = new Set((dispositivos ?? []).map((d) => d.user_agent ?? ''))
  if (!aparatos.has(ua) && aparatos.size >= MAX_DISPOSITIVOS) {
    responder(res, 403, {
      ok: false,
      error:
        `Esta cuenta ya tiene ${MAX_DISPOSITIVOS} dispositivos dados de alta. ` +
        'Pide a un supervisor que revoque el que ya no se use.',
    })
    return
  }

  /*
   * El primer alta de la cuenta quema la contraseña temporal: es el único
   * momento en que hacerlo no cuesta nada, porque no hay ninguna sesión que
   * GoTrue pueda revocar. A partir de aquí la contraseña es una aleatoria que
   * no conoce nadie y no se vuelve a tocar — tocarla es lo que mataba a los
   * demás dispositivos.
   */
  if ((dispositivos ?? []).length === 0) {
    const { error } = await supabase.auth.admin.updateUserById(perfil.id, {
      password: randomBytes(32).toString('base64'),
    })
    if (error) console.error('[alta] No se pudo quemar la contraseña temporal:', error.message)
  }

  const { data: enlace, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  const tokenHash = enlace?.properties?.hashed_token
  if (error || !tokenHash) {
    console.error('[alta] No se pudo emitir el pase:', error?.message ?? 'sin hashed_token')
    responder(res, 500, { ok: false, error: 'No se pudo completar el alta. Inténtalo de nuevo.' })
    return
  }

  // El código se quema aquí, con el pase ya emitido: quemarlo antes dejaría un
  // código muerto sin sesión a cambio si `generateLink` fallara.
  await supabase
    .from('enrollment_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', codigo.id)

  responder(res, 200, { ok: true, token_hash: tokenHash })
}
