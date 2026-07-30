/**
 * Ciclo de vida de la sesión: alta del dispositivo, desbloqueo con PIN y
 * bloqueo por inactividad.
 */

import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import {
  MAX_PIN_ATTEMPTS,
  VAULT_ITERATIONS,
  deriveVaultKeys,
  generateStrongPassword,
  newVaultSalt,
  openSession,
  sealSession,
  unwrapSecret,
  wrapSecret,
  type SealedSession,
  type VaultParams,
  type WrappedSecret,
} from './pin'

const SEALED_KEY = 'sealed-session'
const ATTEMPTS_KEY = 'pin-attempts'
const DEVICE_KEY = 'aulas.dispositivo'

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
 * El identificador de ESTE aparato, estable mientras no se borren sus datos.
 *
 * Existe por el tope de tres dispositivos: sin él, cada vez que alguien vuelve a
 * darse de alta en el mismo iPad se gastaría un hueco nuevo y a la cuarta el
 * aparato de siempre dejaría de entrar. No identifica el hardware —vaciar el
 * almacenamiento lo cambia— y no hace falta que lo haga: solo tiene que
 * reconocer que este navegador ya estaba.
 *
 * Sobrevive a cerrar sesión a propósito, que es justo el caso que importa:
 * cerrar sesión y volver a entrar no puede consumir un hueco.
 */
export function deviceId(): string {
  try {
    const guardado = localStorage.getItem(DEVICE_KEY)
    if (guardado && guardado.length >= 8) return guardado
    const nuevo = crypto.randomUUID()
    localStorage.setItem(DEVICE_KEY, nuevo)
    return nuevo
  } catch {
    // Safari en modo privado no deja escribir. Se devuelve uno de usar y tirar:
    // el alta funciona igual, solo que ese navegador contará como aparato nuevo
    // la próxima vez.
    return crypto.randomUUID()
  }
}

/**
 * Cómo se llama este aparato en la lista de dispositivos.
 *
 * Antes eran tres palabras —iPad, iPhone, Navegador— y con tres dispositivos por
 * persona eso deja de servir para lo único que tiene que servir: reconocer cuál
 * revocar. Con el sistema y el navegador, «iPad · Safari» y «Windows · Chrome»
 * se distinguen de un vistazo.
 */
export function deviceLabel(): string {
  const ua = navigator.userAgent
  const sistema = /iPad/.test(ua)
    ? 'iPad'
    : /iPhone/.test(ua)
      ? 'iPhone'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? // Un iPad con «Solicitar sitio web para ordenador» se anuncia como Mac.
            // El multitáctil lo delata: ningún Mac lo tiene.
            navigator.maxTouchPoints > 1
            ? 'iPad'
            : 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Navegador'

  const navegador = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null

  return navegador ? `${sistema} · ${navegador}` : sistema
}

/**
 * Alta del dispositivo con email + código de un solo uso.
 *
 * El código es la contraseña temporal que el admin ha creado. En cuanto entra,
 * se rota a una aleatoria fuerte, y esa contraseña **se guarda envuelta en la
 * bóveda** —cifrada con el PIN— para que los otros dos dispositivos puedan
 * entrar sin pedir otro código. Sigue sin guardarse en claro en ninguna parte.
 *
 * El orden de los pasos no es casual:
 *
 *   1. Entrar con el código.
 *   2. **Pedir hueco.** Si ya hay tres dispositivos, aquí se para: el código
 *      todavía no se ha quemado y la contraseña todavía no se ha rotado, así que
 *      quien revoque uno puede volver con el mismo código. Hacerlo al final
 *      dejaría a alguien sin dispositivo Y sin código.
 *   3. Rotar la contraseña, que es lo que invalida el código como credencial.
 *   4. Guardar la bóveda con la contraseña nueva dentro.
 *   5. Marcar el código como consumido.
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

  const hueco = await registerDevice()
  if (!hueco.ok) {
    await supabase.auth.signOut({ scope: 'local' })
    return hueco
  }

  const password = generateStrongPassword()
  const { error: rotateError } = await supabase.auth.updateUser({ password })
  if (rotateError) {
    // Si no se puede quemar el código, no se sigue: dejarlo activo sería dejar
    // una credencial débil y permanente en el servidor.
    await supabase.auth.signOut()
    return { ok: false, error: 'No se pudo completar el alta. Inténtalo de nuevo.' }
  }

  /*
   * La bóveda no bloquea el alta si falla.
   *
   * Quien acaba de teclear su código quiere entrar en el aula, no enterarse de
   * que el servicio de vinculación tuvo un mal segundo. Y se arregla solo:
   * `asegurarBoveda()` corre en cada desbloqueo y, al no encontrar bóveda,
   * vuelve a rotar la contraseña y la escribe.
   */
  await guardarBoveda(pin, password).catch(() => undefined)

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

  return { ok: true }
}

/**
 * Pide hueco para este aparato. Es también el latido inicial: si ya estaba, solo
 * actualiza su nombre y su última conexión.
 */
async function registerDevice(via: 'codigo' | 'pin' = 'codigo'): Promise<EnrollResult> {
  const { error } = await supabase.rpc('registrar_dispositivo', {
    p_dispositivo: deviceId(),
    p_etiqueta: deviceLabel(),
    p_agente: navigator.userAgent.slice(0, 300),
    p_via: via,
  })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// -----------------------------------------------------------------------------
// La bóveda: entrar en el segundo y el tercer dispositivo sin código
// -----------------------------------------------------------------------------

/**
 * Escribe la bóveda: salt nuevo, verificador nuevo y sobre nuevo, de una vez.
 *
 * Entera y siempre: media bóveda —un verificador que no abre su propio sobre—
 * dejaría la cuenta sin poder vincular y sin poder decir por qué.
 */
async function guardarBoveda(pin: string, password: string): Promise<void> {
  const params: VaultParams = { salt: newVaultSalt(), iteraciones: VAULT_ITERATIONS }
  const claves = await deriveVaultKeys(pin, params)
  const sobre = await wrapSecret(claves.envoltorio, password)

  const { error } = await supabase.rpc('guardar_boveda', {
    p_salt: params.salt,
    p_iteraciones: params.iteraciones,
    p_verificador: claves.verificador,
    p_iv: sobre.iv,
    p_secreto: sobre.secreto,
  })
  if (error) throw new Error(error.message)
}

export interface EstadoBoveda {
  existe: boolean
  caducada: boolean
  actualizada: string | null
  dispositivos: number
  maximo: number
}

export async function estadoBoveda(): Promise<EstadoBoveda | null> {
  const { data, error } = await supabase.rpc('estado_boveda')
  if (error || !data) return null
  return data as EstadoBoveda
}

/**
 * Si esta cuenta todavía no tiene bóveda, se la crea.
 *
 * Es lo que hace que la vinculación funcione para quien ya usaba la aplicación
 * antes de que existiera: su contraseña se generó y se tiró, así que no hay nada
 * que envolver. La única salida es generar otra y envolver esa.
 *
 * El peor caso está acotado a propósito, y por eso se puede hacer sin miedo: si
 * la rotación sale bien y la escritura falla, la cuenta queda con una contraseña
 * que no conoce nadie y sin bóveda — que es **exactamente la situación de
 * partida**. Los dispositivos que ya están dentro siguen entrando con su refresh
 * token, y el siguiente desbloqueo lo vuelve a intentar.
 *
 * Lo que NO hace es tocar una bóveda caducada. Caducada significa que un
 * administrador acaba de emitir un código de alta, o sea que la contraseña de la
 * cuenta ES ese código; rotarla aquí lo invalidaría y dejaría a quien lo tiene
 * en la mano con un papel inservible.
 */
export async function asegurarBoveda(pin: string): Promise<void> {
  if (!navigator.onLine) return

  const estado = await estadoBoveda()
  if (!estado || estado.existe) return

  const password = generateStrongPassword()
  const { error } = await supabase.auth.updateUser({ password })
  if (error) return

  for (let intento = 0; intento < 3; intento++) {
    try {
      await guardarBoveda(pin, password)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500 * 2 ** intento))
    }
  }
}

export interface LinkResult {
  ok: boolean
  error?: string
}

/**
 * El canje del verificador por el sobre, y la lectura de su respuesta.
 *
 * `vincular_dispositivo` **devuelve** el fallo en vez de lanzarlo, y eso no es
 * un capricho de estilo del servidor: lanzarlo revertiría el contador de
 * intentos que hace seguro un PIN de cuatro dígitos (ver el comentario de la
 * función en `20260730000600_varios_dispositivos.sql`). Aquí es donde esa
 * respuesta se convierte en algo que la pantalla pueda enseñar.
 *
 * Un `error` de PostgREST sí es un fallo de verdad —red, permisos, la función
 * que no existe porque falta la migración— y se distingue del «no» del
 * servidor, que viene con `ok: false` y su motivo.
 */
async function canjear(
  email: string,
  verificador: string,
): Promise<{ ok: true; sobre: WrappedSecret } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc('vincular_dispositivo', {
    p_email: email,
    p_verificador: verificador,
    p_dispositivo: deviceId(),
    p_etiqueta: deviceLabel(),
    p_agente: navigator.userAgent.slice(0, 300),
  })

  if (error) {
    return {
      ok: false,
      error: navigator.onLine
        ? `No se ha podido contactar con el servidor: ${error.message}`
        : 'Vincular un dispositivo nuevo necesita conexión.',
    }
  }

  const r = data as
    | { ok: true; iv: string; secreto: string }
    | { ok: false; motivo: string; mensaje: string }
    | null

  if (!r) return { ok: false, error: 'El servidor no ha contestado nada.' }
  if (!r.ok) return { ok: false, error: r.mensaje }

  return { ok: true, sobre: { iv: r.iv, secreto: r.secreto } }
}

/**
 * Alta de un dispositivo **sin código**: email y el PIN que ya se usa en otro.
 *
 * Los tres pasos, y ninguno de más:
 *
 *   1. Preguntar con qué derivar. El servidor contesta lo mismo exista o no la
 *      cuenta, así que esto no dice si un correo está dado de alta.
 *   2. Derivar del PIN el verificador y la clave del envoltorio, y canjear el
 *      primero por el sobre. Aquí es donde el servidor cuenta los intentos y
 *      mira si queda hueco.
 *   3. Abrir el sobre y entrar por la puerta normal, con la contraseña de la
 *      cuenta. **No se rota**: la comparten los otros dispositivos.
 */
export async function linkDeviceWithPin(email: string, pin: string): Promise<LinkResult> {
  const correo = email.trim()

  const { data: params, error: errParams } = await supabase.rpc('parametros_de_vinculacion', {
    p_email: correo,
  })
  if (errParams || !params) {
    return {
      ok: false,
      error: navigator.onLine
        ? 'No se ha podido contactar con el servidor. Inténtalo de nuevo.'
        : 'Vincular un dispositivo nuevo necesita conexión. El PIN sin cobertura solo funciona en un dispositivo que ya esté dado de alta.',
    }
  }

  const claves = await deriveVaultKeys(pin, params as VaultParams)

  const canje = await canjear(correo, claves.verificador)
  if (!canje.ok) return canje

  const password = await unwrapSecret(claves.envoltorio, canje.sobre)
  if (!password) {
    return {
      ok: false,
      error: 'La vinculación de esta cuenta está dañada. Pide un código de alta a un administrador.',
    }
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email: correo, password })
  if (error || !data.session) {
    return {
      ok: false,
      error:
        'Tu PIN es correcto, pero el servidor ya no acepta esa contraseña. ' +
        'Suele ser porque se ha emitido un código de alta nuevo: pídelo y usa el código.',
    }
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('id', data.session.user.id)
    .single()

  const sealed = await sealSession(pin, data.session, {
    email: profile?.email ?? correo,
    fullName: profile?.full_name ?? correo,
  })

  await db.meta.put({ key: SEALED_KEY, value: sealed })
  await db.meta.put({ key: ATTEMPTS_KEY, value: 0 })
  pinEnMemoria = pin
  cacheForTab(data.session)
  await touch()

  return { ok: true }
}

/**
 * Cambiar el PIN.
 *
 * El PIN es de la persona y no del aparato, así que cambiarlo tiene que cambiar
 * las dos cosas: la bóveda del servidor —que es la que abren los dispositivos
 * nuevos— y el sobre local de ESTE dispositivo. Los otros que ya estén dentro
 * siguen abriendo el suyo con el PIN viejo hasta que alguien los vuelva a
 * vincular; se dice en la pantalla, porque es lo único que sorprende de todo
 * esto.
 *
 * El PIN actual no se comprueba en local sino contra la bóveda, y es a
 * propósito: así el cambio prueba que quien lo pide sabe el PIN de la CUENTA, y
 * de paso recupera la contraseña que hay que volver a envolver.
 */
export async function changePin(pinActual: string, pinNuevo: string): Promise<LinkResult> {
  const sealed = await getSealed()
  if (!sealed) return { ok: false, error: 'Este dispositivo no está dado de alta.' }
  if (!navigator.onLine) return { ok: false, error: 'Cambiar el PIN necesita conexión.' }

  const correo = sealed.hint.email

  const { data: params, error: errParams } = await supabase.rpc('parametros_de_vinculacion', {
    p_email: correo,
  })
  if (errParams || !params) {
    return { ok: false, error: 'No se ha podido contactar con el servidor.' }
  }

  const viejas = await deriveVaultKeys(pinActual, params as VaultParams)
  const canje = await canjear(correo, viejas.verificador)
  if (!canje.ok) return canje

  const password = await unwrapSecret(viejas.envoltorio, canje.sobre)
  if (!password) return { ok: false, error: 'La vinculación de esta cuenta está dañada.' }

  try {
    await guardarBoveda(pinNuevo, password)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'No se ha podido guardar.' }
  }

  // Y el sobre local, para que el PIN nuevo desbloquee este aparato sin red.
  const tokens = readTabCache()
  if (tokens) {
    await db.meta.put({ key: SEALED_KEY, value: await sealSession(pinNuevo, tokens, sealed.hint) })
  }
  pinEnMemoria = pinNuevo
  await db.meta.put({ key: ATTEMPTS_KEY, value: 0 })

  return { ok: true }
}

export interface Dispositivo {
  id: string
  profile_id: string
  label: string
  enrolled_via: 'codigo' | 'pin'
  enrolled_at: string
  last_seen_at: string | null
  revoked_at: string | null
  revoked_reason: string | null
  revocado_por: string | null
  device_key: string | null
  /** ¿Es este mismo? Sale de comparar con el identificador local. */
  esEste: boolean
}

/**
 * Los dispositivos de una persona, o los de todo el mundo si no se dice cuál.
 *
 * El filtro por perfil no es cosmético: la RLS de `devices` deja a un
 * coordinador ver los de cualquiera, así que sin él la pantalla «Mi cuenta» de
 * un supervisor enseñaría la plantilla entera bajo el título «Mis dispositivos».
 */
export async function misDispositivos(profileId?: string | null): Promise<Dispositivo[]> {
  const yo = deviceId()
  let consulta = supabase.from('mis_dispositivos').select('*')
  if (profileId) consulta = consulta.eq('profile_id', profileId)

  const { data, error } = await consulta.order('enrolled_at', { ascending: false })
  if (error) throw new Error(error.message)

  return ((data ?? []) as Array<Omit<Dispositivo, 'esEste'>>).map((d) => ({
    ...d,
    esEste: d.device_key === yo,
  }))
}

export async function revocarDispositivo(id: string, motivo?: string): Promise<void> {
  const { error } = await supabase.rpc('revocar_dispositivo', {
    p_id: id,
    p_motivo: motivo ?? null,
  })
  if (error) throw new Error(error.message)
}

/**
 * «Sigo aquí», «¿me habéis echado?» y, si hace falta, «apuntadme».
 *
 * Se llama al desbloquear y en cada bajada del maestro. Hace tres cosas que en
 * realidad son la misma pregunta hecha en el momento en que ya hay red:
 *
 *  - Marca la última conexión, que es lo que convierte la lista de dispositivos
 *    en algo con lo que decidir cuál revocar.
 *  - Detecta que a este lo han revocado. Conviene ser exacto sobre lo que eso es
 *    y lo que no: el refresh token sigue valiendo para GoTrue hasta que caduque,
 *    así que esto es un dispositivo que **se retira solo**, no una expulsión que
 *    el servidor imponga. Para eso está `alta codigo <email>`, que rota la
 *    contraseña.
 *  - Se registra si no lo estaba. Es el camino por el que entran los
 *    dispositivos que ya se usaban antes de que existiera todo esto: tienen
 *    sesión válida y ninguna fila con clave.
 */
export async function sincronizarDispositivo(): Promise<{
  revocado: boolean
  aviso: string | null
}> {
  const { data, error } = await supabase.rpc('latido_dispositivo', { p_dispositivo: deviceId() })
  if (error || !data) return { revocado: false, aviso: null }

  const estado = data as { registrado?: boolean; revocado?: boolean }
  if (estado.revocado) return { revocado: true, aviso: null }
  if (estado.registrado) return { revocado: false, aviso: null }

  const alta = await registerDevice('pin')
  return {
    revocado: false,
    // Sin hueco no se echa a nadie que ya esté dentro: seguir trabajando es más
    // importante que el recuento. Pero se dice, porque significa que hay un
    // dispositivo de más que alguien tiene que mirar.
    aviso: alta.ok ? null : (alta.error ?? null),
  }
}

/**
 * Se acabó para este aparato: fuera la sesión sellada y fuera el respaldo.
 *
 * Distinto de `lock()`, que conserva el sobre para poder volver con el PIN. Aquí
 * el dispositivo deja de estar dado de alta y hace falta vincularlo otra vez.
 */
export async function olvidarDispositivo(): Promise<void> {
  clearTabCache()
  pinEnMemoria = null
  await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined)
  await db.meta.delete(SEALED_KEY)
  await db.meta.delete('last-active')
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

  /*
   * Y el único momento del día en que la aplicación tiene el PIN y una sesión
   * viva a la vez.
   *
   * Es exactamente lo que hace falta para preparar la bóveda de quien ya usaba
   * la aplicación antes de que existiera. Va sin esperar y sin poder fallar
   * hacia fuera: desbloquear no puede depender de esto.
   */
  void asegurarBoveda(pin).catch(() => undefined)

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
