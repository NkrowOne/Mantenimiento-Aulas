/**
 * Cuándo una fila del libro puede dar de alta su aula sola, y cuándo no.
 *
 * El libro trae aulas que el maestro no tiene —23 de Sócrates y 20 de Antonio
 * Gaudí en la última pasada— y hasta ahora cada una era una duda que alguien
 * tenía que contestar a mano, una por una, pasada tras pasada. Crearlas solas
 * es lo que pide el trabajo, pero crear una sala equivocada es caro de deshacer:
 * las incidencias se reparten entre la buena y la inventada, y ninguna de las
 * dos tiene el histórico entero.
 *
 * Por eso esto no intenta adivinar. Solo deja pasar lo que **no se puede leer
 * de dos maneras**: un código de la nomenclatura del campus (`2.6`, `-1.3`,
 * `0.1P`) en un edificio que el maestro ya conoce. Todo lo demás —«Aula Demo»,
 * «Sala Vip», «Laboratorio 9»— sigue siendo una duda, porque ahí una errata es
 * invisible: nadie puede mirar «Sala Vip» y decir si falta o si es la «SALA
 * VIP» que ya existe escrita de otra forma.
 *
 * La regla del campus, medida sobre las 276 salas del maestro: el código es
 * `<planta>.<número>` y el sufijo de letras, cuando lo hay, es el código del
 * edificio (`0.1P` es la 0.1 del edificio P). El primer número es la planta en
 * 162 de las 185 salas que siguen ese formato; las 23 excepciones son los
 * `MÓDULO n` del Edificio Central y los `1.x-` del CRAI, que viven en la
 * `PLANTA -1`. Por eso la planta se LEE de la columna del libro siempre que
 * venga, y solo se deduce cuando la fila no la trae.
 */

import { canonicalZone, norm } from './normalize'

/** Un aula que el libro trae, el maestro no tiene, y se puede crear sin dudar. */
export interface SalaQueSePuedeCrear {
  /** El código con el que se creará, sin el sufijo del edificio. */
  code: string
  /** La planta donde va, con el nombre que usa el maestro. */
  zona: string
  /**
   * `true` si la planta sale del código y no de la columna del libro.
   *
   * Se dice en pantalla y se guarda en el aviso: una planta leída es un dato y
   * una deducida es una apuesta, y quien revisa la lista tiene derecho a saber
   * cuáles son cuáles antes de dar el visto bueno.
   */
  plantaDeducida: boolean
}

/**
 * El código de aula del campus: `2.6`, `-1.3`, `0.10`, con el sufijo opcional
 * del edificio pegado o separado (`0.1P`, `2.6 S`).
 *
 * Dos dígitos como mucho en cada lado: `1.1` y `2.10` existen, `1.2345` no, y
 * dejar pasar cualquier longitud convertiría un número de serie mal pegado en
 * un aula nueva.
 */
const CODIGO = /^(-?\d{1,2})\.(\d{1,2})\s*([A-ZÑ]{1,4})?$/

/** `1` → `1ª PLANTA`. Los nombres son los que el maestro ya usa en 15 edificios. */
function plantaDelNumero(n: number): string | null {
  if (n === 0) return 'PLANTA BAJA'
  if (n < 0) return `PLANTA ${n}`
  if (n >= 1 && n <= 9) return `${n}ª PLANTA`
  return null
}

/**
 * ¿Puede esta fila crear su aula sin preguntar?
 *
 * @param aula        lo que dice la columna «AULAS», tal cual.
 * @param zonaDelLibro lo que dice la columna «PLANTA/MÓDULO», ya arrastrada.
 * @param edificioCodigo el código del edificio del maestro al que cruzó la fila.
 * @returns el alta, o `null` si esta fila tiene que seguir siendo una duda.
 */
export function salaQueSePuedeCrear(
  aula: string,
  zonaDelLibro: string,
  edificioCodigo: string,
): SalaQueSePuedeCrear | null {
  const m = CODIGO.exec(norm(aula))
  if (!m) return null

  const planta = m[1]!
  const numero = m[2]!
  const sufijo = m[3] ?? ''

  /*
   * El sufijo tiene que ser el edificio de la fila, si lo lleva.
   *
   * `2.6 S` en una fila del edificio S es la 2.6 de Sócrates. `2.6 H` en esa
   * misma fila es una contradicción —el código dice un edificio y la columna
   * dice otro— y crear cualquiera de los dos es crear la sala equivocada en la
   * mitad de los casos. Se devuelve a la duda, que es donde alguien la mira.
   */
  if (sufijo !== '' && norm(sufijo) !== norm(edificioCodigo)) return null

  const code = `${planta}.${numero}`

  const delLibro = canonicalPlanta(zonaDelLibro)
  if (delLibro !== 'SIN ZONA') {
    return { code, zona: delLibro, plantaDeducida: false }
  }

  // Sin planta en el libro: la del código, y solo si es una de las normales.
  const deducida = plantaDelNumero(Number(planta))
  if (deducida === null) return null
  return { code, zona: deducida, plantaDeducida: true }
}

/**
 * El nombre de planta del maestro para lo que escribe el libro.
 *
 * El libro dice `PLANTA 1` y `PLANTA 2`; el maestro dice `1ª PLANTA` y `2ª
 * PLANTA` en los quince edificios que tienen plantas numeradas. Son la misma
 * planta, y sin esto `sync_mover_sala` no encuentra la del maestro y crea una
 * segunda con el nombre del libro: el mismo edificio con «PLANTA 2» y «2ª
 * PLANTA» a la vez, y las aulas repartidas entre las dos.
 *
 * No toca lo que no reconoce: `MÓDULO 3`, `AULAS MSI`, `LABORATORIO H` y
 * `POLIVALENTES` son nombres propios de una planta, no una forma de escribir
 * un número, y traducirlos sería inventarse una planta que nadie ha pedido.
 *
 * Se apoya en `canonicalZone`, que ya arreglaba las tildes —`norm()` deja
 * `MODULO` y el maestro dice `MÓDULO`— pero que hasta ahora solo usaba el
 * script de importación. La sincronización nunca pasó por ahí, y por eso
 * `PLANTA 2` llegaba tal cual al servidor: diecisiete filas en cuarentena
 * diciendo que no era ninguna planta de ese edificio.
 */
export function canonicalPlanta(raw: string): string {
  const n = canonicalZone(raw)
  if (n === 'SIN ZONA') return n

  // `PLANTA 0` y `PLANTA BAJA` son la de la calle. `BAJA` delante porque el
  // `\d+` de abajo no casa con ella y la dejaría pasar sin tocar, que también
  // sería correcto, pero así se lee la intención.
  if (/^PLANTA\s+BAJA$/.test(n)) return 'PLANTA BAJA'

  const m = /^PLANTA\s+(-?\d{1,2})$/.exec(n)
  if (m) {
    const deducida = plantaDelNumero(Number(m[1]))
    if (deducida !== null) return deducida
  }

  // `2º PLANTA` con la ordinal masculina, que es una errata de teclear.
  return n.replace(/^(\d{1,2})º\s+PLANTA$/, '$1ª PLANTA')
}
