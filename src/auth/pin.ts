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
 */

const PBKDF2_ITERATIONS = 310_000
const SALT_BYTES = 16
const IV_BYTES = 12

export const MIN_PIN_LENGTH = 4
export const MAX_PIN_LENGTH = 8
export const MAX_PIN_ATTEMPTS = 5

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
