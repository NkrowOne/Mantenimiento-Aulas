/**
 * La chapa de un edificio: un monograma para cada uno, generado.
 *
 * Todas las chapas eran la misma: un cuadrado teñido con el código en
 * monoespaciada. Diecisiete cuadrados iguales no identifican nada —hay que leer
 * el código de cada uno—, y el conjunto se ve como lo que es: una plantilla.
 *
 * Esto decide, para cada edificio, tres cosas:
 *
 *   - **la letra**: recta, inclinada o pesada. Siempre gruesa y siempre en el
 *     centro;
 *   - **el detalle**: ninguno, una base, una franja al lado o un arco en la
 *     esquina. Uno solo;
 *   - **el fondo**: el color de la aplicación o su tono hondo. La letra, blanca
 *     siempre.
 *
 * **Poco, y a propósito.** La primera versión variaba mucho más: letras de
 * contorno, finas y estrechas, rótulos en vertical, a sangre, apilados, puntos,
 * rayas, cuatro tintas. Cada chapa por separado tenía gracia; las dieciocho
 * juntas, en una lista, eran un muestrario, y quien lo usa lo dijo con una
 * palabra: caótico. Las que gustaron tenían todas lo mismo —la letra gruesa en
 * el centro y un único gesto—, y eso es lo que ha quedado. Una familia se
 * reconoce porque comparte casi todo: aquí se comparte la tipografía, el
 * color, la colocación y la forma, y lo que cambia es la inclinación, el peso y
 * dónde va el detalle.
 *
 * La letra blanca es también petición de quien lo usa. Había una tinta
 * «teñida» —letra de color sobre fondo claro— y, mezclada con las llenas, la
 * lista alternaba chapas oscuras y claras sin que eso significara nada. Con la
 * letra siempre blanca todas pesan lo mismo, y lo que distingue a una de otra
 * es su forma.
 *
 * **Sale del código y del nombre, y de nada más.** No se guarda en ningún
 * sitio: es una función pura de lo que el edificio ya dice de sí mismo. Así
 *
 *   - un edificio nuevo tiene su chapa en el instante en que se crea, sin que
 *     nadie la diseñe;
 *   - si cambia su sigla o su nombre, cambia su chapa —es otro rótulo—;
 *   - y todos los dispositivos pintan la misma sin tener que sincronizar nada.
 *
 * Vive en `domain` y sin React para poder probar justo eso.
 */

import { norm } from './normalize'

export type LetraDeMonograma = 'recta' | 'inclinada' | 'pesada'

export type DetalleDeMonograma = 'liso' | 'base' | 'franja' | 'arco'

/** El fondo, porque la letra es siempre blanca: el color, o su tono hondo. */
export type TintaDeMonograma = 'llena' | 'honda'

export interface Monograma {
  /** Lo que se escribe: el código, sin espacios. */
  texto: string
  letra: LetraDeMonograma
  detalle: DetalleDeMonograma
  tinta: TintaDeMonograma
}

const LETRAS: readonly LetraDeMonograma[] = ['recta', 'inclinada', 'pesada']

/** La base y la franja van dos veces: son el gesto más claro, y el que más gustó. */
const DETALLES: readonly DetalleDeMonograma[] = ['base', 'franja', 'arco', 'liso', 'base', 'franja']

const TINTAS: readonly TintaDeMonograma[] = ['llena', 'honda']

/**
 * FNV-1a de 32 bits con el batido final de MurmurHash3. No hace falta nada
 * criptográfico: solo que dos textos parecidos —«AYD1» y «AYD2»— den números
 * que no se parezcan, y que el mismo texto dé siempre el mismo número en
 * cualquier dispositivo. El batido es por los bits bajos, que FNV deja poco
 * mezclados con textos cortos y que es de donde sale cada elección.
 */
function huella(texto: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

export function monogramaDeEdificio(code: string, name: string | null | undefined = ''): Monograma {
  // Lo que se escribe: sin espacios, y con un guion si no hay código que poner.
  const texto = norm(code).replace(/\s+/g, '') || '–'

  // Cada elección sale de su propia huella. Sacarlas todas de un mismo número
  // las ata entre sí: los edificios con la misma letra tendrían siempre el
  // mismo detalle, y la variedad sería la mitad de la que parece.
  const semilla = `${texto}|${norm(name)}`
  const elige = <T>(cual: string, entre: readonly T[], siNada: T): T =>
    entre[huella(`${cual}:${semilla}`) % entre.length] ?? siNada

  return {
    texto,
    letra: elige('letra', LETRAS, 'recta'),
    detalle: elige('detalle', DETALLES, 'liso'),
    tinta: elige('tinta', TINTAS, 'llena'),
  }
}
