import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  abrirLibro,
  columnaANumero,
  leerHoja,
  marcarRecalculo,
  numeroAColumna,
  parchear,
  parchearHojaXml,
  partirCelda,
} from './xlsx'
import { descomprimir, leerZip } from '../lib/zip'

const LIBRO = process.env.LIBRO_XLSX
const libro = LIBRO ? readFileSync(LIBRO) : null

describe('las direcciones de celda', () => {
  it('van y vuelven, también pasada la Z', () => {
    for (const n of [1, 26, 27, 52, 53, 702, 703]) {
      expect(columnaANumero(numeroAColumna(n))).toBe(n)
    }
    expect(numeroAColumna(1)).toBe('A')
    expect(numeroAColumna(27)).toBe('AA')
  })

  it('se parten en columna y fila', () => {
    expect(partirCelda('B87')).toEqual({ columna: 'B', fila: 87 })
    expect(partirCelda('AA1048576')).toEqual({ columna: 'AA', fila: 1048576 })
  })

  it('lo que no es una referencia se dice', () => {
    expect(() => partirCelda('87B')).toThrow(/no es una referencia/)
  })
})

// Una hoja mínima con las formas que trae Excel: cadena compartida, número,
// celda con fórmula y su valor cacheado, y una fila con huecos.
const HOJA = `<?xml version="1.0"?><worksheet><sheetData>` +
  `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>` +
  `<row r="2" ht="30"><c r="A2" s="5"><v>42</v></c><c r="B2"><f>A2*2</f><v>84</v></c></row>` +
  `<row r="7"><c r="A7" t="inlineStr"><is><t>ya estaba</t></is></c></row>` +
  `</sheetData></worksheet>`

describe('parchear una celda toca esa celda y nada más', () => {
  it('sustituye el valor y conserva el estilo', () => {
    const out = parchearHojaXml(HOJA, [{ celda: 'A2', valor: 99 }])
    expect(out).toContain('<c r="A2" s="5"><v>99</v></c>')
  })

  it('el resto de la hoja queda igual, carácter a carácter', () => {
    const out = parchearHojaXml(HOJA, [{ celda: 'A2', valor: 99 }])
    // La fórmula de B2 y su alto de fila siguen ahí sin tocar.
    expect(out).toContain('<c r="B2"><f>A2*2</f><v>84</v></c>')
    expect(out).toContain('<row r="2" ht="30">')
    expect(out).toContain('<c r="A7" t="inlineStr"><is><t>ya estaba</t></is></c>')
  })

  it('`null` no toca la celda: es lo que impide escribir un hueco encima de un dato', () => {
    expect(parchearHojaXml(HOJA, [{ celda: 'A2', valor: null }])).toBe(HOJA)
  })

  it('la cadena vacía sí la vacía, que es otra cosa y se pide a propósito', () => {
    const out = parchearHojaXml(HOJA, [{ celda: 'A2', valor: '' }])
    expect(out).toContain('<c r="A2" s="5"/>')
  })

  it('el texto se escribe en la propia celda, sin tocar las cadenas compartidas', () => {
    const out = parchearHojaXml(HOJA, [{ celda: 'A2', valor: 'SALA-000087' }])
    expect(out).toContain('t="inlineStr"')
    expect(out).toContain('SALA-000087')
  })

  it('lo que hay que escapar se escapa', () => {
    const out = parchearHojaXml(HOJA, [{ celda: 'A2', valor: 'Aula <5> & "seis"' }])
    expect(out).toContain('Aula &lt;5&gt; &amp; &quot;seis&quot;')
    expect(out).not.toContain('<5>')
  })

  it('los espacios de los extremos sobreviven', () => {
    const out = parchearHojaXml(HOJA, [{ celda: 'A2', valor: ' con espacios ' }])
    expect(out).toContain('xml:space="preserve"')
  })
})

describe('las celdas y filas autocerradas no se comen a las de al lado', () => {
  // `<c r="A1"/>` y `<row r="9"/>` son legales y Excel las escribe. Con la
  // alternancia al revés, `[^>]*` se tragaba la barra y el analizador cerraba
  // en el `</c>` de la celda siguiente, devorando todo lo de en medio.
  const CONVACIAS = `<worksheet><sheetData>` +
    `<row r="1"><c r="A1"/><c r="B1" t="inlineStr"><is><t>visible</t></is></c></row>` +
    `<row r="2"/>` +
    `<row r="3"><c r="A3"><v>7</v></c></row>` +
    `</sheetData></worksheet>`

  it('la celda de después de una vacía se sigue leyendo', async () => {
    const filas = await leerFilasDe(CONVACIAS)
    expect(filas.find((f) => f.fila === 1)!.celdas.B).toBe('visible')
  })

  it('y la fila de después de una vacía también', async () => {
    const filas = await leerFilasDe(CONVACIAS)
    expect(filas.map((f) => f.fila)).toEqual([1, 2, 3])
    expect(filas.find((f) => f.fila === 3)!.celdas.A).toBe(7)
  })

  it('escribir en una fila vacía la abre sin romper el XML', () => {
    const out = parchearHojaXml(CONVACIAS, [{ celda: 'A2', valor: 'entra' }])
    expect(out).toContain('<row r="2">')
    expect(out).not.toContain('<row r="2"/>')
    expect(out).toContain('</row>')
    expect(out).toContain('visible')
  })
})

describe('las celdas y filas que no existían se crean en su sitio', () => {
  it('una celda nueva va en orden de columna dentro de su fila', () => {
    const out = parchearHojaXml(HOJA, [{ celda: 'B1', valor: 'medio' }])
    const fila = /<row r="1">([\s\S]*?)<\/row>/.exec(out)![1]!
    expect(fila.indexOf('r="A1"')).toBeLessThan(fila.indexOf('r="B1"'))
    expect(fila.indexOf('r="B1"')).toBeLessThan(fila.indexOf('r="C1"'))
  })

  it('una fila nueva va entre las que la rodean, no al final', () => {
    const out = parchearHojaXml(HOJA, [{ celda: 'A5', valor: 'nueva' }])
    expect(out.indexOf('r="2"')).toBeLessThan(out.indexOf('r="5"'))
    expect(out.indexOf('r="5"')).toBeLessThan(out.indexOf('r="7"'))
  })

  it('una fila más allá del final también entra, dentro de sheetData', () => {
    const out = parchearHojaXml(HOJA, [{ celda: 'A99', valor: 'al final' }])
    expect(out).toContain('<row r="99">')
    expect(out.indexOf('r="99"')).toBeLessThan(out.indexOf('</sheetData>'))
  })

  it('varios cambios de golpe se aplican todos', () => {
    const out = parchearHojaXml(HOJA, [
      { celda: 'A2', valor: 1 },
      { celda: 'D2', valor: 'nueva' },
      { celda: 'A9', valor: 'otra fila' },
    ])
    expect(out).toContain('<c r="A2" s="5"><v>1</v></c>')
    expect(out).toContain('r="D2"')
    expect(out).toContain('<row r="9">')
  })
})

describe('el recálculo al abrir', () => {
  it('se añade si no estaba', () => {
    expect(marcarRecalculo('<workbook><sheets/></workbook>')).toContain('fullCalcOnLoad="1"')
  })

  it('se añade al calcPr que ya existía, sin duplicarlo', () => {
    const out = marcarRecalculo('<workbook><calcPr calcId="191029"/></workbook>')
    expect(out).toContain('calcId="191029"')
    expect(out.match(/fullCalcOnLoad/g)).toHaveLength(1)
  })

  it('si ya estaba puesto, no se toca nada', () => {
    const x = '<workbook><calcPr calcId="1" fullCalcOnLoad="1"/></workbook>'
    expect(marcarRecalculo(x)).toBe(x)
  })
})

describe.skipIf(!libro)('sobre el libro real', () => {
  it('resuelve las hojas por su nombre, no por el número del fichero', async () => {
    const l = await abrirLibro(new Uint8Array(libro!))
    expect(l.hojas.map((h) => h.nombre)).toContain('Estado Aulas y Salas de reunion')
    for (const h of l.hojas) expect(h.ruta).toMatch(/^xl\/worksheets\//)
  })

  it('lee la hoja de estado con sus 276 salas y sus direcciones reales', async () => {
    const l = await abrirLibro(new Uint8Array(libro!))
    const filas = await leerHoja(l, 'Estado Aulas y Salas de reunion')
    expect(filas.length).toBeGreaterThan(270)
    // La fila 1 es la cabecera y las direcciones son las de la hoja.
    expect(filas[0]!.fila).toBe(1)
    expect(Object.keys(filas[1]!.celdas).length).toBeGreaterThan(3)
  })

  it('cambiar una celda modifica UNA entrada del zip y no pierde ninguna', async () => {
    const original = new Uint8Array(libro!)
    const l = await abrirLibro(original)
    const parcheado = await parchear(l, [
      { hoja: 'Estado Aulas y Salas de reunion', celdas: [{ celda: 'Z2', valor: 'SALA-000001' }] },
    ])

    const antes = leerZip(original)
    const despues = leerZip(parcheado)

    expect(despues.map((e) => e.nombre)).toEqual(antes.map((e) => e.nombre))

    const cambiadas = antes
      .filter((e, i) => !bytesIguales(e.comprimido, despues[i]!.comprimido))
      .map((e) => e.nombre)
    // La hoja tocada y `workbook.xml`, que lleva la marca de recalcular.
    expect(cambiadas).toHaveLength(2)
    expect(cambiadas).toContain('xl/workbook.xml')
  })

  it('y lo escrito se vuelve a leer donde se puso', async () => {
    const l = await abrirLibro(new Uint8Array(libro!))
    const parcheado = await parchear(l, [
      { hoja: 'Estado Aulas y Salas de reunion', celdas: [{ celda: 'Z2', valor: 'SALA-000001' }] },
    ])
    const filas = await leerHoja(await abrirLibro(parcheado), 'Estado Aulas y Salas de reunion')
    expect(filas.find((f) => f.fila === 2)!.celdas.Z).toBe('SALA-000001')
  })

  it('sobreviven la etiqueta de confidencialidad y los metadatos de SharePoint', async () => {
    const l = await abrirLibro(new Uint8Array(libro!))
    const parcheado = await parchear(l, [
      { hoja: 'Estado Aulas y Salas de reunion', celdas: [{ celda: 'Z2', valor: 'x' }] },
    ])
    const nombres = leerZip(parcheado).map((e) => e.nombre)
    expect(nombres.some((n) => /customXml/i.test(n))).toBe(true)
    expect(nombres).toContain('[Content_Types].xml')
  })

  it('las fórmulas de las otras hojas siguen siendo fórmulas', async () => {
    const original = new Uint8Array(libro!)
    const l = await abrirLibro(original)
    const conFormulas = (await Promise.all(
      leerZip(original)
        .filter((e) => /^xl\/worksheets\//.test(e.nombre))
        .map(async (e) => [e.nombre, (new TextDecoder().decode(await descomprimir(e)).match(/<f>/g) ?? []).length] as const),
    )).filter(([, n]) => n > 0)
    expect(conFormulas.length).toBeGreaterThan(0)

    const parcheado = await parchear(l, [
      { hoja: 'Estado Aulas y Salas de reunion', celdas: [{ celda: 'Z2', valor: 'x' }] },
    ])
    for (const [nombre, n] of conFormulas) {
      const e = leerZip(parcheado).find((x) => x.nombre === nombre)!
      const ahora = (new TextDecoder().decode(await descomprimir(e)).match(/<f>/g) ?? []).length
      expect(ahora).toBe(n)
    }
  })
})

function bytesIguales(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}


/** Envuelve un XML de hoja suelto en un libro mínimo para poder leerlo. */
async function leerFilasDe(hojaXml: string) {
  const { escribirZip, reemplazar } = await import('../lib/zip')
  const base = {
    metodo: 8, banderas: 0, fecha: 0, hora: 0, versionCreacion: 20, versionNecesaria: 20,
    atributosInternos: 0, atributosExternos: 0, extraLocal: new Uint8Array(0),
    extraCentral: new Uint8Array(0), comentario: new Uint8Array(0), crc32: 0,
    comprimido: new Uint8Array(0), tamanoOriginal: 0,
  }
  const t = (x: string) => new TextEncoder().encode(x)
  const zip = escribirZip([
    await reemplazar({ ...base, nombre: 'xl/workbook.xml' },
      t('<workbook><sheets><sheet name="Hoja" r:id="rId1"/></sheets></workbook>')),
    await reemplazar({ ...base, nombre: 'xl/_rels/workbook.xml.rels' },
      t('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')),
    await reemplazar({ ...base, nombre: 'xl/worksheets/sheet1.xml' }, t(hojaXml)),
  ])
  return leerHoja(await abrirLibro(zip), 'Hoja')
}
