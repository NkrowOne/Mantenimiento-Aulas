/**
 * Buscar un artículo del almacén por lo que se teclea.
 *
 * Lo que había devolvía los SEIS primeros y solo miraba el nombre. Con «HDMI»
 * hay más de seis cables, y el que se había gastado podía ser el séptimo: no
 * salía, y no había forma de llegar a él sin adivinar cómo se escribía entero.
 * Ahora salen todos y la lista desplaza.
 *
 * Y tres cosas que con todos a la vista pasan a importar:
 *
 *  - **Los alias también cuentan.** Un artículo renombrado se sigue encontrando
 *    por el nombre de antes, que es el que tiene en la cabeza quien lleva años
 *    pidiéndolo así. Se devuelve cuál ha coincidido, para enseñarlo: si no, un
 *    resultado que no se parece a lo tecleado parece un error.
 *  - **Por palabras, en cualquier orden.** «hdmi 5» encuentra «Cable HDMI 5 m».
 *    Buscar la frase entera obligaba a acertar el orden y los espacios.
 *  - **El orden.** Primero los que EMPIEZAN por lo tecleado, luego los que lo
 *    llevan tal cual, luego los que tienen las palabras sueltas y al final los
 *    que solo coinciden por un nombre antiguo. Dentro de cada grupo,
 *    alfabético con los números en su sitio: «2 m» antes que «10 m».
 */

import { norm } from '@/domain/normalize'

/** Lo mínimo de un artículo para poder buscarlo. */
export interface ArticuloBuscable {
  name: string
  aliases?: readonly string[] | null
}

/** Un resultado: el artículo y, si ha salido por un nombre antiguo, cuál. */
export interface Encontrado<T> {
  articulo: T
  /** El alias que ha coincidido, o `null` si ha coincidido el nombre. */
  alias: string | null
}

/**
 * Todos los artículos que coinciden con `texto`, del más al menos probable.
 *
 * Sin tope a propósito: la lista la recorta quien la pinta, con una caja que
 * desplaza, y no esto. Un tope aquí es exactamente el fallo que se arregla.
 */
export function buscarArticulos<T extends ArticuloBuscable>(
  articulos: readonly T[],
  texto: string,
): Array<Encontrado<T>> {
  const q = norm(texto)
  if (!q) return []
  const palabras = q.split(' ')
  const todas = (en: string): boolean => palabras.every((p) => en.includes(p))

  const puntuados: Array<Encontrado<T> & { rango: number }> = []
  for (const articulo of articulos) {
    const nombre = norm(articulo.name)
    if (todas(nombre)) {
      const rango = nombre.startsWith(q) ? 0 : nombre.includes(q) ? 1 : 2
      puntuados.push({ articulo, alias: null, rango })
      continue
    }
    const alias = (articulo.aliases ?? []).find((a) => todas(norm(a)))
    if (alias !== undefined) puntuados.push({ articulo, alias, rango: 3 })
  }

  return puntuados
    .sort(
      (a, b) =>
        a.rango - b.rango ||
        a.articulo.name.localeCompare(b.articulo.name, 'es', { numeric: true, sensitivity: 'base' }),
    )
    .map(({ articulo, alias }) => ({ articulo, alias }))
}
