import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { escribirLibro } from './libro'
import { abrirLibro, leerHoja } from './xlsx'
import { descomprimir } from '../lib/zip'

const LIBRO = process.env.LIBRO_XLSX
const bytes = LIBRO ? readFileSync(LIBRO) : null

const ESTADO = 'Estado Aulas y Salas de reunion'

async function abrir() {
  return abrirLibro(new Uint8Array(bytes!))
}

async function xmlDe(libro: Awaited<ReturnType<typeof abrir>>, ruta: string): Promise<string> {
  return new TextDecoder().decode(await descomprimir(libro.entradas.find((e) => e.nombre === ruta)!))
}

describe.skipIf(!bytes)('escribir el libro', () => {
  it('sin pedir nada devuelve un libro que se puede volver a abrir', async () => {
    const salida = await escribirLibro(await abrir(), [])
    const otra = await abrirLibro(salida)
    expect(otra.hojas.map((h) => h.nombre)).toEqual((await abrir()).hojas.map((h) => h.nombre))
  })

  it('escribe una celda sin tocar las demás', async () => {
    const salida = await escribirLibro(await abrir(), [
      { hoja: ESTADO, celdas: [{ celda: 'X2', valor: 'probado' }] },
    ])
    const otra = await abrirLibro(salida)
    const filas = await leerHoja(otra, ESTADO)
    expect(filas.find((f) => f.fila === 2)!.celdas.X).toBe('probado')
    expect(filas.find((f) => f.fila === 2)!.celdas.C).toBe('0.1P')
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

  it('al mover filas se tira la caché de recálculo', async () => {
    const original = await abrir()
    expect(original.entradas.some((e) => e.nombre === 'xl/calcChain.xml')).toBe(true)

    const salida = await escribirLibro(original, [
      { hoja: ESTADO, filas: { insertar: [{ tras: 30, celdas: [{ celda: 'A31', valor: 'x' }] }] } },
    ])
    const otra = await abrirLibro(salida)
    expect(otra.entradas.some((e) => e.nombre === 'xl/calcChain.xml')).toBe(false)
  })

  it('escribir solo celdas no tira la caché', async () => {
    const salida = await escribirLibro(await abrir(), [
      { hoja: ESTADO, celdas: [{ celda: 'X2', valor: 'x' }] },
    ])
    expect((await abrirLibro(salida)).entradas.some((e) => e.nombre === 'xl/calcChain.xml')).toBe(true)
  })

  it('los comentarios siguen a su aula al insertar', async () => {
    const original = await abrir()
    const antes = await xmlDe(original, 'xl/comments1.xml')
    expect(antes).toContain('ref="Q205"')

    const salida = await escribirLibro(original, [
      { hoja: ESTADO, filas: { insertar: [{ tras: 30, celdas: [{ celda: 'A31', valor: 'x' }] }] } },
    ])
    const despues = await xmlDe(await abrirLibro(salida), 'xl/comments1.xml')
    expect(despues).toContain('ref="Q206"')
    expect(despues).toContain('La TV esta estropeada')
  })

  it('el ancla del dibujo del comentario también', async () => {
    const original = await abrir()
    const antes = await xmlDe(original, 'xl/drawings/vmlDrawing1.vml')
    const filasAntes = [...antes.matchAll(/<x:Row>(\d+)<\/x:Row>/g)].map((m) => Number(m[1]))
    expect(filasAntes.length).toBeGreaterThan(0)

    const salida = await escribirLibro(original, [
      { hoja: ESTADO, filas: { insertar: [{ tras: 30, celdas: [{ celda: 'A31', valor: 'x' }] }] } },
    ])
    const despues = await xmlDe(await abrirLibro(salida), 'xl/drawings/vmlDrawing1.vml')
    const filasDespues = [...despues.matchAll(/<x:Row>(\d+)<\/x:Row>/g)].map((m) => Number(m[1]))
    // Todas las de debajo del corte bajan una; ninguna se queda igual por error.
    expect(filasDespues).toEqual(filasAntes.map((f) => (f + 1 >= 31 ? f + 1 : f)))
  })

  it('la etiqueta de confidencialidad y los metadatos de SharePoint siguen ahí', async () => {
    const original = await abrir()
    const salida = await escribirLibro(original, [
      { hoja: ESTADO, filas: { insertar: [{ tras: 30, celdas: [{ celda: 'A31', valor: 'x' }] }] } },
    ])
    const otra = await abrirLibro(salida)
    for (const parte of [
      'docMetadata/LabelInfo.xml',
      'customXml/item1.xml',
      'customXml/item2.xml',
      'customXml/item3.xml',
      'xl/theme/theme1.xml',
    ]) {
      expect(otra.entradas.some((e) => e.nombre === parte)).toBe(true)
    }
  })
})

describe.skipIf(!bytes)('añadir hojas', () => {
  it('la hoja nueva sale al final y se lee', async () => {
    const salida = await escribirLibro(
      await abrir(),
      [],
      [
        {
          nombre: 'Revisiones',
          filas: [
            ['Aula', 'Fecha', 'Revisó'],
            ['0.1P', 45000, 'Ana'],
          ],
          anchos: [14, 12, 20],
        },
      ],
    )
    const otra = await abrirLibro(salida)
    expect(otra.hojas.map((h) => h.nombre)).toContain('Revisiones')
    expect(otra.hojas[otra.hojas.length - 1]!.nombre).toBe('Revisiones')

    const filas = await leerHoja(otra, 'Revisiones')
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
