/**
 * ¿Hay que volver a bajar el espejo?
 *
 * El servidor contesta a `espejo_version()` con un sello por cada fuente del
 * espejo (ver la migración del 23 de septiembre). Si es el mismo que el que
 * se guardó tras la última bajada completa, no ha cambiado nada y no hay que
 * pedir nueve tablas para descubrirlo. Aquí solo está la decisión, sin red ni
 * base, para poder probarla.
 */

/**
 * Cada cuánto se baja entero aunque el servidor diga que nada cambió.
 *
 * La comparación por sellos tiene una grieta de milisegundos: una transacción
 * que empezó antes y confirmó después de leer la versión no la mueve. Media
 * hora acota lo que puede tardar en verse un cambio que cayera justo ahí, sin
 * volver al gasto de antes (era cada dos minutos).
 */
export const REFRESCO_COMPLETO_MS = 30 * 60 * 1000

export interface VersionGuardada {
  /** La respuesta del servidor, serializada, tal y como se comparó. */
  version: string
  /** Cuándo terminó la bajada completa que la dejó guardada. */
  at: number
}

/**
 * La respuesta del servidor convertida en algo comparable. `null` si no es un
 * objeto: un servidor sin la migración contesta con un error y aquí llega
 * `null`, que significa «no se sabe» y se resuelve bajando, como siempre.
 */
export function claveDeVersion(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const o = data as Record<string, unknown>
  const ordenado: Record<string, unknown> = {}
  for (const k of Object.keys(o).sort()) ordenado[k] = o[k]
  return JSON.stringify(ordenado)
}

export function hayQueBajar(
  servidor: string | null,
  guardada: VersionGuardada | null | undefined,
  ahora: number,
): boolean {
  // Sin versión del servidor no hay con qué comparar: se baja.
  if (servidor === null) return true
  // Nunca se guardó una bajada completa: se baja.
  if (!guardada) return true
  if (guardada.version !== servidor) return true
  // Igual, pero la red de seguridad manda una entera de vez en cuando.
  return ahora - guardada.at >= REFRESCO_COMPLETO_MS
}
