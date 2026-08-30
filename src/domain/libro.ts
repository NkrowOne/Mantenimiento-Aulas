/**
 * El libro entero: escribir celdas, mover filas y añadir hojas en una pasada.
 *
 * `xlsx.ts` sabe de celdas y `estructura.ts` sabe de filas, pero las dos miran
 * un solo fichero de hoja. Hay tres cosas que solo se ven desde arriba y que son
 * justo las que rompen un libro sin avisar:
 *
 * **Un comentario vive en dos ficheros a la vez.** La referencia está en
 * `comments1.xml` y el cuadrito amarillo en un `.vml` con la fila en base 0. Se
 * llega a los dos por el fichero de relaciones de la hoja, no por su nombre —
 * `comments1.xml` puede ser de la tercera pestaña.
 *
 * **Las fórmulas de una hoja miran a las otras.** Mover una fila de `Bolsa 2026`
 * obliga a repasar las fórmulas de las cinco hojas y los nombres definidos, no
 * solo las de la hoja que se toca.
 *
 * **`calcChain.xml` sobra en cuanto la estructura cambia.** Es la caché del
 * orden de recálculo y apunta a celdas por posición. Mantenerla correcta cuesta
 * más que tirarla, y es de los pocos ficheros cuya incoherencia Excel sí
 * denuncia al abrir. Tirarlo no pierde nada: se regenera solo. Pero tirarlo
 * bien son tres sitios —la entrada del zip, el `Override` de los tipos de
 * contenido y la relación del libro—, y dejarse uno da el error que se quería
 * evitar.
 *
 * Sobre añadir hojas: **no se toca `styles.xml`**. Las hojas nuevas se pintan
 * reutilizando los índices de estilo que el libro ya tiene —la banda de la
 * cabecera es la que ya usa la hoja de estado— porque meter formatos nuevos
 * obliga a renumerar una tabla que todas las celdas del libro están usando. Sale
 * más barato parecerse a lo que hay que inventar un estilo propio, y además el
 * resultado se parece al libro de siempre, que es lo que se pidió.
 */

import {
  corregirComentarios,
  corregirReferenciasExternas,
  corregirVml,
  editarHojaXml,
  planificar,
} from './estructura'
import type { EdicionDeFilas, MapaDeFilas } from './estructura'
import { escapar, marcarRecalculo, parchearHojaXml } from './xlsx'
import type { Cambio, Libro, ValorCelda } from './xlsx'
import { crearEntrada, descomprimir, escribirZip, reemplazar } from '../lib/zip'
import type { EntradaZip } from '../lib/zip'

const TIPO_HOJA =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'

// -----------------------------------------------------------------------------
// Lo que se le pide al libro
// -----------------------------------------------------------------------------

export interface EdicionDeHoja {
  hoja: string
  /**
   * Celdas a escribir, con las **direcciones de la hoja original**. Se aplican
   * después de mover las filas, así que aquí se escribe `M87` pensando en el
   * `M87` de hoy aunque acabe siendo el `M89`.
   */
  celdas?: Cambio[]
  filas?: EdicionDeFilas
}

export interface HojaNueva {
  nombre: string
  /** La primera fila es la cabecera y se pinta como tal. */
  filas: ValorCelda[][]
  /** Anchos de columna, en caracteres. Uno por columna. */
  anchos?: number[]
  /** Inmoviliza la fila de cabecera. Por defecto sí. */
  inmovilizar?: boolean
  /** Pone autofiltro sobre la cabecera. Por defecto sí. */
  autofiltro?: boolean
  /** Índice de formato de número por columna (0 = general). */
  formatos?: Array<number | undefined>
}

// -----------------------------------------------------------------------------
// Escribir
// -----------------------------------------------------------------------------

/**
 * Aplica todo y devuelve el libro. Lo que no se toca vuelve con sus bytes.
 *
 * El orden importa y no es intercambiable: primero se mueven las filas —que es
 * lo que cambia las direcciones— y solo después se escriben las celdas, ya
 * traducidas. Al revés se escribiría el número de serie en la fila de al lado.
 */
export async function escribirLibro(
  libro: Libro,
  ediciones: EdicionDeHoja[],
  hojasNuevas: HojaNueva[] = [],
): Promise<Uint8Array> {
  let entradas = [...libro.entradas]
  let hojas = [...libro.hojas]
  let estructuraTocada = false

  for (const ed of ediciones) {
    const hoja = hojas.find((h) => h.nombre === ed.hoja)
    if (!hoja) throw new Error(`El libro no tiene la hoja «${ed.hoja}»`)

    const mapa = planificar(ed.filas ?? {})
    const celdas = (ed.celdas ?? []).filter((c) => c.valor !== null)
    if (mapa.vacio && celdas.length === 0) continue

    const i = indice(entradas, hoja.ruta)
    let xml = await texto(entradas[i]!)

    if (!mapa.vacio) {
      estructuraTocada = true
      xml = editarHojaXml(xml, ed.filas ?? {}, mapa)
    }
    if (celdas.length > 0) {
      xml = parchearHojaXml(xml, celdas.map((c) => traducir(c, mapa)).filter((c) => c !== null))
    }
    entradas[i] = await reemplazar(entradas[i]!, bytes(xml))

    if (!mapa.vacio) {
      entradas = await moverLoDeFuera(entradas, hoja.ruta, ed.hoja, mapa, hojas)
    }
  }

  for (const nueva of hojasNuevas) {
    const r = await anadirHoja(entradas, hojas, nueva)
    entradas = r.entradas
    hojas = r.hojas
    estructuraTocada = true
  }

  if (estructuraTocada) entradas = quitarCalcChain(entradas)

  const iw = entradas.findIndex((e) => e.nombre === 'xl/workbook.xml')
  if (iw >= 0) {
    const xml = await texto(entradas[iw]!)
    const nuevo = marcarRecalculo(xml)
    if (nuevo !== xml) entradas[iw] = await reemplazar(entradas[iw]!, bytes(nuevo))
  }

  return escribirZip(entradas)
}

/** Una celda escrita contra la hoja de antes, apuntando a la de después. */
function traducir(c: Cambio, mapa: MapaDeFilas): Cambio | null {
  if (mapa.vacio) return c
  const m = /^([A-Z]+)(\d+)$/.exec(c.celda.toUpperCase())
  if (!m) return c
  const nueva = mapa.nuevo(Number(m[2]))
  // Escribir en una fila que se acaba de borrar no es un error del que llama:
  // es lo que pasa cuando en la misma pasada un aula se archiva y se corrige.
  // Gana el borrado, que es la orden más fuerte.
  if (nueva === null) return null
  return { ...c, celda: `${m[1]}${nueva}` }
}

/** Comentarios, dibujos y las fórmulas de las demás hojas. */
async function moverLoDeFuera(
  entradas: EntradaZip[],
  ruta: string,
  nombre: string,
  mapa: MapaDeFilas,
  hojas: Array<{ nombre: string; ruta: string }>,
): Promise<EntradaZip[]> {
  const out = [...entradas]

  for (const destino of await relacionesDe(out, ruta)) {
    const i = out.findIndex((e) => e.nombre === destino)
    if (i < 0) continue
    if (destino.includes('/comments')) {
      out[i] = await reemplazar(out[i]!, bytes(corregirComentarios(await texto(out[i]!), mapa)))
    } else if (destino.endsWith('.vml')) {
      out[i] = await reemplazar(out[i]!, bytes(corregirVml(await texto(out[i]!), mapa)))
    }
  }

  // Las fórmulas de las otras hojas y los nombres definidos del libro.
  for (const otra of [...hojas.map((h) => h.ruta), 'xl/workbook.xml']) {
    if (otra === ruta) continue
    const i = out.findIndex((e) => e.nombre === otra)
    if (i < 0) continue
    const xml = await texto(out[i]!)
    const nuevo = corregirReferenciasExternas(xml, nombre, mapa)
    if (nuevo !== xml) out[i] = await reemplazar(out[i]!, bytes(nuevo))
  }

  return out
}

/** Los ficheros a los que apunta una hoja: comentarios, dibujos, hipervínculos. */
async function relacionesDe(entradas: EntradaZip[], ruta: string): Promise<string[]> {
  const partes = ruta.split('/')
  const fichero = partes.pop()!
  const rels = `${partes.join('/')}/_rels/${fichero}.rels`
  const i = entradas.findIndex((e) => e.nombre === rels)
  if (i < 0) return []

  const xml = await texto(entradas[i]!)
  const base = partes.join('/')
  const out: string[] = []
  for (const m of xml.matchAll(/Target="([^"]+)"/g)) {
    const t = m[1]!
    if (t.startsWith('http')) continue
    out.push(normalizarRuta(base, t))
  }
  return out
}

/** `xl/worksheets` + `../drawings/vmlDrawing1.vml` → `xl/drawings/vmlDrawing1.vml`. */
function normalizarRuta(base: string, relativa: string): string {
  if (relativa.startsWith('/')) return relativa.slice(1)
  const partes = base.split('/')
  for (const trozo of relativa.split('/')) {
    if (trozo === '.' || trozo === '') continue
    if (trozo === '..') partes.pop()
    else partes.push(trozo)
  }
  return partes.join('/')
}

/** La caché de recálculo: sobra en cuanto se mueve una fila, y en tres sitios. */
function quitarCalcChain(entradas: EntradaZip[]): EntradaZip[] {
  if (!entradas.some((e) => e.nombre === 'xl/calcChain.xml')) return entradas
  return entradas.filter((e) => e.nombre !== 'xl/calcChain.xml')
}

// -----------------------------------------------------------------------------
// Hojas nuevas
// -----------------------------------------------------------------------------

/**
 * Añade una hoja al final del libro.
 *
 * El número del fichero (`sheet7.xml`) no dice nada del orden de las pestañas
 * —el orden lo da `workbook.xml`— pero sí tiene que no chocar con ninguno que ya
 * exista, incluido el de una hoja que se borró en su día y dejó el hueco.
 */
async function anadirHoja(
  entradas: EntradaZip[],
  hojas: Array<{ nombre: string; ruta: string }>,
  nueva: HojaNueva,
): Promise<{ entradas: EntradaZip[]; hojas: Array<{ nombre: string; ruta: string }> }> {
  if (hojas.some((h) => h.nombre === nueva.nombre)) {
    throw new Error(`El libro ya tiene una hoja «${nueva.nombre}»`)
  }
  if (nueva.nombre.length > 31) {
    throw new Error(`«${nueva.nombre}» pasa de 31 caracteres: Excel no admite ese nombre de hoja`)
  }

  let out = [...entradas]
  const usados = new Set(
    out
      .map((e) => /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(e.nombre)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number),
  )
  let n = 1
  while (usados.has(n)) n++
  const ruta = `xl/worksheets/sheet${n}.xml`

  const modelo = out.find((e) => e.nombre === 'xl/workbook.xml')!
  const estilos = await estilosDeCabecera(out, hojas)
  out.push(await crearEntrada(ruta, bytes(xmlDeHoja(nueva, estilos)), modelo))

  // 1 — la relación del libro
  const ir = indice(out, 'xl/_rels/workbook.xml.rels')
  const rels = await texto(out[ir]!)
  const rid = idLibre(rels)
  out[ir] = await reemplazar(
    out[ir]!,
    bytes(
      rels.replace(
        '</Relationships>',
        `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/></Relationships>`,
      ),
    ),
  )

  // 2 — la pestaña
  const iw = indice(out, 'xl/workbook.xml')
  const wb = await texto(out[iw]!)
  const idsHoja = [...wb.matchAll(/<sheet\b[^>]*\bsheetId="(\d+)"/g)].map((m) => Number(m[1]))
  const sheetId = Math.max(0, ...idsHoja) + 1
  out[iw] = await reemplazar(
    out[iw]!,
    bytes(
      wb.replace(
        '</sheets>',
        `<sheet name="${escapar(nueva.nombre)}" sheetId="${sheetId}" r:id="${rid}"/></sheets>`,
      ),
    ),
  )

  // 3 — el tipo de contenido, sin el cual Excel no sabe qué es el fichero
  const ic = indice(out, '[Content_Types].xml')
  const ct = await texto(out[ic]!)
  out[ic] = await reemplazar(
    out[ic]!,
    bytes(ct.replace('</Types>', `<Override PartName="/${ruta}" ContentType="${TIPO_HOJA}"/></Types>`)),
  )

  return { entradas: out, hojas: [...hojas, { nombre: nueva.nombre, ruta }] }
}

function idLibre(rels: string): string {
  const usados = new Set([...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1])))
  let n = 1
  while (usados.has(n)) n++
  return `rId${n}`
}

/**
 * Los índices de estilo de la cabecera y del cuerpo, sacados del propio libro.
 *
 * Se leen de la hoja de estado: su fila 1 es la banda de cabecera que la gente
 * reconoce, y su fila 2 el cuerpo normal. Si no estuviera, las hojas nuevas
 * salen sin formato, que es feo pero no roto.
 */
async function estilosDeCabecera(
  entradas: EntradaZip[],
  hojas: Array<{ nombre: string; ruta: string }>,
): Promise<{ cabecera: string; cuerpo: string }> {
  const hoja = hojas[0]
  if (!hoja) return { cabecera: '', cuerpo: '' }
  const i = entradas.findIndex((e) => e.nombre === hoja.ruta)
  if (i < 0) return { cabecera: '', cuerpo: '' }
  const xml = await texto(entradas[i]!)
  return {
    cabecera: estiloDeLaFila(xml, 1),
    cuerpo: estiloDeLaFila(xml, 2),
  }
}

function estiloDeLaFila(xml: string, fila: number): string {
  const m = new RegExp(`<row\\b[^>]*\\br="${fila}"[^>]*>([\\s\\S]*?)</row>`).exec(xml)
  if (!m) return ''
  return /<c\b[^>]*\bs="(\d+)"/.exec(m[1]!)?.[1] ?? ''
}

function xmlDeHoja(hoja: HojaNueva, estilos: { cabecera: string; cuerpo: string }): string {
  const columnas = Math.max(1, ...hoja.filas.map((f) => f.length))
  const inmovilizar = hoja.inmovilizar ?? true
  const autofiltro = hoja.autofiltro ?? true

  const vista = inmovilizar
    ? `<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>`
    : `<sheetView workbookViewId="0"/>`

  const cols = hoja.anchos
    ? `<cols>${hoja.anchos
        .map((a, i) => `<col min="${i + 1}" max="${i + 1}" width="${a}" customWidth="1"/>`)
        .join('')}</cols>`
    : ''

  const filas = hoja.filas
    .map((valores, i) => {
      const numero = i + 1
      const s = i === 0 ? estilos.cabecera : estilos.cuerpo
      const celdas = valores
        .map((v, c) => (v === null ? '' : celdaXml(letra(c + 1) + numero, s, v)))
        .join('')
      return `<row r="${numero}">${celdas}</row>`
    })
    .join('')

  const ultima = Math.max(1, hoja.filas.length)
  const dim = `A1:${letra(columnas)}${ultima}`
  const filtro = autofiltro && hoja.filas.length > 0 ? `<autoFilter ref="${dim}"/>` : ''

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<dimension ref="${dim}"/><sheetViews>${vista}</sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>${cols}` +
    `<sheetData>${filas}</sheetData>${filtro}</worksheet>`
  )
}

function celdaXml(ref: string, estilo: string, valor: Exclude<ValorCelda, null>): string {
  const s = estilo ? ` s="${estilo}"` : ''
  if (typeof valor === 'number') return `<c r="${ref}"${s}><v>${valor}</v></c>`
  if (typeof valor === 'boolean') return `<c r="${ref}"${s} t="b"><v>${valor ? 1 : 0}</v></c>`
  if (valor === '') return ''
  if (valor.startsWith('=')) return `<c r="${ref}"${s}><f>${escapar(valor.slice(1))}</f></c>`
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapar(valor)}</t></is></c>`
}

function letra(n: number): string {
  let s = ''
  let x = n
  while (x > 0) {
    const r = (x - 1) % 26
    s = String.fromCharCode(65 + r) + s
    x = Math.floor((x - 1) / 26)
  }
  return s
}

// -----------------------------------------------------------------------------

function indice(entradas: EntradaZip[], ruta: string): number {
  const i = entradas.findIndex((e) => e.nombre === ruta)
  if (i < 0) throw new Error(`El libro no tiene «${ruta}»`)
  return i
}

async function texto(e: EntradaZip): Promise<string> {
  return new TextDecoder().decode(await descomprimir(e))
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}
