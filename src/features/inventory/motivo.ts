/**
 * El motivo de una retirada o de una baja del almacén.
 *
 * Quitar algo del almacén deja un hueco que alguien tendrá que explicar dentro
 * de un año, así que se pide un motivo y se pide con un mínimo: «roto» no dice
 * nada a quien lo lea entonces. La base lo comprueba igual
 * (`motivo_obligatorio()` en la migración del 23 de septiembre); aquí solo se
 * evita mandar algo que va a volver rechazado, y se le dice a quien escribe
 * cuánto le falta.
 */

/** Caracteres mínimos, sin contar los espacios de los extremos. */
export const MOTIVO_MIN = 10

export function motivoValido(texto: string): boolean {
  return texto.trim().length >= MOTIVO_MIN
}

/** Cuántos caracteres faltan para que el motivo valga; 0 si ya vale. */
export function faltanParaElMotivo(texto: string): number {
  return Math.max(0, MOTIVO_MIN - texto.trim().length)
}
