import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  columnasEscritas,
  mostrarColumnas,
  corregirComentarios,
  corregirReferenciasExternas,
  corregirVml,
  editarHojaXml,
  planificar,
  remapearFormula,
  remapearRango,
  remapearSqref,
} from './estructura'
import { abrirLibro, leerHoja } from './xlsx'
import { descomprimir } from '../lib/zip'

const LIBRO = process.env.LIBRO_XLSX
const libro = LIBRO ? readFileSync(LIBRO) : null

describe('el plan de filas', () => {
  it('sin nada que hacer no mueve nada', () => {
    const m = planificar({})
    expect(m.vacio).toBe(true)
    expect(m.nuevo(87)).toBe(87)
  })

  it('insertar empuja hacia abajo lo que viene después', () => {
    const m = planificar({ insertar: [{ tras: 10, celdas: [] }] })
    expect(m.nuevo(10)).toBe(10)
    expect(m.nuevo(11)).toBe(12)
    expect(m.insertadas).toEqual([11])
  })

  it('borrar sube lo que venía después', () => {
    const m = planificar({ borrar: [10] })
    expect(m.nuevo(9)).toBe(9)
    expect(m.nuevo(10)).toBeNull()
    expect(m.nuevo(11)).toBe(10)
  })

  it('varias filas detrás de la misma quedan seguidas y en orden', () => {
    const m = planificar({
      insertar: [
        { tras: 5, celdas: [] },
        { tras: 5, celdas: [] },
        { tras: 5, celdas: [] },
      ],
    })
    expect(m.insertadas).toEqual([6, 7, 8])
    expect(m.nuevo(6)).toBe(9)
  })

  it('insertar y borrar a la vez se compensan', () => {
    const m = planificar({ borrar: [3], insertar: [{ tras: 10, celdas: [] }] })
    expect(m.nuevo(2)).toBe(2)
    expect(m.nuevo(4)).toBe(3)
    expect(m.nuevo(10)).toBe(9)
    expect(m.nuevo(11)).toBe(11)
    expect(m.insertadas).toEqual([10])
  })

  it('las filas que no están en el fichero también se mueven', () => {
    // Una hoja llega hasta la 1.048.576 aunque el XML solo traiga 400 filas.
    const m = planificar({ insertar: [{ tras: 1, celdas: [] }] })
    expect(m.nuevo(1_000_000)).toBe(1_000_001)
  })

  it('insertar detrás de una fila que se borra no significa nada', () => {
    expect(() => planificar({ borrar: [7], insertar: [{ tras: 7, celdas: [] }] })).toThrow(
      /no se puede saber dónde va/,
    )
  })

  it('hacia abajo y hacia arriba saltan los huecos', () => {
    const m = planificar({ borrar: [5, 6, 7] })
    expect(m.haciaAbajo(5)).toBe(5) // la 8, que ahora es la 5
    expect(m.haciaArriba(7)).toBe(4)
  })
})

describe('los rangos', () => {
  it('mueven los dos extremos', () => {
    const m = planificar({ insertar: [{ tras: 1, celdas: [] }] })
    expect(remapearRango('A1:X416', m)).toBe('A1:X417')
  })

  it('el principio busca hacia abajo y el final hacia arriba', () => {
    const m = planificar({ borrar: [10, 20] })
    expect(remapearRango('A10:X20', m)).toBe('A10:X18')
  })

  it('un rango que se queda sin filas desaparece', () => {
    const m = planificar({ borrar: [5] })
    expect(remapearRango('G5:G5', m)).toBeNull()
    expect(remapearRango('G5', m)).toBeNull()
  })

  it('las columnas enteras no tienen filas que mover', () => {
    const m = planificar({ insertar: [{ tras: 1, celdas: [] }] })
    expect(remapearRango('G:G', m)).toBe('G:G')
  })

  it('respeta el dólar al escribirlo de vuelta', () => {
    const m = planificar({ insertar: [{ tras: 1, celdas: [] }] })
    expect(remapearRango('$A$5:$A$9', m)).toBe('$A$5:$A$9'.replace(/5/, '6').replace(/9/, '10'))
  })

  it('un sqref con huecos mantiene los huecos', () => {
    const m = planificar({ insertar: [{ tras: 1, celdas: [] }] })
    expect(remapearSqref('G1:G106 G111:G114 G310:G1048576', m)).toBe(
      'G1:G107 G112:G115 G311:G1048576',
    )
  })

  it('no se pasa del final de la hoja', () => {
    const m = planificar({ insertar: [{ tras: 1, celdas: [] }] })
    expect(remapearSqref('G310:G1048576', m)).toBe('G311:G1048576')
  })
})

describe('las fórmulas', () => {
  it('mueven las referencias', () => {
    const m = planificar({ insertar: [{ tras: 1, celdas: [] }] })
    expect(remapearFormula('P5-N5', m)).toBe('P6-N6')
    expect(remapearFormula('SUM(B2:M2)', m)).toBe('SUM(B3:M3)')
  })

  it('el dólar no protege de una inserción, igual que en Excel', () => {
    const m = planificar({ insertar: [{ tras: 1, celdas: [] }] })
    expect(remapearFormula('$P$5-$N$5', m)).toBe('$P$6-$N$6')
  })

  it('una referencia a una fila borrada se convierte en #REF!', () => {
    const m = planificar({ borrar: [5] })
    expect(remapearFormula('P5-N4', m)).toBe('#REF!-N4')
  })

  it('no toca lo que va entre comillas', () => {
    const m = planificar({ insertar: [{ tras: 1, celdas: [] }] })
    expect(remapearFormula('IF(A2="B2",A2,"")', m)).toBe('IF(A3="B2",A3,"")')
  })

  it('no confunde un nombre de función con una referencia', () => {
    const m = planificar({ insertar: [{ tras: 1, celdas: [] }] })
    expect(remapearFormula('LOG10(A2)', m)).toBe('LOG10(A3)')
    expect(remapearFormula('SUM(A2)', m)).toBe('SUM(A3)')
  })

  it('deja en paz el nombre de otra hoja entre apóstrofos', () => {
    const m = planificar({ insertar: [{ tras: 1, celdas: [] }] })
    expect(remapearFormula("'Bolsa 2026'!N5", m)).toBe("'Bolsa 2026'!N6")
  })
})

// Una hoja con las formas que de verdad trae este libro: fusiones, autofiltro,
// formato condicional con huecos, panel inmovilizado y una fórmula.
const HOJA =
  `<?xml version="1.0"?><worksheet><dimension ref="A1:Q10"/>` +
  `<sheetViews><sheetView><pane ySplit="1" topLeftCell="A2" state="frozen"/>` +
  `<selection pane="bottomLeft" activeCell="A5" sqref="A5"/></sheetView></sheetViews>` +
  `<sheetData>` +
  `<row r="1"><c r="A1" s="3" t="inlineStr"><is><t>Cabecera</t></is></c></row>` +
  `<row r="2" ht="15"><c r="A2" s="7" t="inlineStr"><is><t>uno</t></is></c><c r="N2" s="9"><f>SUM(B2:M2)</f><v>0</v></c></row>` +
  `<row r="3"><c r="A3" s="7" t="inlineStr"><is><t>dos</t></is></c><c r="N3" s="9"><f>SUM(B3:M3)</f><v>0</v></c></row>` +
  `<row r="4"/>` +
  `</sheetData>` +
  `<autoFilter ref="A1:Q10"/>` +
  `<mergeCells count="2"><mergeCell ref="A2:A3"/><mergeCell ref="B2:B3"/></mergeCells>` +
  `<conditionalFormatting sqref="G1:G2 G4:G10"><cfRule type="colorScale" priority="1"/></conditionalFormatting>` +
  `</worksheet>`

describe('editar una hoja', () => {
  it('inserta una fila con el estilo de su vecina y empuja el resto', () => {
    const edicion = {
      insertar: [{ tras: 2, celdas: [{ celda: 'A3', valor: 'nueva' }] }],
    }
    const mapa = planificar(edicion)
    const out = editarHojaXml(HOJA, edicion, mapa)

    expect(out).toContain('<row r="3" ht="15">')
    expect(out).toContain('<c r="A3" s="7" t="inlineStr"><is><t xml:space="preserve">nueva</t></is></c>')
    // La que era la 3 ahora es la 4, y su fórmula la sigue.
    expect(out).toContain('<c r="N4" s="9"><f>SUM(B4:M4)</f>')
    expect(out).toContain('<autoFilter ref="A1:Q11"/>')
    expect(out).toContain('<mergeCell ref="A2:A4"/>')
    expect(out).toContain('sqref="G1:G2 G5:G11"')
  })

  it('borrar una fila se lleva su fusión y sube lo de debajo', () => {
    const edicion = { borrar: [2, 3] }
    const mapa = planificar(edicion)
    const out = editarHojaXml(HOJA, edicion, mapa)

    expect(out).not.toContain('<row r="2" ht="15">')
    expect(out).not.toContain('mergeCell')
    expect(out).toContain('<row r="2"/>') // la que era la 4
    expect(out).toContain('<autoFilter ref="A1:Q8"/>')
  })

  it('la cuenta de fusiones se rehace', () => {
    const edicion = { borrar: [3] }
    const mapa = planificar(edicion)
    const out = editarHojaXml(HOJA, edicion, mapa)
    // A2:A3 y B2:B3 pierden su segunda fila: dejan de ser fusiones.
    expect(out).not.toContain('mergeCell')
  })

  it('el panel inmovilizado y la celda activa se mueven', () => {
    const edicion = { insertar: [{ tras: 2, celdas: [{ celda: 'A3', valor: 'x' }] }] }
    const mapa = planificar(edicion)
    const out = editarHojaXml(HOJA, edicion, mapa)
    expect(out).toContain('activeCell="A6"')
    expect(out).toContain('sqref="A6"')
  })

  it('una fila nueva puede llevar una fórmula', () => {
    const edicion = { insertar: [{ tras: 3, celdas: [{ celda: 'N4', valor: '=SUM(B4:M4)' }] }] }
    const mapa = planificar(edicion)
    const out = editarHojaXml(HOJA, edicion, mapa)
    expect(out).toContain('<c r="N4" s="9"><f>SUM(B4:M4)</f></c>')
  })

  it('sin plan devuelve exactamente el mismo XML', () => {
    expect(editarHojaXml(HOJA, {}, planificar({}))).toBe(HOJA)
  })
})

describe('el formato de una fila insertada', () => {
  // Una fila nueva hereda el estilo de la fila detrás de la que cae. En la
  // columna «Fecha Revisión» eso es una lotería: media columna del libro se
  // quedó en «General» porque nunca tuvo fecha, así que un aula nueva podía
  // estrenar su revisión enseñando 46218.
  const HOJA_MIXTA = [
    '<worksheet><sheetData>',
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Aula</t></is></c></row>',
    '<row r="2"><c r="A2" s="9"/></row>',   // la vecina: sin formato de fecha
    '</sheetData></worksheet>',
  ].join('')

  it('si la celda dice que es una fecha, se le pide un estilo que la pinte', () => {
    const edicion = {
      insertar: [{ tras: 2, celdas: [{ celda: 'A3', valor: 46218, formato: 'fecha' as const }] }],
    }
    const resolver = (col: string, formato: string) => (col === 'A' && formato === 'fecha' ? '77' : null)
    const out = editarHojaXml(HOJA_MIXTA, edicion, planificar(edicion), resolver)
    expect(out).toContain('<c r="A3" s="77"><v>46218</v></c>')
  })

  it('y si el resolvedor no encuentra ninguno, se queda con el de su vecina', () => {
    const edicion = {
      insertar: [{ tras: 2, celdas: [{ celda: 'A3', valor: 46218, formato: 'fecha' as const }] }],
    }
    const out = editarHojaXml(HOJA_MIXTA, edicion, planificar(edicion), () => null)
    expect(out).toContain('<c r="A3" s="9"><v>46218</v></c>')
  })

  it('una celda sin formato declarado no molesta al resolvedor', () => {
    const edicion = { insertar: [{ tras: 2, celdas: [{ celda: 'A3', valor: 'texto' }] }] }
    const out = editarHojaXml(HOJA_MIXTA, edicion, planificar(edicion), () => '77')
    expect(out).toContain('<c r="A3" s="9"')
  })
})

describe('el final de la hoja', () => {
  // Las dos hojas de partes del libro real traen 1.960 filas con estilo que
  // llegan hasta la 1048559: alguien pintó la hoja entera hace años y Excel
  // guardó un `<row>` por cada una. Con la última de Excel en la 1048576, hacen
  // falta dieciocho partes nuevos para pasarse — y pasarse en silencio dejaba un
  // libro que no abre.
  const CASI = [
    '<worksheet><sheetData>',
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Aula</t></is></c></row>',
    '<row r="2"><c r="A2" t="inlineStr"><is><t>1.7</t></is></c></row>',
    '<row r="1048574" s="7" customFormat="1"/>',
    '<row r="1048575" s="7" customFormat="1"/>',
    '<row r="1048576" s="7" customFormat="1"/>',
    '</sheetData></worksheet>',
  ].join('')

  it('las filas vacías del final se caen para hacer sitio, como en Excel', () => {
    const edicion = { insertar: [{ tras: 2, celdas: [{ celda: 'A3', valor: 'parte nuevo' }] }] }
    const out = editarHojaXml(CASI, edicion, planificar(edicion))

    expect(out).toContain('<t xml:space="preserve">parte nuevo</t>')
    // La 1048575 pasa a la 1048576 y la que estaba ahí se cae: no hay sitio.
    expect(out).toContain('<row r="1048576"')
    expect(out).not.toMatch(/r="10485(7[7-9]|8\d)"/)
    // Y no quedan dos filas con el mismo número, que tampoco sería un libro.
    const numeros = [...out.matchAll(/<row[^>]*\br="(\d+)"/g)].map((m) => m[1])
    expect(new Set(numeros).size).toBe(numeros.length)
  })

  it('pero si lo que se cae lleva datos, no se inserta y se dice por qué', () => {
    const conDatos = CASI.replace(
      '<row r="1048576" s="7" customFormat="1"/>',
      '<row r="1048576" s="7"><c r="A1048576" t="inlineStr"><is><t>algo</t></is></c></row>',
    )
    const edicion = { insertar: [{ tras: 2, celdas: [{ celda: 'A3', valor: 'parte nuevo' }] }] }
    expect(() => editarHojaXml(conDatos, edicion, planificar(edicion))).toThrow(/No caben más filas/)
  })
})

describe('lo que vive fuera de la hoja', () => {
  it('los comentarios siguen a su celda', () => {
    const m = planificar({ insertar: [{ tras: 1, celdas: [] }] })
    const xml = '<comments><commentList><comment ref="Q205" authorId="0"><text>x</text></comment></commentList></comments>'
    expect(corregirComentarios(xml, m)).toContain('ref="Q206"')
  })

  it('un comentario cuya celda se borra se va con ella', () => {
    const m = planificar({ borrar: [205] })
    const xml = '<comments><commentList><comment ref="Q205" authorId="0"><text>x</text></comment></commentList></comments>'
    expect(corregirComentarios(xml, m)).not.toContain('comment ref')
  })

  // El `.vml` del libro real: cinco `<v:shape>`, cuatro con comentario, y cada
  // uno con su `<x:Row>` en base 0 y un `<x:Anchor>` de ocho números donde el
  // 3.º y el 7.º son también filas, también en base 0.
  const forma = (fila: number, arriba: number, abajo: number, id: string): string =>
    `<v:shape id="${id}" type="#_x0000_t202"><x:ClientData ObjectType="Note">` +
    `<x:Anchor>17,15,${arriba},17,18,35,${abajo},15</x:Anchor>` +
    `<x:Row>${fila}</x:Row><x:Column>16</x:Column>` +
    `</x:ClientData></v:shape>`

  it('el ancla del vml va en base 0', () => {
    const m = planificar({ insertar: [{ tras: 1, celdas: [] }] })
    // La fila 205 de la hoja se escribe 204 en el vml.
    expect(corregirVml(forma(204, 203, 206, 'a'), m)).toContain('<x:Row>205</x:Row>')
  })

  it('el <x:Anchor> también lleva filas, y son las que dibujan el recuadro', () => {
    // Moviendo solo `<x:Row>`, el comentario apunta a la celda buena y se pinta
    // donde estaba: encima de otra fila.
    const m = planificar({ insertar: [{ tras: 1, celdas: [] }] })
    expect(corregirVml(forma(204, 203, 206, 'a'), m)).toContain('<x:Anchor>17,15,204,17,18,35,207,15</x:Anchor>')
  })

  it('la forma de un comentario borrado se va con él', () => {
    // `corregirComentarios` quita el `<comment>` de la fila borrada. Si la forma
    // se quedara, los dos ficheros dejarían de tener el mismo número de
    // elementos, y Excel los empareja **por orden**: a partir del que falta,
    // cada comentario cuelga del recuadro del siguiente.
    const m = planificar({ borrar: [205] })
    const vml = forma(204, 203, 206, 'a') + forma(300, 299, 302, 'b')
    const out = corregirVml(vml, m)
    expect(out).not.toContain('id="a"')
    expect(out).toContain('id="b"')
    expect((out.match(/<v:shape/g) ?? []).length).toBe(1)
  })

  it('una forma sin comentario no se toca', () => {
    const m = planificar({ insertar: [{ tras: 1, celdas: [] }] })
    const suelta = '<v:shape id="fondo" type="#_x0000_t202"><v:fill/></v:shape>'
    expect(corregirVml(suelta, m)).toBe(suelta)
  })

  it('solo se tocan las referencias que nombran la hoja', () => {
    const m = planificar({ insertar: [{ tras: 1, celdas: [] }] })
    const xml = `<f>'Bolsa 2026'!N5+N5</f>`
    expect(corregirReferenciasExternas(xml, 'Bolsa 2026', m)).toBe(`<f>'Bolsa 2026'!N6+N5</f>`)
  })
})

describe.skipIf(!libro)('sobre el libro real', () => {
  it('insertar un aula en su edificio no descoloca las de abajo', async () => {
    const l = await abrirLibro(new Uint8Array(libro!))
    const hoja = l.hojas.find((h) => h.nombre === 'Estado Aulas y Salas de reunion')!
    const xml = new TextDecoder().decode(
      await descomprimir(l.entradas.find((e) => e.nombre === hoja.ruta)!),
    )
    const antes = await leerHoja(l, 'Estado Aulas y Salas de reunion')

    // Detrás de la última fila del EDIFICIO P.
    const edicion = {
      insertar: [
        {
          tras: 30,
          celdas: [
            { celda: 'A31', valor: 'EDIFICIO P' },
            { celda: 'C31', valor: '0.99P' },
          ],
        },
      ],
    }
    const mapa = planificar(edicion)
    const out = editarHojaXml(xml, edicion, mapa)

    // Ni una sola fila se queda con su número viejo por debajo del corte.
    const numeros = [...out.matchAll(/<row\b[^>]*\br="(\d+)"/g)].map((m) => Number(m[1]))
    expect(new Set(numeros).size).toBe(numeros.length)
    expect(numeros).toEqual([...numeros].sort((a, b) => a - b))

    // La fila que era la 31 sigue diciendo lo mismo, una más abajo.
    const eran31 = antes.find((f) => f.fila === 31)!
    const filaNueva = /<row\b[^>]*\br="32"[^>]*>([\s\S]*?)<\/row>/.exec(out)
    expect(filaNueva).not.toBeNull()
    for (const [col, valor] of Object.entries(eran31.celdas)) {
      if (typeof valor !== 'string' || valor === '') continue
      expect(filaNueva![1]).toContain(`r="${col}32"`)
    }

    expect(out).toContain('<c r="A31"')
    // El autofiltro crece con la hoja.
    expect(out).toMatch(/<autoFilter ref="A1:X417"/)
  })

  it('las fusiones del libro real sobreviven al desplazamiento', async () => {
    const l = await abrirLibro(new Uint8Array(libro!))
    const hoja = l.hojas.find((h) => h.nombre === 'Estado Aulas y Salas de reunion')!
    const xml = new TextDecoder().decode(
      await descomprimir(l.entradas.find((e) => e.nombre === hoja.ruta)!),
    )
    const cuantas = [...xml.matchAll(/<mergeCell\b/g)].length
    expect(cuantas).toBeGreaterThan(0)

    const edicion = { insertar: [{ tras: 1, celdas: [{ celda: 'A2', valor: 'x' }] }] }
    const out = editarHojaXml(xml, edicion, planificar(edicion))

    // Todas siguen ahí, una fila más abajo, y la cuenta cuadra.
    expect([...out.matchAll(/<mergeCell\b/g)].length).toBe(cuantas)
    const declarada = Number(/<mergeCells\b[^>]*count="(\d+)"/.exec(out)![1])
    expect(declarada).toBe(cuantas)
    expect(out).toContain('<mergeCell ref="E68:E69"/>') // era E67:E68
  })
})

describe('las columnas escondidas', () => {
  const COLS =
    '<worksheet><cols>' +
    '<col min="1" max="1" width="60" customWidth="1"/>' +
    '<col min="2" max="3" width="15" hidden="1" customWidth="1"/>' +
    '<col min="8" max="8" width="15" hidden="1"/>' +
    '</cols><sheetData/></worksheet>'

  it('se enseñan las que reciben dato', () => {
    // En «Bolsa 2026» enero y febrero están ocultas, y «Total Instalado» las
    // suma: un dato ahí es un descuadre que no se ve.
    const out = mostrarColumnas(COLS, new Set(['B', 'C']))
    expect(out).toContain('<col min="2" max="3" width="15" customWidth="1"/>')
    expect(out).toContain('<col min="8" max="8" width="15" hidden="1"/>')
  })

  it('un rango a medias se parte y cada mitad conserva su ancho', () => {
    const out = mostrarColumnas(COLS, new Set(['B']))
    expect(out).toContain('<col min="2" max="2" width="15" customWidth="1"/>')
    expect(out).toContain('<col min="3" max="3" width="15" hidden="1" customWidth="1"/>')
  })

  it('las que nadie toca se quedan escondidas', () => {
    expect(mostrarColumnas(COLS, new Set(['A']))).toBe(COLS)
    expect(mostrarColumnas(COLS, new Set())).toBe(COLS)
  })

  it('una hoja sin bloque de columnas no cambia', () => {
    const sinCols = '<worksheet><sheetData/></worksheet>'
    expect(mostrarColumnas(sinCols, new Set(['B']))).toBe(sinCols)
  })

  it('solo cuentan las columnas donde se escribe de verdad', () => {
    // `null` no toca la celda, así que tampoco destapa su columna.
    expect(
      columnasEscritas([
        { celda: 'B2', valor: 3 },
        { celda: 'C2', valor: null },
        { celda: 'AA9', valor: 'x' },
      ]),
    ).toEqual(new Set(['B', 'AA']))
  })
})
