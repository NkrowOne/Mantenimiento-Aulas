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
 * Así que se lee `styles.xml` y se contesta la primera pregunta: **de los
 * estilos que ya usa este libro, ¿cuál pinta una fecha?** Para las celdas de las
 * hojas de la gente no se crea ninguno: se reutiliza el que ya tiene la columna.
 *
 * La segunda mitad del fichero es la otra pregunta, la de las hojas que escribe
 * la aplicación: **¿qué índice tiene «cabecera de la app» en este libro?**
 * Esas hojas se pintan con un puñado de estilos con nombre (`ClaveDeEstilo`) y
 * aquí se convierten en números de `cellXfs`. La regla que lo hace seguro es
 * una sola: **`styles.xml` solo crece por el final**. Nunca se renumera lo que
 * hay —todas las celdas del libro lo usan por su número— y antes de añadir se
 * busca un estilo idéntico (misma fuente, mismo relleno, mismo borde, mismo
 * formato, misma alineación) para reutilizar su índice. Así el libro no engorda
 * pasada a pasada: la segunda vez que se escribe, `styles.xml` sale igual.
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

// -----------------------------------------------------------------------------
// Los estilos con nombre de las hojas que escribe la aplicación
// -----------------------------------------------------------------------------

/**
 * Claves semánticas de estilo. `libro.ts` las convierte en índices de
 * `cellXfs` con `asegurarEstilos`, creándolos si faltan.
 */
export type ClaveDeEstilo =
  | 'cabecera'
  | 'cabeceraApp'
  | 'cabeceraDiscreta'
  | 'titulo'
  | 'etiqueta'
  | 'texto'
  | 'textoAjustado'
  | 'textoSinBorde'
  | 'fecha'
  | 'porcentaje'
  | 'entero'
  | 'ok'
  | 'aviso'
  | 'critico'
  | 'apagado'

export type Tinte = 'ok' | 'aviso' | 'critico' | 'apagado'

/** Los tintes de `tokens.css`, para que la hoja diga lo mismo que la pantalla. */
export const COLOR_DE_TINTE: Record<Tinte, string> = {
  ok: 'E2F1E9',
  aviso: 'F8EFDC',
  critico: 'FAE8E6',
  apagado: 'E7ECED',
}

/** El fondo de las bandas alternas de las hojas de la gente. */
export const COLOR_DE_BANDA = 'F2F6FA'

/** Lo que define un estilo, sin números: es lo que se compara para reutilizar. */
export interface Receta {
  fuente: {
    nombre: string
    tamano: number
    negrita: boolean
    cursiva: boolean
    /** `RRGGBB` sin alfa, o `null` para el color por defecto. */
    color: string | null
  }
  /** Fondo sólido `RRGGBB`, o `null` si no lleva. */
  relleno: string | null
  /** Borde fino `D9D9D9` a los cuatro lados, o ninguno. */
  borde: boolean
  /** Un `numFmtId` de serie, o `'fecha'` para el `dd/mm/yyyy` del libro. */
  numFmt: number | 'fecha'
  alineacion: {
    horizontal: 'center' | null
    vertical: 'center' | 'top' | null
    ajustar: boolean
  }
}

const ARIAL_10: Receta['fuente'] = { nombre: 'Arial', tamano: 10, negrita: false, cursiva: false, color: null }
const SIN_ALINEAR: Receta['alineacion'] = { horizontal: null, vertical: null, ajustar: false }
const ARRIBA: Receta['alineacion'] = { horizontal: null, vertical: 'top', ajustar: false }
const ARRIBA_AJUSTADO: Receta['alineacion'] = { horizontal: null, vertical: 'top', ajustar: true }
const CENTRADO: Receta['alineacion'] = { horizontal: 'center', vertical: 'center', ajustar: true }

const CUERPO: Receta = { fuente: ARIAL_10, relleno: null, borde: true, numFmt: 0, alineacion: ARRIBA }

/** Cada clave, deletreada. Los colores son los del libro y los de `tokens.css`. */
export function recetaDe(clave: ClaveDeEstilo): Receta {
  switch (clave) {
    case 'cabecera':
      return {
        fuente: { ...ARIAL_10, negrita: true, color: 'FFFFFF' },
        relleno: '1F4E78',
        borde: true,
        numFmt: 0,
        alineacion: CENTRADO,
      }
    case 'cabeceraApp':
      return {
        fuente: { ...ARIAL_10, negrita: true, cursiva: true, color: 'FFFFFF' },
        relleno: '5B7F9E',
        borde: true,
        numFmt: 0,
        alineacion: CENTRADO,
      }
    case 'cabeceraDiscreta':
      return {
        fuente: { ...ARIAL_10, negrita: true, color: '415357' },
        relleno: 'E7ECED',
        borde: true,
        numFmt: 0,
        alineacion: CENTRADO,
      }
    case 'titulo':
      return {
        fuente: { ...ARIAL_10, tamano: 14, negrita: true, color: '1F4E78' },
        relleno: null,
        borde: false,
        numFmt: 0,
        alineacion: SIN_ALINEAR,
      }
    case 'etiqueta':
      return { fuente: { ...ARIAL_10, negrita: true }, relleno: null, borde: false, numFmt: 0, alineacion: ARRIBA_AJUSTADO }
    case 'texto':
      return CUERPO
    case 'textoAjustado':
      return { ...CUERPO, alineacion: ARRIBA_AJUSTADO }
    case 'textoSinBorde':
      return { ...CUERPO, borde: false, alineacion: ARRIBA_AJUSTADO }
    case 'fecha':
      return { ...CUERPO, numFmt: 'fecha' }
    case 'porcentaje':
      return { ...CUERPO, numFmt: 9 }
    case 'entero':
      return { ...CUERPO, numFmt: 1 }
    case 'ok':
    case 'aviso':
    case 'critico':
    case 'apagado':
      return { ...CUERPO, relleno: COLOR_DE_TINTE[clave] }
  }
}

/**
 * La misma receta con un fondo de tinte. Una fecha en una fila «crítica» tiene
 * que seguir siendo una fecha: el tinte se suma al formato, no lo sustituye.
 */
export function conTinte(receta: Receta, tinte: Tinte): Receta {
  return { ...receta, relleno: COLOR_DE_TINTE[tinte] }
}

/** El código del formato de fecha que usan las hojas de la aplicación. */
const CODIGO_FECHA = 'dd/mm/yyyy'
const COLOR_DEL_BORDE = 'D9D9D9'

export interface EstilosAsegurados {
  /** El `styles.xml` con lo que hubo que añadir. Idéntico al de entrada si nada. */
  xml: string
  indices: Map<ClaveDeEstilo, number>
}

/**
 * Los índices de `cellXfs` de cada clave, añadiendo al final lo que falte.
 *
 * Lo que se añade se añade en cinco listas —`numFmts`, `fonts`, `fills`,
 * `borders`, `cellXfs`— y en cada una primero se busca si ya hay una entrada
 * igual. La comparación es por lo que pinta, no por los bytes: el libro real
 * escribe sus colores como `00FFFFFF` y Excel como `FFFFFFFF`, y los dos son
 * blanco. Sin esa tolerancia, la pasada siguiente no reconocería lo que la
 * anterior dejó y el fichero crecería sin techo.
 */
export function asegurarEstilos(stylesXml: string, claves: Iterable<ClaveDeEstilo>): EstilosAsegurados {
  const lista = [...new Set(claves)]
  const r = asegurarRecetas(stylesXml, lista.map(recetaDe))
  const indices = new Map<ClaveDeEstilo, number>()
  lista.forEach((clave, i) => indices.set(clave, r.indices[i]!))
  return { xml: r.xml, indices }
}

/** Lo mismo, para recetas sueltas (las combinaciones de tinte y formato). */
export function asegurarRecetas(stylesXml: string, recetas: Receta[]): { xml: string; indices: number[] } {
  let xml = stylesXml
  for (const seccion of ['numFmts', 'fonts', 'fills', 'borders', 'cellXfs'] as const) {
    xml = asegurarSeccion(xml, seccion)
  }

  const indices: number[] = []
  for (const receta of recetas) {
    const numFmtId = receta.numFmt === 'fecha' ? -1 : receta.numFmt
    let idFecha = -1
    if (receta.numFmt === 'fecha') {
      const r = asegurarNumFmt(xml, CODIGO_FECHA)
      xml = r.xml
      idFecha = r.id
    }
    const fuente = asegurarEnLista(xml, 'fonts', 'font', firmaDeFuente, xmlDeFuente(receta.fuente))
    xml = fuente.xml
    const relleno = asegurarEnLista(xml, 'fills', 'fill', firmaDeRelleno, xmlDeRelleno(receta.relleno))
    xml = relleno.xml
    const borde = asegurarEnLista(xml, 'borders', 'border', firmaDeBorde, xmlDeBorde(receta.borde))
    xml = borde.xml

    const xf = xmlDeXf(numFmtId < 0 ? idFecha : numFmtId, fuente.indice, relleno.indice, borde.indice, receta.alineacion)
    const r = asegurarEnLista(xml, 'cellXfs', 'xf', (x) => firmaDeXf(x, xml), xf)
    xml = r.xml
    indices.push(r.indice)
  }
  return { xml, indices }
}

/**
 * El índice de un `dxf` con ese fondo, añadiéndolo si no lo hay.
 *
 * Es el estilo diferencial de las bandas alternas por formato condicional. El
 * libro real ya trae uno con `F2F6FA`: en él no se debe añadir otro.
 */
export function asegurarDxfDeFondo(stylesXml: string, rgb: string): { xml: string; indice: number } {
  const xml = asegurarSeccion(stylesXml, 'dxfs')
  const nuevo =
    `<dxf><fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor rgb="FF${rgb}"/></patternFill></fill></dxf>`
  return asegurarEnLista(xml, 'dxfs', 'dxf', firmaDeDxf, nuevo)
}

// --- El orden de las secciones de styles.xml, para insertar la que falte -----

const ORDEN_DE_SECCIONES = [
  'numFmts',
  'fonts',
  'fills',
  'borders',
  'cellStyleXfs',
  'cellXfs',
  'cellStyles',
  'dxfs',
  'tableStyles',
  'colors',
  'extLst',
]

/** Si `styles.xml` no tiene la sección, se crea vacía en el sitio que le toca. */
function asegurarSeccion(xml: string, seccion: string): string {
  if (new RegExp(`<${seccion}\\b`).test(xml)) return xml
  const vacia = `<${seccion} count="0"></${seccion}>`
  const despues = ORDEN_DE_SECCIONES.slice(ORDEN_DE_SECCIONES.indexOf(seccion) + 1)
  for (const s of despues) {
    const m = new RegExp(`<${s}\\b`).exec(xml)
    if (m) return xml.slice(0, m.index) + vacia + xml.slice(m.index)
  }
  const cierre = xml.lastIndexOf('</styleSheet>')
  if (cierre < 0) throw new Error('styles.xml no tiene <styleSheet>: no es la hoja de estilos de un libro')
  return xml.slice(0, cierre) + vacia + xml.slice(cierre)
}

/** El bloque de una sección: sus límites y sus elementos hijos. */
function seccion(xml: string, nombre: string): { inicio: number; fin: number; cuerpo: string } {
  const m = new RegExp(`<${nombre}\\b([^>]*?)(/>|>([\\s\\S]*?)</${nombre}>)`).exec(xml)
  if (!m) throw new Error(`styles.xml no tiene <${nombre}>`)
  return { inicio: m.index, fin: m.index + m[0].length, cuerpo: m[3] ?? '' }
}

/** Los elementos de primer nivel de una lista: `<font>…</font>` o `<font/>`. */
function elementosDe(cuerpo: string, etiqueta: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${etiqueta}\\b[^>]*?/>|<${etiqueta}\\b[^>]*?>[\\s\\S]*?</${etiqueta}>`, 'g')
  for (const m of cuerpo.matchAll(re)) out.push(m[0])
  return out
}

/**
 * Busca en una lista un elemento con la misma firma; si no está, lo añade al
 * final y actualiza el `count`. Devuelve su índice, que es lo que las celdas
 * usan.
 */
function asegurarEnLista(
  xml: string,
  nombre: string,
  etiqueta: string,
  firma: (elemento: string) => string,
  nuevo: string,
): { xml: string; indice: number } {
  const s = seccion(xml, nombre)
  const elementos = elementosDe(s.cuerpo, etiqueta)
  const buscada = firma(nuevo)
  const i = elementos.findIndex((e) => firma(e) === buscada)
  if (i >= 0) return { xml, indice: i }

  const cabecera = /^<[^>]*?>/.exec(xml.slice(s.inicio, s.fin))![0]
  const total = elementos.length + 1
  const abre = /\bcount="\d+"/.test(cabecera)
    ? cabecera.replace(/\bcount="\d+"/, `count="${total}"`)
    : cabecera.replace(/\/?>$/, ` count="${total}">`)
  const bloque = `${abre.replace(/\/>$/, '>')}${s.cuerpo}${nuevo}</${nombre}>`
  return { xml: xml.slice(0, s.inicio) + bloque + xml.slice(s.fin), indice: elementos.length }
}

/** El `numFmtId` del código pedido, declarándolo si el libro no lo tiene. */
function asegurarNumFmt(xml: string, codigo: string): { xml: string; id: number } {
  const s = seccion(xml, 'numFmts')
  const ids: number[] = []
  for (const m of s.cuerpo.matchAll(/<numFmt\b[^>]*\bnumFmtId="(\d+)"[^>]*\bformatCode="([^"]*)"/g)) {
    ids.push(Number(m[1]))
    if (desescapar(m[2] ?? '') === codigo) return { xml, id: Number(m[1]) }
  }
  // Los de serie llegan hasta el 163; el primero libre a partir del 164.
  let id = 164
  while (ids.includes(id)) id++
  const r = asegurarEnLista(
    xml,
    'numFmts',
    'numFmt',
    (e) => e,
    `<numFmt numFmtId="${id}" formatCode="${codigo.replace(/"/g, '&quot;')}"/>`,
  )
  return { xml: r.xml, id }
}

// --- Firmas: lo que pinta cada entrada, sin los bytes con los que se escribió --

function valorDe(elemento: string, etiqueta: string): string | null {
  const m = new RegExp(`<${etiqueta}\\b([^>]*?)/?>`).exec(elemento)
  if (!m) return null
  return /\bval="([^"]*)"/.exec(m[1]!)?.[1] ?? ''
}

/** `<b/>`, `<b val="1"/>` y `<b val="true"/>` son lo mismo; `<b val="0"/>` no. */
function bandera(elemento: string, etiqueta: string): boolean {
  const v = valorDe(elemento, etiqueta)
  return v !== null && v !== '0' && v !== 'false'
}

/** `00FFFFFF`, `FFFFFFFF` y `FFFFFF` son el mismo blanco. */
function colorDe(trozo: string): string {
  const rgb = /\brgb="([0-9A-Fa-f]+)"/.exec(trozo)?.[1]
  if (rgb) return rgb.slice(-6).toUpperCase()
  const theme = /\btheme="(\d+)"/.exec(trozo)?.[1]
  if (theme) return `theme:${theme}`
  const indexed = /\bindexed="(\d+)"/.exec(trozo)?.[1]
  if (indexed) return `indexed:${indexed}`
  return ''
}

function firmaDeFuente(font: string): string {
  const color = /<color\b[^>]*\/?>/.exec(font)?.[0] ?? ''
  return [
    valorDe(font, 'name') ?? '',
    valorDe(font, 'sz') ?? '',
    bandera(font, 'b') ? 'b' : '',
    bandera(font, 'i') ? 'i' : '',
    bandera(font, 'u') ? 'u' : '',
    bandera(font, 'strike') ? 's' : '',
    colorDe(color),
  ].join('|')
}

function firmaDeRelleno(fill: string): string {
  const pattern = /\bpatternType="([^"]*)"/.exec(fill)?.[1] ?? 'none'
  if (pattern === 'none') return 'none'
  const fg = /<fgColor\b[^>]*\/?>/.exec(fill)?.[0] ?? ''
  return `${pattern}|${colorDe(fg)}`
}

function firmaDeBorde(border: string): string {
  return ['left', 'right', 'top', 'bottom']
    .map((lado) => {
      const m = new RegExp(`<${lado}\\b([^>]*?)(/>|>([\\s\\S]*?)</${lado}>)`).exec(border)
      if (!m) return 'none'
      const estilo = /\bstyle="([^"]*)"/.exec(m[1]!)?.[1] ?? 'none'
      return estilo === 'none' ? 'none' : `${estilo}:${colorDe(m[3] ?? '')}`
    })
    .join('|')
}

/** En un `dxf` Excel pone el color del fondo sólido en `bgColor`, otros en `fgColor`. */
function firmaDeDxf(dxf: string): string {
  const fill = /<fill\b[\s\S]*?<\/fill>/.exec(dxf)?.[0] ?? ''
  const bg = /<bgColor\b[^>]*\/?>/.exec(fill)?.[0]
  const fg = /<fgColor\b[^>]*\/?>/.exec(fill)?.[0]
  const fuente = /<font\b[\s\S]*?<\/font>/.exec(dxf)?.[0]
  return `${colorDe(bg ?? fg ?? '')}|${fuente ? firmaDeFuente(fuente) : ''}`
}

/**
 * Un `xf` se compara por lo que apunta, no por sus números: dos fuentes
 * iguales en índices distintos siguen siendo la misma fuente.
 */
function firmaDeXf(xf: string, stylesXml: string): string {
  const numFmtId = Number(/\bnumFmtId="(\d+)"/.exec(xf)?.[1] ?? 0)
  const fontId = Number(/\bfontId="(\d+)"/.exec(xf)?.[1] ?? 0)
  const fillId = Number(/\bfillId="(\d+)"/.exec(xf)?.[1] ?? 0)
  const borderId = Number(/\bborderId="(\d+)"/.exec(xf)?.[1] ?? 0)
  const fonts = elementosDe(seccion(stylesXml, 'fonts').cuerpo, 'font')
  const fills = elementosDe(seccion(stylesXml, 'fills').cuerpo, 'fill')
  const borders = elementosDe(seccion(stylesXml, 'borders').cuerpo, 'border')

  const codigo = (() => {
    const s = seccion(stylesXml, 'numFmts').cuerpo
    const m = new RegExp(`<numFmt\\b[^>]*\\bnumFmtId="${numFmtId}"[^>]*\\bformatCode="([^"]*)"`).exec(s)
    return m ? desescapar(m[1] ?? '') : `#${numFmtId}`
  })()
  const al = /<alignment\b([^>]*?)\/?>/.exec(xf)?.[1] ?? ''
  const alineacion = [
    /\bhorizontal="([^"]*)"/.exec(al)?.[1] ?? '',
    /\bvertical="([^"]*)"/.exec(al)?.[1] ?? '',
    /\bwrapText="(1|true)"/.test(al) ? 'wrap' : '',
  ].join(',')

  return [
    codigo,
    firmaDeFuente(fonts[fontId] ?? ''),
    firmaDeRelleno(fills[fillId] ?? ''),
    firmaDeBorde(borders[borderId] ?? ''),
    alineacion,
  ].join('||')
}

// --- Cómo se escribe lo nuevo, en la forma que usa Excel ---------------------

function xmlDeFuente(f: Receta['fuente']): string {
  return (
    `<font>${f.negrita ? '<b/>' : ''}${f.cursiva ? '<i/>' : ''}<sz val="${f.tamano}"/>` +
    `${f.color ? `<color rgb="FF${f.color}"/>` : ''}<name val="${f.nombre}"/><family val="2"/></font>`
  )
}

function xmlDeRelleno(rgb: string | null): string {
  if (!rgb) return '<fill><patternFill patternType="none"/></fill>'
  return `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor indexed="64"/></patternFill></fill>`
}

function xmlDeBorde(fino: boolean): string {
  if (!fino) return '<border><left/><right/><top/><bottom/><diagonal/></border>'
  const lado = (l: string) => `<${l} style="thin"><color rgb="FF${COLOR_DEL_BORDE}"/></${l}>`
  return `<border>${lado('left')}${lado('right')}${lado('top')}${lado('bottom')}<diagonal/></border>`
}

function xmlDeXf(
  numFmtId: number,
  fontId: number,
  fillId: number,
  borderId: number,
  a: Receta['alineacion'],
): string {
  const conAlineacion = a.horizontal !== null || a.vertical !== null || a.ajustar
  const attrs =
    `numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"` +
    `${numFmtId ? ' applyNumberFormat="1"' : ''} applyFont="1"${fillId ? ' applyFill="1"' : ''}` +
    `${borderId ? ' applyBorder="1"' : ''}${conAlineacion ? ' applyAlignment="1"' : ''}`
  if (!conAlineacion) return `<xf ${attrs}/>`
  const al =
    `<alignment${a.horizontal ? ` horizontal="${a.horizontal}"` : ''}` +
    `${a.vertical ? ` vertical="${a.vertical}"` : ''}${a.ajustar ? ' wrapText="1"' : ''}/>`
  return `<xf ${attrs}>${al}</xf>`
}
