import { readFileSync, writeFileSync } from 'node:fs'
import { abrirLibro, leerHoja } from '../src/domain/xlsx'
import { escribirLibro } from '../src/domain/libro'

const RUTA = process.env.LIBRO_XLSX!
const bytes = new Uint8Array(readFileSync(RUTA))
const libro = await abrirLibro(bytes)
console.log('hojas', libro.hojas)

const b26 = await leerHoja(libro, 'Bolsa 2026')
const f2 = b26.find(f => f.fila === 2)!
console.log('Bolsa2026 fila2 celdas:', JSON.stringify(f2.celdas))
const f5 = b26.find(f => f.fila === 5)!
console.log('Bolsa2026 fila5 celdas:', JSON.stringify(f5.celdas))

const b25 = await leerHoja(libro, 'Bolsa 2025')
const g2 = b25.find(f => f.fila === 2)!
console.log('Bolsa2025 fila2:', JSON.stringify(g2.celdas))
