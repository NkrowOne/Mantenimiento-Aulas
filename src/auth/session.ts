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

/**
 * El PIN, mientras la pestaña viva. En memoria y en ninguna otra parte.
 *
 * Está aquí por una razón concreta: GoTrue **rota** el refresh token en cada
 * renovación (`GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED`) y revoca el
 * anterior diez segundos después. El token viaja a memoria del cliente de
 * Supabase y ahí se quedaba: ni el respaldo de `localStorage` ni la sesión
 * sellada con el PIN se volvían a escribir nunca.
 *
 * O sea que una hora después de entrar —`GOTRUE_JWT_EXP` son 3600 segundos— los
 * dos sitios donde guardamos la sesión contenían un token muerto. Recargar
 * dejaba de funcionar, y el PIN también: `unlockWithPin()` mandaba el token
 * revocado, `setSession()` fallaba... y como su error no se miraba, la
 * aplicación se daba por desbloqueada **sin sesión ninguna**. Desde fuera se ve
 * igual que lo que se ve cuando RLS bloquea: todo vacío, ningún error, y el rol
 * atascado en `tecnico` porque `getUser()` devuelve null.
 *
 * Guardar el PIN es lo que permite volver a sellar la sesión cada vez que el
 * token se renueva. No sale de aquí, no se persiste y se borra al cerrar sesión;
 * la pestaña ya lo tuvo en memoria para descifrar, así que no expone nada nuevo.
 */
let pinEnMemoria: string | null = null

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

/**
 * Guarda la sesión que acaba de emitir el servidor en los dos sitios: el
 * respaldo que sobrevive a recargar, y el sobre cifrado con el PIN.
 *
 * El segundo solo se puede reescribir si tenemos el PIN a mano, que es el caso
 * mientras la pestaña siga viva desde que alguien lo tecleó. Cuando no lo está
 * —una recarga reanuda con el respaldo, sin pedir PIN— se actualiza al menos el
 * respaldo, y el sobre se pone al día en el siguiente desbloqueo.
 */
async function custodiar(session: TabSession): Promise<void> {
  cacheForTab(session)

  if (!pinEnMemoria) return
  const sealed = await getSealed()
  if (!sealed) return
  await db.meta.put({ key: SEALED_KEY, value: await sealSession(pinEnMemoria, session, sealed.hint) })
}

/**
 * Sigue las renovaciones del token para que lo guardado nunca sea lo viejo.
 *
 * Sin esto, todo lo demás de este fichero funciona exactamente una hora.
 */
export function watchSession(): () => void {
  const { data } = supabase.auth.onAuthStateChange((evento, session) => {
    if (!session) return
    if (evento !== 'TOKEN_REFRESHED' && evento !== 'SIGNED_IN' && evento !== 'USER_UPDATED') return
    void custodiar({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    })
  })

  return () => data.subscription.unsubscribe()
}

/**
 * ¿Es «no he podido preguntar» y no «me han dicho que no»?
 *
 * Es la distinción que decide si el técnico entra o se queda fuera, así que se
 * mira por varios lados: `supabase-js` marca los fallos de transporte como
 * `AuthRetryableFetchError` y les deja el estado a 0 o sin definir, mientras que
 * un rechazo del servidor trae un 400 o un 401.
 */
function esFalloDeRed(error: unknown): boolean {
  if (!navigator.onLine) return true
  const e = error as { name?: string; status?: number; message?: string }
  if (e?.name === 'AuthRetryableFetchError') return true
  if (typeof e?.status === 'number' && e.status !== 0) return false
  return /fetch|network|failed to fetch|networkerror|load failed|timeout/i.test(e?.message ?? '')
}

/**
 * Vuelve a establecer la sesión cuando regrese la conexión.
 *
 * Sin esto, quien entra sin cobertura se queda con la aplicación en local para
 * siempre: `resumeSession()` solo corre al arrancar, así que recuperar la línea
 * a media mañana no serviría de nada hasta la siguiente recarga.
 *
 * Se registra una sola vez y se desengancha al primer intento, tenga éxito o
 * no: si vuelve a fallar, el motor de sincronización ya reintenta por su cuenta.
 */
function reintentarAlVolverLaRed(session: TabSession): void {
  const alVolver = (): void => {
    window.removeEventListener('online', alVolver)
    void (async () => {
      const { data } = await supabase.auth.setSession(session)
      if (data.session) {
        await custodiar({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        })
      }
    })()
  }
  window.addEventListener('online', alVolver)
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
  // A partir de aquí, cada renovación del token se vuelve a sellar sola.
  pinEnMemoria = pin
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

  /*
   * El PIN era correcto —el sobre se ha abierto—, pero eso no significa que el
   * servidor siga aceptando lo que había dentro.
   *
   * El error de `setSession()` se descartaba, así que un refresh token ya
   * revocado desbloqueaba la aplicación igual, sin sesión: todas las lecturas
   * volvían vacías, `getUser()` devolvía null y el rol se quedaba en `tecnico`.
   * Un zombi. Y es indistinguible, desde la pantalla, de que RLS te bloquee.
   */
  const { data: viva, error } = await supabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  })

  /*
   * Y aquí hay que distinguir dos cosas que se parecen y no lo son.
   *
   * «El servidor dice que no» y «no he podido preguntarle» llegan las dos como
   * un error de `setSession()`, pero piden lo contrario:
   *
   *   - Rechazo real (400/401): el refresh token está revocado. Entrar sería
   *     entrar a una aplicación que no puede leer nada.
   *   - Fallo de red: **hay que dejar entrar**. El PIN se valida en local a
   *     propósito, y todo el trabajo de campo ocurre en sótanos y pasillos sin
   *     cobertura. Exigir servidor para desbloquear vacía de sentido el diseño
   *     entero: el técnico llega al aula, no tiene línea y no puede ni abrir la
   *     revisión que iba a rellenar sin conexión.
   *
   * Lo destapó la previsualización: sin servidor delante, la pantalla del PIN
   * respondía «el servidor ya no acepta esta sesión» y no dejaba pasar de ahí.
   */
  if (error && esFalloDeRed(error)) {
    pinEnMemoria = pin
    // Los tokens siguen siendo los buenos; lo que falta es la red. Se guardan y
    // se reintenta en cuanto vuelva, para que la sesión quede viva sola.
    cacheForTab(session)
    reintentarAlVolverLaRed(session)
    await touch()
    return { ok: true }
  }

  if (error || !viva.session) {
    return {
      ok: false,
      error:
        'Tu PIN es correcto, pero el servidor ya no acepta esta sesión. ' +
        'Pide un código de alta nuevo para volver a registrar el dispositivo.',
    }
  }

  pinEnMemoria = pin
  // Lo que devuelve `setSession` NO es lo que le hemos mandado: al renovar, el
  // servidor emite un refresh token nuevo y anula el anterior. Guardar el que
  // teníamos era justo lo que dejaba el dispositivo con un token muerto.
  await custodiar({
    access_token: viva.session.access_token,
    refresh_token: viva.session.refresh_token,
  })
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

  const { data, error } = await supabase.auth.setSession({
    access_token: cached.access_token,
    refresh_token: cached.refresh_token,
  })
  if (error || !data.session) {
    // El refresh token ya no vale (revocado, rotado por otro dispositivo…):
    // se pide el PIN, que es la vía correcta para volver a entrar.
    clearTabCache()
    return false
  }

  // Reanudar consume el refresh token y devuelve otro. Sin escribirlo, la
  // siguiente recarga mandaría el mismo token ya revocado y la sesión duraría
  // exactamente una: reanudar una vez y no poder reanudar nunca más.
  await custodiar({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  })
  await touch()
  return true
}

/*
 * Aquí vivía `resealCurrentSession(pin)`, que hacía esto mismo pero **no la
 * llamaba nadie**: había que pasarle el PIN y para cuando el token se renovaba
 * ya no lo tenía nadie a mano. De ahí que la sesión guardada se quedara
 * congelada en el primer token. Ahora lo hace `custodiar()`, sola, en cada
 * renovación.
 */

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
  pinEnMemoria = null
  await supabase.auth.signOut({ scope: 'local' })
  await db.meta.delete('last-active')
}

/** Minutos de inactividad configurados. 0 significa que no caduca. */
export const lockAfterMinutes = LOCK_AFTER_MS / 60_000
