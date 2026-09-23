/**
 * Contra qué URL habla el worker con Supabase, y cómo se cuenta cuando no
 * puede.
 *
 * Existe porque las dos preguntas se estaban contestando de dos maneras en el
 * mismo contenedor, y de ahí salían dos síntomas que no parecían el mismo
 * fallo:
 *
 *  - `admin-user.ts` mira `SUPABASE_URL` y, si no está, `SUPABASE_UPSTREAM` —el
 *    host:puerto de Kong en la red interna, que es el que ya usa el Caddyfile—.
 *    El resto del worker miraba solo `SUPABASE_URL`. En un despliegue sobre
 *    plataforma, donde la imagen de la PWA lleva el worker dentro y la variable
 *    que hay es `SUPABASE_UPSTREAM`, eso significa que la orden de consola
 *    encuentra la API y el worker no.
 *
 *  - Y cuando no la encuentra, `supabase-js` **no lanza**: devuelve el fallo de
 *    red en `error`, igual que devolvería «este token no vale». El código lo
 *    leía como lo segundo y contestaba «La sesión no vale o ha caducado» a quien
 *    tenía la sesión perfectamente. Se manda a mirar el sitio equivocado: el
 *    técnico cierra sesión, vuelve a entrar, y pasa lo mismo.
 *
 * Son dos problemas distintos y se arreglan en sitios distintos, así que hay
 * que poder distinguirlos desde la pantalla.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** Una URL candidata, con el nombre de la variable de la que salió. */
export interface Candidata {
  url: string
  de: string
}

function conEsquema(v: string): string {
  return /^https?:\/\//.test(v) ? v : `http://${v}`
}

/**
 * Por dónde se puede intentar llegar a la API, en orden de preferencia.
 *
 * Son dos y **las dos se prueban**, que es la diferencia entre que esto
 * funcione solo y que haya que entrar al servidor a cambiar una variable:
 *
 *  - `SUPABASE_URL`, si está. Es la explícita y va primero.
 *  - `SUPABASE_UPSTREAM`, el host:puerto de Kong en la red interna. Es la que
 *    el Caddyfile ya usa para hacer de proxy de `/rest/*`, o sea **una que se
 *    sabe que llega**: si la aplicación carga datos, esa dirección responde.
 *
 * Que haya dos no es redundancia: en un despliegue sobre plataforma, con el
 * worker dentro de la imagen de la PWA, es fácil que `SUPABASE_URL` acabe
 * apuntando al dominio público —que desde dentro del contenedor no tiene por
 * qué resolver— mientras `SUPABASE_UPSTREAM` apunta al vecino de al lado. Con
 * una sola, eso es un servicio caído; con las dos, un reintento.
 *
 * Y no es un agujero: las dos las escribe quien despliega, no quien llama.
 */
export function urlsDeLaApi(): Candidata[] {
  const out: Candidata[] = []
  const explicita = process.env['SUPABASE_URL']
  if (explicita) out.push({ url: explicita, de: 'SUPABASE_URL' })
  const upstream = process.env['SUPABASE_UPSTREAM']
  if (upstream) {
    const url = conEsquema(upstream)
    if (!out.some((c) => c.url === url)) out.push({ url, de: 'SUPABASE_UPSTREAM' })
  }
  return out
}

/** La primera, que es contra la que se intenta antes de nada. */
export function urlDeLaApi(): string {
  return urlsDeLaApi()[0]?.url ?? ''
}

/** De qué variable ha salido, para poder señalarla cuando es la equivocada. */
export function variableDeLaUrl(): string {
  return urlsDeLaApi()[0]?.de ?? 'SUPABASE_URL'
}

/**
 * ¿Este fallo es «no se ha podido ni preguntar»?
 *
 * `supabase-js` envuelve el fallo de red en un error propio y por el camino se
 * deja el `cause` donde Node guarda el motivo, así que lo único que queda es el
 * texto. `fetch failed` es lo que dice Node; los demás son los códigos que
 * asoman cuando alguien los deja pasar.
 */
export function esFalloDeRed(err: unknown): boolean {
  const m =
    typeof err === 'string' ? err : ((err as { message?: string } | null)?.message ?? '')
  return /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|network|Failed to fetch|Load failed/i.test(
    m,
  )
}

/** Qué ha pasado al preguntar quién es quien llama. */
export type Sesion =
  | { que: 'vale'; id: string }
  /** El token no sirve: caducado, de otro sitio, o de una cuenta borrada. */
  | { que: 'no vale' }
  /** No se ha podido preguntar. Es un problema del servidor, no de quien llama. */
  | { que: 'sin respuesta'; motivo: string }

/**
 * Quién es quien llama, distinguiendo «ha dicho que no» de «no ha contestado».
 *
 * Es toda la razón de ser de este módulo: las dos cosas llegan como `error` y
 * confundirlas manda a la persona equivocada a arreglar lo que no es.
 */
export async function deQuienEsLaSesion(
  supabase: SupabaseClient,
  jwt: string,
): Promise<Sesion> {
  const { data, error } = await supabase.auth.getUser(jwt)
  if (error) {
    if (esFalloDeRed(error)) return { que: 'sin respuesta', motivo: error.message }
    return { que: 'no vale' }
  }
  if (!data.user) return { que: 'no vale' }
  return { que: 'vale', id: data.user.id }
}

/**
 * El cliente que de verdad llega a la API, probando las dos direcciones.
 *
 * La comprobación es `/auth/v1/health`, que no necesita clave y contesta en un
 * milisegundo por la red interna. Se hace **una sola vez** y se recuerda: a
 * partir de ahí es el cliente de siempre, sin coste por petición.
 *
 * Si ninguna llega, se devuelve el motivo de la primera, que es la que quien
 * despliega creía que valía y por tanto la que hay que mirar.
 */
let recordado: { admin: SupabaseClient; de: string } | null = null

export async function apiQueResponde(
  crear: (url: string) => SupabaseClient,
): Promise<{ ok: true; admin: SupabaseClient; de: string } | { ok: false; motivo: string }> {
  if (recordado) return { ok: true, ...recordado }

  const candidatas = urlsDeLaApi()
  if (candidatas.length === 0) {
    return { ok: false, motivo: 'no hay ni SUPABASE_URL ni SUPABASE_UPSTREAM' }
  }

  const fallos: string[] = []
  for (const c of candidatas) {
    try {
      const res = await fetch(`${c.url.replace(/\/+$/, '')}/auth/v1/health`, {
        signal: AbortSignal.timeout(5000),
      })
      // Cualquier respuesta vale: lo que se comprueba es que HAY alguien, no
      // que le guste la pregunta. Un 401 de Kong también dice «estoy aquí».
      if (res.status > 0) {
        recordado = { admin: crear(c.url), de: c.de }
        if (c.de !== candidatas[0]!.de) {
          console.warn(
            `[api] ${candidatas[0]!.de} (${candidatas[0]!.url}) no responde; ` +
              `se usa ${c.de} (${c.url}).`,
          )
        }
        return { ok: true, ...recordado }
      }
    } catch (e) {
      fallos.push(`${c.de} (${c.url}): ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { ok: false, motivo: fallos.join(' · ') }
}

/** El texto que se le enseña a quien pulsó, cuando no se ha podido preguntar. */
export function noSeHaPodidoPreguntar(motivo: string): string {
  return (
    `El servidor no ha podido comprobar la sesión contra Supabase (${motivo}). ` +
    `No es tu sesión: es que no llega a la API en ${urlDeLaApi() || '(sin URL)'}, ` +
    `de ${variableDeLaUrl()}. Cerrar sesión y volver a entrar no lo arregla.`
  )
}
