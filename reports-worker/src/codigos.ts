/**
 * El código de alta: cómo se genera, cómo se guarda y qué hay que mirar antes.
 *
 * Vive aparte porque ahora lo usan dos sitios —la orden de consola y el botón
 * de la pantalla de Usuarios— y la cabecera de `admin-user.ts` ya avisaba de lo
 * que pasa si se copia: «dos copias del alfabeto de los códigos, de su hash y
 * de su caducidad se separan en cuanto una de las dos cambie, y el síntoma
 * sería un código que la aplicación no reconoce». Con una sola copia no puede
 * pasar.
 *
 * Aquí no hay `process.exit` ni `console.log` a propósito: la consola sale por
 * un lado y la pantalla por otro, y quien decide cómo se cuenta un fallo es
 * quien llama. Esto solo hace el trabajo y devuelve lo que ha pasado.
 */

import { createHash, randomInt } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { MAX_DISPOSITIVOS } from './alta.js'

/** Horas que dura un código antes de caducar. */
export const CODE_TTL_HOURS = 24

/**
 * Alfabeto sin caracteres confundibles: nada de O/0, I/1/l, S/5.
 * El código se dicta en voz alta o se apunta en un papel, y un carácter ambiguo
 * se traduce en una llamada al admin.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ2346789'

export function generateCode(): string {
  const pick = (): string => ALPHABET[randomInt(ALPHABET.length)]!
  const group = (): string => Array.from({ length: 4 }, pick).join('')
  return `${group()}-${group()}-${group()}`
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

/** Un dispositivo dado de alta que sigue vivo. */
export interface Dispositivo {
  id: string
  label: string | null
  user_agent: string | null
  enrolled_at: string | null
  last_seen_at: string | null
}

/** Los dispositivos vivos de una cuenta. */
export async function dispositivosDe(
  admin: SupabaseClient,
  profileId: string,
): Promise<Dispositivo[]> {
  const { data, error } = await admin
    .from('devices')
    .select('id, label, user_agent, enrolled_at, last_seen_at')
    .eq('profile_id', profileId)
    .is('revoked_at', null)
    .order('enrolled_at')
  if (error) throw new Error(error.message)
  return (data ?? []) as Dispositivo[]
}

/**
 * Cuántos APARATOS hay, que no es lo mismo que cuántas filas.
 *
 * En iOS, Safari, la PWA instalada y los demás navegadores del mismo aparato
 * comparten user-agent, y contarlos por separado gastaría el cupo entero en un
 * solo iPhone. Es el criterio del canje, así que contar filas aquí daría un
 * número distinto del que decide si el código va a servir.
 */
export function cuantosAparatos(dispositivos: Dispositivo[]): number {
  return new Set(dispositivos.map((d) => d.user_agent ?? '')).size
}

/** Guarda el hash del código y anula el anterior, que deja de valer. */
export async function guardarCodigoNuevo(
  admin: SupabaseClient,
  profileId: string,
  code: string,
): Promise<void> {
  await admin
    .from('enrollment_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('profile_id', profileId)
    .is('consumed_at', null)

  const expires = new Date(Date.now() + CODE_TTL_HOURS * 3600_000)
  const { error } = await admin.from('enrollment_codes').insert({
    profile_id: profileId,
    code_hash: hashCode(code),
    expires_at: expires.toISOString(),
  })
  if (error) throw new Error(error.message)
}

/** Lo que ha pasado al emitir un código, para que lo cuente quien llame. */
export interface CodigoEmitido {
  code: string
  /** Cuándo deja de valer, en ISO. */
  caduca: string
  /** Filas de `devices` vivas. */
  dispositivos: number
  /** Aparatos distintos, que es lo que mira el canje. */
  aparatos: number
  /**
   * `true` si el canje va a rechazar este código por cupo lleno.
   *
   * Es la diferencia entre un código que sirve y uno que no, y no se ve por
   * ningún otro lado: `/alta/canjear` contesta 403 antes de mirar el código.
   */
  cupoLleno: boolean
}

/**
 * Emite un código nuevo para una cuenta que ya existe.
 *
 * La contraseña solo se toca cuando la cuenta **no tiene ningún dispositivo**.
 * No es una optimización: cambiar la contraseña de un usuario revoca sus
 * sesiones, así que hacerlo con aparatos conectados echaría de la aplicación a
 * quien no ha pedido nada. Lo explica entero la cabecera de `alta.ts`.
 */
export async function emitirCodigo(
  admin: SupabaseClient,
  profileId: string,
): Promise<CodigoEmitido> {
  const code = generateCode()

  const dispositivos = await dispositivosDe(admin, profileId)
  const aparatos = cuantosAparatos(dispositivos)

  if (dispositivos.length === 0) {
    const { error } = await admin.auth.admin.updateUserById(profileId, { password: code })
    if (error) throw new Error(error.message)
  }

  await guardarCodigoNuevo(admin, profileId, code)

  return {
    code,
    caduca: new Date(Date.now() + CODE_TTL_HOURS * 3600_000).toISOString(),
    dispositivos: dispositivos.length,
    aparatos,
    cupoLleno: aparatos >= MAX_DISPOSITIVOS,
  }
}
