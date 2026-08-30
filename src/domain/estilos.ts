/**
 * Qué formato tiene cada estilo del libro, para no escribir un `46218` donde
 * tiene que poner una fecha.
 *
 * Parece un detalle de presentación y es un fallo de los que se ven desde la
 * puerta. En una hoja de Excel **una fecha es un número**: el 23 de junio de
 * 2025 se guarda como `45831` y lo que la convierte en una fecha a la vista es
 * el formato de la celda, no el valor. Si se escribe el número en una celda cuyo
 * formato es «General», la columna «Fecha Revisión» enseña cinco cifras.
 *
 * Y pasa de verdad, porque esta hoja tiene la columna a medias: las celdas con
 * fecha llevan formato de fecha y **las que están vacías se quedaron en
 * General**. Mientras nadie escribiera en ellas daba igual. En cuanto la
 * sincronización rellena las 137 revisiones que faltaban, la mitad de la columna
 * sale en números.
 *
 * Heredar el estilo de la celda de al lado —que es lo que hace el parcheador
 * para una columna nueva— tampoco vale aquí: a la izquierda de «Fecha Revisión»
 * está «AULAS», que es texto.
 *
 * Así que se lee `styles.xml` y se contesta la única pregunta que hace falta:
 * **de los estilos que ya usa este libro, ¿cuál pinta una fecha?** No se crea
 * ninguno: crear un estilo obliga a añadir una entrada a una tabla que todas las
 * celdas del libro están usando por su número, y renumerarla mal cambia el
 * aspecto de celdas que nadie tocó.
 */

// -----------------------------------------------------------------------------
// Los formatos que trae Excel de serie
// -----------------------------------------------------------------------------

/**
 * Los `numFmtId` reservados que son fechas u horas.
 *
 * Van escritos porque no aparecen en `styles.xml`: Excel los da por sabidos y
 * solo escribe los que alguien se ha inventado (del 164 en adelante).
 */
const FECHAS_DE_SERIE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])

/** `9` es `0%` y `10` es `0.00%`. */
const PORCENTAJES_DE_SERIE = new Set([9, 10])

export type Formato = 'fecha' | 'porcentaje' | 'otro'

function desescapar(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export interface Estilos {
  /** Qué pinta el estilo número `s`. */
  formatoDe(s: number): Formato
  /** Un estilo del libro que pinte lo que se pide, o `null` si no hay ninguno. */
  alguno(formato: Formato): number | null
}

/**
 * Lee `styles.xml`.
 *
 * `cellXfs` es la lista que indexa el atributo `s` de cada celda; cada entrada
 * apunta a un `numFmtId`, que o es uno de los de serie o está declarado arriba
 * en `numFmts` con su código (`dd/mm/yyyy`, `0%`).
 */
export function leerEstilos(xml: string): Estilos {
  // 1 — Los formatos que este libro se ha inventado.
  const propios = new Map<number, string>()
  for (const m of xml.matchAll(/<numFmt\b[^>]*\bnumFmtId="(\d+)"[^>]*\bformatCode="([^"]*)"/g)) {
    // El código viene escapado: un formato con texto literal se escribe
    // `&quot;mes de &quot;General`, y sin deshacerlo la comilla no se reconoce y
    // ese texto pasa por una fecha porque lleva una `m` y una `d`.
    propios.set(Number(m[1]), desescapar(m[2] ?? ''))
  }

  // 2 — La lista que usan las celdas. `cellXfs` y no `cellStyleXfs`: la segunda
  //     es la de los estilos con nombre, y el `s` de una celda no la indexa.
  const bloque = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? ''
  const porEstilo: Formato[] = []
  for (const m of bloque.matchAll(/<xf\b([^>]*?)\/>|<xf\b([^>]*?)>/g)) {
    const attrs = m[1] ?? m[2] ?? ''
    const id = Number(/\bnumFmtId="(\d+)"/.exec(attrs)?.[1] ?? 0)
    porEstilo.push(clasificar(id, propios.get(id)))
  }

  const primeroDe = new Map<Formato, number>()
  porEstilo.forEach((f, i) => {
    if (f !== 'otro' && !primeroDe.has(f)) primeroDe.set(f, i)
  })

  return {
    formatoDe: (s) => porEstilo[s] ?? 'otro',
    alguno: (f) => primeroDe.get(f) ?? null,
  }
}

/**
 * Qué pinta un formato.
 *
 * Para los inventados se mira el código, y se mira con cuidado: el mes y los
 * minutos se escriben los dos con `m`, y hay que quitar antes lo que va entre
 * comillas —un `"mes de "` dentro del formato no lo convierte en una fecha— y
 * los códigos de color (`[Red]`, `[$-C0A]`).
 */
function clasificar(id: number, codigo: string | undefined): Formato {
  if (codigo === undefined) {
    if (FECHAS_DE_SERIE.has(id)) return 'fecha'
    if (PORCENTAJES_DE_SERIE.has(id)) return 'porcentaje'
    return 'otro'
  }

  const limpio = codigo.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '')
  // El `%` manda: `0.00%` es un porcentaje aunque lleve una `d` de «días».
  if (limpio.includes('%')) return 'porcentaje'
  if (/[ymdhs]/i.test(limpio)) return 'fecha'
  return 'otro'
}

/**
 * El estilo que le toca a una celda para que pinte lo que se le pide.
 *
 * Se busca en este orden, y el orden es lo que hace que el resultado se parezca
 * al libro y no a una hoja nueva:
 *
 *  1. **El que ya tiene**, si ya pinta bien. Lo normal, y no se toca nada.
 *  2. **El de otra celda de su misma columna** que sí pinte bien: es el que puso
 *     quien montó la hoja, con su borde y su color.
 *  3. **Cualquiera del libro** que pinte bien. Feo pero legible.
 *  4. Ninguno: se deja como está. Un número mal formateado es mejor que un
 *     estilo inventado que cambie el aspecto de la hoja.
 */
export function estiloQuePinta(
  estilos: Estilos,
  formato: Formato,
  actual: number | null,
  enLaColumna: number[],
): number | null {
  if (formato === 'otro') return null
  if (actual !== null && estilos.formatoDe(actual) === formato) return null

  const deLaColumna = enLaColumna.find((s) => estilos.formatoDe(s) === formato)
  if (deLaColumna !== undefined) return deLaColumna

  return estilos.alguno(formato)
}

/** Los estilos que se usan hoy en una columna de una hoja, de arriba abajo. */
export function estilosDeLaColumna(xmlHoja: string, columna: string): number[] {
  const out: number[] = []
  const patron = new RegExp(`<c\\b[^>]*\\br="${columna}\\d+"[^>]*\\bs="(\\d+)"`, 'g')
  for (const m of xmlHoja.matchAll(patron)) {
    const s = Number(m[1])
    if (!out.includes(s)) out.push(s)
  }
  return out
}
