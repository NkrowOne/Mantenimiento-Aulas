/**
 * Leer y **parchear celdas** de un `.xlsx` sin regenerar el libro.
 *
 * Encima de `lib/zip.ts`, que ya garantiza que lo que no se toca vuelve byte a
 * byte. Aquí se resuelve la otra mitad: cambiar el valor de unas celdas
 * concretas tocando lo mínimo del XML de la hoja, y dejar en paz todo lo demás
 * —fórmulas de las otras celdas, formatos condicionales, autofiltro, validación,
 * comentarios, la fila inmovilizada.
 *
 * Tres decisiones que no son de estilo:
 *
 * **Se lee la dirección real de cada celda** (`B87`), no la posición en una
 * lista de filas. Una hoja puede tener filas ocultas, huecos o empezar donde
 * quiera, y «la fila 87 del array» no es «la fila 87 de la hoja». Como la
 * sincronización identifica cada fila por su matrícula y luego tiene que
 * escribir *esa* celda, equivocarse aquí escribe el número de serie en el aula
 * de al lado sin que salte nada.
 *
 * **Al escribir texto se usa `inlineStr`, no la tabla de cadenas compartidas.**
 * Meter una cadena nueva en `sharedStrings.xml` obliga a renumerar índices que
 * otras hojas están usando, y un índice mal movido cambia el texto de celdas que
 * nadie tocó. Con `inlineStr` el texto vive dentro de su propia celda: cuesta
 * unos bytes y no puede estropear nada ajeno.
 *
 * **Se marca el libro para recalcular al abrir** (`fullCalcOnLoad`). Si se
 * cambia una celda de la que depende una fórmula, el valor cacheado de esa
 * fórmula se queda obsoleto dentro del fichero, y quien lo abra ve un número
 * viejo hasta que Excel decida recalcular por su cuenta.
 *
 * El XML de una hoja lo genera Excel y es regular: por eso aquí se trabaja con
 * expresiones regulares sobre `<c>` y `<row>` en vez de con un analizador
 * completo, que no viene ni en el navegador ni en Node sin dependencias. Lo que
 * no encaje con esa forma se dice y se para.
 */

import { descomprimir, escribirZip, leerZip, reemplazar } from '../lib/zip'
import type { EntradaZip } from '../lib/zip'

// -----------------------------------------------------------------------------
// Direcciones de celda
// -----------------------------------------------------------------------------

/** `A` → 1, `Z` → 26, `AA` → 27. */
export function columnaANumero(letras: string): number {
  let n = 0
  for (const c of letras.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64)
  return n
}

/** 1 → `A`, 27 → `AA`. */
export function numeroAColumna(n: number): string {
  let s = ''
  let x = n
  while (x > 0) {
    const r = (x - 1) % 26
    s = String.fromCharCode(65 + r) + s
    x = Math.floor((x - 1) / 26)
  }
  return s
}

export function partirCelda(ref: string): { columna: string; fila: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase())
  if (!m) throw new Error(`«${ref}» no es una referencia de celda`)
  return { columna: m[1]!, fila: Number(m[2]) }
}

// -----------------------------------------------------------------------------
// El libro abierto
// -----------------------------------------------------------------------------

export interface Hoja {
  nombre: string
  /** Ruta dentro del zip: `xl/worksheets/sheet1.xml`. */
  ruta: string
}

export interface Libro {
  entradas: EntradaZip[]
  hojas: Hoja[]
}

function entrada(libro: Libro, ruta: string): number {
  const i = libro.entradas.findIndex((e) => e.nombre === ruta)
  if (i < 0) throw new Error(`El libro no tiene «${ruta}»`)
  return i
}

async function leerTexto(libro: Libro, ruta: string): Promise<string> {
  return new TextDecoder().decode(await descomprimir(libro.entradas[entrada(libro, ruta)]!))
}

/**
 * Abre el libro y resuelve qué fichero es cada hoja.
 *
 * El nombre que ve la gente (`Estado Aulas y Salas de reunion`) y el fichero
 * (`sheet3.xml`) se relacionan a través de un `r:id` y del fichero de
 * relaciones. El número del nombre del fichero **no** dice el orden: `sheet1.xml`
 * puede ser la tercera pestaña.
 */
export async function abrirLibro(bytes: Uint8Array): Promise<Libro> {
  const entradas = leerZip(bytes)
  const libro: Libro = { entradas, hojas: [] }

  const workbook = await leerTexto(libro, 'xl/workbook.xml')
  const rels = await leerTexto(libro, 'xl/_rels/workbook.xml.rels')

  const destino = new Map<string, string>()
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1]
    const target = /Target="([^"]+)"/.exec(m[0])?.[1]
    if (id && target) destino.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''))
  }

  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const nombre = /name="([^"]*)"/.exec(m[0])?.[1]
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1]
    if (!nombre || !rid) continue
    const target = destino.get(rid)
    if (!target) continue
    libro.hojas.push({ nombre: desescapar(nombre), ruta: `xl/${target}` })
  }

  if (libro.hojas.length === 0) throw new Error('El libro no declara ninguna hoja')
  return libro
}

// -----------------------------------------------------------------------------
// Leer una hoja
// -----------------------------------------------------------------------------

export type ValorCelda = string | number | boolean | null

export interface FilaLeida {
  /** El número de fila **de la hoja**, no la posición en esta lista. */
  fila: number
  /** Columna (`B`) → valor. Las celdas vacías no aparecen. */
  celdas: Record<string, ValorCelda>
}

function desescapar(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}

export function escapar(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Solo el texto: `<is>` y `<si>` pueden venir troceados en varios `<r><t>`. */
function textoDe(xml: string): string {
  let out = ''
  for (const m of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += desescapar(m[1] ?? '')
  return out
}

async function cadenasCompartidas(libro: Libro): Promise<string[]> {
  if (!libro.entradas.some((e) => e.nombre === 'xl/sharedStrings.xml')) return []
  const xml = await leerTexto(libro, 'xl/sharedStrings.xml')
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map((m) => textoDe(m[1] ?? ''))
}

/**
 * Lee las filas de una hoja con sus direcciones reales.
 *
 * Las fechas salen como el número de serie de Excel: convertirlas exige mirar el
 * formato de cada celda, y quien las necesite como fecha ya sabe qué columna es
 * —adivinarlo aquí, con las tres fechas ilegibles que trae este libro, sería
 * inventar.
 */
export async function leerHoja(libro: Libro, nombre: string): Promise<FilaLeida[]> {
  const hoja = libro.hojas.find((h) => h.nombre === nombre)
  if (!hoja) throw new Error(`El libro no tiene la hoja «${nombre}»`)

  const compartidas = await cadenasCompartidas(libro)
  const xml = await leerTexto(libro, hoja.ruta)
  const filas: FilaLeida[] = []

  // La forma autocerrada va **primero** en la alternancia, y no es un detalle:
  // `[^>]*` se traga la barra de `<row r="9"/>`, así que con el orden contrario
  // la rama de pareja abre en esa fila vacía y cierra en el `</row>` de la
  // siguiente, devorando todo lo que hay en medio.
  for (const mf of xml.matchAll(/<row\b([^>]*)\/>|<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const attrs = mf[1] ?? mf[2] ?? ''
    const numero = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? 0)
    if (!numero) continue
    const celdas: Record<string, ValorCelda> = {}

    for (const mc of (mf[3] ?? '').matchAll(/<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const ca = mc[1] ?? mc[2] ?? ''
      const ref = /\br="([A-Z]+\d+)"/.exec(ca)?.[1]
      if (!ref) continue
      const tipo = /\bt="([^"]+)"/.exec(ca)?.[1] ?? 'n'
      const cuerpo = mc[3] ?? ''
      const columna = partirCelda(ref).columna

      if (tipo === 'inlineStr') {
        celdas[columna] = textoDe(cuerpo)
        continue
      }
      const v = /<v>([\s\S]*?)<\/v>/.exec(cuerpo)?.[1]
      if (v === undefined) continue
      if (tipo === 's') celdas[columna] = compartidas[Number(v)] ?? ''
      else if (tipo === 'b') celdas[columna] = v === '1'
      else if (tipo === 'str' || tipo === 'e') celdas[columna] = desescapar(v)
      else celdas[columna] = Number(v)
    }

    filas.push({ fila: numero, celdas })
  }

  return filas
}

// -----------------------------------------------------------------------------
// Parchear
// -----------------------------------------------------------------------------

export interface Cambio {
  /** `B87`. */
  celda: string
  /**
   * `null` **no toca la celda**: la deja exactamente como está, con su fórmula y
   * su formato. Para vaciarla hay que pedir `''` a propósito, y eso sí borra su
   * contenido. La diferencia es la defensa contra escribir un hueco encima de un
   * dato bueno.
   */
  valor: ValorCelda
}

function xmlDeCelda(ref: string, estilo: string, valor: Exclude<ValorCelda, null>): string {
  const s = estilo ? ` s="${estilo}"` : ''
  if (typeof valor === 'number') return `<c r="${ref}"${s}><v>${valor}</v></c>`
  if (typeof valor === 'boolean') return `<c r="${ref}"${s} t="b"><v>${valor ? 1 : 0}</v></c>`
  if (valor === '') return `<c r="${ref}"${s}/>`
  // `xml:space="preserve"` o los espacios de los extremos desaparecen al leer.
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapar(valor)}</t></is></c>`
}

/** Reescribe el XML de una hoja con los cambios pedidos. */
export function parchearHojaXml(xml: string, cambios: Cambio[]): string {
  const porFila = new Map<number, Cambio[]>()
  for (const c of cambios) {
    if (c.valor === null) continue // no tocar
    const { fila } = partirCelda(c.celda)
    const l = porFila.get(fila) ?? []
    l.push({ ...c, celda: c.celda.toUpperCase() })
    porFila.set(fila, l)
  }
  if (porFila.size === 0) return xml

  let out = xml
  const pendientes = new Set(porFila.keys())

  out = out.replace(
    /<row\b([^>]*)\/>|<row\b([^>]*)>([\s\S]*?)<\/row>/g,
    (todo, a1: string, a2: string, cuerpo: string) => {
      const attrs = a1 ?? a2 ?? ''
      const numero = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? 0)
      const dela = porFila.get(numero)
      if (!numero || !dela) return todo
      pendientes.delete(numero)
      // Una fila autocerrada existe pero está vacía: al escribir en ella deja
      // de estarlo, así que hay que abrirla.
      return `<row${attrs.replace(/\/$/, '')}>${aplicarEnFila(cuerpo ?? '', dela)}</row>`
    },
  )

  // Las filas que no existían se crean, en su sitio: una hoja con las filas
  // desordenadas la abre Excel y la reordena, pero por el camino se lleva por
  // delante los rangos que apuntaban a ellas.
  for (const fila of [...pendientes].sort((a, b) => a - b)) {
    const nueva = `<row r="${fila}">${aplicarEnFila('', porFila.get(fila)!)}</row>`
    out = insertarFila(out, fila, nueva)
  }

  return out
}

function aplicarEnFila(cuerpo: string, cambios: Cambio[]): string {
  const pendientes = new Map(cambios.map((c) => [c.celda, c]))

  let out = cuerpo.replace(
    /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g,
    (todo, a1: string, a2: string) => {
      const attrs = a1 ?? a2 ?? ''
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1]
      if (!ref) return todo
      const c = pendientes.get(ref)
      if (!c) return todo
      pendientes.delete(ref)
      // El estilo se conserva: es lo que lleva el formato de número, el borde y
      // el color de la celda, y perderlo convierte una fecha en un número de
      // cinco cifras a la vista de todo el mundo.
      const estilo = /\bs="(\d+)"/.exec(attrs)?.[1] ?? ''
      return xmlDeCelda(ref, estilo, c.valor as Exclude<ValorCelda, null>)
    },
  )

  // Las celdas que no existían van dentro de la fila y **en orden de columna**,
  // y heredan el estilo de su vecina de la izquierda. En estas hojas el formato
  // corre por filas —la banda de la cabecera, el borde de la cuadrícula— y una
  // celda sin estilo en medio se ve: la cabecera `Ref` saldría sin el color de
  // las demás y en esa fila se rompería el borde. Contra el libro real solo
  // pasa dos veces (414 de las 416 celdas de la columna ya existían vacías con
  // su estilo), pero esas dos se notan.
  for (const c of [...pendientes.values()].sort(
    (a, b) => columnaANumero(partirCelda(a.celda).columna) - columnaANumero(partirCelda(b.celda).columna),
  )) {
    const estilo = estiloDeLaIzquierda(out, columnaANumero(partirCelda(c.celda).columna))
    out = insertarCelda(out, c.celda, xmlDeCelda(c.celda, estilo, c.valor as Exclude<ValorCelda, null>))
  }
  return out
}

/** El `s` de la celda existente más cercana por la izquierda, o nada. */
function estiloDeLaIzquierda(cuerpo: string, columna: number): string {
  let mejor = ''
  let mejorCol = 0
  for (const m of cuerpo.matchAll(/<c\b([^>]*?)\/>|<c\b([^>]*?)>/g)) {
    const attrs = m[1] ?? m[2] ?? ''
    const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1]
    if (!ref) continue
    const n = columnaANumero(ref)
    if (n < columna && n > mejorCol) {
      mejorCol = n
      mejor = /\bs="(\d+)"/.exec(attrs)?.[1] ?? ''
    }
  }
  return mejor
}

function insertarCelda(cuerpo: string, ref: string, xml: string): string {
  const n = columnaANumero(partirCelda(ref).columna)
  let corte = cuerpo.length
  for (const m of cuerpo.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"/g)) {
    if (columnaANumero(m[1]!) > n) {
      corte = m.index
      break
    }
  }
  return cuerpo.slice(0, corte) + xml + cuerpo.slice(corte)
}

function insertarFila(xml: string, fila: number, nueva: string): string {
  for (const m of xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)) {
    if (Number(m[1]) > fila) return xml.slice(0, m.index) + nueva + xml.slice(m.index)
  }
  const cierre = xml.lastIndexOf('</sheetData>')
  if (cierre < 0) throw new Error('La hoja no tiene <sheetData>: no es una hoja de cálculo normal')
  return xml.slice(0, cierre) + nueva + xml.slice(cierre)
}

/**
 * Marca el libro para que recalcule al abrirlo.
 *
 * Sin esto, cambiar una celda de la que depende `=P5-N5` deja el resultado viejo
 * guardado dentro del fichero, y quien lo abra ve un número que ya no es verdad
 * sin ninguna señal de que lo sea.
 */
export function marcarRecalculo(workbookXml: string): string {
  if (/<calcPr\b[^>]*fullCalcOnLoad="1"/.test(workbookXml)) return workbookXml
  if (/<calcPr\b[^>]*\/>/.test(workbookXml)) {
    return workbookXml.replace(/<calcPr\b([^>]*)\/>/, '<calcPr$1 fullCalcOnLoad="1"/>')
  }
  return workbookXml.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>')
}

/**
 * Aplica los cambios y devuelve el libro entero. Todo lo que no sea la hoja
 * tocada y `workbook.xml` vuelve con sus bytes originales.
 */
export async function parchear(
  libro: Libro,
  cambios: Array<{ hoja: string; celdas: Cambio[] }>,
): Promise<Uint8Array> {
  const entradas = [...libro.entradas]

  for (const { hoja: nombre, celdas } of cambios) {
    if (celdas.every((c) => c.valor === null)) continue
    const hoja = libro.hojas.find((h) => h.nombre === nombre)
    if (!hoja) throw new Error(`El libro no tiene la hoja «${nombre}»`)
    const i = entradas.findIndex((e) => e.nombre === hoja.ruta)
    const xml = new TextDecoder().decode(await descomprimir(entradas[i]!))
    const nuevo = parchearHojaXml(xml, celdas)
    if (nuevo === xml) continue
    entradas[i] = await reemplazar(entradas[i]!, new TextEncoder().encode(nuevo))
  }

  const iw = entradas.findIndex((e) => e.nombre === 'xl/workbook.xml')
  if (iw >= 0) {
    const xml = new TextDecoder().decode(await descomprimir(entradas[iw]!))
    const nuevo = marcarRecalculo(xml)
    if (nuevo !== xml) entradas[iw] = await reemplazar(entradas[iw]!, new TextEncoder().encode(nuevo))
  }

  return escribirZip(entradas)
}
