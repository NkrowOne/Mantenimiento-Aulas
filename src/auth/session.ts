/**
 * Ciclo de vida de la sesión: alta del dispositivo, desbloqueo con PIN y
 * bloqueo por inactividad.
 */

import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import {
  MAX_PIN_ATTEMPTS,
  generateStrongPassword,
  openSession,
  sealSession,
  type SealedSession,
} from './pin'

const SEALED_KEY = 'sealed-session'
const ATTEMPTS_KEY = 'pin-attempts'

/**
 * Minutos de inactividad antes de volver a pedir el PIN.
 *
 * **0 = nunca**, y es el valor por defecto: la sesión dura hasta que alguien
 * pulsa «Cerrar sesión». Es lo que se pidió expresamente, y para trabajo de
 * campo tiene sentido — que la aplicación te eche mientras revisas aulas es una
 * molestia diaria garantizada.
 *
 * A cambio, conviene saber qué se pierde: con la sesión abierta, **quien coja
 * el dispositivo entra directamente**. El PIN pasa a proteger solo a partir de
 * que alguien cierra sesión a propósito. Si los iPads se comparten entre turnos
 * o salen del campus, poner aquí 480 (una jornada) recupera esa protección sin
 * estorbar durante el trabajo.
 */
const LOCK_AFTER_MS = Number(import.meta.env['VITE_LOCK_AFTER_MINUTES'] ?? 0) * 60 * 1000

/**
 * Sesión activa del dispositivo.
 *
 * En `localStorage`, no en `sessionStorage`: tiene que sobrevivir a cerrar la
 * pestaña, apagar el iPad y reiniciarlo. Solo desaparece cuando el usuario
 * cierra sesión, o si falla el PIN cinco veces.
 *
 * El cliente de Supabase va con `persistSession: false` a propósito, para que
 * la custodia sea nuestra y no suya: así «cerrar sesión» significa exactamente
 * lo que dice y no queda ningún token suelto en otro sitio.
 */
const TAB_SESSION_KEY = 'aulas.session'

interface TabSession {
  access_token: string
  refresh_token: string
}

function cacheForTab(session: TabSession): void {
  try {
    localStorage.setItem(TAB_SESSION_KEY, JSON.stringify(session))
  } catch {
    // Safari en modo privado lanza al escribir. No es motivo para no entrar:
    // solo significa que una recarga volverá a pedir el PIN.
  }
}

function readTabCache(): TabSession | null {
  try {
    const raw = localStorage.getItem(TAB_SESSION_KEY)
    return raw ? (JSON.parse(raw) as TabSession) : null
  } catch {
    return null
  }
}

function clearTabCache(): void {
  try {
    localStorage.removeItem(TAB_SESSION_KEY)
  } catch {
    /* nada que limpiar */
  }
}

export interface EnrollResult {
  ok: boolean
  error?: string
}

/**
 * Alta del dispositivo con email + código de un solo uso.
 *
 * El código es la contraseña temporal que el admin ha creado. En cuanto entra,
 * se rota a una aleatoria fuerte que no se guarda en ningún sitio: así el
 * código deja de ser una credencial válida y la única llave que queda es el
 * refresh token, cifrado con el PIN.
 */
export async function enrollDevice(
  email: string,
  code: string,
  pin: string,
): Promise<EnrollResult> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: code })
  if (error || !data.session) {
    return { ok: false, error: 'Email o código incorrectos, o el código ha caducado.' }
  }

  const { error: rotateError } = await supabase.auth.updateUser({
    password: generateStrongPassword(),
  })
  if (rotateError) {
    // Si no se puede quemar el código, no se sigue: dejarlo activo sería dejar
    // una credencial débil y permanente en el servidor.
    await supabase.auth.signOut()
    return { ok: false, error: 'No se pudo completar el alta. Inténtalo de nuevo.' }
  }

  await supabase.rpc('consume_enrollment_code')

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('id', data.session.user.id)
    .single()

  const sealed = await sealSession(pin, data.session, {
    email: profile?.email ?? email,
    fullName: profile?.full_name ?? email,
  })

  await db.meta.put({ key: SEALED_KEY, value: sealed })
  await db.meta.put({ key: ATTEMPTS_KEY, value: 0 })
  cacheForTab(data.session)
  await touch()
  await registerDevice(data.session.user.id)

  return { ok: true }
}

async function registerDevice(profileId: string): Promise<void> {
  const label = /iPad/.test(navigator.userAgent)
    ? 'iPad'
    : /iPhone/.test(navigator.userAgent)
      ? 'iPhone'
      : 'Navegador'
  await supabase.from('devices').insert({
    profile_id: profileId,
    label,
    user_agent: navigator.userAgent.slice(0, 300),
  })
}

export async function getSealed(): Promise<SealedSession | null> {
  const entry = await db.meta.get(SEALED_KEY)
  return (entry?.value as SealedSession | undefined) ?? null
}

export async function hasEnrolledDevice(): Promise<boolean> {
  return (await getSealed()) !== null
}

export interface UnlockResult {
  ok: boolean
  attemptsLeft?: number
  wiped?: boolean
  error?: string
}

/**
 * Desbloquea con el PIN. Funciona sin red: solo descifra lo que ya está en el
 * dispositivo y restaura la sesión en el cliente de Supabase.
 */
export async function unlockWithPin(pin: string): Promise<UnlockResult> {
  const sealed = await getSealed()
  if (!sealed) return { ok: false, error: 'Este dispositivo no está dado de alta.' }

  const session = await openSession<{ access_token: string; refresh_token: string }>(pin, sealed)

  if (!session) {
    const attempts = (((await db.meta.get(ATTEMPTS_KEY))?.value as number) ?? 0) + 1
    await db.meta.put({ key: ATTEMPTS_KEY, value: attempts })

    if (attempts >= MAX_PIN_ATTEMPTS) {
      // Se borra la sesión, no los datos: lo que estuviera pendiente ya está
      // respaldado en el servidor, y lo que no, se conserva para el siguiente
      // alta. Borrar el trabajo del técnico por teclear mal sería inaceptable.
      await db.meta.delete(SEALED_KEY)
      await db.meta.put({ key: ATTEMPTS_KEY, value: 0 })
      clearTabCache()
      return { ok: false, wiped: true, error: 'Demasiados intentos. Pide un nuevo código de alta.' }
    }

    return { ok: false, attemptsLeft: MAX_PIN_ATTEMPTS - attempts, error: 'PIN incorrecto.' }
  }

  await db.meta.put({ key: ATTEMPTS_KEY, value: 0 })
  await supabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  })
  cacheForTab(session)
  await touch()

  return { ok: true }
}

/**
 * Reanuda sin PIN si la pestaña sigue viva y no ha pasado el tiempo de
 * inactividad. Es lo que permite dejar la aplicación abierta toda la mañana y
 * que una recarga no interrumpa el trabajo.
 */
export async function resumeSession(): Promise<boolean> {
  if (await shouldRelock()) {
    clearTabCache()
    return false
  }

  const cached = readTabCache()
  if (!cached) return false

  const { error } = await supabase.auth.setSession({
    access_token: cached.access_token,
    refresh_token: cached.refresh_token,
  })
  if (error) {
    // El refresh token ya no vale (revocado, rotado por otro dispositivo…):
    // se pide el PIN, que es la vía correcta para volver a entrar.
    clearTabCache()
    return false
  }

  await touch()
  return true
}

/** Vuelve a sellar la sesión tras renovarse el token, para no perder el refresh. */
export async function resealCurrentSession(pin: string): Promise<void> {
  const { data } = await supabase.auth.getSession()
  const sealed = await getSealed()
  if (!data.session || !sealed) return
  await db.meta.put({ key: SEALED_KEY, value: await sealSession(pin, data.session, sealed.hint) })
}

export async function touch(): Promise<void> {
  await db.meta.put({ key: 'last-active', value: Date.now() })
}

/** ¿Ha estado la app en segundo plano lo bastante como para volver a pedir el PIN? */
/**
 * ¿Toca volver a pedir el PIN por inactividad?
 *
 * Con `LOCK_AFTER_MS = 0` la respuesta es siempre no: la sesión solo termina
 * cuando alguien la cierra.
 */
export async function shouldRelock(): Promise<boolean> {
  if (LOCK_AFTER_MS <= 0) return false
  const last = (await db.meta.get('last-active'))?.value as number | undefined
  if (!last) return true
  return Date.now() - last > LOCK_AFTER_MS
}

/**
 * Cierra la sesión a propósito. Es la única forma de que termine si no hay
 * caducidad configurada.
 *
 * Borra la sesión activa pero **conserva la sesión sellada con el PIN**, así
 * que para volver a entrar basta el PIN: no hace falta un código de alta nuevo.
 */
export async function lock(): Promise<void> {
  clearTabCache()
  await supabase.auth.signOut({ scope: 'local' })
  await db.meta.delete('last-active')
}

/** Minutos de inactividad configurados. 0 significa que no caduca. */
export const lockAfterMinutes = LOCK_AFTER_MS / 60_000
