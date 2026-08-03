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

/**
 * Las llaves del sobre: una pareja ECDH P-256.
 *
 * Existen por un fallo que costó dispositivos enteros: el sobre se cifraba
 * directamente con el PIN, así que solo podía REESCRIBIRSE teniendo el PIN a
 * mano. Tras recargar, el PIN ya no estaba en memoria; el token se renovaba
 * —GoTrue rota el refresh token en cada renovación y revoca el anterior— y el
 * sobre se quedaba congelado con el token viejo. Al cerrar sesión y volver a
 * entrar, el PIN abría el sobre… y dentro había un token que el servidor ya
 * había revocado. Peor: presentarlo hacía que GoTrue revocara la familia
 * entera. «Tu PIN es correcto, pero el servidor ya no acepta esta sesión», y
 * el dispositivo muerto hasta pedir otro código de alta.
 *
 * Con una pareja de llaves, sellar y abrir se separan: se SELLA con la
 * pública, que va en claro y no necesita PIN — cualquier renovación del token
 * puede dejar el sobre al día, haya pasado lo que haya pasado con la pestaña.
 * Se ABRE con la privada, que viaja cifrada con el PIN. El PIN protege
 * exactamente lo mismo que antes; lo único que cambia es que mantener el sobre
 * fresco ya no lo necesita.
 */
export interface LlavesDeSobre {
  /** Pública P-256 (formato raw, base64). Con ella se sella, sin PIN. */
  pub: string
  /** Privada (PKCS#8) cifrada con la clave derivada del PIN. */
  priv: { salt: string; iv: string; data: string }
}

export interface SealedSession {
  /** Presente en el formato asimétrico. Los sobres antiguos no lo llevan. */
  v?: 2
  llaves?: LlavesDeSobre
  /** Pública efímera del último sellado (raw, base64). Solo v2. */
  eph?: string
  iv: string
  ciphertext: string
  /** Sal del cifrado directo con el PIN. Solo sobres antiguos (v1). */
  salt?: string
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

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const

/**
 * Genera las llaves del sobre y deja la privada bajo el PIN.
 *
 * Se llama una vez por alta (y una más al migrar un sobre antiguo). El PIN no
 * se guarda: si es incorrecto, descifrar la privada falla — AES-GCM está
 * autenticado — y eso ES la comprobación del PIN.
 */
export async function crearLlaves(pin: string): Promise<LlavesDeSobre> {
  const pareja = await crypto.subtle.generateKey(ECDH, true, ['deriveKey'])
  const pub = await crypto.subtle.exportKey('raw', pareja.publicKey)
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pareja.privateKey)

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const llaveDelPin = await deriveKey(pin, salt)
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    llaveDelPin,
    pkcs8,
  )

  return {
    pub: toBase64(pub),
    priv: {
      salt: toBase64(salt.buffer as ArrayBuffer),
      iv: toBase64(iv.buffer as ArrayBuffer),
      data: toBase64(data),
    },
  }
}

/**
 * Sella la sesión con la llave PÚBLICA del sobre: no necesita el PIN, y por
 * eso puede llamarse en cada renovación del token, que es lo que mantiene el
 * sobre siempre al día. Cifrado ECIES de manual: pareja efímera + ECDH con la
 * pública del sobre + AES-GCM con la clave compartida.
 */
export async function sealSession(
  llaves: LlavesDeSobre,
  session: unknown,
  hint: SealedSession['hint'],
): Promise<SealedSession> {
  const pub = await crypto.subtle.importKey('raw', fromBase64(llaves.pub) as BufferSource, ECDH, false, [])
  const efimera = await crypto.subtle.generateKey(ECDH, false, ['deriveKey'])
  const clave = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: pub },
    efimera.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    clave,
    new TextEncoder().encode(JSON.stringify(session)),
  )

  return {
    v: 2,
    llaves,
    eph: toBase64(await crypto.subtle.exportKey('raw', efimera.publicKey)),
    iv: toBase64(iv.buffer as ArrayBuffer),
    ciphertext: toBase64(ciphertext),
    hint,
  }
}

/**
 * Descifra la sesión. Devuelve null si el PIN es incorrecto — AES-GCM está
 * autenticado, así que un PIN erróneo hace que el descifrado falle, no que
 * produzca basura.
 *
 * Abre los dos formatos: el asimétrico (v2) y el antiguo, cifrado directo con
 * el PIN, que es el que llevan los dispositivos dados de alta antes de este
 * cambio. Quien desbloquea uno antiguo lo migra (ver `unlockWithPin`).
 */
export async function openSession<T = unknown>(
  pin: string,
  sealed: SealedSession,
): Promise<T | null> {
  try {
    if (sealed.llaves && sealed.eph) {
      const llaveDelPin = await deriveKey(pin, fromBase64(sealed.llaves.priv.salt))
      const pkcs8 = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(sealed.llaves.priv.iv) as BufferSource },
        llaveDelPin,
        fromBase64(sealed.llaves.priv.data) as BufferSource,
      )
      const priv = await crypto.subtle.importKey('pkcs8', pkcs8, ECDH, false, ['deriveKey'])
      const eph = await crypto.subtle.importKey('raw', fromBase64(sealed.eph) as BufferSource, ECDH, false, [])
      const clave = await crypto.subtle.deriveKey(
        { name: 'ECDH', public: eph },
        priv,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
      )
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(sealed.iv) as BufferSource },
        clave,
        fromBase64(sealed.ciphertext) as BufferSource,
      )
      return JSON.parse(new TextDecoder().decode(plain)) as T
    }

    // Sobre antiguo: AES-GCM con la clave derivada del PIN, tal cual.
    const key = await deriveKey(pin, fromBase64(sealed.salt ?? ''))
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
