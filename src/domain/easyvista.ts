/**
 * El código de EasyVista de un parte: cómo se guarda y qué se le exige.
 *
 * Cada avería que atiende el equipo tiene, además del número del libro
 * (`external_ref`, que lo pone la base), un ticket en EasyVista —el sistema de
 * incidencias de la organización—. Ese código no llega siempre a la vez que la
 * avería: a veces se tiene al abrirla, a veces al cerrarla y a veces días
 * después, con la incidencia ya resuelta. Por eso se escribe por tres puertas
 * distintas, y por eso la regla de qué es un código válido vive aquí, una sola
 * vez, y no en cada formulario.
 *
 * Se exige poco a propósito. EasyVista numera «I260916_0042», pero no se ha
 * visto el catálogo entero de sus prefijos y una regla estricta rechazaría el
 * código de verdad el día que cambie. Lo que sí: sin espacios dentro, que cabe
 * en una etiqueta, y en mayúsculas para que la búsqueda no dependa de cómo se
 * tecleó. La base aplica exactamente la misma regla
 * (`normalizar_codigo_easyvista` e `incidents_easyvista_ref_formato`).
 */

/** Lo más largo que se acepta. Sobra para cualquier numeración razonable. */
export const CODIGO_EASYVISTA_MAX = 40

/**
 * El código tal y como se guarda: recortado y en mayúsculas. `null` si no hay
 * nada escrito, que es lo normal — la mayoría de los partes se abren antes de
 * tener ticket.
 */
export function normalizarCodigoEasyVista(texto: string | null | undefined): string | null {
  const limpio = (texto ?? '').trim().toUpperCase()
  return limpio === '' ? null : limpio
}

/**
 * Qué le pasa al código, dicho para leerlo en pantalla. `null` si vale (y vacío
 * vale: el código es opcional en las tres puertas).
 *
 * Devuelve el mensaje y no un booleano por lo mismo que la explicación del
 * cierre: un botón que no hace nada sin decir por qué se lee como una
 * aplicación rota.
 */
export function problemaDeCodigoEasyVista(texto: string): string | null {
  const limpio = texto.trim()
  if (limpio === '') return null
  if (/\s/.test(limpio)) return 'El código de EasyVista no lleva espacios.'
  if (limpio.length > CODIGO_EASYVISTA_MAX) {
    return `Un código de EasyVista no pasa de ${CODIGO_EASYVISTA_MAX} caracteres.`
  }
  return null
}
