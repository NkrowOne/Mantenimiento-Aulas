/**
 * Un libro de Excel hecho de cero.
 *
 * Todo lo demás de `domain/` parte de un libro que ya existe —el de SharePoint—
 * y lo parchea celda a celda para que vuelva como estaba salvo en lo que
 * cambia. Una exportación es lo contrario: no hay libro de partida, no hay
 * nada que conservar, y lo que sale es un fichero para mirar, filtrar y
 * guardar, no el original al que hay que devolver el trabajo de otros.
 *
 * Pero escribir las hojas ya está resuelto, y está resuelto con cuidado:
 * estilos con nombre, fechas que se ven como fechas, tablas con su filtro,
 * tintes por fila, cabecera inmovilizada. Hacerlo otra vez aquí sería
 * mantener dos generadores de hojas, y el primero que se tocara dejaría al otro
 * sacando ficheros que Excel «repara».
 *
 * Así que este módulo no genera hojas: fabrica **el libro más pequeño que
 * `escribirLibro` acepta** —una hoja vacía, los estilos justos, ni una cadena
 * compartida— y le pide que rehaga esa hoja y añada las demás. El resultado es
 * un libro hecho con exactamente el mismo código que el de la sincronización, y
 * por eso se abre igual.
 *
 * La hoja vacía de partida se llama como la primera hoja pedida, no «Hoja1».
 * `escribirLibro` rehace entera una hoja que ya existe (en su mismo fichero) y
 * añade las que no, así que no hace falta ninguna operación para «borrar» una
 * hoja provisional —que es justo lo que no sabe hacer, y con razón: nadie borra
 * hojas de un libro ajeno—. Queda un libro con exactamente las hojas pedidas, en
 * el orden pedido, y la primera es la que se abre.
 *
 * Y sin `calcChain.xml`: es la caché del orden de recálculo, apunta a celdas
 * por posición y solo existe en libros con fórmulas. Aquí no hay ninguna, y un
 * libro nuevo no tiene que cargar con una caché que nadie ha calculado.
 */

import { escribirLibro } from './libro'
import type { HojaNueva } from './libro'
import { abrirLibro, escapar } from './xlsx'
import type { ValorCelda } from './xlsx'
import { diaEnMadrid } from './fechas'
import { escribirZip, reemplazar } from '../lib/zip'
import type { EntradaZip } from '../lib/zip'

/** El tipo de contenido de un `.xlsx`, para el `Blob` y para quien lo sirva. */
export const TIPO_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// -----------------------------------------------------------------------------
// Lo que Excel no admite, dicho antes de escribir nada
// -----------------------------------------------------------------------------

/** Los límites de una hoja de Excel (`.xlsx`): 1.048.576 filas por 16.384 columnas. */
const MAX_FILAS = 1_048_576
const MAX_COLUMNAS = 16_384

/**
 * Lo que un nombre de hoja no puede llevar: `\ / ? * [ ] :`. Excel lo rechaza al
 * abrir el fichero con el diálogo de «contenido ilegible», no con un error
 * que se pueda leer, y el nombre sale de una pantalla, no de un programador.
 */
const NOMBRE_INVALIDO = /[\\/?*[\]:]/

function comprobar(hojas: HojaNueva[]): void {
  if (hojas.length === 0) {
    throw new Error('Un libro necesita al menos una hoja')
  }
  const vistos = new Set<string>()
  for (const h of hojas) {
    const n = h.nombre
    if (n.trim() === '') throw new Error('Una hoja no puede tener el nombre vacío')
    if (n.length > 31) throw new Error(`«${n}» pasa de 31 caracteres: Excel no admite ese nombre de hoja`)
    if (NOMBRE_INVALIDO.test(n)) {
      throw new Error(`«${n}» lleva un carácter que Excel no admite en el nombre de una hoja (\\ / ? * [ ] :)`)
    }
    if (n.startsWith("'") || n.endsWith("'")) {
      throw new Error(`«${n}» empieza o acaba en apóstrofo: Excel no admite ese nombre de hoja`)
    }
    // Excel no distingue mayúsculas en los nombres de hoja: «Stock» y «STOCK»
    // son la misma, y el libro con las dos no se abre.
    const clave = n.toLowerCase()
    if (vistos.has(clave)) throw new Error(`Dos hojas se llaman «${n}»: Excel no admite nombres repetidos`)
    vistos.add(clave)

    if (h.filas.length > MAX_FILAS) {
      throw new Error(`«${n}» tiene ${h.filas.length} filas y Excel admite ${MAX_FILAS}`)
    }
    const columnas = Math.max(0, ...h.filas.map((f) => f.length))
    if (columnas > MAX_COLUMNAS) {
      throw new Error(`«${n}» tiene ${columnas} columnas y Excel admite ${MAX_COLUMNAS}`)
    }
  }
}

// -----------------------------------------------------------------------------
// El libro más pequeño que se puede abrir
// -----------------------------------------------------------------------------

const NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

const CABECERA_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

/**
 * Una entrada de zip sin pasado. La fecha es 1980-01-01 00:00 —la primera que el
 * formato de zip puede escribir— y no el reloj: el mismo contenido tiene que dar
 * los mismos bytes, y `crearEntrada` copia esta fecha en las entradas que añade
 * después (hojas, tablas).
 */
const MOLDE: Omit<EntradaZip, 'nombre'> = {
  metodo: 8,
  banderas: 0,
  fecha: (1 << 5) | 1,
  hora: 0,
  versionCreacion: 20,
  versionNecesaria: 20,
  atributosInternos: 0,
  atributosExternos: 0,
  extraLocal: new Uint8Array(0),
  extraCentral: new Uint8Array(0),
  comentario: new Uint8Array(0),
  crc32: 0,
  comprimido: new Uint8Array(0),
  tamanoOriginal: 0,
}

const entrada = (nombre: string, xml: string): Promise<EntradaZip> =>
  reemplazar({ ...MOLDE, nombre }, new TextEncoder().encode(xml))

/**
 * El libro con una sola hoja vacía, llamada `nombreDeLaHoja`.
 *
 * Lo justo para que `escribirLibro` tenga dónde trabajar: el libro con su
 * relación, los tipos de contenido, y un `styles.xml` con la fuente, los dos
 * rellenos y el borde que exige el formato y los **`tableStyles`** (sin ellos
 * una tabla no tiene estilo al que apuntar). Las listas de `numFmts`, `dxfs` y
 * los demás los crea `estilos.ts` cuando hacen falta y en el sitio que el
 * esquema exige.
 */
async function libroEnBlanco(nombreDeLaHoja: string) {
  const entradas: EntradaZip[] = [
    await entrada(
      '[Content_Types].xml',
      `${CABECERA_XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>',
    ),
    await entrada(
      '_rels/.rels',
      `${CABECERA_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    await entrada(
      'xl/workbook.xml',
      `${CABECERA_XML}<workbook ${NS}>` +
        '<bookViews><workbookView activeTab="0"/></bookViews>' +
        `<sheets><sheet name="${escapar(nombreDeLaHoja)}" sheetId="1" r:id="rId1"/></sheets>` +
        '<calcPr calcId="191029"/></workbook>',
    ),
    await entrada(
      'xl/_rels/workbook.xml.rels',
      `${CABECERA_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    ),
    await entrada(
      'xl/styles.xml',
      `${CABECERA_XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '<dxfs count="0"/>' +
        '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
        '</styleSheet>',
    ),
    await entrada(
      'xl/worksheets/sheet1.xml',
      `${CABECERA_XML}<worksheet ${NS}><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>` +
        '<sheetFormatPr defaultRowHeight="15"/><sheetData/></worksheet>',
    ),
  ]
  return abrirLibro(escribirZip(entradas))
}

// -----------------------------------------------------------------------------
// Lo que una celda no puede llevar
// -----------------------------------------------------------------------------

/** Lo que cabe en el texto de una celda de Excel. Un texto más largo hace que Excel «repare» el libro. */
const MAX_TEXTO = 32_767

/**
 * Un valor tal y como se puede escribir sin que el libro mienta o se rompa.
 *
 * **Un texto que empieza por `=` es una fórmula** para el escritor de hojas
 * —`xmlDeCelda` lo escribe en `<f>`, que es lo que necesita la sincronización
 * para las suyas—. En una exportación eso es una puerta abierta: una nota de un
 * técnico, un número de serie mal tecleado o un nombre de artículo que empiece
 * por `=` se ejecutaría en el Excel de quien abre el fichero (`=HYPERLINK(…)`,
 * o el viejo `=cmd|…` de la inyección de fórmulas). Aquí no hay fórmulas que
 * escribir, así que todo texto es texto: el que empieza por `=` lleva delante
 * un apóstrofo, que es lo que enseña la guía de OWASP y lo que Excel hace
 * cuando uno teclea esa celda a mano.
 *
 * Y dos cosas más que no dan error al escribir y sí al abrir: un número que no
 * es finito (`NaN` se escribiría como `<v>NaN</v>`) se queda en blanco, y un
 * texto de más de 32.767 caracteres se corta.
 */
function celdaSegura(v: ValorCelda): ValorCelda {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return v
  const t = v.startsWith('=') ? `'${v}` : v
  return t.length > MAX_TEXTO ? `${t.slice(0, MAX_TEXTO - 1)}…` : t
}

// -----------------------------------------------------------------------------
// Lo que se llama desde fuera
// -----------------------------------------------------------------------------

/**
 * Un libro nuevo con exactamente `hojas`, en ese orden y con la primera activa.
 *
 * Cada hoja se pinta según su `caracter`: las `'app'` salen como tabla con
 * bandas y pestaña azul claro, las `'editable'` con autofiltro y las
 * `'discreta'` en gris y sin filtro. Las fechas se escriben como número de
 * serie (`fechaAExcel`) y el formato `'fecha'` de la columna las pinta como
 * `dd/mm/aaaa`.
 *
 * **Nada de lo que se le pasa se convierte en fórmula**: un texto que empieza
 * por `=` se escribe como texto, con un apóstrofo delante (ver `celdaSegura`).
 *
 * Falla —con un mensaje que se puede enseñar— si la lista está vacía, si dos
 * hojas se llaman igual (sin distinguir mayúsculas), o si un nombre pasa de 31
 * caracteres o lleva alguno de `\ / ? * [ ] :`. Todo eso lo rechaza Excel al
 * abrir, sin decir cuál era el problema.
 */
export async function libroNuevo(hojas: HojaNueva[]): Promise<Uint8Array> {
  comprobar(hojas)
  const primera = hojas[0]!.nombre
  const libro = await libroEnBlanco(primera)
  const seguras = hojas.map((h) => ({ ...h, filas: h.filas.map((fila) => fila.map(celdaSegura)) }))
  return escribirLibro(libro, [], [], {
    rehacer: seguras,
    orden: seguras.map((h) => h.nombre),
    activa: primera,
  })
}

/** Lo que un nombre de fichero no admite en Windows ni en macOS, más los caracteres de control. */
const NO_VALE_EN_UN_NOMBRE = /[\\/:*?"<>|\u0000-\u001f\u007f]/g

/**
 * `Almacén` → `Almacén 2026-10-27.xlsx`.
 *
 * El día es el de **Madrid**, no el del aparato: un iPad con la zona mal puesta,
 * o un ordenador de la nube en UTC, no debe fechar a las 00:30 del 27 con el
 * 26. Es la misma regla que el resto de la aplicación (`diaEnMadrid`).
 *
 * Lo que no vale en un nombre de fichero se cambia por un espacio y no se
 * quita: `Stock ene/feb` es `Stock ene feb` y no `Stock enefeb`. Una `.xlsx`
 * que el nombre ya lleve se respeta una sola vez, y si de la base no queda nada
 * se usa «Exportación» en vez de dejar un fichero que empiece por la fecha.
 */
export function nombreConFecha(base: string, hoy: Date = new Date()): string {
  const limpio = base
    .replace(/\.xlsx$/i, '')
    .replace(NO_VALE_EN_UN_NOMBRE, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 100)
    // Ni puntos ni espacios al principio o al final: `Almacén.` no es un nombre
    // válido en Windows y `.Almacén` esconde el fichero en macOS. Se quitan
    // DESPUÉS de cortar, que puede dejar uno al final.
    .replace(/^[.\s]+|[.\s]+$/g, '')
  return `${limpio === '' ? 'Exportación' : limpio} ${diaEnMadrid(hoy)}.xlsx`
}
