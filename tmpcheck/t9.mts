import { readFileSync, writeFileSync } from 'node:fs'
import { abrirLibro } from '../src/domain/xlsx'
import { escribirLibro } from '../src/domain/libro'
const libro = await abrirLibro(new Uint8Array(readFileSync(process.env.LIBRO_XLSX!)))
// Bolsa 2025 esta congelada, pero probamos el remapeo sobre sus formulas reales:
// insertar detras de la 3 y borrar la 10, a la vez.
const out = await escribirLibro(libro, [{ hoja: 'Bolsa 2025', filas: {
  insertar: [{ tras: 3, celdas: [{ celda: 'A4', valor: 'NUEVO' }] }], borrar: [10] } }])
writeFileSync(process.env.SALIDA!, out)
