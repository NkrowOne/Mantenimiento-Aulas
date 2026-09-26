/**
 * Tablas de Excel en las hojas que escribe la aplicación.
 *
 * Una tabla («Dar formato como tabla») es lo que hace que una hoja de la app se
 * lea de un vistazo: cabecera fija con filtro, bandas alternas, y un nombre
 * (`Revisiones`) con el que las fórmulas de la gente pueden referirse a ella
 * sin contar filas. Y es también la parte del libro que más sitios toca a la
 * vez, que es por lo que vive en su propio módulo:
 *
 *  1. la **parte** `xl/tables/tableN.xml`, con el rango, las columnas y el
 *     estilo;
 *  2. la **relación** desde la hoja, en `xl/worksheets/_rels/sheetN.xml.rels`
 *     (creando el fichero si la hoja no tenía relaciones);
 *  3. el **tipo de contenido** de la parte, en `[Content_Types].xml`;
 *  4. el `<tableParts>` dentro de la hoja, que es lo único que `libro.ts`
 *     escribe por su cuenta porque va dentro del XML que genera.
 *
 * Y lo que Excel exige de una tabla y no perdona: cabeceras de **texto, no
 * vacías y únicas**, exactamente iguales en la celda y en `tableColumn`; al
 * menos **una fila de datos** además de la cabecera; un `id` único en el libro
 * y un `displayName` único sin espacios ni tildes; y que la hoja no lleve su
 * propio `autoFilter` encima de la tabla. Un fallo en cualquiera de ellas no da
 * un error: da el diálogo de «Excel ha encontrado contenido ilegible», que es
 * justo lo que nadie quiere ver al abrir el libro que le acaban de mandar.
 *
 * Rehacer una hoja que ya tiene tabla **reutiliza la suya**: se actualizan el
 * rango y las columnas de la misma parte, con el mismo `id` y el mismo nombre,
 * y el libro no gana una tabla por pasada.
 */

import { crearEntrada, descomprimir, reemplazar } from '../lib/zip'
import type { EntradaZip } from '../lib/zip'
import { escapar, numeroAColumna } from './xlsx'
import type { ValorCelda } from './xlsx'

export const TIPO_DE_TABLA = 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml'
export const RELACION_DE_TABLA = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/table'
const XMLNS_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'

// -----------------------------------------------------------------------------
// Lo que hay que decidir antes de escribir nada
// -----------------------------------------------------------------------------

/**
 * `Movimientos de Almacén` → `MovimientosDeAlmacen`.
 *
 * El nombre de una tabla se usa en fórmulas, así que sigue las reglas de los
 * nombres definidos: sin espacios, sin tildes, sin empezar por número y sin
 * parecerse a una referencia de celda.
 */
export function nombreDeTabla(nombreHoja: string): string {
  const sinTildes = nombreHoja.normalize('NFD').replace(/[̀-ͯ]/g, '')
  const trozos = sinTildes.split(/[^A-Za-z0-9]+/).filter((t) => t.length > 0)
  let nombre = trozos.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join('')
  if (nombre === '' || /^\d/.test(nombre) || /^[A-Za-z]{1,3}\d+$/.test(nombre)) nombre = `Tabla${nombre}`
  return nombre
}

/**
 * Los nombres de columna que la tabla puede llevar, sacados de la cabecera.
 *
 * Una tabla exige cabeceras de texto, no vacías y únicas: una vacía pasa a
 * `Columna N` y una repetida se sufija `(2)`. Quien escribe la hoja usa estos
 * mismos textos en la fila 1, porque si la celda y `tableColumn` no dicen lo
 * mismo Excel «repara» el libro.
 */
export function columnasDeTabla(cabecera: ValorCelda[]): string[] {
  const vistas = new Map<string, number>()
  return cabecera.map((v, i) => {
    const base = v === null || v === '' ? `Columna ${i + 1}` : String(v)
    const veces = vistas.get(base) ?? 0
    vistas.set(base, veces + 1)
    return veces === 0 ? base : `${base} (${veces + 1})`
  })
}

/** `A1:<últimaCol><últimaFila>`, con al menos una fila de datos. */
export function refDeTabla(columnas: number, filas: number): string {
  return `A1:${numeroAColumna(Math.max(1, columnas))}${Math.max(2, filas)}`
}

// -----------------------------------------------------------------------------
// La parte de la tabla
// -----------------------------------------------------------------------------

export interface DatosDeTabla {
  nombre: string
  ref: string
  columnas: string[]
}

/** El XML de `xl/tables/tableN.xml`, en la forma estándar que escribe Excel. */
export function xmlDeTabla(id: number, tabla: DatosDeTabla): string {
  const columnas = tabla.columnas
    .map((c, i) => `<tableColumn id="${i + 1}" name="${escapar(c)}"/>`)
    .join('')
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${id}" ` +
    `name="${escapar(tabla.nombre)}" displayName="${escapar(tabla.nombre)}" ref="${tabla.ref}" totalsRowShown="0">` +
    `<autoFilter ref="${tabla.ref}"/>` +
    `<tableColumns count="${tabla.columnas.length}">${columnas}</tableColumns>` +
    `<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>` +
    `</table>`
  )
}

/** Lo que va al final de `<worksheet>` para que la hoja sepa que tiene tabla. */
export function xmlDeTableParts(rid: string): string {
  return `<tableParts count="1"><tablePart r:id="${rid}"/></tableParts>`
}

/** `xl/worksheets/sheet7.xml` → `xl/worksheets/_rels/sheet7.xml.rels`. */
export function rutaDeRels(rutaHoja: string): string {
  const partes = rutaHoja.split('/')
  const fichero = partes.pop()!
  return `${partes.join('/')}/_rels/${fichero}.rels`
}

/** `xl/worksheets` + `/xl/tables/table1.xml` o `../tables/table1.xml` → `xl/tables/table1.xml`. */
function resolverRuta(rutaHoja: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const partes = rutaHoja.split('/')
  partes.pop()
  for (const trozo of target.split('/')) {
    if (trozo === '.' || trozo === '') continue
    if (trozo === '..') partes.pop()
    else partes.push(trozo)
  }
  return partes.join('/')
}

/** La tabla que una hoja ya tiene, si la tiene: su relación y su parte. */
export async function tablaDeHoja(
  entradas: EntradaZip[],
  rutaHoja: string,
): Promise<{ rid: string; ruta: string; xml: string } | null> {
  const rels = entradas.find((e) => e.nombre === rutaDeRels(rutaHoja))
  if (!rels) return null
  const xmlRels = await texto(rels)
  for (const m of xmlRels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (!m[0].includes(RELACION_DE_TABLA)) continue
    const rid = /\bId="([^"]+)"/.exec(m[0])?.[1]
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1]
    if (!rid || !target) continue
    const ruta = resolverRuta(rutaHoja, target)
    const parte = entradas.find((e) => e.nombre === ruta)
    if (!parte) continue
    return { rid, ruta, xml: await texto(parte) }
  }
  return null
}

/**
 * Deja la hoja con **una** tabla con esos datos, y devuelve el `r:id` con el
 * que la hoja tiene que citarla en su `<tableParts>`.
 *
 * Si la hoja ya tenía tabla se actualizan `ref` y columnas de la suya; si no,
 * se crea la parte con el primer número de fichero libre y el `id` siguiente al
 * mayor del libro, se relaciona desde la hoja y se declara su tipo de contenido.
 */
export async function asegurarTabla(
  entradas: EntradaZip[],
  rutaHoja: string,
  datos: DatosDeTabla,
): Promise<{ entradas: EntradaZip[]; rid: string }> {
  let out = [...entradas]
  const existente = await tablaDeHoja(out, rutaHoja)

  if (existente) {
    const id = Number(/<table\b[^>]*\bid="(\d+)"/.exec(existente.xml)?.[1] ?? 1)
    // El nombre se conserva: puede haber fórmulas de la gente que lo usen.
    const nombre = /<table\b[^>]*\bdisplayName="([^"]*)"/.exec(existente.xml)?.[1] ?? datos.nombre
    const nuevo = xmlDeTabla(id, { ...datos, nombre })
    if (nuevo !== existente.xml) {
      const i = out.findIndex((e) => e.nombre === existente.ruta)
      out[i] = await reemplazar(out[i]!, bytes(nuevo))
    }
    return { entradas: out, rid: existente.rid }
  }

  // 1 — la parte, con número de fichero e `id` que no choquen con ninguna tabla
  //     del libro, también las de hojas que no son de la app.
  const usados = new Set<number>()
  let mayorId = 0
  for (const e of out) {
    const m = /^xl\/tables\/table(\d+)\.xml$/.exec(e.nombre)
    if (!m) continue
    usados.add(Number(m[1]))
    const id = /<table\b[^>]*\bid="(\d+)"/.exec(await texto(e))?.[1]
    mayorId = Math.max(mayorId, Number(id ?? 0))
  }
  let n = 1
  while (usados.has(n)) n++
  const ruta = `xl/tables/table${n}.xml`
  const nombre = await nombreLibre(out, datos.nombre)
  const modelo = out.find((e) => e.nombre === rutaHoja) ?? out.find((e) => e.nombre === 'xl/workbook.xml')!
  out.push(await crearEntrada(ruta, bytes(xmlDeTabla(mayorId + 1, { ...datos, nombre })), modelo))

  // 2 — la relación desde la hoja. El destino va relativo a la hoja, que es
  //     como lo escribe Excel.
  const rutaRels = rutaDeRels(rutaHoja)
  const ir = out.findIndex((e) => e.nombre === rutaRels)
  const relsXml =
    ir >= 0 ? await texto(out[ir]!) : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${XMLNS_RELS}"></Relationships>`
  const rid = idLibre(relsXml)
  const relacion = `<Relationship Id="${rid}" Type="${RELACION_DE_TABLA}" Target="../tables/table${n}.xml"/>`
  const relsNuevo = relsXml.includes('</Relationships>')
    ? relsXml.replace('</Relationships>', `${relacion}</Relationships>`)
    : relsXml.replace(/<Relationships\b([^>]*)\/>/, `<Relationships$1>${relacion}</Relationships>`)
  if (ir >= 0) out[ir] = await reemplazar(out[ir]!, bytes(relsNuevo))
  else out.push(await crearEntrada(rutaRels, bytes(relsNuevo), modelo))

  // 3 — el tipo de contenido, sin el cual Excel no sabe qué es la parte.
  const ic = out.findIndex((e) => e.nombre === '[Content_Types].xml')
  if (ic < 0) throw new Error('El libro no tiene [Content_Types].xml')
  const ct = await texto(out[ic]!)
  if (!ct.includes(`PartName="/${ruta}"`)) {
    out[ic] = await reemplazar(
      out[ic]!,
      bytes(ct.replace('</Types>', `<Override PartName="/${ruta}" ContentType="${TIPO_DE_TABLA}"/></Types>`)),
    )
  }

  return { entradas: out, rid }
}

/** Un `displayName` que ninguna otra tabla del libro tenga ya. */
async function nombreLibre(entradas: EntradaZip[], deseado: string): Promise<string> {
  const usados = new Set<string>()
  for (const e of entradas) {
    if (!/^xl\/tables\/table\d+\.xml$/.test(e.nombre)) continue
    const n = /<table\b[^>]*\bdisplayName="([^"]*)"/.exec(await texto(e))?.[1]
    if (n) usados.add(n.toLowerCase())
  }
  let nombre = deseado
  let k = 2
  while (usados.has(nombre.toLowerCase())) nombre = `${deseado}_${k++}`
  return nombre
}

function idLibre(rels: string): string {
  const usados = new Set([...rels.matchAll(/\bId="rId(\d+)"/g)].map((m) => Number(m[1])))
  let n = 1
  while (usados.has(n)) n++
  return `rId${n}`
}

// -----------------------------------------------------------------------------
// El nombre definido del autofiltro
// -----------------------------------------------------------------------------

/**
 * Quita de `workbook.xml` el `_xlnm._FilterDatabase` de la hoja que está en
 * esa posición (0-based, la de `<sheets>`). Una tabla lleva su propio filtro y
 * Excel se queja si además encuentra el de la hoja apuntando al mismo rango.
 * Si la lista de nombres se queda vacía, se quita entera: un `<definedNames/>`
 * sin hijos no es un libro válido.
 */
export function quitarFiltroDeHoja(workbookXml: string, indiceHoja: number): string {
  const patron = new RegExp(
    `<definedName\\b[^>]*\\bname="_xlnm\\._FilterDatabase"[^>]*\\blocalSheetId="${indiceHoja}"[^>]*>[\\s\\S]*?</definedName>`,
    'g',
  )
  let out = workbookXml.replace(patron, '')
  out = out.replace(/<definedNames\b[^>]*>\s*<\/definedNames>/, '')
  return out
}

// -----------------------------------------------------------------------------

async function texto(e: EntradaZip): Promise<string> {
  return new TextDecoder().decode(await descomprimir(e))
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}
