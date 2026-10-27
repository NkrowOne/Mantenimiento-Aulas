import { describe, expect, it } from 'vitest'
import { TIPO_XLSX, libroNuevo, nombreConFecha } from './exportar'
import type { HojaNueva } from './libro'
import { abrirLibro, leerHoja } from './xlsx'
import type { Libro } from './xlsx'
import { leerEstilos } from './estilos'
import { descomprimir } from '../lib/zip'

async function xmlDe(libro: Libro, ruta: string): Promise<string> {
  const e = libro.entradas.find((x) => x.nombre === ruta)
  if (!e) throw new Error(`no está ${ruta}`)
  return new TextDecoder().decode(await descomprimir(e))
}

async function xmlDeHoja(libro: Libro, nombre: string): Promise<string> {
  return xmlDe(libro, libro.hojas.find((h) => h.nombre === nombre)!.ruta)
}

const EXISTENCIAS: HojaNueva = {
  nombre: 'Existencias',
  filas: [
    ['Artículo', 'Desde', 'Cantidad', 'Notas'],
    ['Cable HDMI 2 m', 46288, 12, 'bien'],
    ['Ratón', 46289, null, null],
  ],
  anchos: [30, 11, 10, 40],
  formatos: [undefined, 'fecha', 'entero', 'textoAjustado'],
  tintes: ['critico', undefined],
}

const NOTAS: HojaNueva = {
  nombre: 'Notas',
  filas: [['Qué'], ['Una nota']],
  caracter: 'editable',
}

describe('TIPO_XLSX', () => {
  it('es el tipo de contenido de un .xlsx', () => {
    expect(TIPO_XLSX).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  })
})

describe('libroNuevo', () => {
  it('se abre con el lector del proyecto, con las hojas pedidas y en su orden', async () => {
    const libro = await abrirLibro(await libroNuevo([EXISTENCIAS, NOTAS]))
    expect(libro.hojas.map((h) => h.nombre)).toEqual(['Existencias', 'Notas'])
    // Sin la hoja provisional de partida: exactamente dos ficheros de hoja.
    expect(libro.entradas.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.nombre))).toHaveLength(2)
  })

  it('el orden es el que se pide, no el alfabético ni el de creación', async () => {
    const libro = await abrirLibro(
      await libroNuevo([
        { nombre: 'Zeta', filas: [['a'], ['1']] },
        { nombre: 'Alfa', filas: [['b'], ['2']] },
        { nombre: 'Medio', filas: [['c'], ['3']] },
      ]),
    )
    expect(libro.hojas.map((h) => h.nombre)).toEqual(['Zeta', 'Alfa', 'Medio'])
    const wb = await xmlDe(libro, 'xl/workbook.xml')
    expect([...wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => m[1])).toEqual(['Zeta', 'Alfa', 'Medio'])
  })

  it('leerHoja devuelve los valores escritos, con las celdas vacías sin aparecer', async () => {
    const libro = await abrirLibro(await libroNuevo([EXISTENCIAS, NOTAS]))
    const filas = await leerHoja(libro, 'Existencias')
    expect(filas.map((f) => f.fila)).toEqual([1, 2, 3])
    expect(filas[0]!.celdas).toEqual({ A: 'Artículo', B: 'Desde', C: 'Cantidad', D: 'Notas' })
    expect(filas[1]!.celdas).toEqual({ A: 'Cable HDMI 2 m', B: 46288, C: 12, D: 'bien' })
    // `null` es una celda sin valor: con estilo, pero que no se lee.
    expect(filas[2]!.celdas).toEqual({ A: 'Ratón', B: 46289 })
    expect((await leerHoja(libro, 'Notas')).map((f) => f.celdas)).toEqual([{ A: 'Qué' }, { A: 'Una nota' }])
  })

  it('una columna de fecha es un número de serie con formato de fecha', async () => {
    const libro = await abrirLibro(await libroNuevo([EXISTENCIAS]))
    const xml = await xmlDeHoja(libro, 'Existencias')
    const estilos = leerEstilos(await xmlDe(libro, 'xl/styles.xml'))
    const s = (ref: string) => Number(new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(xml)?.[1])
    // B2 está en una fila tintada (crítica) y B3 en una sin tinte: el tinte se
    // suma al formato, no lo sustituye.
    expect(estilos.formatoDe(s('B2'))).toBe('fecha')
    expect(estilos.formatoDe(s('B3'))).toBe('fecha')
    expect(estilos.formatoDe(s('A2'))).toBe('otro')
    // Y el valor es el número, no un texto con la fecha.
    expect(xml).toMatch(/<c r="B2" s="\d+"><v>46288<\/v><\/c>/)
  })

  it('no lleva calcChain en ningún sitio: ni en el zip, ni en los tipos, ni en las relaciones', async () => {
    const libro = await abrirLibro(await libroNuevo([EXISTENCIAS, NOTAS]))
    expect(libro.entradas.map((e) => e.nombre).filter((n) => /calcChain/i.test(n))).toEqual([])
    expect(await xmlDe(libro, '[Content_Types].xml')).not.toMatch(/calcChain/i)
    expect(await xmlDe(libro, 'xl/_rels/workbook.xml.rels')).not.toMatch(/calcChain/i)
  })

  it('cada parte declarada existe y cada relación del libro apunta a algo que está', async () => {
    const libro = await abrirLibro(await libroNuevo([EXISTENCIAS, NOTAS]))
    const nombres = new Set(libro.entradas.map((e) => e.nombre))
    const tipos = await xmlDe(libro, '[Content_Types].xml')
    for (const m of tipos.matchAll(/<Override\b[^>]*PartName="\/([^"]+)"/g)) expect(nombres).toContain(m[1])

    const rels = await xmlDe(libro, 'xl/_rels/workbook.xml.rels')
    for (const m of rels.matchAll(/Target="([^"]+)"/g)) expect(nombres).toContain(`xl/${m[1]}`)

    // Y cada fichero de hoja está declarado: sin el tipo de contenido Excel no sabe qué es.
    for (const h of libro.hojas) expect(tipos).toContain(`PartName="/${h.ruta}"`)
    // Los `r:id` de <sheets> son todos distintos y existen en las relaciones.
    const wb = await xmlDe(libro, 'xl/workbook.xml')
    const ids = [...wb.matchAll(/<sheet\b[^>]*\br:id="([^"]+)"/g)].map((m) => m[1]!)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(rels).toContain(`Id="${id}"`)
  })

  it('se abre en la primera hoja, y solo esa va seleccionada', async () => {
    const libro = await abrirLibro(await libroNuevo([EXISTENCIAS, NOTAS]))
    expect(await xmlDe(libro, 'xl/workbook.xml')).toContain('activeTab="0"')
    expect(await xmlDeHoja(libro, 'Existencias')).toContain('tabSelected="1"')
    expect(await xmlDeHoja(libro, 'Notas')).not.toContain('tabSelected')
  })

  it('las hojas de la app son tablas con su cabecera, y las editables llevan autofiltro', async () => {
    const libro = await abrirLibro(await libroNuevo([EXISTENCIAS, NOTAS]))
    const tabla = await xmlDe(libro, 'xl/tables/table1.xml')
    expect(tabla).toContain('ref="A1:D3"')
    expect(tabla).toContain('<tableColumn id="1" name="Artículo"/>')
    expect(await xmlDeHoja(libro, 'Existencias')).toContain('<tableParts')
    const notas = await xmlDeHoja(libro, 'Notas')
    expect(notas).toContain('<autoFilter ref="A1:A2"/>')
    expect(notas).not.toContain('<tableParts')
  })

  it('la cabecera va inmovilizada, los anchos puestos y las pestañas coloreadas', async () => {
    const libro = await abrirLibro(await libroNuevo([EXISTENCIAS]))
    const xml = await xmlDeHoja(libro, 'Existencias')
    expect(xml).toContain('state="frozen"')
    expect(xml).toContain('<col min="1" max="1" width="30" customWidth="1"/>')
    expect(xml).toContain('<tabColor rgb="FF9DC3E6"/>')
  })

  it('una sola hoja, con un nombre con & y apóstrofo en medio, sale tal cual', async () => {
    const nombre = "Aulas & Salas d'ensayo"
    const libro = await abrirLibro(await libroNuevo([{ nombre, filas: [['x'], ['y']] }]))
    expect(libro.hojas.map((h) => h.nombre)).toEqual([nombre])
    expect((await leerHoja(libro, nombre))[1]!.celdas).toEqual({ A: 'y' })
  })

  it('una hoja solo con cabecera es válida', async () => {
    const libro = await abrirLibro(await libroNuevo([{ nombre: 'Vacía', filas: [['A', 'B']] }]))
    expect(await leerHoja(libro, 'Vacía')).toHaveLength(1)
    // Una tabla necesita una fila de datos: el rango llega a la 2 aunque esté vacía.
    expect(await xmlDe(libro, 'xl/tables/table1.xml')).toContain('ref="A1:B2"')
  })

  it('el mismo contenido da los mismos bytes', async () => {
    const a = await libroNuevo([EXISTENCIAS, NOTAS])
    const b = await libroNuevo([EXISTENCIAS, NOTAS])
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('no modifica las hojas que recibe', async () => {
    const hoja: HojaNueva = { nombre: 'Datos', filas: [['a'], ['=1+1']] }
    await libroNuevo([hoja])
    expect(hoja.filas[1]![0]).toBe('=1+1')
  })

  describe('lo que viene de personas no se convierte en fórmula', () => {
    it('un texto que empieza por = se escribe como texto, con un apóstrofo delante', async () => {
      const libro = await abrirLibro(
        await libroNuevo([
          { nombre: 'Datos', filas: [['Nota', '=SUMA(A1)'], ['=HYPERLINK("http://malo")', '=cmd|\' /C calc\'!A0']] },
        ]),
      )
      const xml = await xmlDeHoja(libro, 'Datos')
      expect(xml).not.toContain('<f>')
      const filas = await leerHoja(libro, 'Datos')
      expect(filas[1]!.celdas).toEqual({ A: '\'=HYPERLINK("http://malo")', B: "'=cmd|' /C calc'!A0" })
      expect(filas[1]!.formulas).toEqual({})
      // La cabecera también.
      expect(filas[0]!.celdas.B).toBe("'=SUMA(A1)")
    })

    it('otros signos al principio (+, -, @) ya son texto en el fichero y no se tocan', async () => {
      const libro = await abrirLibro(await libroNuevo([{ nombre: 'Datos', filas: [['a'], ['+1'], ['-2'], ['@x']] }]))
      expect((await leerHoja(libro, 'Datos')).slice(1).map((f) => f.celdas.A)).toEqual(['+1', '-2', '@x'])
    })
  })

  describe('lo que no da error al escribir y sí al abrir', () => {
    it('un número que no es finito se queda en blanco', async () => {
      const libro = await abrirLibro(await libroNuevo([{ nombre: 'Datos', filas: [['n'], [Number.NaN], [Infinity], [7]] }]))
      expect((await xmlDeHoja(libro, 'Datos'))).not.toMatch(/NaN|Infinity/)
      expect((await leerHoja(libro, 'Datos')).map((f) => f.celdas.A)).toEqual(['n', undefined, undefined, 7])
    })

    it('un texto de más de 32.767 caracteres se corta', async () => {
      const largo = 'x'.repeat(40_000)
      const libro = await abrirLibro(await libroNuevo([{ nombre: 'Datos', filas: [['t'], [largo]] }]))
      const texto = (await leerHoja(libro, 'Datos'))[1]!.celdas.A as string
      expect(texto).toHaveLength(32_767)
      expect(texto.endsWith('…')).toBe(true)
    })

    it('un carácter de control en una nota no deja la hoja mal formada', async () => {
      const libro = await abrirLibro(await libroNuevo([{ nombre: 'Datos', filas: [['t'], ['salto\u000Bde Word']] }]))
      const xml = await xmlDeHoja(libro, 'Datos')
      expect(xml).not.toContain('\u000B')
      expect((await leerHoja(libro, 'Datos'))[1]!.celdas.A).toContain('salto')
    })
  })

  describe('rechaza, con un mensaje que se puede enseñar, lo que Excel rechazaría al abrir', () => {
    const hoja = (nombre: string): HojaNueva => ({ nombre, filas: [['a'], ['b']] })

    it('una lista vacía', async () => {
      await expect(libroNuevo([])).rejects.toThrow(/al menos una hoja/)
    })

    it('dos hojas con el mismo nombre, también si solo cambian las mayúsculas', async () => {
      await expect(libroNuevo([hoja('Stock'), hoja('Stock')])).rejects.toThrow(/Dos hojas se llaman «Stock»/)
      await expect(libroNuevo([hoja('Stock'), hoja('STOCK')])).rejects.toThrow(/nombres repetidos/)
    })

    it('un nombre de más de 31 caracteres', async () => {
      await expect(libroNuevo([hoja('x'.repeat(32))])).rejects.toThrow(/31 caracteres/)
      await expect(libroNuevo([hoja('x'.repeat(31))])).resolves.toBeInstanceOf(Uint8Array)
    })

    it.each(['a/b', 'a\\b', 'a?b', 'a*b', 'a[b', 'a]b', 'a:b'])('un nombre con %s', async (nombre) => {
      await expect(libroNuevo([hoja(nombre)])).rejects.toThrow(/carácter que Excel no admite/)
    })

    it('un nombre vacío, o que empieza o acaba en apóstrofo', async () => {
      await expect(libroNuevo([hoja('  ')])).rejects.toThrow(/nombre vacío/)
      await expect(libroNuevo([hoja("'abc")])).rejects.toThrow(/apóstrofo/)
      await expect(libroNuevo([hoja("abc'")])).rejects.toThrow(/apóstrofo/)
    })
  })
})

describe('nombreConFecha', () => {
  const HOY = new Date('2026-10-27T10:00:00Z')

  it('la base, un espacio, el día y .xlsx', () => {
    expect(nombreConFecha('Almacén', HOY)).toBe('Almacén 2026-10-27.xlsx')
  })

  it('el día es el de Madrid, no el del reloj UTC', () => {
    // Octubre ya es horario de invierno (UTC+1): las 23:30 UTC del 26 son las 00:30 del 27.
    expect(nombreConFecha('Almacén', new Date('2026-10-26T23:30:00Z'))).toBe('Almacén 2026-10-27.xlsx')
    expect(nombreConFecha('Almacén', new Date('2026-10-26T22:30:00Z'))).toBe('Almacén 2026-10-26.xlsx')
    // Y en verano (UTC+2) el cambio de día cae una hora antes.
    expect(nombreConFecha('Almacén', new Date('2026-07-14T22:30:00Z'))).toBe('Almacén 2026-07-15.xlsx')
    expect(nombreConFecha('Almacén', new Date('2026-07-14T21:30:00Z'))).toBe('Almacén 2026-07-14.xlsx')
  })

  it('sin fecha usa hoy', () => {
    expect(nombreConFecha('Almacén')).toMatch(/^Almacén \d{4}-\d{2}-\d{2}\.xlsx$/)
  })

  it('quita lo que no vale en un nombre de fichero, sin pegar las palabras', () => {
    expect(nombreConFecha('Stock: ene/feb?', HOY)).toBe('Stock ene feb 2026-10-27.xlsx')
    expect(nombreConFecha('a\\b*c"d<e>f|g', HOY)).toBe('a b c d e f g 2026-10-27.xlsx')
    expect(nombreConFecha('con\u0000control\u001f', HOY)).toBe('con control 2026-10-27.xlsx')
  })

  it('recoge los espacios y no deja puntos ni espacios en los extremos', () => {
    expect(nombreConFecha('  Almacén   central. ', HOY)).toBe('Almacén central 2026-10-27.xlsx')
    expect(nombreConFecha('.oculto', HOY)).toBe('oculto 2026-10-27.xlsx')
  })

  it('una .xlsx que la base ya lleve no se repite', () => {
    expect(nombreConFecha('Almacén.xlsx', HOY)).toBe('Almacén 2026-10-27.xlsx')
    expect(nombreConFecha('Almacén.XLSX', HOY)).toBe('Almacén 2026-10-27.xlsx')
  })

  it('si de la base no queda nada, se llama «Exportación»', () => {
    expect(nombreConFecha('', HOY)).toBe('Exportación 2026-10-27.xlsx')
    expect(nombreConFecha('???', HOY)).toBe('Exportación 2026-10-27.xlsx')
    expect(nombreConFecha('.xlsx', HOY)).toBe('Exportación 2026-10-27.xlsx')
  })

  it('conserva tildes, eñes y rayas', () => {
    expect(nombreConFecha('Año — PCs ñandú', HOY)).toBe('Año — PCs ñandú 2026-10-27.xlsx')
  })

  it('una base larguísima se corta', () => {
    const n = nombreConFecha('x'.repeat(300), HOY)
    expect(n).toBe(`${'x'.repeat(100)} 2026-10-27.xlsx`)
  })
})
