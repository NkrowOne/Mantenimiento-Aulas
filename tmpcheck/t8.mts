import { readFileSync, writeFileSync } from 'node:fs'
import { abrirLibro } from '../src/domain/xlsx'
import { escribirLibro } from '../src/domain/libro'
const libro = await abrirLibro(new Uint8Array(readFileSync(process.env.LIBRO_XLSX!)))
// SOLO insertar una fila detras de la 100: nada se borra.
const out = await escribirLibro(libro, [{ hoja: 'Estado Aulas y Salas de reunion', filas: {
  insertar: [{ tras: 100, celdas: [{ celda: 'C101', valor: 'AULA NUEVA' }] }] } }])
writeFileSync(process.env.SALIDA!, out)
