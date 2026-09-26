import { describe, expect, it } from 'vitest'
import {
  asegurarTabla,
  columnasDeTabla,
  nombreDeTabla,
  quitarFiltroDeHoja,
  refDeTabla,
  rutaDeRels,
  tablaDeHoja,
  xmlDeTabla,
} from './tablas'
import { descomprimir, reemplazar } from '../lib/zip'
import type { EntradaZip } from '../lib/zip'

const base = {
  metodo: 8, banderas: 0, fecha: 0, hora: 0, versionCreacion: 20, versionNecesaria: 20,
  atributosInternos: 0, atributosExternos: 0, extraLocal: new Uint8Array(0),
  extraCentral: new Uint8Array(0), comentario: new Uint8Array(0), crc32: 0,
  comprimido: new Uint8Array(0), tamanoOriginal: 0,
}
const t = (x: string) => new TextEncoder().encode(x)
const entrada = (nombre: string, xml: string) => reemplazar({ ...base, nombre }, t(xml))
const texto = async (entradas: EntradaZip[], nombre: string) => {
  const e = entradas.find((x) => x.nombre === nombre)
  return e ? new TextDecoder().decode(await descomprimir(e)) : null
}

async function entradasMinimas(): Promise<EntradaZip[]> {
  return [
    await entrada('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    await entrada('xl/workbook.xml', '<workbook><sheets><sheet name="Estado" sheetId="1" r:id="rId1"/><sheet name="Revisiones" sheetId="2" r:id="rId2"/></sheets></workbook>'),
    await entrada('xl/worksheets/sheet1.xml', '<worksheet><sheetData/></worksheet>'),
    await entrada('xl/worksheets/sheet2.xml', '<worksheet><sheetData/></worksheet>'),
  ]
}

describe('el nombre de una tabla', () => {
  it('sale del nombre de la hoja, sin espacios ni tildes', () => {
    expect(nombreDeTabla('Revisiones')).toBe('Revisiones')
    expect(nombreDeTabla('Movimientos de Almacén')).toBe('MovimientosDeAlmacen')
    expect(nombreDeTabla('Inventario por Sala')).toBe('InventarioPorSala')
    expect(nombreDeTabla('Cambios 2026-09-21')).toBe('Cambios20260921')
  })

  it('no puede empezar por número ni parecer una celda', () => {
    expect(nombreDeTabla('2026 Bolsa')).toBe('Tabla2026Bolsa')
    expect(nombreDeTabla('AB12')).toBe('TablaAB12')
  })
})

describe('las columnas de una tabla', () => {
  it('son texto, no vacías y únicas', () => {
    expect(columnasDeTabla(['Ref', null, 'Aula', 'Aula', 3, ''])).toEqual([
      'Ref', 'Columna 2', 'Aula', 'Aula (2)', '3', 'Columna 6',
    ])
  })

  it('el rango llega al menos a la fila 2: una tabla sin datos no existe', () => {
    expect(refDeTabla(3, 1)).toBe('A1:C2')
    expect(refDeTabla(3, 0)).toBe('A1:C2')
    expect(refDeTabla(14, 430)).toBe('A1:N430')
  })
})

describe('la parte de la tabla', () => {
  it('tiene la forma estándar: id, nombre, rango, filtro, columnas y estilo', () => {
    const xml = xmlDeTabla(3, { nombre: 'Revisiones', ref: 'A1:C4', columnas: ['Ref', 'Fecha', 'Quién'] })
    expect(xml).toContain('<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="3" name="Revisiones" displayName="Revisiones" ref="A1:C4"')
    expect(xml).toContain('<autoFilter ref="A1:C4"/>')
    expect(xml).toContain('<tableColumns count="3"><tableColumn id="1" name="Ref"/><tableColumn id="2" name="Fecha"/><tableColumn id="3" name="Quién"/></tableColumns>')
    expect(xml).toContain('<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>')
  })

  it('lo que hay que escapar en un nombre de columna se escapa', () => {
    expect(xmlDeTabla(1, { nombre: 'X', ref: 'A1:A2', columnas: ['Entrada & Salida'] })).toContain('name="Entrada &amp; Salida"')
  })

  it('la ruta de las relaciones de una hoja va al lado de la hoja', () => {
    expect(rutaDeRels('xl/worksheets/sheet7.xml')).toBe('xl/worksheets/_rels/sheet7.xml.rels')
  })
})

describe('asegurar la tabla de una hoja', () => {
  const datos = { nombre: 'Revisiones', ref: 'A1:C4', columnas: ['Ref', 'Fecha', 'Quién'] }

  it('crea la parte, la relación y el tipo de contenido', async () => {
    const r = await asegurarTabla(await entradasMinimas(), 'xl/worksheets/sheet2.xml', datos)
    expect(r.rid).toBe('rId1')
    expect(await texto(r.entradas, 'xl/tables/table1.xml')).toContain('id="1" name="Revisiones"')
    expect(await texto(r.entradas, 'xl/worksheets/_rels/sheet2.xml.rels')).toContain(
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>',
    )
    expect(await texto(r.entradas, '[Content_Types].xml')).toContain(
      '<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>',
    )
  })

  it('si la hoja ya tiene tabla, actualiza la suya y no añade otra', async () => {
    const uno = await asegurarTabla(await entradasMinimas(), 'xl/worksheets/sheet2.xml', datos)
    const dos = await asegurarTabla(uno.entradas, 'xl/worksheets/sheet2.xml', { ...datos, ref: 'A1:C40' })
    expect(dos.rid).toBe(uno.rid)
    expect(dos.entradas.filter((e) => e.nombre.startsWith('xl/tables/'))).toHaveLength(1)
    expect(await texto(dos.entradas, 'xl/tables/table1.xml')).toContain('ref="A1:C40"')
    // Y con los mismos datos, el mismo fichero: nada que reescribir.
    const tres = await asegurarTabla(dos.entradas, 'xl/worksheets/sheet2.xml', { ...datos, ref: 'A1:C40' })
    expect(tres.entradas).toEqual(dos.entradas)
  })

  it('las relaciones que la hoja ya tenía (comentarios, dibujo) se conservan', async () => {
    const entradas = [
      ...(await entradasMinimas()),
      await entrada(
        'xl/worksheets/_rels/sheet2.xml.rels',
        '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="/xl/comments/comment2.xml" Id="comments"/></Relationships>',
      ),
    ]
    const r = await asegurarTabla(entradas, 'xl/worksheets/sheet2.xml', datos)
    const rels = await texto(r.entradas, 'xl/worksheets/_rels/sheet2.xml.rels')
    expect(rels).toContain('Id="comments"')
    expect(rels).toContain('relationships/table')
    expect(r.rid).toBe('rId1')
  })

  it('el id y el número de fichero no chocan con las tablas que ya hay', async () => {
    const entradas = [
      ...(await entradasMinimas()),
      await entrada('xl/tables/table1.xml', xmlDeTabla(7, { nombre: 'Otra', ref: 'A1:A2', columnas: ['x'] })),
    ]
    const r = await asegurarTabla(entradas, 'xl/worksheets/sheet2.xml', datos)
    const nueva = await texto(r.entradas, 'xl/tables/table2.xml')
    expect(nueva).toContain('id="8"')
  })

  it('un nombre que ya usa otra tabla se sufija', async () => {
    const entradas = [
      ...(await entradasMinimas()),
      await entrada('xl/tables/table1.xml', xmlDeTabla(1, { nombre: 'Revisiones', ref: 'A1:A2', columnas: ['x'] })),
    ]
    const r = await asegurarTabla(entradas, 'xl/worksheets/sheet2.xml', datos)
    expect(await texto(r.entradas, 'xl/tables/table2.xml')).toContain('displayName="Revisiones_2"')
  })

  it('se encuentra la tabla de una hoja por su relación', async () => {
    const r = await asegurarTabla(await entradasMinimas(), 'xl/worksheets/sheet2.xml', datos)
    const t = await tablaDeHoja(r.entradas, 'xl/worksheets/sheet2.xml')
    expect(t?.ruta).toBe('xl/tables/table1.xml')
    expect(await tablaDeHoja(r.entradas, 'xl/worksheets/sheet1.xml')).toBeNull()
  })
})

describe('el nombre definido del autofiltro', () => {
  const wb =
    '<workbook><definedNames>' +
    `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Estado!$A$1:$C$3</definedName>` +
    `<definedName name="_xlnm._FilterDatabase" localSheetId="1" hidden="1">Revisiones!$A$1:$C$3</definedName>` +
    '</definedNames></workbook>'

  it('se quita el de esa hoja y solo ese', () => {
    const out = quitarFiltroDeHoja(wb, 1)
    expect(out).toContain('localSheetId="0"')
    expect(out).not.toContain('localSheetId="1"')
  })

  it('si no queda ninguno, se quita la lista entera', () => {
    expect(quitarFiltroDeHoja(quitarFiltroDeHoja(wb, 1), 0)).toBe('<workbook></workbook>')
  })
})
