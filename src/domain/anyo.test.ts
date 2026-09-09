import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { anyoDelParte, corteDeAnyo, partesFueraDeSuAnyo } from './anyo'
import { BOLSA_2026, MATERIAL_2026 } from './mapa'
import { escribirLibro } from './libro'
import { abrirLibro, leerHoja } from './xlsx'

const LIBRO = process.env.LIBRO_XLSX
const bytes = LIBRO ? readFileSync(LIBRO) : null

const EXISTENTES = [
  'Estado Aulas y Salas de reunion',
  'Material Instalado 2026',
  'Bolsa 2026',
  'Material Instalado 2025',
  'Bolsa 2025',
]

const ARTICULOS = [
  { nombre: 'Cable HDMI fibra 10 m', nombreAlternativo: 'Cable HDMI Fibra 10 metros', saldo: 26 },
  { nombre: 'Altavoces', nombreAlternativo: null, saldo: 0 },
  { nombre: 'Ratón', nombreAlternativo: null, saldo: 12 },
]

describe('el corte de año', () => {
  it('crea las dos hojas que faltan', () => {
    const c = corteDeAnyo({ anyo: 2027, hojasExistentes: EXISTENTES, articulos: ARTICULOS })
    expect(c.hojas.map((h) => h.nombre)).toEqual(['Material Instalado 2027', 'Bolsa 2027'])
  })

  it('no crea nada si ya están: repetir la pasada no duplica hojas', () => {
    const c = corteDeAnyo({ anyo: 2026, hojasExistentes: EXISTENTES, articulos: ARTICULOS })
    expect(c.hojas).toEqual([])
    expect(c.avisos).toEqual([])
  })

  it('crea solo la que falte', () => {
    const c = corteDeAnyo({
      anyo: 2027,
      hojasExistentes: [...EXISTENTES, 'Bolsa 2027'],
      articulos: ARTICULOS,
    })
    expect(c.hojas.map((h) => h.nombre)).toEqual(['Material Instalado 2027'])
  })

  it('la hoja de partes sale con su cabecera y vacía', () => {
    const c = corteDeAnyo({ anyo: 2027, hojasExistentes: EXISTENTES, articulos: ARTICULOS })
    const partes = c.hojas.find((h) => h.nombre === 'Material Instalado 2027')!
    expect(partes.filas).toHaveLength(1)
    expect(partes.filas[0]).toEqual(MATERIAL_2026.columnas.map((col) => col.cabecera))
  })

  it('la hoja de partes nueva no resucita la columna Observación de 2025', () => {
    const c = corteDeAnyo({ anyo: 2027, hojasExistentes: EXISTENTES, articulos: ARTICULOS })
    const partes = c.hojas.find((h) => h.nombre === 'Material Instalado 2027')!
    expect(partes.filas[0]).not.toContain('Observación')
  })

  it('la bolsa arrastra el saldo del cierre a Total Comprado', () => {
    const c = corteDeAnyo({ anyo: 2027, hojasExistentes: EXISTENTES, articulos: ARTICULOS })
    const bolsa = c.hojas.find((h) => h.nombre === 'Bolsa 2027')!
    const iNombre = BOLSA_2026.columnas.findIndex((col) => col.campo === 'articulo.nombre')
    const iComprado = BOLSA_2026.columnas.findIndex((col) => col.campo === 'articulo.comprado')
    const cable = bolsa.filas.find((f) => f[iNombre] === 'Cable HDMI fibra 10 m')!
    expect(cable[iComprado]).toBe(26)
  })

  it('los doce meses nacen vacíos: el año no ha consumido nada', () => {
    const c = corteDeAnyo({ anyo: 2027, hojasExistentes: EXISTENTES, articulos: ARTICULOS })
    const bolsa = c.hojas.find((h) => h.nombre === 'Bolsa 2027')!
    for (let col = 1; col <= 12; col++) {
      expect(bolsa.filas[1]![col], `mes ${col}`).toBeNull()
    }
  })

  it('las fórmulas se escriben desde el mapa, no copiando las viejas', () => {
    // Copiarlas arrastraría el `=P34-N34` de la fila 35, que apunta a la de al lado.
    const c = corteDeAnyo({ anyo: 2027, hojasExistentes: EXISTENTES, articulos: ARTICULOS })
    const bolsa = c.hojas.find((h) => h.nombre === 'Bolsa 2027')!
    const iDisponible = BOLSA_2026.columnas.findIndex((col) => col.campo === 'articulo.disponible')
    expect(bolsa.filas[1]![iDisponible]).toBe('=P2-N2')
    expect(bolsa.filas[2]![iDisponible]).toBe('=P3-N3')
  })

  it('la segunda grafía se arrastra para no perder el alias', () => {
    const c = corteDeAnyo({ anyo: 2027, hojasExistentes: EXISTENTES, articulos: ARTICULOS })
    const bolsa = c.hojas.find((h) => h.nombre === 'Bolsa 2027')!
    const iAlt = BOLSA_2026.columnas.findIndex((col) => col.campo === 'articulo.nombreAlternativo')
    const cable = bolsa.filas.find((f) => f[0] === 'Cable HDMI fibra 10 m')!
    expect(cable[iAlt]).toBe('Cable HDMI Fibra 10 metros')
    // Y si no la había, se repite el nombre bueno en vez de dejar el hueco.
    const altavoces = bolsa.filas.find((f) => f[0] === 'Altavoces')!
    expect(altavoces[iAlt]).toBe('Altavoces')
  })

  it('un saldo negativo no se arrastra: el almacén no debe unidades', () => {
    const c = corteDeAnyo({
      anyo: 2027,
      hojasExistentes: EXISTENTES,
      articulos: [{ nombre: 'Descuadrado', nombreAlternativo: null, saldo: -4 }],
    })
    const bolsa = c.hojas.find((h) => h.nombre === 'Bolsa 2027')!
    const iComprado = BOLSA_2026.columnas.findIndex((col) => col.campo === 'articulo.comprado')
    expect(bolsa.filas[1]![iComprado]).toBe(0)
  })
})

describe('el año de un parte', () => {
  it('lo dice la fecha, no la pestaña', () => {
    expect(anyoDelParte('2025-01-13')).toBe(2025)
    expect(anyoDelParte('2026-06-25T10:00:00.000Z')).toBe(2026)
    expect(anyoDelParte(null)).toBeNull()
    expect(anyoDelParte('no es una fecha')).toBeNull()
  })

  it('los partes en la hoja de otro año se cuentan', () => {
    // Es lo que pasa hoy: dos partes de 2025 dentro de «Material Instalado 2026».
    const fuera = partesFueraDeSuAnyo('Material Instalado 2026', [
      { fila: 8, numero: 'I260113_0038', abierta: '2025-01-13' },
      { fila: 2, numero: 'I260102_0002', abierta: '2026-01-02' },
    ])
    expect(fuera).toEqual([{ fila: 8, numero: 'I260113_0038', anyo: 2025 }])
  })

  it('una hoja sin año en el nombre no se juzga', () => {
    expect(partesFueraDeSuAnyo('Partes', [{ fila: 2, numero: 'X', abierta: '2020-01-01' }])).toEqual([])
  })
})

describe.skipIf(!bytes)('sobre el libro real', () => {
  it('las hojas de 2027 entran y se leen', async () => {
    const libro = await abrirLibro(new Uint8Array(bytes!))
    const c = corteDeAnyo({
      anyo: 2027,
      hojasExistentes: libro.hojas.map((h) => h.nombre),
      articulos: ARTICULOS,
    })
    const salida = await escribirLibro(libro, [], c.hojas)
    const otra = await abrirLibro(salida)

    expect(otra.hojas.map((h) => h.nombre)).toContain('Bolsa 2027')
    const bolsa = await leerHoja(otra, 'Bolsa 2027')
    expect(bolsa[0]!.celdas.A).toBe('Articulo / Material')
    expect(bolsa[0]!.celdas.N).toBe('Total Instalado')
    // Tres artículos, ordenados.
    expect(bolsa.slice(1).map((f) => f.celdas.A)).toEqual([
      'Altavoces',
      'Cable HDMI fibra 10 m',
      'Ratón',
    ])
  })

  it('el libro real ya trae dos partes fuera de su año, y se detectan', async () => {
    const libro = await abrirLibro(new Uint8Array(bytes!))
    const filas = await leerHoja(libro, 'Material Instalado 2026')
    const { excelAFecha } = await import('./valores')
    const partes = filas
      .filter((f) => f.fila > 1 && f.celdas.D)
      .map((f) => ({
        fila: f.fila,
        numero: String(f.celdas.D),
        abierta: typeof f.celdas.B === 'number' ? excelAFecha(f.celdas.B) : null,
      }))
    const fuera = partesFueraDeSuAnyo('Material Instalado 2026', partes)
    expect(fuera.length).toBeGreaterThan(0)
    for (const f of fuera) expect(f.anyo).not.toBe(2026)
  })
})
