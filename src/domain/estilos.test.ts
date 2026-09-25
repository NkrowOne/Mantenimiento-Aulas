import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  asegurarDxfDeFondo,
  asegurarEstilos,
  asegurarRecetas,
  conTinte,
  estiloQuePinta,
  estilosDeLaColumna,
  leerEstilos,
  recetaDe,
} from './estilos'
import { escribirLibro } from './libro'
import { abrirLibro, leerHoja } from './xlsx'
import { descomprimir } from '../lib/zip'
import { fechaAExcel } from './valores'

const LIBRO = process.env.LIBRO_XLSX
const bytes = LIBRO ? readFileSync(LIBRO) : null

const ESTILOS = `<styleSheet>
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>
    <numFmt numFmtId="165" formatCode="&quot;mes de &quot;General"/>
  </numFmts>
  <cellXfs count="6">
    <xf numFmtId="0"/>
    <xf numFmtId="14"/>
    <xf numFmtId="9"/>
    <xf numFmtId="164"/>
    <xf numFmtId="165"/>
    <xf numFmtId="49"/>
  </cellXfs>
</styleSheet>`

describe('leer los formatos del libro', () => {
  const e = leerEstilos(ESTILOS)

  it('conoce los formatos que Excel da por sabidos', () => {
    // El 14 es `mm-dd-yy` y no aparece escrito en ningún sitio del fichero.
    expect(e.formatoDe(1)).toBe('fecha')
    expect(e.formatoDe(2)).toBe('porcentaje')
    expect(e.formatoDe(0)).toBe('otro')
  })

  it('lee los que el libro se ha inventado', () => {
    expect(e.formatoDe(3)).toBe('fecha')
  })

  it('un texto entre comillas no convierte un formato en fecha', () => {
    // «mes de » lleva una `m` y una `d`, y no es una fecha.
    expect(e.formatoDe(4)).toBe('otro')
  })

  it('el texto no es ninguna de las dos cosas', () => {
    expect(e.formatoDe(5)).toBe('otro')
  })

  it('sabe dar uno de cada clase', () => {
    expect(e.alguno('fecha')).toBe(1)
    expect(e.alguno('porcentaje')).toBe(2)
  })

  it('un libro sin formatos no inventa ninguno', () => {
    const vacio = leerEstilos('<styleSheet><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>')
    expect(vacio.alguno('fecha')).toBeNull()
  })
})

describe('elegir el estilo que pinta', () => {
  const e = leerEstilos(ESTILOS)

  it('si el que tiene ya pinta bien, no se toca', () => {
    expect(estiloQuePinta(e, 'fecha', 1, [1, 0])).toBeNull()
  })

  it('si no, se toma el de otra celda de su columna', () => {
    // La columna «Fecha Revisión» tiene celdas de fecha y celdas en General.
    expect(estiloQuePinta(e, 'fecha', 0, [0, 3])).toBe(3)
  })

  it('y si en la columna no hay ninguno, cualquiera del libro', () => {
    expect(estiloQuePinta(e, 'fecha', 0, [0, 5])).toBe(1)
  })

  it('si el libro no tiene ninguno, se deja como está', () => {
    const vacio = leerEstilos('<styleSheet><cellXfs><xf numFmtId="0"/></cellXfs></styleSheet>')
    expect(estiloQuePinta(vacio, 'fecha', 0, [0])).toBeNull()
  })

  it('los estilos de una columna salen en orden y sin repetir', () => {
    const xml =
      '<row r="1"><c r="D1" s="7"/></row><row r="2"><c r="D2" s="9"/><c r="E2" s="3"/></row>' +
      '<row r="3"><c r="D3" s="9"/></row>'
    expect(estilosDeLaColumna(xml, 'D')).toEqual([7, 9])
  })
})

describe.skipIf(!bytes)('sobre el libro real', () => {
  it('la columna de fecha de la hoja de estado está a medias, y por eso hace falta', async () => {
    const libro = await abrirLibro(new Uint8Array(bytes!))
    const estilos = leerEstilos(
      new TextDecoder().decode(
        await descomprimir(libro.entradas.find((e) => e.nombre === 'xl/styles.xml')!),
      ),
    )
    const xml = new TextDecoder().decode(
      await descomprimir(libro.entradas.find((e) => e.nombre === libro.hojas[0]!.ruta)!),
    )
    const enD = estilosDeLaColumna(xml, 'D')
    const clases = new Set(enD.map((s) => estilos.formatoDe(s)))
    // Hay celdas de fecha y celdas que no lo son en la misma columna: eso es lo
    // que hace que escribir en una vacía enseñe `46218`.
    expect(clases.has('fecha')).toBe(true)
    expect(clases.size).toBeGreaterThan(1)
  })

  it('una fecha escrita en una celda vacía sale con formato de fecha', async () => {
    const libro = await abrirLibro(new Uint8Array(bytes!))
    // `D2` está vacía y su estilo es «General»: es la celda del problema.
    const salida = await escribirLibro(libro, [
      {
        hoja: 'Estado Aulas y Salas de reunion',
        celdas: [{ celda: 'D2', valor: fechaAExcel('2026-07-15')!, formato: 'fecha' }],
      },
    ])

    const otra = await abrirLibro(salida)
    const xml = new TextDecoder().decode(
      await descomprimir(otra.entradas.find((e) => e.nombre === otra.hojas[0]!.ruta)!),
    )
    const estilos = leerEstilos(
      new TextDecoder().decode(
        await descomprimir(otra.entradas.find((e) => e.nombre === 'xl/styles.xml')!),
      ),
    )
    const s = /<c\b[^>]*\br="D2"[^>]*\bs="(\d+)"/.exec(xml)?.[1]
    expect(s).toBeTruthy()
    expect(estilos.formatoDe(Number(s))).toBe('fecha')

    // Y el valor sigue siendo el número de serie, que es lo que Excel guarda.
    const filas = await leerHoja(otra, 'Estado Aulas y Salas de reunion')
    expect(filas.find((f) => f.fila === 2)!.celdas.D).toBe(fechaAExcel('2026-07-15'))
  })

  it('no se añade ni un estilo al libro: se reutilizan los suyos', async () => {
    const libro = await abrirLibro(new Uint8Array(bytes!))
    const antes = new TextDecoder().decode(
      await descomprimir(libro.entradas.find((e) => e.nombre === 'xl/styles.xml')!),
    )
    const salida = await escribirLibro(libro, [
      {
        hoja: 'Estado Aulas y Salas de reunion',
        celdas: [
          { celda: 'D2', valor: 46218, formato: 'fecha' },
          { celda: 'G2', valor: 0.42, formato: 'porcentaje' },
        ],
      },
    ])
    const otra = await abrirLibro(salida)
    const despues = new TextDecoder().decode(
      await descomprimir(otra.entradas.find((e) => e.nombre === 'xl/styles.xml')!),
    )
    expect(despues).toBe(antes)
  })
})

// -----------------------------------------------------------------------------
// Los estilos con nombre de las hojas de la aplicación
// -----------------------------------------------------------------------------

/** Un `styles.xml` recién nacido: lo mínimo que Excel escribe en un libro vacío. */
const MINIMO =
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
  '</styleSheet>'

/**
 * Lo que trae el libro real, escrito por otra herramienta: colores con alfa
 * `00`, atributos de más (`pivotButton`, `quotePrefix`) y la fuente con sus
 * hijos en otro orden. Pinta exactamente lo mismo que `cabecera` y `texto`.
 */
const COMO_EL_LIBRO_REAL =
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd h:mm:ss" /><numFmt numFmtId="165" formatCode="dd/mm/yyyy" /></numFmts>' +
  '<fonts count="3"><font><name val="Calibri" /><family val="2" /><color theme="1" /><sz val="11" /><scheme val="minor" /></font>' +
  '<font><name val="Arial" /><b val="1" /><color rgb="00FFFFFF" /><sz val="10" /></font>' +
  '<font><name val="Arial" /><sz val="10" /></font></fonts>' +
  '<fills count="3"><fill><patternFill /></fill><fill><patternFill patternType="gray125" /></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="001F4E78" /></patternFill></fill></fills>' +
  '<borders count="2"><border><left /><right /><top /><bottom /><diagonal /></border>' +
  '<border><left style="thin"><color rgb="00D9D9D9" /></left><right style="thin"><color rgb="00D9D9D9" /></right><top style="thin"><color rgb="00D9D9D9" /></top><bottom style="thin"><color rgb="00D9D9D9" /></bottom></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" /></cellStyleXfs>' +
  '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" pivotButton="0" quotePrefix="0" xfId="0" />' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyAlignment="1" pivotButton="0" quotePrefix="0" xfId="0"><alignment horizontal="center" vertical="center" wrapText="1" /></xf>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="1" applyAlignment="1" pivotButton="0" quotePrefix="0" xfId="0"><alignment vertical="top" /></xf>' +
  '<xf numFmtId="165" fontId="2" fillId="0" borderId="1" applyAlignment="1" pivotButton="0" quotePrefix="0" xfId="0"><alignment vertical="top" /></xf></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0" hidden="0" /></cellStyles>' +
  '<dxfs count="1"><dxf><fill><patternFill patternType="solid"><fgColor rgb="00F2F6FA" /></patternFill></fill></dxf></dxfs>' +
  '<tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleLight16" />' +
  '</styleSheet>'

const cuenta = (xml: string, etiqueta: string) => (xml.match(new RegExp(`<${etiqueta}\\b`, 'g')) ?? []).length
const count = (xml: string, seccion: string) => Number(new RegExp(`<${seccion} count="(\\d+)"`).exec(xml)?.[1])

describe('asegurar los estilos con nombre', () => {
  it('añade al final lo que falta y actualiza los count', () => {
    const r = asegurarEstilos(MINIMO, ['cabecera', 'texto', 'fecha'])
    // El 0 ya estaba; los tres nuevos van detrás, en el orden pedido.
    expect([...r.indices.entries()]).toEqual([['cabecera', 1], ['texto', 2], ['fecha', 3]])
    expect(count(r.xml, 'cellXfs')).toBe(4)
    expect(cuenta(/<cellXfs[\s\S]*?<\/cellXfs>/.exec(r.xml)![0], 'xf')).toBe(4)
    expect(count(r.xml, 'fonts')).toBe(cuenta(/<fonts[\s\S]*?<\/fonts>/.exec(r.xml)![0], 'font'))
    expect(count(r.xml, 'fills')).toBe(cuenta(/<fills[\s\S]*?<\/fills>/.exec(r.xml)![0], 'fill'))
    // Y lo que había no se ha movido: el xf 0 sigue siendo el primero.
    expect(r.xml).toContain('<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>')
  })

  it('la segunda vez no cambia ni un byte y da los mismos índices', () => {
    const uno = asegurarEstilos(MINIMO, ['cabecera', 'cabeceraApp', 'texto', 'fecha', 'porcentaje', 'entero', 'ok', 'titulo'])
    const dos = asegurarEstilos(uno.xml, ['cabecera', 'cabeceraApp', 'texto', 'fecha', 'porcentaje', 'entero', 'ok', 'titulo'])
    expect(dos.xml).toBe(uno.xml)
    expect(dos.indices).toEqual(uno.indices)
    // Pedidos en otro orden, los mismos índices: el índice es del estilo, no del pedido.
    const tres = asegurarEstilos(uno.xml, ['titulo', 'ok', 'cabecera'])
    expect(tres.xml).toBe(uno.xml)
    expect(tres.indices.get('titulo')).toBe(uno.indices.get('titulo'))
  })

  it('reconoce un estilo idéntico aunque esté escrito con otros bytes', () => {
    // El libro real escribe `00FFFFFF` y `pivotButton="0"`: sigue siendo la cabecera.
    const r = asegurarEstilos(COMO_EL_LIBRO_REAL, ['cabecera', 'texto', 'fecha'])
    expect(r.xml).toBe(COMO_EL_LIBRO_REAL)
    expect(r.indices.get('cabecera')).toBe(1)
    expect(r.indices.get('texto')).toBe(2)
    expect(r.indices.get('fecha')).toBe(3)
  })

  it('la fecha usa el numFmt que el libro ya tiene con ese código, y si no lo declara', () => {
    const conEl = asegurarEstilos(COMO_EL_LIBRO_REAL, ['fecha'])
    expect(conEl.xml).not.toContain('numFmtId="166"')

    const sinEl = asegurarEstilos(MINIMO, ['fecha'])
    // No había `<numFmts>`: se crea delante de `<fonts>`, que es su sitio.
    expect(sinEl.xml).toMatch(/<numFmts count="1"><numFmt numFmtId="164" formatCode="dd\/mm\/yyyy"\/><\/numFmts><fonts/)
    expect(sinEl.xml).toContain('numFmtId="164" fontId=')
  })

  it('lo que devuelve pinta lo que dice, según leerEstilos', () => {
    const r = asegurarEstilos(MINIMO, ['fecha', 'porcentaje', 'texto'])
    const e = leerEstilos(r.xml)
    expect(e.formatoDe(r.indices.get('fecha')!)).toBe('fecha')
    expect(e.formatoDe(r.indices.get('porcentaje')!)).toBe('porcentaje')
    expect(e.formatoDe(r.indices.get('texto')!)).toBe('otro')
  })

  it('un tinte se suma al formato: una fecha en fila crítica sigue siendo fecha', () => {
    const receta = conTinte(recetaDe('fecha'), 'critico')
    expect(receta.numFmt).toBe('fecha')
    expect(receta.relleno).toBe('FAE8E6')
    const r = asegurarRecetas(MINIMO, [receta, recetaDe('fecha'), recetaDe('critico')])
    // Tres estilos distintos: la fecha tintada no es ni la fecha ni el tinte.
    expect(new Set(r.indices).size).toBe(3)
    expect(leerEstilos(r.xml).formatoDe(r.indices[0]!)).toBe('fecha')
  })

  it('los estilos que se distinguen solo por el borde o la alineación no se confunden', () => {
    const r = asegurarEstilos(MINIMO, ['texto', 'textoAjustado', 'textoSinBorde', 'etiqueta'])
    expect(new Set(r.indices.values()).size).toBe(4)
  })

  it('el dxf de las bandas se reutiliza si el libro ya lo trae', () => {
    const r = asegurarDxfDeFondo(COMO_EL_LIBRO_REAL, 'F2F6FA')
    expect(r.xml).toBe(COMO_EL_LIBRO_REAL)
    expect(r.indice).toBe(0)
  })

  it('y si no lo trae se crea la sección en su sitio', () => {
    const r = asegurarDxfDeFondo(MINIMO, 'F2F6FA')
    expect(r.indice).toBe(0)
    expect(r.xml).toMatch(/<\/cellStyles><dxfs count="1"><dxf>.*<\/dxfs><tableStyles/)
    const otra = asegurarDxfDeFondo(r.xml, 'F2F6FA')
    expect(otra.xml).toBe(r.xml)
    expect(asegurarDxfDeFondo(r.xml, 'FFFFFF').indice).toBe(1)
  })
})

describe.skipIf(!bytes)('los estilos con nombre sobre el libro real', () => {
  it('lo que el libro ya tiene se reutiliza sin añadir nada', async () => {
    const libro = await abrirLibro(new Uint8Array(bytes!))
    const xml = new TextDecoder().decode(
      await descomprimir(libro.entradas.find((e) => e.nombre === 'xl/styles.xml')!),
    )
    const r = asegurarEstilos(xml, ['cabecera', 'cabeceraApp', 'texto', 'fecha', 'porcentaje', 'textoAjustado', 'titulo', 'etiqueta', 'textoSinBorde'])
    // Son, uno por uno, los estilos con los que se reformateó el libro.
    expect(r.xml).toBe(xml)
    expect(r.indices.get('cabecera')).toBe(1)
    expect(r.indices.get('cabeceraApp')).toBe(2)
    expect(r.indices.get('fecha')).toBe(4)
    expect(asegurarDxfDeFondo(xml, 'F2F6FA')).toEqual({ xml, indice: 0 })
  })
})
