import { readFileSync, writeFileSync } from 'node:fs'
import { abrirLibro } from '../src/domain/xlsx'
import { escribirLibro } from '../src/domain/libro'

const RUTA = process.env.LIBRO_XLSX!
const libro = await abrirLibro(new Uint8Array(readFileSync(RUTA)))

// Exactamente lo que emite sincronizarBolsa cuando cree que la formula se piso:
const out = await escribirLibro(libro, [{
  hoja: 'Bolsa 2026',
  celdas: [
    { celda: 'N5', valor: '=B5+C5+D5+E5+F5+G5+H5+I5+J5+K5+L5+M5' },
    { celda: 'O5', valor: '=P5-N5' },
  ],
}])
writeFileSync('/tmp/claude-0/-home-user-Mantenimiento-Aulas/8619e721-67c3-5ce9-8f4b-73bc4009d4f4/scratchpad/t2.xlsx', out)
console.log('escrito')
