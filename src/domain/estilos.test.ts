import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { estiloQuePinta, estilosDeLaColumna, leerEstilos } from './estilos'
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
