import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { escribirLibro } from './libro'
import type { Acabado, HojaNueva } from './libro'
import { abrirLibro, leerHoja } from './xlsx'
import type { Libro } from './xlsx'
import { leerEstilos } from './estilos'
import { descomprimir, escribirZip, reemplazar } from '../lib/zip'
import type { EntradaZip } from '../lib/zip'

const LIBRO = process.env.LIBRO_XLSX
const bytes = LIBRO ? readFileSync(LIBRO) : null

const ESTADO = 'Estado Aulas y Salas de reunion'

async function abrir() {
  return abrirLibro(new Uint8Array(bytes!))
}

async function xmlDe(libro: Libro, ruta: string): Promise<string> {
  const e = libro.entradas.find((x) => x.nombre === ruta)
  if (!e) throw new Error(`no está ${ruta}`)
  return new TextDecoder().decode(await descomprimir(e))
}

async function xmlDeHoja(libro: Libro, nombre: string): Promise<string> {
  return xmlDe(libro, libro.hojas.find((h) => h.nombre === nombre)!.ruta)
}

/** Las partes a las que apunta una hoja: comentarios, dibujo. */
async function relacionesDe(libro: Libro, nombre: string): Promise<string[]> {
  const ruta = libro.hojas.find((h) => h.nombre === nombre)!.ruta
  const partes = ruta.split('/')
  const fichero = partes.pop()!
  const e = libro.entradas.find((x) => x.nombre === `${partes.join('/')}/_rels/${fichero}.rels`)
  if (!e) return []
  const xml = new TextDecoder().decode(await descomprimir(e))
  return [...xml.matchAll(/Target="\/?(?:xl\/)?([^"]+)"/g)].map((m) => `xl/${m[1]!.replace(/^\.\.\//, '')}`)
}

const cuenta = (xml: string, etiqueta: string) => (xml.match(new RegExp(`<${etiqueta}\\b`, 'g')) ?? []).length

/** El mismo libro con el XML de una hoja cambiado a mano. */
async function conHoja(libro: Libro, nombre: string, f: (xml: string) => string): Promise<Libro> {
  const hoja = libro.hojas.find((h) => h.nombre === nombre)!
  const entradas = await Promise.all(
    libro.entradas.map(async (e) =>
      e.nombre === hoja.ruta ? reemplazar(e, new TextEncoder().encode(f(new TextDecoder().decode(await descomprimir(e))))) : e,
    ),
  )
  return abrirLibro(await escribirZip(entradas))
}

// -----------------------------------------------------------------------------
// Un libro mínimo construido aquí, para probar el acabado sin el libro real
// -----------------------------------------------------------------------------

const base = {
  metodo: 8, banderas: 0, fecha: 0, hora: 0, versionCreacion: 20, versionNecesaria: 20,
  atributosInternos: 0, atributosExternos: 0, extraLocal: new Uint8Array(0),
  extraCentral: new Uint8Array(0), comentario: new Uint8Array(0), crc32: 0,
  comprimido: new Uint8Array(0), tamanoOriginal: 0,
}
const t = (x: string) => new TextEncoder().encode(x)
const entrada = (nombre: string, xml: string) => reemplazar({ ...base, nombre }, t(xml))

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

/**
 * Tres hojas: «Estado» (de la gente, con cabecera, datos, autofiltro y
 * `sheetPr`), «Revisiones» (de la app, con comentarios y dibujo relacionados,
 * y una regla condicional vieja que debe desaparecer al rehacerla) y «Léeme»
 * (sin `sheetPr`). El libro se abre en la segunda y tiene dos hojas con
 * `tabSelected="1"`, que es el fallo que el acabado tiene que corregir.
 */
async function libroMinimo(): Promise<Libro> {
  const entradas: EntradaZip[] = [
    await entrada(
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>' +
        '</Types>',
    ),
    await entrada(
      '_rels/.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    await entrada(
      'xl/workbook.xml',
      `<workbook ${NS}><bookViews><workbookView activeTab="1"/></bookViews>` +
        '<sheets><sheet name="Estado" sheetId="1" r:id="rId1"/><sheet name="Revisiones" sheetId="2" r:id="rId2"/><sheet name="Léeme" sheetId="3" r:id="rId3"/></sheets>' +
        '<definedNames>' +
        '<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Estado!$A$1:$C$3</definedName>' +
        '<definedName name="_xlnm._FilterDatabase" localSheetId="1" hidden="1">Revisiones!$A$1:$B$2</definedName>' +
        '<definedName name="Total" localSheetId="2">Léeme!$A$1</definedName>' +
        '</definedNames><calcPr calcId="1"/></workbook>',
    ),
    await entrada(
      'xl/_rels/workbook.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>' +
        '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/>' +
        '</Relationships>',
    ),
    await entrada(
      'xl/styles.xml',
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
        '</styleSheet>',
    ),
    await entrada(
      'xl/worksheets/sheet1.xml',
      `<worksheet ${NS}><sheetPr><outlinePr summaryBelow="1"/></sheetPr><dimension ref="A1:C3"/>` +
        '<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>' +
        '<sheetData>' +
        '<row r="1"><c r="A1" s="0" t="inlineStr"><is><t>Aula</t></is></c><c r="B1" t="inlineStr"><is><t>Fecha</t></is></c><c r="C1" s="0"/></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>0.1P</t></is></c><c r="B2" s="1"><v>45831</v></c></row>' +
        '<row r="3"><c r="A3" t="inlineStr"><is><t>0.2P</t></is></c><c r="B3" s="1"><v>45832</v></c></row>' +
        '</sheetData><autoFilter ref="A1:C3"/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>',
    ),
    await entrada(
      'xl/worksheets/sheet2.xml',
      `<worksheet ${NS}><dimension ref="A1:B2"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>` +
        '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Ref</t></is></c><c r="B1" t="inlineStr"><is><t>Fecha</t></is></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>vieja</t></is></c><c r="B2"><v>1</v></c></row></sheetData>' +
        '<autoFilter ref="A1:B2"/>' +
        '<conditionalFormatting sqref="A2:B2"><cfRule type="expression" priority="1" dxfId="0"><formula>MOD(ROW(),2)=0</formula></cfRule></conditionalFormatting>' +
        '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><legacyDrawing r:id="rId2"/></worksheet>',
    ),
    await entrada(
      'xl/worksheets/_rels/sheet2.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/>' +
        '</Relationships>',
    ),
    await entrada(
      'xl/comments1.xml',
      '<comments><authors><author>Ana</author></authors><commentList><comment ref="A2" authorId="0"><text><t>Se revisó a mano</t></text></comment></commentList></comments>',
    ),
    await entrada('xl/drawings/vmlDrawing1.vml', '<xml><x:ClientData ObjectType="Note"><x:Row>1</x:Row><x:Column>0</x:Column></x:ClientData></xml>'),
    await entrada(
      'xl/worksheets/sheet3.xml',
      `<worksheet ${NS}><dimension ref="A1:A1"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>` +
        '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Léeme</t></is></c></row></sheetData></worksheet>',
    ),
    await entrada('xl/calcChain.xml', '<calcChain><c r="B2" i="1"/></calcChain>'),
  ]
  return abrirLibro(escribirZip(entradas))
}

const REVISIONES: HojaNueva = {
  nombre: 'Revisiones',
  filas: [
    ['Ref', 'Fecha', 'Horas', 'Notas'],
    ['SALA-000001', 45831, 921, 'bien'],
    ['SALA-000002', 45832, null, 'la TV no enciende'],
    ['SALA-000003', 45833, 10, null],
  ],
  anchos: [14, 11, 8, 40],
  formatos: [undefined, 'fecha', 'entero', 'textoAjustado'],
  tintes: ['ok', 'critico', undefined],
}

const ACABADO: Acabado = {
  rehacer: [REVISIONES],
  cabeceras: [{ hoja: 'Estado', columnas: { A: 'cabecera', B: 'cabeceraApp', C: 'cabeceraApp' } }],
  bandas: ['Estado'],
  orden: ['Estado', 'Revisiones'],
  discretas: ['Léeme'],
  activa: 'Estado',
}

describe('el acabado sobre un libro mínimo', () => {
  it('sin acabado ni hojas nuevas, styles.xml no se toca', async () => {
    const libro = await libroMinimo()
    const antes = await xmlDe(libro, 'xl/styles.xml')
    const otra = await abrirLibro(await escribirLibro(libro, [{ hoja: 'Estado', celdas: [{ celda: 'C2', valor: 'x' }] }]))
    expect(await xmlDe(otra, 'xl/styles.xml')).toBe(antes)
  })

  it('rehacer una hoja la deja en su mismo fichero, con sus relaciones y su cola', async () => {
    const libro = await libroMinimo()
    const otra = await abrirLibro(await escribirLibro(libro, [], [], { rehacer: [REVISIONES] }))
    expect(otra.hojas.find((h) => h.nombre === 'Revisiones')!.ruta).toBe('xl/worksheets/sheet2.xml')
    expect(await relacionesDe(otra, 'Revisiones')).toEqual(
      expect.arrayContaining(['xl/comments1.xml', 'xl/drawings/vmlDrawing1.vml']),
    )
    const xml = await xmlDeHoja(otra, 'Revisiones')
    expect(xml).toContain('<legacyDrawing r:id="rId2"/>')
    expect(xml).toContain('<pageMargins')
    // Lo que depende de las filas se regenera: ni el autofiltro viejo ni la regla vieja.
    expect(xml).not.toContain('<autoFilter')
    expect(xml).not.toContain('<conditionalFormatting')
    // Y `tableParts` es el ÚLTIMO hijo, después del dibujo.
    expect(xml).toMatch(/<legacyDrawing r:id="rId2"\/><tableParts count="1"><tablePart r:id="rId3"\/><\/tableParts><\/worksheet>$/)

    const filas = await leerHoja(otra, 'Revisiones')
    expect(filas).toHaveLength(4)
    expect(filas[3]!.celdas.A).toBe('SALA-000003')
  })

  it('el número de filas puede bajar, y la tabla lo sigue', async () => {
    const libro = await libroMinimo()
    const uno = await abrirLibro(await escribirLibro(libro, [], [], { rehacer: [REVISIONES] }))
    expect(await xmlDe(uno, 'xl/tables/table1.xml')).toContain('ref="A1:D4"')
    const dos = await abrirLibro(await escribirLibro(uno, [], [], { rehacer: [{ ...REVISIONES, filas: [REVISIONES.filas[0]!] }] }))
    expect(await leerHoja(dos, 'Revisiones')).toHaveLength(1)
    // Una tabla necesita una fila de datos: el rango llega a la 2 aunque esté vacía.
    expect(await xmlDe(dos, 'xl/tables/table1.xml')).toContain('ref="A1:D2"')
    expect(dos.entradas.filter((e) => e.nombre.startsWith('xl/tables/'))).toHaveLength(1)
  })

  it('la tabla lleva las cabeceras exactas y se declara en los tipos de contenido', async () => {
    const otra = await abrirLibro(await escribirLibro(await libroMinimo(), [], [], { rehacer: [REVISIONES] }))
    const tabla = await xmlDe(otra, 'xl/tables/table1.xml')
    expect(tabla).toContain('<tableColumns count="4"><tableColumn id="1" name="Ref"/><tableColumn id="2" name="Fecha"/><tableColumn id="3" name="Horas"/><tableColumn id="4" name="Notas"/></tableColumns>')
    expect(tabla).toContain('displayName="Revisiones"')
    expect(await xmlDe(otra, '[Content_Types].xml')).toContain('PartName="/xl/tables/table1.xml"')
    // La tabla lleva su filtro: el nombre definido del autofiltro de esa hoja sobra.
    const wb = await xmlDe(otra, 'xl/workbook.xml')
    expect(wb).not.toContain('Revisiones!$A$1:$B$2')
    expect(wb).toContain('Estado!$A$1:$C$3')
  })

  it('la fecha y el porcentaje se ven como tales según leerEstilos, sin tomar nada prestado', async () => {
    const hoja: HojaNueva = { ...REVISIONES, formatos: [undefined, 'fecha', 'porcentaje', undefined] }
    const otra = await abrirLibro(await escribirLibro(await libroMinimo(), [], [], { rehacer: [hoja] }))
    const estilos = leerEstilos(await xmlDe(otra, 'xl/styles.xml'))
    const xml = await xmlDeHoja(otra, 'Revisiones')
    const s = (ref: string) => Number(new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(xml)?.[1])
    expect(estilos.formatoDe(s('B2'))).toBe('fecha')
    expect(estilos.formatoDe(s('C2'))).toBe('porcentaje')
    expect(estilos.formatoDe(s('A2'))).toBe('otro')
  })

  it('los tintes van por fila y no le quitan el formato a la fecha', async () => {
    const otra = await abrirLibro(await escribirLibro(await libroMinimo(), [], [], { rehacer: [REVISIONES] }))
    const styles = await xmlDe(otra, 'xl/styles.xml')
    const xml = await xmlDeHoja(otra, 'Revisiones')
    const fills = [...(/<fills[\s\S]*?<\/fills>/.exec(styles)![0].matchAll(/<fill>[\s\S]*?<\/fill>|<fill\/>/g))].map((m) => m[0])
    const xfs = [...(/<cellXfs[\s\S]*?<\/cellXfs>/.exec(styles)![0].matchAll(/<xf\b[^>]*?\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g))].map((m) => m[0])
    const fondoDe = (ref: string) => {
      const s = Number(new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(xml)?.[1])
      const fill = Number(/fillId="(\d+)"/.exec(xfs[s]!)?.[1])
      return /rgb="FF([0-9A-F]{6})"/.exec(fills[fill]!)?.[1] ?? null
    }
    expect(fondoDe('A2')).toBe('E2F1E9')
    expect(fondoDe('B2')).toBe('E2F1E9')
    expect(fondoDe('A3')).toBe('FAE8E6')
    // La celda vacía de la fila crítica también va tintada: la banda no tiene huecos.
    expect(fondoDe('C3')).toBe('FAE8E6')
    expect(fondoDe('A4')).toBeNull()
    expect(leerEstilos(styles).formatoDe(Number(/<c r="B3" s="(\d+)"/.exec(xml)?.[1]))).toBe('fecha')
  })

  it('un estilo suelto por celda gana a formatos y tintes, y los altos de fila se respetan', async () => {
    const hoja: HojaNueva = {
      nombre: 'Léeme',
      caracter: 'discreta',
      inmovilizar: false,
      filas: [['Título del libro', null], ['Qué es', 'Un texto largo']],
      estilos: { A1: 'titulo', A2: 'etiqueta', B2: 'textoSinBorde' },
      altos: { 1: 24, 2: 45 },
    }
    const otra = await abrirLibro(await escribirLibro(await libroMinimo(), [], [], { rehacer: [hoja] }))
    const xml = await xmlDeHoja(otra, 'Léeme')
    const styles = await xmlDe(otra, 'xl/styles.xml')
    const xfs = [...(/<cellXfs[\s\S]*?<\/cellXfs>/.exec(styles)![0].matchAll(/<xf\b[^>]*?\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g))].map((m) => m[0])
    const fonts = [...(/<fonts[\s\S]*?<\/fonts>/.exec(styles)![0].matchAll(/<font>[\s\S]*?<\/font>/g))].map((m) => m[0])
    const fuenteDe = (ref: string) => fonts[Number(/fontId="(\d+)"/.exec(xfs[Number(new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(xml)?.[1])]!)?.[1])]!
    expect(fuenteDe('A1')).toContain('<sz val="14"/>')
    expect(fuenteDe('A2')).toContain('<b/>')
    expect(xml).toContain('<row r="1" ht="24" customHeight="1">')
    expect(xml).toContain('<row r="2" ht="45" customHeight="1">')
    // Discreta: sin tabla, sin autofiltro, pestaña gris.
    expect(xml).not.toContain('<tableParts')
    expect(xml).not.toContain('<autoFilter')
    expect(xml).toContain('<sheetPr><tabColor rgb="FF7F7F7F"/></sheetPr>')
  })

  it('una hoja editable lleva autofiltro y no tabla; una de la app, tabla y pestaña azul', async () => {
    const editable: HojaNueva = { nombre: 'PCs', caracter: 'editable', filas: [['Modelo', 'Serie'], ['M720', 'X1']] }
    const otra = await abrirLibro(await escribirLibro(await libroMinimo(), [], [editable, { nombre: 'App', filas: [['a'], ['b']] }]))
    const pcs = await xmlDeHoja(otra, 'PCs')
    expect(pcs).toContain('<autoFilter ref="A1:B2"/>')
    expect(pcs).not.toContain('<tableParts')
    expect(pcs).not.toContain('<tabColor')
    const app = await xmlDeHoja(otra, 'App')
    expect(app).toContain('<tableParts')
    expect(app).toContain('<tabColor rgb="FF9DC3E6"/>')
    // La cabecera de cada una con su clave: 1F4E78 la editable, 5B7F9E la de la app.
    const styles = await xmlDe(otra, 'xl/styles.xml')
    expect(styles).toContain('FF1F4E78')
    expect(styles).toContain('FF5B7F9E')
  })

  it('las cabeceras de las hojas de la gente cambian solo el estilo de las celdas con valor', async () => {
    const libro = await libroMinimo()
    const otra = await abrirLibro(await escribirLibro(libro, [], [], { cabeceras: ACABADO.cabeceras }))
    const xml = await xmlDeHoja(otra, 'Estado')
    // `B1` no tenía `s` y lo gana detrás de `t`: el orden de atributos da igual.
    const sA = /<c r="A1"[^>]*\bs="(\d+)"/.exec(xml)?.[1]
    const sB = /<c r="B1"[^>]*\bs="(\d+)"/.exec(xml)?.[1]
    expect(sA).toBeTruthy()
    expect(sB).toBeTruthy()
    expect(sA).not.toBe(sB)
    expect(xml).toContain('<is><t>Aula</t></is>')
    // C1 no tiene valor: se queda como estaba.
    expect(xml).toContain('<c r="C1" s="0"/>')
    // Y el cuerpo no se toca.
    expect(xml).toContain('<c r="B2" s="1"><v>45831</v></c>')
  })

  it('un cambio con estilo con nombre escribe ese estilo y no el de la vecina', async () => {
    const libro = await libroMinimo()
    const otra = await abrirLibro(
      await escribirLibro(libro, [{ hoja: 'Estado', celdas: [{ celda: 'D1', valor: 'Ref', estilo: 'cabeceraApp' }] }]),
    )
    const xml = await xmlDeHoja(otra, 'Estado')
    const s = Number(/<c r="D1" s="(\d+)"/.exec(xml)?.[1])
    const styles = await xmlDe(otra, 'xl/styles.xml')
    const xfs = [...(/<cellXfs[\s\S]*?<\/cellXfs>/.exec(styles)![0].matchAll(/<xf\b[^>]*?\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g))].map((m) => m[0])
    expect(xfs[s]).toContain('applyFill="1"')
    expect(xfs[s]).toContain('<alignment horizontal="center" vertical="center" wrapText="1"/>')
  })

  it('las bandas se añaden una vez y se ajustan al crecer la hoja', async () => {
    const libro = await libroMinimo()
    const uno = await abrirLibro(await escribirLibro(libro, [], [], { bandas: ['Estado'] }))
    const xml1 = await xmlDeHoja(uno, 'Estado')
    expect(xml1).toContain('<conditionalFormatting sqref="A2:C3"><cfRule type="expression" dxfId="0" priority="1"><formula>MOD(ROW(),2)=0</formula></cfRule></conditionalFormatting>')
    // En su sitio: después del autofiltro y antes de los márgenes.
    expect(xml1).toMatch(/<autoFilter ref="A1:C3"\/><conditionalFormatting[\s\S]*<\/conditionalFormatting><pageMargins/)
    expect(cuenta(await xmlDe(uno, 'xl/styles.xml'), 'dxf')).toBe(1)

    // Una fila más y la misma orden: la regla sigue siendo una, con el rango nuevo.
    const dos = await abrirLibro(
      await escribirLibro(uno, [{ hoja: 'Estado', filas: { insertar: [{ tras: 3, celdas: [{ celda: 'A4', valor: '0.3P' }] }] } }], [], { bandas: ['Estado'] }),
    )
    const xml2 = await xmlDeHoja(dos, 'Estado')
    expect(cuenta(xml2, 'cfRule')).toBe(1)
    expect(xml2).toContain('sqref="A2:C4"')
    expect(cuenta(await xmlDe(dos, 'xl/styles.xml'), 'dxf')).toBe(1)
    // Y el autofiltro, la dimensión y el nombre oculto del filtro siguen a los
    // datos: una fila añadida al final no puede quedar fuera del desplegable.
    expect(xml2).toContain('<autoFilter ref="A1:C4"/>')
    expect(xml2).toContain('<dimension ref="A1:C4"/>')
    expect(await xmlDe(dos, 'xl/workbook.xml')).toContain(
      '<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Estado!$A$1:$C$4</definedName>',
    )
  })

  it('una fórmula escrita contra la hoja de antes baja con su fila y habla de la nueva', async () => {
    // Se borra la 2 y se escribe una fórmula en la 3: la celda pasa a ser la 2
    // y la fórmula tiene que sumar la 2, no la 3 (que ahora es otra fila).
    const libro = await libroMinimo()
    const otra = await abrirLibro(
      await escribirLibro(libro, [
        { hoja: 'Estado', filas: { borrar: [2] }, celdas: [{ celda: 'C3', valor: '=A3+B3' }] },
      ]),
    )
    const filas = await leerHoja(otra, 'Estado')
    expect(filas.find((f) => f.fila === 2)!.formulas!.C).toBe('A2+B2')
  })

  it('una celda vacía autocerrada en la cabecera no roba el color a la de al lado', async () => {
    const libro = await libroMinimo()
    const con = await conHoja(libro, 'Estado', (xml) =>
      xml.replace(/<row r="1">[\s\S]*?<\/row>/, '<row r="1"><c r="A1" s="1" t="inlineStr"><is><t>Uno</t></is></c><c r="B1" s="1"/><c r="C1" s="1" t="inlineStr"><is><t>Tres</t></is></c></row>'),
    )
    const otra = await abrirLibro(
      await escribirLibro(con, [], [], { cabeceras: [{ hoja: 'Estado', columnas: { A: 'cabecera', B: 'cabecera', C: 'cabeceraApp' } }] }),
    )
    const xml = await xmlDeHoja(otra, 'Estado')
    const s = (ref: string) => new RegExp(`<c r="${ref}"[^>]*\\bs="(\\d+)"`).exec(xml)?.[1]
    // A y C pintadas con dos estilos distintos (cabecera y cabeceraApp); B, vacía, como estaba.
    expect(s('A1')).not.toBe('1')
    expect(s('C1')).not.toBe('1')
    expect(s('A1')).not.toBe(s('C1'))
    expect(s('B1')).toBe('1')
    expect(xml).toContain('<c r="B1" s="1"/>')
  })

  it('las filas de totales quedan fuera del filtro y de las bandas', async () => {
    const libro = await libroMinimo()
    const otra = await abrirLibro(await escribirLibro(libro, [], [], { bandas: ['Estado'], totales: { Estado: 1 } }))
    const xml = await xmlDeHoja(otra, 'Estado')
    // Tres filas: la última es un total. La dimensión las cubre; el filtro y las bandas, no.
    expect(xml).toContain('<dimension ref="A1:C3"/>')
    expect(xml).toContain('<autoFilter ref="A1:C2"/>')
    expect(xml).toContain('sqref="A2:C2"')
    expect(await xmlDe(otra, 'xl/workbook.xml')).toContain('>Estado!$A$1:$C$2</definedName>')
  })

  it('el orden de pestañas remapea los localSheetId y deja una sola activa', async () => {
    const libro = await libroMinimo()
    const otra = await abrirLibro(
      await escribirLibro(libro, [], [], { orden: ['Revisiones'], discretas: ['Léeme'], activa: 'Estado' }),
    )
    expect(otra.hojas.map((h) => h.nombre)).toEqual(['Revisiones', 'Estado', 'Léeme'])
    const wb = await xmlDe(otra, 'xl/workbook.xml')
    // Estado pasa del 0 al 1 y Revisiones del 1 al 0; Léeme se queda en el 2.
    expect(wb).toContain('<definedName name="_xlnm._FilterDatabase" localSheetId="1" hidden="1">Estado!$A$1:$C$3</definedName>')
    expect(wb).toContain('<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Revisiones!$A$1:$B$2</definedName>')
    expect(wb).toContain('<definedName name="Total" localSheetId="2">Léeme!$A$1</definedName>')
    expect(wb).toContain('activeTab="1"')
    const seleccionadas = await Promise.all(otra.hojas.map(async (h) => /tabSelected="1"/.test(await xmlDeHoja(otra, h.nombre))))
    expect(seleccionadas).toEqual([false, true, false])
    // La discreta va gris, con `tabColor` como primer hijo de un `sheetPr` nuevo.
    expect(await xmlDeHoja(otra, 'Léeme')).toMatch(/<worksheet [^>]*><sheetPr><tabColor rgb="FF7F7F7F"\/><\/sheetPr><dimension/)
    // Reordenar es cambiar la estructura: la caché de recálculo se va.
    expect(otra.entradas.some((e) => e.nombre === 'xl/calcChain.xml')).toBe(false)
  })

  it('`tabColor` es el primer hijo de un `sheetPr` que ya existía', async () => {
    const otra = await abrirLibro(await escribirLibro(await libroMinimo(), [], [], { pestanas: { Estado: '9DC3E6' } }))
    expect(await xmlDeHoja(otra, 'Estado')).toContain('<sheetPr><tabColor rgb="FF9DC3E6"/><outlinePr summaryBelow="1"/></sheetPr>')
  })

  it('las discretas van al final en el orden de sus patrones, con prefijo', async () => {
    const libro = await libroMinimo()
    const otra = await abrirLibro(
      await escribirLibro(libro, [], [{ nombre: 'Cambios 2026-09-21', filas: [['a']] }], { orden: ['Estado'], discretas: ['Cambios*', 'Léeme'] }),
    )
    expect(otra.hojas.map((h) => h.nombre)).toEqual(['Estado', 'Revisiones', 'Cambios 2026-09-21', 'Léeme'])
  })

  it('el mismo acabado dos veces da el mismo libro', async () => {
    const libro = await libroMinimo()
    const uno = await escribirLibro(libro, [], [], ACABADO)
    const dos = await escribirLibro(await abrirLibro(uno), [], [], ACABADO)
    const a = await abrirLibro(uno)
    const b = await abrirLibro(dos)
    expect(await xmlDe(b, 'xl/styles.xml')).toBe(await xmlDe(a, 'xl/styles.xml'))
    expect(await xmlDe(b, 'xl/workbook.xml')).toBe(await xmlDe(a, 'xl/workbook.xml'))
    const tablas = (l: Libro) => l.entradas.filter((e) => e.nombre.startsWith('xl/tables/')).length
    expect(tablas(b)).toBe(tablas(a))
    expect(tablas(a)).toBe(1)
    for (const h of a.hojas) {
      expect(await xmlDeHoja(b, h.nombre)).toBe(await xmlDeHoja(a, h.nombre))
    }
    expect(cuenta(await xmlDe(b, 'xl/styles.xml'), 'dxf')).toBe(1)
    expect(cuenta(await xmlDe(b, 'xl/workbook.xml'), 'definedName')).toBe(2)
    // Y hasta los bytes: la segunda pasada no produce una versión nueva en SharePoint.
    expect(Buffer.compare(Buffer.from(uno), Buffer.from(dos))).toBe(0)
  })

  it('rehacer una hoja que no existe la añade', async () => {
    const otra = await abrirLibro(await escribirLibro(await libroMinimo(), [], [], { rehacer: [{ nombre: 'Movimientos de Almacén', filas: [['Fecha', 'Artículo'], [1, 'x']] }] }))
    expect(otra.hojas.map((h) => h.nombre)).toContain('Movimientos de Almacén')
    expect(await xmlDe(otra, 'xl/tables/table1.xml')).toContain('displayName="MovimientosDeAlmacen"')
  })
})

// -----------------------------------------------------------------------------
// Sobre el libro real
// -----------------------------------------------------------------------------

describe.skipIf(!bytes)('escribir el libro', () => {
  it('sin pedir nada devuelve un libro que se puede volver a abrir', async () => {
    const salida = await escribirLibro(await abrir(), [])
    const otra = await abrirLibro(salida)
    expect(otra.hojas.map((h) => h.nombre)).toEqual((await abrir()).hojas.map((h) => h.nombre))
  })

  it('escribe una celda sin tocar las demás', async () => {
    const antes = await leerHoja(await abrir(), ESTADO)
    const salida = await escribirLibro(await abrir(), [
      { hoja: ESTADO, celdas: [{ celda: 'X2', valor: 'probado' }] },
    ])
    const otra = await abrirLibro(salida)
    const filas = await leerHoja(otra, ESTADO)
    expect(filas.find((f) => f.fila === 2)!.celdas.X).toBe('probado')
    expect(filas.find((f) => f.fila === 2)!.celdas.C).toBe(antes.find((f) => f.fila === 2)!.celdas.C)
  })

  it('insertar una fila mueve las celdas que se piden con ella', async () => {
    // Se escribe pensando en la hoja de antes: `C31` es la fila 31 de hoy.
    const salida = await escribirLibro(await abrir(), [
      {
        hoja: ESTADO,
        filas: {
          insertar: [
            {
              tras: 30,
              celdas: [
                { celda: 'A31', valor: 'EDIFICIO P' },
                { celda: 'C31', valor: '0.99P' },
              ],
            },
          ],
        },
        celdas: [{ celda: 'X31', valor: 'la de antes' }],
      },
    ])

    const otra = await abrirLibro(salida)
    const filas = await leerHoja(otra, ESTADO)
    expect(filas.find((f) => f.fila === 31)!.celdas.C).toBe('0.99P')
    // La celda pedida sobre la fila 31 de antes ha ido a parar a la 32.
    expect(filas.find((f) => f.fila === 32)!.celdas.X).toBe('la de antes')
  })

  it('borrar una fila la quita y sube las de debajo', async () => {
    const antes = await leerHoja(await abrir(), ESTADO)
    const era32 = antes.find((f) => f.fila === 32)!

    const salida = await escribirLibro(await abrir(), [
      { hoja: ESTADO, filas: { borrar: [31] } },
    ])
    const filas = await leerHoja(await abrirLibro(salida), ESTADO)
    expect(filas.find((f) => f.fila === 31)!.celdas.C).toBe(era32.celdas.C)
  })

  it('al mover filas no queda caché de recálculo', async () => {
    const salida = await escribirLibro(await abrir(), [
      { hoja: ESTADO, filas: { insertar: [{ tras: 30, celdas: [{ celda: 'A31', valor: 'x' }] }] } },
    ])
    const otra = await abrirLibro(salida)
    expect(otra.entradas.some((e) => e.nombre === 'xl/calcChain.xml')).toBe(false)
  })

  it('escribir solo celdas no tira la caché, si la había', async () => {
    const original = await abrir()
    const tenia = original.entradas.some((e) => e.nombre === 'xl/calcChain.xml')
    const salida = await escribirLibro(original, [
      { hoja: ESTADO, celdas: [{ celda: 'X2', valor: 'x' }] },
    ])
    expect((await abrirLibro(salida)).entradas.some((e) => e.nombre === 'xl/calcChain.xml')).toBe(tenia)
  })

  it('los comentarios siguen a su aula al insertar', async () => {
    const original = await abrir()
    const comentarios = (await relacionesDe(original, ESTADO)).find((r) => /comment/.test(r))!
    expect(comentarios).toBeTruthy()
    const antes = await xmlDe(original, comentarios)
    const refs = [...antes.matchAll(/<comment\b[^>]*\bref="([A-Z]+)(\d+)"/g)].map((m) => [m[1]!, Number(m[2])] as const)
    expect(refs.length).toBeGreaterThan(0)
    const textos = [...antes.matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]).slice(0, 3)

    const salida = await escribirLibro(original, [
      { hoja: ESTADO, filas: { insertar: [{ tras: 30, celdas: [{ celda: 'A31', valor: 'x' }] }] } },
    ])
    const despues = await xmlDe(await abrirLibro(salida), comentarios)
    for (const [col, fila] of refs) {
      expect(despues).toContain(`ref="${col}${fila > 30 ? fila + 1 : fila}"`)
    }
    for (const texto of textos) expect(despues).toContain(texto)
  })

  it('el ancla del dibujo del comentario también', async () => {
    const original = await abrir()
    const vml = (await relacionesDe(original, ESTADO)).find((r) => r.endsWith('.vml'))!
    const antes = await xmlDe(original, vml)
    const filasAntes = [...antes.matchAll(/<x:Row>(\d+)<\/x:Row>/g)].map((m) => Number(m[1]))
    // El libro reformateado escribe el dibujo con otros prefijos (`ns2:Row`),
    // que `estructura.ts` no mueve: ahí no hay anclas que comprobar, solo que
    // el dibujo sigue estando.
    if (filasAntes.length === 0) {
      expect(antes).toMatch(/<(?:\w+:)?Row>\d+<\/(?:\w+:)?Row>/)
      return
    }

    const salida = await escribirLibro(original, [
      { hoja: ESTADO, filas: { insertar: [{ tras: 30, celdas: [{ celda: 'A31', valor: 'x' }] }] } },
    ])
    const despues = await xmlDe(await abrirLibro(salida), vml)
    const filasDespues = [...despues.matchAll(/<x:Row>(\d+)<\/x:Row>/g)].map((m) => Number(m[1]))
    // Todas las de debajo del corte bajan una; ninguna se queda igual por error.
    expect(filasDespues).toEqual(filasAntes.map((f) => (f + 1 >= 31 ? f + 1 : f)))
  })

  it('ninguna parte del libro se pierde por el camino', async () => {
    const original = await abrir()
    const salida = await escribirLibro(original, [
      { hoja: ESTADO, filas: { insertar: [{ tras: 30, celdas: [{ celda: 'A31', valor: 'x' }] }] } },
    ])
    const otra = await abrirLibro(salida)
    const nombres = new Set(otra.entradas.map((e) => e.nombre))
    for (const e of original.entradas) {
      if (e.nombre === 'xl/calcChain.xml') continue
      expect(nombres.has(e.nombre)).toBe(true)
    }
  })
})

describe.skipIf(!bytes)('la caché de recálculo', () => {
  it('si el libro la trae, la trae en los tres sitios', async () => {
    const libro = await abrir()
    const tiene = libro.entradas.some((e) => e.nombre === 'xl/calcChain.xml')
    expect((await xmlDe(libro, '[Content_Types].xml')).includes('/xl/calcChain.xml')).toBe(tiene)
    expect((await xmlDe(libro, 'xl/_rels/workbook.xml.rels')).includes('calcChain')).toBe(tiene)
  })

  it('mover una fila la quita de los tres, no solo del zip', async () => {
    // Dejar el `Override` o la relación apuntando a una parte que ya no está es
    // exactamente el error que se evitaba tirándola: Excel sí denuncia ése.
    const salida = await escribirLibro(await abrir(), [
      { hoja: ESTADO, filas: { insertar: [{ tras: 30, celdas: [{ celda: 'C31', valor: 'nueva' }] }] } },
    ])
    const otra = await abrirLibro(salida)
    expect(otra.entradas.some((e) => e.nombre === 'xl/calcChain.xml')).toBe(false)
    expect(await xmlDe(otra, '[Content_Types].xml')).not.toContain('calcChain')
    expect(await xmlDe(otra, 'xl/_rels/workbook.xml.rels')).not.toContain('calcChain')
  })

  it('escribir solo celdas no la toca: la estructura no se ha movido', async () => {
    const original = await abrir()
    const tenia = (await xmlDe(original, '[Content_Types].xml')).includes('calcChain')
    const salida = await escribirLibro(original, [
      { hoja: ESTADO, celdas: [{ celda: 'X2', valor: 'probado' }] },
    ])
    const otra = await abrirLibro(salida)
    expect((await xmlDe(otra, '[Content_Types].xml')).includes('calcChain')).toBe(tenia)
  })

  it('y las demás relaciones del libro siguen enteras', async () => {
    const original = await abrir()
    const antes = await xmlDe(original, 'xl/_rels/workbook.xml.rels')
    const tenia = original.entradas.some((e) => e.nombre === 'xl/calcChain.xml') ? 1 : 0
    const salida = await escribirLibro(original, [
      { hoja: ESTADO, filas: { insertar: [{ tras: 30, celdas: [{ celda: 'C31', valor: 'nueva' }] }] } },
    ])
    const despues = await xmlDe(await abrirLibro(salida), 'xl/_rels/workbook.xml.rels')
    const cuentaRel = (x: string) => (x.match(/<Relationship\b/g) ?? []).length
    expect(cuentaRel(despues)).toBe(cuentaRel(antes) - tenia)
  })
})

describe.skipIf(!bytes)('añadir hojas', () => {
  it('la hoja nueva sale al final y se lee', async () => {
    const salida = await escribirLibro(
      await abrir(),
      [],
      [
        {
          nombre: 'Prueba de hoja nueva',
          filas: [
            ['Aula', 'Fecha', 'Revisó'],
            ['0.1P', 45000, 'Ana'],
          ],
          anchos: [14, 12, 20],
        },
      ],
    )
    const otra = await abrirLibro(salida)
    expect(otra.hojas[otra.hojas.length - 1]!.nombre).toBe('Prueba de hoja nueva')

    const filas = await leerHoja(otra, 'Prueba de hoja nueva')
    expect(filas[0]!.celdas).toEqual({ A: 'Aula', B: 'Fecha', C: 'Revisó' })
    expect(filas[1]!.celdas).toEqual({ A: '0.1P', B: 45000, C: 'Ana' })
  })

  it('no choca con el número de fichero de las hojas que ya hay', async () => {
    const salida = await escribirLibro(
      await abrir(),
      [],
      [
        { nombre: 'Uno', filas: [['a']] },
        { nombre: 'Dos', filas: [['b']] },
      ],
    )
    const otra = await abrirLibro(salida)
    const rutas = otra.hojas.map((h) => h.ruta)
    expect(new Set(rutas).size).toBe(rutas.length)
    expect(await leerHoja(otra, 'Uno')).toHaveLength(1)
    expect(await leerHoja(otra, 'Dos')).toHaveLength(1)
  })

  it('la hoja nueva se declara en los tipos de contenido', async () => {
    const salida = await escribirLibro(await abrir(), [], [{ nombre: 'Movimientos', filas: [['a']] }])
    const otra = await abrirLibro(salida)
    const ct = await xmlDe(otra, '[Content_Types].xml')
    const ruta = otra.hojas.find((h) => h.nombre === 'Movimientos')!.ruta
    expect(ct).toContain(`PartName="/${ruta}"`)
  })

  it('una hoja repetida se dice, no se duplica', async () => {
    await expect(
      escribirLibro(await abrir(), [], [{ nombre: ESTADO, filas: [['a']] }]),
    ).rejects.toThrow(/ya tiene una hoja/)
  })

  it('un nombre de más de 31 caracteres se dice', async () => {
    await expect(
      escribirLibro(await abrir(), [], [{ nombre: 'x'.repeat(32), filas: [['a']] }]),
    ).rejects.toThrow(/31 caracteres/)
  })

  it('una fórmula en una hoja nueva se escribe como fórmula', async () => {
    const salida = await escribirLibro(
      await abrir(),
      [],
      [{ nombre: 'Sumas', filas: [['Total'], ['=1+1']] }],
    )
    const otra = await abrirLibro(salida)
    const xml = await xmlDe(otra, otra.hojas.find((h) => h.nombre === 'Sumas')!.ruta)
    expect(xml).toContain('<f>1+1</f>')
  })
})

describe.skipIf(!bytes)('el acabado sobre el libro real', () => {
  const GENTE = [ESTADO, 'Material Instalado 2026', 'Bolsa 2026', 'PCs STOCK 2026', 'Material Instalado 2025', 'Bolsa 2025']
  const columnas: Record<string, 'cabecera' | 'cabeceraApp'> = {}
  for (let c = 0; c < 24; c++) {
    const l = String.fromCharCode(65 + c)
    columnas[l] = ['E', 'H', 'I', 'J'].includes(l) ? 'cabeceraApp' : 'cabecera'
  }
  columnas.Y = 'cabeceraApp'
  const acabado: Acabado = {
    rehacer: [{ ...REVISIONES, tintes: ['ok', 'critico', 'apagado'] }],
    cabeceras: [{ hoja: ESTADO, columnas }],
    bandas: GENTE,
    orden: [...GENTE, 'Revisiones', 'Movimientos de Almacén', 'Inventario por Sala'],
    discretas: ['Sincronización', 'Léeme', 'Cambios*'],
    activa: ESTADO,
  }

  it('ordena, colorea, hace la tabla y deja una sola pestaña activa', async () => {
    const otra = await abrirLibro(await escribirLibro(await abrir(), [], [], acabado))
    const nombres = otra.hojas.map((h) => h.nombre)
    expect(nombres.slice(0, 9)).toEqual(acabado.orden)
    expect(nombres.slice(9).every((n) => /^(Sincronización|Léeme|Cambios)/.test(n))).toBe(true)
    expect(await xmlDe(otra, 'xl/workbook.xml')).toContain('activeTab="0"')

    const seleccionadas = await Promise.all(otra.hojas.map(async (h) => /tabSelected="1"/.test(await xmlDeHoja(otra, h.nombre))))
    expect(seleccionadas.filter(Boolean)).toHaveLength(1)
    expect(seleccionadas[0]).toBe(true)

    expect(await xmlDeHoja(otra, 'Revisiones')).toContain('<tabColor rgb="FF9DC3E6"/>')
    expect(await xmlDeHoja(otra, 'Léeme')).toMatch(/<sheetPr><tabColor rgb="FF7F7F7F"\/>/)
    expect(await xmlDeHoja(otra, 'Sincronización')).toMatch(/<sheetPr><tabColor rgb="FF7F7F7F"\/>/)

    const tabla = await xmlDe(otra, 'xl/tables/table1.xml')
    expect(tabla).toContain('displayName="Revisiones" ref="A1:D4"')
    expect(await xmlDe(otra, '[Content_Types].xml')).toContain('/xl/tables/table1.xml')
    // Los comentarios de Revisiones siguen relacionados, y el dibujo también.
    expect((await relacionesDe(otra, 'Revisiones')).some((r) => /comment/.test(r))).toBe(true)
    expect(await xmlDeHoja(otra, 'Revisiones')).toMatch(/<legacyDrawing[^>]*\/><tableParts/)
  })

  it('las cabeceras de la hoja de estado llevan su clave y el texto no cambia', async () => {
    const original = await abrir()
    const cabeceraAntes = (await leerHoja(original, ESTADO))[0]!.celdas
    const otra = await abrirLibro(await escribirLibro(original, [], [], acabado))
    expect((await leerHoja(otra, ESTADO))[0]!.celdas).toEqual(cabeceraAntes)
    const xml = await xmlDeHoja(otra, ESTADO)
    const sA = /<c r="A1" s="(\d+)"/.exec(xml)?.[1]
    const sE = /<c r="E1" s="(\d+)"/.exec(xml)?.[1]
    const sD = /<c r="D1" s="(\d+)"/.exec(xml)?.[1]
    expect(sA).toBe(sD)
    expect(sA).not.toBe(sE)
  })

  it('las bandas que el libro ya trae no se repiten, ni su dxf', async () => {
    const original = await abrir()
    const antes = await xmlDe(original, 'xl/styles.xml')
    const otra = await abrirLibro(await escribirLibro(original, [], [], acabado))
    for (const nombre of GENTE) {
      const a = await xmlDeHoja(original, nombre)
      const b = await xmlDeHoja(otra, nombre)
      expect(cuenta(b, 'cfRule')).toBe(cuenta(a, 'cfRule'))
    }
    expect(cuenta(await xmlDe(otra, 'xl/styles.xml'), 'dxf')).toBe(cuenta(antes, 'dxf'))
  })

  it('la segunda pasada no cambia nada: ni estilos, ni tablas, ni reglas, ni nombres', async () => {
    const uno = await escribirLibro(await abrir(), [], [], acabado)
    const dos = await escribirLibro(await abrirLibro(uno), [], [], acabado)
    const a = await abrirLibro(uno)
    const b = await abrirLibro(dos)
    expect(await xmlDe(b, 'xl/styles.xml')).toBe(await xmlDe(a, 'xl/styles.xml'))
    expect(await xmlDe(b, 'xl/workbook.xml')).toBe(await xmlDe(a, 'xl/workbook.xml'))
    expect(b.entradas.filter((e) => e.nombre.startsWith('xl/tables/'))).toHaveLength(
      a.entradas.filter((e) => e.nombre.startsWith('xl/tables/')).length,
    )
    for (const h of a.hojas) {
      expect(cuenta(await xmlDeHoja(b, h.nombre), 'cfRule')).toBe(cuenta(await xmlDeHoja(a, h.nombre), 'cfRule'))
    }
    expect(Buffer.compare(Buffer.from(uno), Buffer.from(dos))).toBe(0)
  })
})
