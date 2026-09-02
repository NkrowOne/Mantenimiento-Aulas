/**
 * Mover filas de sitio sin que el libro se entere de nada más.
 *
 * `xlsx.ts` resuelve escribir **dentro** de una celda que ya existe. Esto
 * resuelve lo otro: que aparezcan filas nuevas y desaparezcan las viejas, que es
 * lo que hace falta cuando en la aplicación se da de alta un aula o se archiva
 * una. Y es una operación de otra naturaleza, porque **el número de fila no es
 * un dato de la fila: es su posición**. Insertar una arriba mueve las 400 de
 * abajo, y con ellas todo lo que en el fichero apunta a una posición:
 *
 *   - las referencias de cada celda (`<c r="M87">`) y de cada `<row r="87">`
 *   - las **celdas combinadas**, que en la hoja de estado son 30 pares de filas
 *   - el rango del **autofiltro** (`A1:X416`)
 *   - los cuatro `sqref` de **formato condicional** de la columna `G`, que traen
 *     huecos a propósito (`G1:G106 G111:G114 …`) y hay que respetar hueco a hueco
 *   - la **validación de datos**, los hipervínculos, el panel inmovilizado y la
 *     celda activa
 *   - el ancla de cada **comentario**, que vive en dos sitios a la vez:
 *     `comments1.xml` con la referencia y el `.vml` con fila y columna en base 0
 *   - las **fórmulas**, incluidas las de las otras hojas que miren a ésta
 *   - `<dimension>`, que es lo que Excel lee para saber de qué tamaño es la hoja
 *
 * Olvidar cualquiera de esos sitios no da un error: da un libro que abre y
 * miente. El comentario «La TV está estropeada» aparece en el aula de al lado, o
 * el degradado del `% Lámparas` colorea la fila equivocada. Por eso aquí no hay
 * un desplazamiento incremental sino **un plan que se calcula una vez** —qué
 * número tiene ahora cada fila de antes— y una sola pasada que lo aplica en
 * todos esos sitios con la misma función.
 *
 * Tres decisiones que no son de estilo:
 *
 * **Las fórmulas se remapean aunque lleven `$`.** El dólar sirve para copiar y
 * rellenar, no para insertar: al meter una fila, Excel mueve también las
 * referencias absolutas. Respetar el `$` aquí sería justo lo contrario de imitar
 * a Excel.
 *
 * **`calcChain.xml` se tira.** Es una caché del orden en que Excel recalculó la
 * última vez, apunta a celdas por posición y no hay forma barata de mantenerla
 * correcta. Un `calcChain` que apunta a una celda que ya no tiene fórmula es de
 * los pocos destrozos que Excel sí denuncia, y como fichero opcional que es, se
 * regenera solo al abrir. Vale más borrarlo que arriesgarse a acertarlo.
 *
 * **Insertar detrás de una fila que se borra es un error, no un apaño.** Las dos
 * órdenes juntas no significan nada —¿va antes o después del hueco?— y elegir
 * una por el que llama es adivinar por él.
 */

import { columnaANumero, escapar, numeroAColumna, partirCelda, xmlDeCelda } from './xlsx'
import type { Cambio, ResolverEstilo } from './xlsx'

/** El último número de fila que admite una hoja de Excel. */
export const FILA_MAXIMA = 1_048_576

// -----------------------------------------------------------------------------
// El plan
// -----------------------------------------------------------------------------

export interface FilaNueva {
  /**
   * Va **justo detrás** de esta fila de la hoja original. `0` la pone la
   * primera. Varias filas con el mismo `tras` salen en el orden en que vengan.
   */
  tras: number
  celdas: Cambio[]
  /**
   * De qué fila original copiar el estilo, si no es de `tras`. Una fila nueva
   * sin estilo se ve: sin bordes, sin el formato de fecha y sin el `0%` de la
   * columna de lámparas.
   */
  estiloDe?: number
}

export interface EdicionDeFilas {
  /** Filas de la hoja original que desaparecen. */
  borrar?: number[]
  insertar?: FilaNueva[]
}

/**
 * Qué número tiene ahora cada fila de antes.
 *
 * Se puede preguntar por **cualquier** fila, exista o no en el XML: una hoja
 * tiene 1.048.576 posiciones y los rangos las usan todas (`G310:G1048576`). Las
 * que no están en el fichero son filas vacías, y también se mueven.
 */
export interface MapaDeFilas {
  /** El número nuevo de una fila de antes, o `null` si esa fila se borró. */
  nuevo(fila: number): number | null
  /** Como `nuevo`, pero si la fila se borró devuelve la siguiente que quedó. */
  haciaAbajo(fila: number): number | null
  /** Como `nuevo`, pero si la fila se borró devuelve la anterior que quedó. */
  haciaArriba(fila: number): number | null
  /** Dónde ha quedado cada fila insertada, en el orden en que se pidieron. */
  insertadas: number[]
  /** `true` si el plan no mueve ni borra nada. */
  vacio: boolean
}

export function planificar(edicion: EdicionDeFilas): MapaDeFilas {
  const borrar = [...new Set(edicion.borrar ?? [])].sort((a, b) => a - b)
  const insertar = edicion.insertar ?? []
  const borradas = new Set(borrar)

  for (const ins of insertar) {
    if (borradas.has(ins.tras)) {
      throw new Error(
        `Se pide insertar detrás de la fila ${ins.tras} y a la vez borrarla: no se puede saber dónde va`,
      )
    }
    if (ins.tras < 0) throw new Error(`«tras: ${ins.tras}» no es una fila`)
  }

  // Cuántas se insertan detrás de cada fila, y cuántas se borran hasta cada
  // punto. Con las dos cuentas, el número nuevo de una fila sale de una resta.
  const trasOrdenados = [...insertar].map((i) => i.tras).sort((a, b) => a - b)

  const insertadasAntesDe = (fila: number): number => contarMenores(trasOrdenados, fila)
  const borradasAntesDe = (fila: number): number => contarMenores(borrar, fila)

  const nuevo = (fila: number): number | null => {
    if (borradas.has(fila)) return null
    return fila + insertadasAntesDe(fila) - borradasAntesDe(fila)
  }

  // Dónde cae cada fila insertada: detrás de la posición nueva de su `tras`, y
  // en el orden de petición cuando varias comparten el mismo.
  const vistas = new Map<number, number>()
  const insertadas = insertar.map((ins) => {
    const orden = vistas.get(ins.tras) ?? 0
    vistas.set(ins.tras, orden + 1)
    const base =
      ins.tras === 0 ? 0 : ins.tras + insertadasAntesDe(ins.tras) - borradasAntesDe(ins.tras)
    return base + 1 + orden
  })

  const haciaAbajo = (fila: number): number | null => {
    let f = fila
    while (f <= FILA_MAXIMA && borradas.has(f)) f++
    return f > FILA_MAXIMA ? null : nuevo(f)
  }
  const haciaArriba = (fila: number): number | null => {
    let f = fila
    while (f >= 1 && borradas.has(f)) f--
    return f < 1 ? null : nuevo(f)
  }

  return {
    nuevo,
    haciaAbajo,
    haciaArriba,
    insertadas,
    vacio: borrar.length === 0 && insertar.length === 0,
  }
}

/** Cuántos elementos del array ordenado son estrictamente menores que `x`. */
function contarMenores(ordenados: number[], x: number): number {
  let lo = 0
  let hi = ordenados.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (ordenados[m]! < x) lo = m + 1
    else hi = m
  }
  return lo
}

// -----------------------------------------------------------------------------
// Rangos
// -----------------------------------------------------------------------------

/**
 * Remapea un rango (`A1:X416`), una celda suelta (`G1`) o una columna entera
 * (`G:G`). Devuelve `null` si el rango se quedó sin ninguna fila.
 *
 * Los extremos se tratan distinto a propósito: el principio busca hacia abajo y
 * el final hacia arriba, que es lo que mantiene el rango dentro de lo que queda
 * cuando se borra justo un borde.
 */
export function remapearRango(ref: string, mapa: MapaDeFilas): string | null {
  const partes = ref.split(':')
  if (partes.length === 1) {
    const uno = remapearCelda(partes[0]!, mapa)
    return uno
  }
  if (partes.length !== 2) return ref

  const a = descomponer(partes[0]!)
  const b = descomponer(partes[1]!)
  if (!a || !b) return ref
  // `G:G` — columnas enteras, sin filas que mover.
  if (a.fila === null && b.fila === null) return ref
  if (a.fila === null || b.fila === null) return ref

  const desde = mapa.haciaAbajo(a.fila)
  const hasta = mapa.haciaArriba(b.fila)
  if (desde === null || hasta === null || desde > hasta) return null

  return `${a.columna}${a.dolarFila}${limitar(desde)}:${b.columna}${b.dolarFila}${limitar(hasta)}`
}

/** Una celda suelta dentro de un `sqref`: si su fila se borró, desaparece. */
function remapearCelda(ref: string, mapa: MapaDeFilas): string | null {
  const c = descomponer(ref)
  if (!c || c.fila === null) return ref
  const n = mapa.nuevo(c.fila)
  if (n === null) return null
  return `${c.columna}${c.dolarFila}${limitar(n)}`
}

interface Descompuesta {
  /** Incluye el `$` de la columna si lo lleva: `$A`. */
  columna: string
  dolarFila: string
  fila: number | null
}

function descomponer(ref: string): Descompuesta | null {
  const m = /^(\$?[A-Za-z]+)(\$?)(\d+)?$/.exec(ref.trim())
  if (!m) return null
  return {
    columna: m[1]!.toUpperCase(),
    dolarFila: m[3] === undefined ? '' : m[2]!,
    fila: m[3] === undefined ? null : Number(m[3]),
  }
}

function limitar(fila: number): number {
  return Math.min(fila, FILA_MAXIMA)
}

/**
 * Si una fila no lleva nada dentro.
 *
 * Las 1.500 filas del final de las hojas de partes existen solo por su estilo:
 * alguien pintó la hoja entera hace años y Excel guardó un `<row>` por cada una.
 * Vacías se pueden tirar sin perder nada, que es lo que hace Excel cuando lo que
 * se cae por abajo al insertar está vacío.
 */
function filaSinDatos(interior: string | undefined): boolean {
  if (!interior) return true
  // Una celda cuenta si tiene valor, texto o fórmula. Una `<c r="A9" s="3"/>`
  // es formato, no dato.
  return !/<(v|is|f)\b/.test(interior)
}

/** Un `sqref` es una lista de rangos separados por espacios. Los vacíos caen. */
export function remapearSqref(sqref: string, mapa: MapaDeFilas): string | null {
  const vivos = sqref
    .split(/\s+/)
    .filter(Boolean)
    .map((r) => remapearRango(r, mapa))
    .filter((r): r is string => r !== null)
  return vivos.length === 0 ? null : vivos.join(' ')
}

// -----------------------------------------------------------------------------
// Fórmulas
// -----------------------------------------------------------------------------

/**
 * Remapea las referencias de fila de una fórmula.
 *
 * Se salta lo que va entre comillas —`"A1 no es una referencia"`— y las
 * funciones cuyo nombre acaba en letra seguida de números no existen, así que
 * basta con exigir que delante de la referencia no haya un carácter de nombre.
 * Una referencia a una fila borrada se convierte en `#REF!`, que es lo que hace
 * Excel y lo que hace visible el destrozo en vez de esconderlo.
 */
export function remapearFormula(formula: string, mapa: MapaDeFilas): string {
  let out = ''
  let i = 0
  while (i < formula.length) {
    const c = formula[i]!
    if (c === '"') {
      const fin = formula.indexOf('"', i + 1)
      const hasta = fin < 0 ? formula.length : fin + 1
      out += formula.slice(i, hasta)
      i = hasta
      continue
    }
    // `'Hoja con espacios'!A1` — el nombre de hoja va entre apóstrofos.
    if (c === "'") {
      const fin = formula.indexOf("'", i + 1)
      const hasta = fin < 0 ? formula.length : fin + 1
      out += formula.slice(i, hasta)
      i = hasta
      continue
    }
    const m = /^(\$?)([A-Z]{1,3})(\$?)(\d{1,7})(?![\d(])/.exec(formula.slice(i))
    const anterior = i === 0 ? '' : formula[i - 1]!
    if (m && !/[A-Za-z0-9_.]/.test(anterior)) {
      const fila = Number(m[4])
      const n = mapa.nuevo(fila)
      out += n === null ? '#REF!' : `${m[1]}${m[2]}${m[3]}${limitar(n)}`
      i += m[0].length
      continue
    }
    out += c
    i++
  }
  return out
}

// -----------------------------------------------------------------------------
// La hoja
// -----------------------------------------------------------------------------

/**
 * Aplica el plan al XML de una hoja: borra filas, mueve las que quedan, mete las
 * nuevas y corrige todos los rangos que hay dentro del propio fichero de hoja.
 *
 * Lo de fuera —comentarios, dibujos, nombres definidos, las fórmulas de las
 * otras hojas— lo hace `editarLibro`, que es quien tiene acceso a esos ficheros.
 */
export function editarHojaXml(
  xml: string,
  edicion: EdicionDeFilas,
  mapa: MapaDeFilas,
  resolver?: ResolverEstilo,
): string {
  if (mapa.vacio) return xml

  const insertar = edicion.insertar ?? []
  const estilos = estilosPorFila(xml)

  // 1 — Las filas que quedan: nuevo número, y las referencias de sus celdas y
  //     de sus fórmulas con él.
  let cuerpo = xml.replace(
    /<row\b([^>]*)\/>|<row\b([^>]*)>([\s\S]*?)<\/row>/g,
    (todo, a1: string, a2: string, interior: string) => {
      const attrs = a1 ?? a2 ?? ''
      const vieja = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? 0)
      if (!vieja) return todo
      const nueva = mapa.nuevo(vieja)
      if (nueva === null) return ''

      // Empujar una fila más allá de la última de Excel deja un libro inválido,
      // y este libro está a un palmo: las dos hojas de partes traen 1.960 filas
      // con estilo que llegan hasta la 1048559, así que **dieciocho** partes
      // nuevos bastan para pasarse. No se puede recortar el número —dos filas
      // con la misma `r` tampoco es un libro— así que se hace lo que hace Excel
      // al insertar: la fila que se cae por abajo desaparece si está vacía, y si
      // lleva algo, no se inserta y se dice por qué.
      if (nueva > FILA_MAXIMA) {
        if (filaSinDatos(interior)) return ''
        throw new Error(
          `No caben más filas: la ${vieja} pasaría a la ${nueva} y la última de Excel es la ${FILA_MAXIMA}. Hay datos en la parte de abajo de la hoja que habría que quitar antes.`,
        )
      }

      const nuevosAttrs = attrs.replace(/\br="\d+"/, `r="${nueva}"`)
      // Una fila sin `spans` es válida; una con `spans` viejo también, porque es
      // una pista de rendimiento y no una verdad. Lo que no vale es un `r` viejo.
      if (a1 !== undefined) return `<row${nuevosAttrs}/>`
      return `<row${nuevosAttrs}>${renumerarCeldas(interior ?? '', vieja, nueva, mapa)}</row>`
    },
  )

  // 2 — Las filas nuevas, cada una en su sitio y con el estilo de su vecina.
  for (const [i, ins] of insertar.entries()) {
    const destino = mapa.insertadas[i]!
    const modelo = ins.estiloDe ?? ins.tras
    cuerpo = insertarFilaXml(
      cuerpo,
      destino,
      ins.celdas,
      estilos.get(modelo) ?? new Map(),
      estilos.get(modelo + 1),
      resolver,
    )
  }

  // 3 — Todo lo que dentro de la hoja apunta a una posición.
  cuerpo = corregirRangos(cuerpo, mapa)

  return cuerpo
}

/** Referencias de celda y fórmulas de una fila que cambia de número. */
function renumerarCeldas(interior: string, vieja: number, nueva: number, mapa: MapaDeFilas): string {
  return interior.replace(
    /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g,
    (todo, a1: string, a2: string, contenido: string) => {
      const attrs = a1 ?? a2 ?? ''
      const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs)
      if (!ref) return todo
      const nuevosAttrs =
        vieja === nueva ? attrs : attrs.replace(/\br="[A-Z]+\d+"/, `r="${ref[1]}${nueva}"`)
      if (a1 !== undefined) return `<c${nuevosAttrs}/>`

      const nuevoContenido = (contenido ?? '').replace(
        /(<f\b[^>]*>)([\s\S]*?)(<\/f>)/g,
        (_t, abre: string, formula: string, cierra: string) =>
          `${abre}${escapar(remapearFormula(desescaparFormula(formula), mapa))}${cierra}`,
      )
      return `<c${nuevosAttrs}>${corregirRefDeFormula(nuevoContenido, mapa)}</c>`
    },
  )
}

/** El atributo `ref` de una fórmula compartida o de matriz (`<f ref="N2:N44">`). */
function corregirRefDeFormula(contenido: string, mapa: MapaDeFilas): string {
  return contenido.replace(/<f\b([^>]*)>/g, (todo, attrs: string) => {
    const m = /\bref="([^"]+)"/.exec(attrs)
    if (!m) return todo
    const nuevo = remapearRango(m[1]!, mapa)
    // Sin rango la fórmula compartida no puede existir: se queda sola, que es
    // válido y lo peor que puede pasar es que Excel la recalcule de más.
    const attrsNuevos =
      nuevo === null ? attrs.replace(/\s*\bref="[^"]+"/, '') : attrs.replace(/\bref="[^"]+"/, `ref="${nuevo}"`)
    return `<f${attrsNuevos}>`
  })
}

function desescaparFormula(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** El `s=` de cada celda de cada fila, para que las nuevas hereden el formato. */
function estilosPorFila(xml: string): Map<number, Map<string, string>> {
  const out = new Map<number, Map<string, string>>()
  for (const mf of xml.matchAll(/<row\b([^>]*)\/>|<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const attrs = mf[1] ?? mf[2] ?? ''
    const fila = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? 0)
    if (!fila) continue
    const porColumna = new Map<string, string>()
    for (const mc of (mf[3] ?? '').matchAll(/<c\b([^>]*?)\/>|<c\b([^>]*?)>/g)) {
      const ca = mc[1] ?? mc[2] ?? ''
      const ref = /\br="([A-Z]+)\d+"/.exec(ca)?.[1]
      if (!ref) continue
      porColumna.set(ref, /\bs="(\d+)"/.exec(ca)?.[1] ?? '')
    }
    // La altura y el estilo de la propia fila también se copian.
    porColumna.set('#row', attrs.replace(/\br="\d+"\s*/, '').replace(/\bspans="[^"]*"\s*/, '').trim())
    out.set(fila, porColumna)
  }
  return out
}

function insertarFilaXml(
  xml: string,
  fila: number,
  celdas: Cambio[],
  estilo: Map<string, string>,
  respaldo: Map<string, string> | undefined,
  resolver?: ResolverEstilo,
): string {
  const conValor = celdas.filter((c) => c.valor !== null)
  const attrsFila = estilo.get('#row') ?? respaldo?.get('#row') ?? ''
  const ordenadas = [...conValor].sort(
    (a, b) =>
      columnaANumero(partirCelda(a.celda).columna) - columnaANumero(partirCelda(b.celda).columna),
  )

  // Cada celda por su columna, para poder añadir después las que la fila nueva
  // no rellena y sacarlas todas en orden: el XML de una fila lo exige.
  const porColumna = new Map<string, string>()
  for (const c of ordenadas) {
    const col = partirCelda(c.celda).columna
    const heredado = estilo.get(col) ?? respaldo?.get(col) ?? ''
    // Una fila nueva hereda el estilo de la fila detrás de la que cae, y en la
    // columna «Fecha Revisión» eso es una lotería: media columna del libro se
    // quedó en «General» porque nunca tuvo fecha. Si la celda dice de qué es
    // —`formato: 'fecha'`— se le pide al mismo resolvedor que ya usa la
    // escritura normal un estilo que de verdad la pinte. Sin él, un aula nueva
    // estrena su revisión enseñando `46218`.
    const s = (c.formato && resolver ? resolver(col, c.formato, heredado) : null) ?? heredado
    // Una fórmula de una fila nueva no puede saber de antemano en qué fila va
    // a caer: entre que se planifica y se escribe se borran e insertan otras.
    // Lleva `{f}` donde va el número, y se pone aquí, que es el único sitio que
    // lo sabe. Antes venía ya resuelto desde el plan con el número de la
    // primera fila nueva, y las veinte siguientes salían todas sumando la
    // fila de la primera.
    const valor =
      typeof c.valor === 'string' && c.valor.startsWith('=')
        ? c.valor.replace(/\{f\}/g, String(fila))
        : (c.valor as string | number | boolean)
    porColumna.set(col, xmlDeCelda(`${col}${fila}`, s, valor))
  }

  // Las celdas que la fila nueva no rellena también llevan su estilo. Sin esto
  // salían sin `<c>`, o sea sin borde, con la fuente por defecto y sin formato
  // de fecha: un hueco en la cuadrícula justo en la fila que acaba de entrar.
  const fuente = estilo.size ? estilo : (respaldo ?? new Map<string, string>())
  for (const [col, s] of fuente) {
    if (col === '#row' || !s || porColumna.has(col)) continue
    porColumna.set(col, `<c r="${col}${fila}" s="${s}"/>`)
  }

  const cuerpo = [...porColumna.entries()]
    .sort((a, b) => columnaANumero(a[0]) - columnaANumero(b[0]))
    .map(([, x]) => x)
    .join('')

  const nueva = `<row r="${fila}"${attrsFila ? ` ${attrsFila}` : ''}>${cuerpo}</row>`

  for (const m of xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)) {
    if (Number(m[1]) > fila) return xml.slice(0, m.index) + nueva + xml.slice(m.index)
  }
  const cierre = xml.lastIndexOf('</sheetData>')
  if (cierre < 0) throw new Error('La hoja no tiene <sheetData>: no es una hoja de cálculo normal')
  return xml.slice(0, cierre) + nueva + xml.slice(cierre)
}

/**
 * Los rangos que viven en el propio fichero de la hoja.
 *
 * `<mergeCells count="30">` lleva la cuenta escrita: si una fusión desaparece
 * porque se borraron sus dos filas y el número no baja, Excel avisa de que el
 * fichero tiene un problema.
 */
function corregirRangos(xml: string, mapa: MapaDeFilas): string {
  let out = xml

  out = out.replace(/<dimension\b[^>]*\bref="([^"]+)"[^>]*\/>/g, (todo, ref: string) => {
    const nuevo = remapearRango(ref, mapa)
    return nuevo === null ? todo : todo.replace(`ref="${ref}"`, `ref="${nuevo}"`)
  })

  // Fusiones: las que se quedan sin filas se van, y la cuenta se rehace.
  out = out.replace(/<mergeCells\b([^>]*)>([\s\S]*?)<\/mergeCells>/g, (_todo, attrs: string, interior: string) => {
    const vivas: string[] = []
    for (const m of interior.matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"[^>]*\/>/g)) {
      const nuevo = remapearRango(m[1]!, mapa)
      // Una fusión de una sola celda no es una fusión: Excel la rechaza.
      if (nuevo === null || !nuevo.includes(':')) continue
      const [a, b] = nuevo.split(':')
      if (a === b) continue
      vivas.push(`<mergeCell ref="${nuevo}"/>`)
    }
    if (vivas.length === 0) return ''
    const nuevosAttrs = attrs.replace(/\bcount="\d+"/, `count="${vivas.length}"`)
    return `<mergeCells${nuevosAttrs}>${vivas.join('')}</mergeCells>`
  })

  out = out.replace(/<autoFilter\b([^>]*)\bref="([^"]+)"/g, (todo, _a: string, ref: string) => {
    const nuevo = remapearRango(ref, mapa)
    return nuevo === null ? todo : todo.replace(`ref="${ref}"`, `ref="${nuevo}"`)
  })

  // Formato condicional: el bloque entero desaparece si se queda sin rango.
  out = out.replace(
    /<conditionalFormatting\b([^>]*)\bsqref="([^"]+)"([^>]*)>([\s\S]*?)<\/conditionalFormatting>/g,
    (todo, _a: string, sqref: string) => {
      const nuevo = remapearSqref(sqref, mapa)
      return nuevo === null ? '' : todo.replace(`sqref="${sqref}"`, `sqref="${nuevo}"`)
    },
  )
  out = out.replace(/<conditionalFormatting\b([^>]*)\bsqref="([^"]+)"([^>]*)\/>/g, (todo, _a, sqref: string) => {
    const nuevo = remapearSqref(sqref, mapa)
    return nuevo === null ? '' : todo.replace(`sqref="${sqref}"`, `sqref="${nuevo}"`)
  })

  out = out.replace(/<dataValidation\b([^>]*)\bsqref="([^"]+)"/g, (todo, _a: string, sqref: string) => {
    const nuevo = remapearSqref(sqref, mapa)
    return nuevo === null ? todo : todo.replace(`sqref="${sqref}"`, `sqref="${nuevo}"`)
  })

  out = out.replace(/<hyperlink\b([^>]*)\bref="([^"]+)"/g, (todo, _a: string, ref: string) => {
    const nuevo = remapearRango(ref, mapa)
    return nuevo === null ? todo : todo.replace(`ref="${ref}"`, `ref="${nuevo}"`)
  })

  // El panel inmovilizado y la celda seleccionada. Que la fila 2 siga siendo la
  // fila 2 después de insertar arriba es exactamente el sentido de esto.
  out = out.replace(/<pane\b([^>]*)\btopLeftCell="([^"]+)"/g, (todo, _a: string, ref: string) => {
    const nuevo = remapearRango(ref, mapa)
    return nuevo === null ? todo : todo.replace(`topLeftCell="${ref}"`, `topLeftCell="${nuevo}"`)
  })
  out = out.replace(/<selection\b([^>]*)>/g, (_todo, attrs: string) => {
    let nuevos = attrs
    const act = /\bactiveCell="([^"]+)"/.exec(attrs)
    if (act) {
      const n = remapearRango(act[1]!, mapa)
      if (n !== null) nuevos = nuevos.replace(`activeCell="${act[1]}"`, `activeCell="${n}"`)
    }
    const sq = /\bsqref="([^"]+)"/.exec(nuevos)
    if (sq) {
      const n = remapearSqref(sq[1]!, mapa)
      if (n !== null) nuevos = nuevos.replace(`sqref="${sq[1]}"`, `sqref="${n}"`)
    }
    return `<selection${nuevos}>`
  })

  return out
}

// -----------------------------------------------------------------------------
// Lo que vive fuera de la hoja
// -----------------------------------------------------------------------------

/** `comments1.xml`: cada comentario está anclado a una celda. */
export function corregirComentarios(xml: string, mapa: MapaDeFilas): string {
  return xml.replace(/<comment\b([^>]*)\bref="([^"]+)"([^>]*)>([\s\S]*?)<\/comment>/g, (todo, _a, ref: string) => {
    const nuevo = remapearRango(ref, mapa)
    // Un comentario cuya celda se borró se va con ella.
    return nuevo === null ? '' : todo.replace(`ref="${ref}"`, `ref="${nuevo}"`)
  })
}

/**
 * El `.vml` del cuadrito amarillo: fila y columna van **en base 0** y en
 * elementos aparte (`<x:Row>204</x:Row>` es la fila 205 de la hoja).
 *
 * Se trabaja forma a forma, y no elemento a elemento, por dos cosas que solo se
 * ven desde la forma entera:
 *
 * **La forma de un comentario borrado se va con él.** `corregirComentarios` quita
 * el `<comment>` cuya fila desapareció; si aquí se dejara su `<v:shape>`, los dos
 * ficheros dejarían de tener el mismo número de elementos. Y Excel **los empareja
 * por orden**, así que a partir del que falta cada comentario cuelga del recuadro
 * del siguiente: «La TV está estropeada» aparecería en el aula de al lado.
 *
 * **El `<x:Anchor>` también lleva filas.** Son ocho números —columna, desfase,
 * fila, desfase, y otra vez para la esquina de abajo— y las dos filas, la 3.ª y
 * la 7.ª, son las que de verdad colocan el recuadro. Moviendo solo `<x:Row>` el
 * comentario apunta a la celda buena y se dibuja donde estaba.
 */
export function corregirVml(xml: string, mapa: MapaDeFilas): string {
  return xml.replace(/<v:shape\b[\s\S]*?<\/v:shape>/g, (forma) => {
    const m = /<x:Row>(\d+)<\/x:Row>/.exec(forma)
    if (!m) return forma

    const anclada = mapa.nuevo(Number(m[1]) + 1)
    // Su fila ya no está: el comentario tampoco, y la forma se va con él.
    if (anclada === null) return ''

    return forma
      .replace(/<x:Row>\d+<\/x:Row>/, `<x:Row>${anclada - 1}</x:Row>`)
      .replace(/<x:Anchor>([^<]*)<\/x:Anchor>/, (todo, lista: string) => {
        const n = lista.split(',').map((x) => x.trim())
        if (n.length !== 8) return todo
        // La de arriba busca hacia abajo y la de abajo hacia arriba, igual que
        // los extremos de un rango: es lo que mantiene el recuadro dentro de lo
        // que queda cuando se borra justo uno de sus bordes.
        const arriba = mapa.haciaAbajo(Number(n[2]) + 1)
        const abajo = mapa.haciaArriba(Number(n[6]) + 1)
        n[2] = String((arriba ?? anclada) - 1)
        n[6] = String((abajo ?? anclada) - 1)
        return `<x:Anchor>${n.join(',')}</x:Anchor>`
      })
  })
}

/**
 * Nombres definidos y fórmulas de otras hojas que apuntan a la que se edita.
 *
 * Solo se tocan las referencias que **nombran** la hoja (`'Bolsa 2026'!N5`): una
 * referencia sin nombre de hoja apunta a la hoja donde está escrita, que no es
 * ésta.
 */
export function corregirReferenciasExternas(xml: string, hoja: string, mapa: MapaDeFilas): string {
  const nombre = hoja.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patron = new RegExp(`('${nombre}'|${nombre})!(\\$?[A-Z]{1,3}\\$?\\d{1,7})`, 'g')
  return xml.replace(patron, (_todo, prefijo: string, ref: string) => {
    const nuevo = remapearRango(ref, mapa)
    return nuevo === null ? `${prefijo}!#REF!` : `${prefijo}!${nuevo}`
  })
}

/** El nombre de la hoja tal y como se escribe dentro de una fórmula. */
export function citarHoja(nombre: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(nombre) ? nombre : `'${nombre.replace(/'/g, "''")}'`
}

/** El número de columna de la letra, sin el `$`. */
export function columnaDe(ref: string): number {
  const m = /^\$?([A-Z]+)/.exec(ref.toUpperCase())
  return m ? columnaANumero(m[1]!) : 0
}

/** `A1` a partir de fila y número de columna. */
export function celda(columna: number, fila: number): string {
  return `${numeroAColumna(columna)}${fila}`
}

// -----------------------------------------------------------------------------
// Columnas escondidas
// -----------------------------------------------------------------------------

/**
 * Enseña las columnas en las que se acaba de escribir.
 *
 * En la hoja `Bolsa 2026` las columnas `B` y `C` —enero y febrero— están
 * **ocultas**. Mientras estuvieron vacías daba igual; en cuanto la
 * sincronización reparte ahí el consumo del año, el resultado es peor que no
 * escribirlo: `Total Instalado` es `=B+C+D+…+M`, así que los meses escondidos
 * **suman** y quien abra la hoja ve un total que no cuadra con ninguno de los
 * números que tiene delante. Un descuadre invisible es exactamente lo que esta
 * sincronización existe para quitar.
 *
 * Así que si hay dato, se enseña. Solo las columnas que reciben algo: las que
 * alguien escondió y siguen vacías se quedan como estaban.
 */
export function mostrarColumnas(xml: string, columnas: Set<string>): string {
  if (columnas.size === 0) return xml
  const numeros = new Set([...columnas].map((c) => columnaANumero(c)))

  return xml.replace(/<cols\b[^>]*>([\s\S]*?)<\/cols>/, (todo, interior: string) => {
    let tocado = false
    const salida: string[] = []

    for (const m of interior.matchAll(/<col\b([^>]*?)\/>/g)) {
      const attrs = m[1] ?? ''
      const min = Number(/\bmin="(\d+)"/.exec(attrs)?.[1] ?? 0)
      const max = Number(/\bmax="(\d+)"/.exec(attrs)?.[1] ?? 0)
      const oculta = /\bhidden="(1|true)"/.test(attrs)

      if (!oculta || !min || !max) {
        salida.push(m[0])
        continue
      }

      // Qué trozos de este rango hay que enseñar y cuáles se quedan.
      const tramos: Array<{ desde: number; hasta: number; ver: boolean }> = []
      for (let n = min; n <= max; n++) {
        const ver = numeros.has(n)
        const ultimo = tramos[tramos.length - 1]
        if (ultimo && ultimo.ver === ver && ultimo.hasta === n - 1) ultimo.hasta = n
        else tramos.push({ desde: n, hasta: n, ver })
      }

      if (tramos.every((t) => !t.ver)) {
        salida.push(m[0])
        continue
      }
      tocado = true

      // Un rango que se parte conserva el resto de atributos —ancho, estilo— en
      // los dos trozos: perderlos cambiaria el aspecto de columnas que nadie ha
      // tocado.
      for (const t of tramos) {
        const base = attrs
          .replace(/\bmin="\d+"/, `min="${t.desde}"`)
          .replace(/\bmax="\d+"/, `max="${t.hasta}"`)
        salida.push(`<col${t.ver ? base.replace(/\s*\bhidden="(?:1|true)"/, '') : base}/>`)
      }
    }

    return tocado ? todo.replace(interior, salida.join('')) : todo
  })
}

/** Las columnas en las que un lote de cambios escribe de verdad. */
export function columnasEscritas(cambios: Cambio[]): Set<string> {
  const out = new Set<string>()
  for (const c of cambios) {
    if (c.valor === null) continue
    const m = /^([A-Z]+)\d+$/.exec(c.celda.toUpperCase())
    if (m) out.add(m[1]!)
  }
  return out
}
