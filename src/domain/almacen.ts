/**
 * Nomenclatura del almacén.
 *
 * El almacén nació de dos sitios que no se hablaban. Por un lado la hoja
 * *Bolsa 2026*, con los 43 artículos que de verdad se compran y se cuentan. Por
 * otro el campo «Material Usado» del histórico de incidencias, que es texto
 * libre escrito con prisa desde un aula: de ahí salieron otros setenta y tantos
 * «artículos» que en realidad son la misma cosa mal escrita —«cables Hdmi
 * 10mts Fibra», «cable hdmi Fibra 10mts», «Cable Hdmi 10mts Fibra»— o ni
 * siquiera son un artículo —«mts», «pulgadas», «cables de»—.
 *
 * El resultado es la pantalla de Almacén que se ve hoy: «Matriz HDMI» y «Matriz
 * Hdmi» separados por una fila, «metros» y «metros red» como si fueran material,
 * y dos mandos a distancia que son el mismo mando. Con la lista así, buscar no
 * encuentra, contar no cuadra y el informe de consumo reparte el gasto de un
 * cable entre seis grafías.
 *
 * Este fichero es la respuesta, y son tres decisiones:
 *
 *  1. **Un nombre canónico por artículo.** Se escribe siempre igual: siglas en
 *     mayúscula (HDMI, USB, RS-232, DisplayPort), longitudes en metros con la
 *     unidad separada (`10 m`, nunca `10mts` ni `10 metros`), y el resto en
 *     minúscula salvo marcas y modelos, que van tal cual (`iiyama T2454MSC`).
 *  2. **Las variantes se funden en él.** Lo que alguien tecleó una vez no se
 *     borra: el artículo redundante desaparece, pero sus movimientos y las
 *     incidencias que lo citan pasan al canónico. El histórico no pierde nada.
 *  3. **Lo que no es un artículo se archiva, no se fusiona.** «mts» no es medio
 *     cable de fibra; adivinar de cuál era falsearía el inventario. Se marca
 *     inactivo: sale de la pantalla de Almacén y sigue enlazado a su incidencia.
 *
 * La regla que decide entre 2 y 3, cuando el texto se queda a medias: si la
 * familia tiene **un solo** artículo en el almacén, la variante se funde con él
 * («selector automatico» → solo hay un selector); si tiene varios y el texto no
 * dice cuál, se archiva («cable usb» → hay de 10 m y de 15 m).
 *
 * Lo usan dos sitios y tienen que decir lo mismo:
 *   - `scripts/import-excel.ts`, para que una instalación nueva nazca limpia.
 *   - `supabase/migrations/20260729000200_almacen_nomenclatura.sql`, para
 *     arreglar la base que ya está en producción. Un test compara las dos
 *     tablas: si alguien toca una y no la otra, salta.
 */

import { norm } from './normalize'

export interface ArticuloAlmacen {
  /** El nombre bueno, el que se ve en la pantalla de Almacén. */
  canonico: string
  /**
   * Todo lo que se ha escrito alguna vez para referirse a este artículo,
   * incluido el nombre con el que está hoy en la base. No hace falta repetir el
   * canónico: se añade solo.
   */
  variantes: string[]
}

/**
 * El catálogo. El orden es el de familia —cables, adaptadores, proyección,
 * informática— y no el alfabético, porque leerlo para revisarlo es el uso
 * principal de esta lista.
 */
export const CATALOGO_ALMACEN: ArticuloAlmacen[] = [
  // --- Cables HDMI de cobre -------------------------------------------------
  {
    canonico: 'Cable HDMI 3 m',
    variantes: ['Cable HDMI 3 mts', 'Cable Hdmi 3mts', 'cables Hdmi 3mts'],
  },
  {
    canonico: 'Cable HDMI 5 m',
    variantes: ['Cable Hdmi 5 metros', 'Cable HDMI 5mts'],
  },
  {
    // «7mts» no existe como artículo: el que se compra es el de 7,5 m. Es la
    // misma tirada de cable redondeada al hablar.
    canonico: 'Cable HDMI 7,5 m',
    variantes: ['Cable HDMI 7,5 mts', 'Cable Hdmi 7mts', 'Cable Hdmi de 7mts'],
  },

  // --- Cables HDMI de fibra -------------------------------------------------
  {
    // A partir de 10 m el cable que se instala es de fibra: no hay HDMI de
    // cobre de esa longitud en la bolsa, así que «Cable HDMI 10mts» es este.
    canonico: 'Cable HDMI fibra 10 m',
    variantes: [
      'Cable HDMI Fibra 10 mts',
      'Cable Hdmi 10mts Fibra',
      'cables Hdmi 10mts Fibra',
      'Cable hdmi Fibra 10mts',
      'cables hdmi fibra 10mts',
      'Cable HDMI 10mts',
      'Cables Hdmi 10mts',
      'cable 10mts fibra',
    ],
  },
  {
    canonico: 'Cable HDMI fibra 15 m',
    variantes: [
      'Cable HDMI Fibra 15 mts',
      'Cable Hdmi 15mts Fibra',
      'Cables Hdmi 15mts Fibra',
      'cables Hdmi15mts Fibra',
      'cable Hdmi fibra 15mts',
      'cable Hdmi fibra15mts',
      'cables hdmi fibra 15mts',
      'cables 15mts Fibra',
    ],
  },
  {
    canonico: 'Cable HDMI fibra 20 m',
    variantes: ['Cable HDMI Fibra 20 mts', 'Cable hdmi 20mts Fibra', 'cables Hdmi 20mts Fibra'],
  },

  // --- Otros cables ---------------------------------------------------------
  {
    canonico: 'Cable USB 10 m',
    variantes: ['Cable USB 10 mts', 'Cable USB 10mts'],
  },
  {
    canonico: 'Cable USB 15 m',
    variantes: ['Cable USB 15 mts', 'Cable usb 15mts'],
  },
  {
    // El único minijack del almacén, así que «cable mini jack» a secas es este.
    canonico: 'Cable audio minijack 10 m',
    variantes: ['Cable Audio Mini Jack 10mts', 'cable mini jack'],
  },
  {
    canonico: 'Cable RS-232',
    variantes: ['Cable RS 232'],
  },

  // --- Adaptadores, conversores y distribución ------------------------------
  {
    // La hoja de 2025 lo llamaba «Adaptador» y la de 2026 «Conversor»: es la
    // misma fila renombrada de un año para otro, no dos artículos.
    canonico: 'Conversor USB a HDMI',
    variantes: [
      'Converso USB a  HDMI',
      'conversores Usb a Hdmi',
      'conversor de Usb a Hdmi',
      'conversores de USB a HDMI',
      'adaptador USB a HDMI',
      'Adaptador usb HDMI',
    ],
  },
  {
    canonico: 'Conversor DisplayPort a HDMI',
    variantes: [
      'Converos DP a HDMI',
      'covserso DP a Hdmi',
      'Adaptador DisplayPort a HDMI',
      'Adaptador Dp a HDMI',
      'Adaptador Dp -Hdmi',
      'adaptador hdmi a displayport',
      'Dp a HDMI',
    ],
  },
  {
    canonico: 'Adaptador HDMI hembra-hembra',
    variantes: ['Adaptador HDMI F to F'],
  },
  {
    canonico: 'Matriz HDMI',
    variantes: [],
  },
  {
    canonico: 'Hub HDMI 1 entrada / 4 salidas',
    variantes: ['Hub de Hdmi 1In / 4 Out'],
  },
  {
    canonico: 'Hub USB',
    variantes: ['Hub de USB'],
  },
  {
    canonico: 'Selector automático HDMI 1 entrada / 2 salidas',
    variantes: [
      'Selector automatico Hdmi 1In / 2 Out',
      'selector automatico',
      'selector automatico,',
    ],
  },
  {
    canonico: 'Extensor USB 2.0 AE',
    variantes: [],
  },
  {
    canonico: 'Extensor USB 3.0 AE',
    variantes: [],
  },

  // --- Proyección -----------------------------------------------------------
  {
    canonico: 'Proyector Epson',
    variantes: [],
  },
  {
    canonico: 'Proyector Epson (Ed. Antonio Gaudí)',
    variantes: [],
  },
  {
    canonico: 'Soporte de techo para proyector',
    variantes: [],
  },
  {
    canonico: 'Lámpara proyector NP30',
    variantes: [],
  },
  {
    canonico: 'Lámpara proyector NP44',
    variantes: [],
  },
  {
    canonico: 'Lámpara proyector NP47',
    variantes: [],
  },
  {
    // El `0I-` de delante parece basura de teclear, pero es una referencia de
    // recambio y corregirla a ojo sería peor que dejarla: si mañana hay que
    // pedirla, el número tiene que ser el que está anotado.
    canonico: 'Lámpara proyector 0I-ET-LAV400',
    variantes: [],
  },
  {
    canonico: 'Pantalla de proyección 2,30 x 2,30 m',
    variantes: ['Pantalla proyección  de 2,30 mts x 2,30 mts'],
  },
  {
    canonico: 'Pantalla de proyección 2,40 x 2,40 m',
    variantes: ['Pantalla proyección  de 2,40 mts x 2,40 mts'],
  },
  {
    canonico: 'Pantalla de proyección 3,00 m',
    variantes: ['Pantalla de proyección de 3,00mts'],
  },
  {
    canonico: 'Mando a distancia de pantalla de proyección',
    variantes: [
      'mando a distancia para pantalla de proyección',
      'mando a distancia pantalla proyección',
    ],
  },

  // --- Pantallas y monitores ------------------------------------------------
  {
    canonico: 'Monitor 86" (edificio BC)',
    variantes: ['Monitor 86 " (edificio BC)'],
  },
  {
    canonico: 'Monitor NEC 49"',
    variantes: [],
  },
  {
    canonico: 'Monitor táctil iiyama T2454MSC 24,5"',
    variantes: ['Monitor táctil iiyama 24,5" T2454MSC'],
  },

  // --- Audio y vídeo --------------------------------------------------------
  {
    canonico: 'Altavoces',
    variantes: ['Juego de altavoces', 'Juego de altavoces,'],
  },
  {
    canonico: 'Micrófono Jabra con soporte de mesa',
    variantes: [],
  },
  {
    canonico: 'Jabra Panacast 50',
    variantes: [],
  },
  {
    // La única cámara del almacén, así que «Camara» a secas es esta.
    canonico: 'Cámara Aver',
    variantes: ['Camaras Aver', 'Camara'],
  },
  {
    canonico: 'Botonera',
    variantes: [],
  },

  // --- Informática ----------------------------------------------------------
  {
    canonico: 'Ordenador Tiny M70Q',
    variantes: [],
  },
  {
    canonico: 'Ordenador Tiny M710Q',
    variantes: [],
  },
  {
    canonico: 'Ordenador Tiny M720Q',
    variantes: [],
  },
  {
    canonico: 'Ordenador Tiny Neo 50Q',
    variantes: [],
  },
  {
    canonico: 'Teclado',
    variantes: ['teclados de pc', 'Teclado nuevo'],
  },
  {
    canonico: 'Ratón',
    variantes: [],
  },

  // --- Instalación ----------------------------------------------------------
  {
    canonico: 'Regleta de luz',
    variantes: [],
  },
]

/**
 * Lo que quedó en la lista sin ser un artículo.
 *
 * Casi todo son restos de partir el texto libre de «Material Usado»: la unidad
 * suelta («mts», «pulgadas»), la frase cortada a la mitad («cables de», «cable
 * HDMI 1.8 m y»), o un material real del que no se dice cuál de las variantes
 * era («cable usb» —¿de 10 m o de 15 m?—).
 *
 * No se fusionan con nadie: repartir «mts» entre los cables de fibra sería
 * inventarse el inventario. Se archivan —`active = false`—, que los saca de la
 * pantalla de Almacén sin romper el enlace con la incidencia que los cita.
 */
export const FRAGMENTOS_ALMACEN: string[] = [
  // Unidades y palabras sueltas
  'mts',
  'metros',
  'pulgadas',
  'EEB',
  // Frases cortadas
  'cables de',
  'Cable de',
  'cable HDMI 1.8 m y',
  // Material sin identificar cuál
  'cables Hdmi',
  'cable Hdmi',
  'cable Hmdi',
  'cable Hdmi fibra',
  'cables Hdmi fibra',
  'cable usb',
  'Cables Usb',
  'cable Usb camara',
  'cable extender usb',
  'm fibra',
  'mts Fibra',
  'mts de fibra',
  'mts de fibra monitor tactil',
  'mts canaleta de suelo',
  'metros red',
  'monitor Tiny',
]

/** Índice variante normalizada → nombre canónico. */
const INDICE = new Map<string, string>()
for (const art of CATALOGO_ALMACEN) {
  // El canónico se indexa a sí mismo: así aplicar esto dos veces no cambia
  // nada, que es lo que permite volver a lanzar la corrección sin miedo.
  for (const v of [art.canonico, ...art.variantes]) INDICE.set(norm(v), art.canonico)
}

const FRAGMENTOS = new Set(FRAGMENTOS_ALMACEN.map(norm))

/** ¿Este nombre es un resto de texto libre en vez de un artículo? */
export function esFragmentoAlmacen(nombre: string): boolean {
  return FRAGMENTOS.has(norm(nombre))
}

/**
 * El nombre bueno de un artículo del almacén.
 *
 * Devuelve el mismo nombre —solo con los espacios recolocados— cuando no está
 * en el catálogo: un artículo que alguien dé de alta mañana no se toca, porque
 * corregir a ciegas lo que no se conoce es como se llegó hasta aquí.
 */
export function canonAlmacen(nombre: string): string {
  const limpio = String(nombre ?? '').replace(/\s+/g, ' ').trim()
  return INDICE.get(norm(limpio)) ?? limpio
}
