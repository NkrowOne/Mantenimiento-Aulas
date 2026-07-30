/**
 * PIN de dispositivo.
 *
 * El PIN **no es la contraseña del servidor**. Cuatro dígitos son 10.000
 * combinaciones: enviarlo como credencial sería inaceptable, y además no
 * funcionaría sin cobertura, que es justo cuando el técnico abre la app en el
 * aula.
 *
 * Lo que hace es derivar una clave que **descifra la sesión de Supabase**
 * guardada en el dispositivo. Consecuencias:
 *   - Se valida en local: entra en modo avión.
 *   - Un iPad perdido no da acceso: sin el PIN, el token es ilegible.
 *   - El PIN no se guarda en ninguna parte, ni siquiera su hash por separado.
 *     Si es incorrecto, el descifrado simplemente falla.
 *
 * Y una segunda función, que es la que permite usar la cuenta en tres
 * dispositivos: el mismo PIN abre una **bóveda** guardada en el servidor con la
 * contraseña de la cuenta dentro (ver la mitad de abajo de este fichero y
 * `supabase/migrations/20260730000600_varios_dispositivos.sql`). El servidor
 * sigue sin ver el PIN: lo que recibe es un verificador derivado, y lo que
 * devuelve es un sobre que solo el PIN abre.
 */

const PBKDF2_ITERATIONS = 310_000
const SALT_BYTES = 16
const IV_BYTES = 12

export const MIN_PIN_LENGTH = 4
export const MAX_PIN_LENGTH = 8
export const MAX_PIN_ATTEMPTS = 5

/**
 * A partir de aquí la aplicación recomienda seis dígitos.
 *
 * Cuatro se siguen aceptando —hay gente que ya tiene el suyo y obligar a
 * cambiarlo el día del despliegue es la clase de fricción que se paga en
 * llamadas—, pero con la bóveda el PIN pasa a proteger algo que vive en el
 * servidor, y dos dígitos más son cien veces más combinaciones por el mismo
 * gesto.
 */
export const RECOMMENDED_PIN_LENGTH = 6

export interface SealedSession {
  salt: string
  iv: string
  ciphertext: string
  /** Para poder mostrar "Sesión de Ana" antes de pedir el PIN. */
  hint: { email: string; fullName: string }
}

function toBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
}

async function deriveKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  )

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Cifra la sesión con el PIN. Lo que se guarda es indescifrable sin él. */
export async function sealSession(
  pin: string,
  session: unknown,
  hint: SealedSession['hint'],
): Promise<SealedSession> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKey(pin, salt)

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(JSON.stringify(session)),
  )

  return {
    salt: toBase64(salt.buffer as ArrayBuffer),
    iv: toBase64(iv.buffer as ArrayBuffer),
    ciphertext: toBase64(ciphertext),
    hint,
  }
}

/**
 * Descifra la sesión. Devuelve null si el PIN es incorrecto — AES-GCM está
 * autenticado, así que un PIN erróneo hace que el descifrado falle, no que
 * produzca basura.
 */
export async function openSession<T = unknown>(
  pin: string,
  sealed: SealedSession,
): Promise<T | null> {
  try {
    const key = await deriveKey(pin, fromBase64(sealed.salt))
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(sealed.iv) as BufferSource },
      key,
      fromBase64(sealed.ciphertext) as BufferSource,
    )
    return JSON.parse(new TextDecoder().decode(plain)) as T
  } catch {
    return null
  }
}

export interface PinValidation {
  ok: boolean
  reason?: string
}

/**
 * Rechaza los PIN que un atacante probaría primero. Con solo 4 dígitos, dejar
 * pasar `1234` o `0000` regala buena parte del espacio de búsqueda.
 */
export function validatePin(pin: string): PinValidation {
  if (!/^\d+$/.test(pin)) {
    return { ok: false, reason: 'El PIN solo puede tener dígitos.' }
  }
  if (pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) {
    return { ok: false, reason: `El PIN debe tener entre ${MIN_PIN_LENGTH} y ${MAX_PIN_LENGTH} dígitos.` }
  }
  if (new Set(pin).size === 1) {
    return { ok: false, reason: 'Elige un PIN con dígitos distintos.' }
  }

  const ascending = [...pin].every((d, i, arr) => i === 0 || Number(d) === Number(arr[i - 1]) + 1)
  const descending = [...pin].every((d, i, arr) => i === 0 || Number(d) === Number(arr[i - 1]) - 1)
  if (ascending || descending) {
    return { ok: false, reason: 'Evita secuencias como 1234 o 4321.' }
  }

  return { ok: true }
}

/** Contraseña larga y aleatoria que sustituye al código de alta tras usarlo. */
export function generateStrongPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return toBase64(bytes.buffer as ArrayBuffer)
}

// -----------------------------------------------------------------------------
// La bóveda: el mismo PIN, en otro dispositivo
// -----------------------------------------------------------------------------

/**
 * Iteraciones con las que nacen las bóvedas nuevas.
 *
 * Las que ya existen recuerdan las suyas —el servidor devuelve las de cada
 * bóveda junto al salt—, así que subir este número no invalida nada: solo
 * encarece las que se creen a partir de mañana.
 */
export const VAULT_ITERATIONS = 310_000

/** Lo que el servidor contesta al preguntar «con qué derivo el PIN de este correo». */
export interface VaultParams {
  salt: string
  iteraciones: number
}

/** El sobre, tal y como viaja. */
export interface WrappedSecret {
  iv: string
  secreto: string
}

/**
 * Las dos mitades que salen del PIN.
 *
 * Se derivan juntas y con una sola pasada de PBKDF2 —que es la cara— y se
 * separan con HKDF y dos etiquetas distintas. Que sean independientes es lo que
 * permite mandar una al servidor sin comprometer la otra: el verificador viaja,
 * la clave del envoltorio no sale nunca de aquí.
 */
export interface VaultKeys {
  /** Va al servidor. Solo sirve para decir «sé el PIN», no para descifrar nada. */
  verificador: string
  /** Se queda aquí. Es la que abre y cierra el sobre. */
  envoltorio: CryptoKey
}

const INFO_VERIFICADOR = 'mantenimiento-aulas:verificador:v1'
const INFO_ENVOLTORIO = 'mantenimiento-aulas:envoltorio:v1'

/** Un salt nuevo, en el mismo formato en el que lo guarda y lo devuelve el servidor. */
export function newVaultSalt(): string {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  return toBase64(salt.buffer as ArrayBuffer)
}

/**
 * Deriva las dos mitades a partir del PIN y de los parámetros de la bóveda.
 *
 * El salt entra en el HKDF además de en el PBKDF2. No hace falta —la clave
 * maestra ya depende de él— pero cuesta cero y hace que dos bóvedas con el
 * mismo PIN y distinto salt no compartan absolutamente nada.
 */
export async function deriveVaultKeys(pin: string, params: VaultParams): Promise<VaultKeys> {
  const salt = fromBase64(params.salt)

  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  )

  const master = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: params.iteraciones,
      hash: 'SHA-256',
    },
    material,
    256,
  )

  const hkdf = await crypto.subtle.importKey('raw', master, 'HKDF', false, [
    'deriveBits',
    'deriveKey',
  ])

  const verificador = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: new TextEncoder().encode(INFO_VERIFICADOR),
    },
    hkdf,
    256,
  )

  const envoltorio = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: new TextEncoder().encode(INFO_ENVOLTORIO),
    },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )

  return { verificador: toBase64(verificador), envoltorio }
}

/** Mete la contraseña de la cuenta en el sobre. */
export async function wrapSecret(key: CryptoKey, secret: string): Promise<WrappedSecret> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(secret),
  )
  return { iv: toBase64(iv.buffer as ArrayBuffer), secreto: toBase64(ciphertext) }
}

/**
 * Abre el sobre. Devuelve null si la clave no es la que lo cerró.
 *
 * En la práctica esto no debería fallar nunca: para recibir el sobre hay que
 * haber pasado el verificador, que sale del mismo PIN. Si falla es que la
 * bóveda se escribió a medias, y devolver null permite decirlo con esas
 * palabras en vez de reventar con un error de criptografía.
 */
export async function unwrapSecret(
  key: CryptoKey,
  wrapped: WrappedSecret,
): Promise<string | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(wrapped.iv) as BufferSource },
      key,
      fromBase64(wrapped.secreto) as BufferSource,
    )
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}
