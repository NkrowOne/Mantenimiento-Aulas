/**
 * La chapa de un edificio: un monograma distinto para cada uno, generado.
 *
 * Todas las chapas eran la misma: un cuadrado teñido con el código en
 * monoespaciada. Diecisiete cuadrados iguales no identifican nada —hay que leer
 * el código de cada uno—, y el conjunto se ve como lo que es: una plantilla. Un
 * edificio se reconoce antes por su FORMA que por su letra, igual que una línea
 * de metro se reconoce por su color antes de leer el número.
 *
 * Esto decide, para cada edificio, cuatro cosas:
 *
 *   - **la letra**: recta, inclinada, monoespaciada, de contorno, fina, pesada o
 *     estrecha;
 *   - **la composición**: centrada, arrimada a una esquina, en vertical, grande y
 *     a sangre, o apilada en dos renglones;
 *   - **el fondo**: liso, cortado en diagonal, con una franja, un arco, un disco,
 *     rayado o con una base;
 *   - **la tinta**: teñida, llena, del azul de la marca o sobre papel.
 *
 * Son variaciones de UN sistema —las dos tipografías de la aplicación, sus
 * colores, la misma chapa redondeada—, no diecisiete logotipos: lo que cambia
 * es cómo se combinan. Por eso se ven de la misma familia y aun así ninguna es
 * igual a la de al lado.
 *
 * **Sale del código y del nombre, y de nada más.** No se guarda en ningún
 * sitio: es una función pura de lo que el edificio ya dice de sí mismo. Así
 *
 *   - un edificio nuevo tiene su chapa en el instante en que se crea, sin que
 *     nadie la diseñe;
 *   - si cambia su sigla o su nombre, cambia su chapa —es otro rótulo—;
 *   - y todos los dispositivos pintan la misma sin tener que sincronizar nada.
 *
 * Vive en `domain` y sin React para poder probar justo eso: que es estable, que
 * cambia cuando tiene que cambiar y que nunca propone una combinación que no se
 * pueda leer.
 */

import { norm } from './normalize'

export type LetraDeMonograma =
  | 'recta'
  | 'inclinada'
  | 'mono'
  | 'contorno'
  | 'fina'
  | 'pesada'
  | 'estrecha'

export type ComposicionDeMonograma = 'centro' | 'esquina' | 'vertical' | 'sangre' | 'apilada'

export type FondoDeMonograma = 'liso' | 'diagonal' | 'franja' | 'arco' | 'disco' | 'rayas' | 'base'

export type TintaDeMonograma = 'tinte' | 'llena' | 'marca' | 'papel'

export interface Monograma {
  /** Lo que se escribe: el código, en uno o dos renglones. */
  lineas: string[]
  letra: LetraDeMonograma
  composicion: ComposicionDeMonograma
  fondo: FondoDeMonograma
  tinta: TintaDeMonograma
}

const LETRAS: readonly LetraDeMonograma[] = [
  'recta',
  'inclinada',
  'mono',
  'contorno',
  'fina',
  'pesada',
  'estrecha',
]

const TINTAS: readonly TintaDeMonograma[] = ['tinte', 'llena', 'marca', 'papel']

/**
 * Qué composiciones admite un código, según lo que mide.
 *
 * Es donde se protege la lectura, y cada regla sale de haberlo visto dibujado:
 *
 *  - Una letra a sangre se lee con una o dos letras; con cuatro se sale.
 *  - En vertical, una letra sola no es un rótulo: es una letra tumbada, y una
 *    «E» tumbada no se reconoce. Hace falta una palabra, o sea dos o más.
 *  - Apilar en dos renglones es lo que salva a un código largo —«AYD1» pasa a
 *    «AY / D1», al doble de cuerpo—. Con tres letras deja una suelta abajo
 *    («EP / S») que se lee como dos cosas, así que es de cuatro en adelante.
 *
 * `centro` va repetido a propósito: es la más tranquila, y si todas las chapas
 * hicieran algo, ninguna destacaría.
 */
function composicionesPara(largo: number): readonly ComposicionDeMonograma[] {
  if (largo <= 1) return ['centro', 'sangre', 'esquina', 'sangre', 'centro']
  if (largo === 2) return ['centro', 'sangre', 'esquina', 'vertical', 'sangre', 'centro']
  if (largo === 3) return ['centro', 'esquina', 'vertical', 'centro', 'esquina']
  if (largo === 4) return ['apilada', 'centro', 'apilada', 'vertical']
  return ['apilada', 'centro']
}

/** Qué fondos no estorban a cada composición. */
function fondosPara(composicion: ComposicionDeMonograma): readonly FondoDeMonograma[] {
  switch (composicion) {
    // Abajo va la letra: una base o un arco en la esquina la pisarían.
    case 'sangre':
    case 'esquina':
      return ['liso', 'diagonal', 'franja', 'rayas', 'disco']
    // La franja lateral es el sitio natural de un rótulo en vertical.
    case 'vertical':
      return ['franja', 'liso', 'diagonal', 'rayas', 'arco', 'franja']
    default:
      return ['liso', 'diagonal', 'franja', 'arco', 'disco', 'rayas', 'base']
  }
}

/**
 * FNV-1a de 32 bits. No hace falta nada criptográfico: solo que dos textos
 * parecidos —«AYD1» y «AYD2»— den números que no se parezcan, y que el mismo
 * texto dé siempre el mismo número en cualquier dispositivo.
 */
function huella(texto: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // El batido final de MurmurHash3. FNV solo deja los bits bajos poco
  // mezclados con textos cortos, y de los bits bajos es de donde sale cada eje:
  // sin esto, la mitad del campus caía en la misma tinta.
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Parte un código en dos renglones lo más parejos posible: «AYD1» → «AY», «D1». */
function apilar(codigo: string): string[] {
  const corte = Math.ceil(codigo.length / 2)
  return [codigo.slice(0, corte), codigo.slice(corte)]
}

export function monogramaDeEdificio(code: string, name: string | null | undefined = ''): Monograma {
  // Lo que se escribe: sin espacios, y con un guion si no hay código que poner.
  const codigo = norm(code).replace(/\s+/g, '') || '–'
  const largo = codigo.length

  // Cada eje sale de su propia huella. Sacarlos todos de un mismo número los
  // ata entre sí: los edificios con la misma letra tendrían siempre el mismo
  // fondo, y la variedad sería la mitad de la que parece.
  const semilla = `${codigo}|${norm(name)}`
  const eje = (cual: string, entre: number): number => huella(`${cual}:${semilla}`) % entre

  const composiciones = composicionesPara(largo)
  const composicion = composiciones[eje('composicion', composiciones.length)] ?? 'centro'

  let letra = LETRAS[eje('letra', LETRAS.length)] ?? 'recta'
  // El contorno necesita cuerpo para leerse: a partir de tres letras el trazo
  // se come los huecos, y en la chapa pequeña es un borrón. Pasa a su hermana
  // llena.
  if (letra === 'contorno' && largo >= 3) letra = 'pesada'
  // La fina, a sangre, se queda en dos palitos: ahí va la recta.
  if (letra === 'fina' && composicion === 'sangre') letra = 'recta'
  // Y una letra inclinada puesta en vertical son dos giros a la vez: no se
  // sabe hacia dónde mira. En vertical va derecha.
  if (letra === 'inclinada' && composicion === 'vertical') letra = 'recta'

  const fondos = fondosPara(composicion)
  const fondo = fondos[eje('fondo', fondos.length)] ?? 'liso'

  const tinta = TINTAS[eje('tinta', TINTAS.length)] ?? 'tinte'

  return {
    lineas: composicion === 'apilada' ? apilar(codigo) : [codigo],
    letra,
    composicion,
    fondo,
    tinta,
  }
}
