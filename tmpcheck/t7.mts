import { readFileSync, writeFileSync } from 'node:fs'
import { abrirLibro } from '../src/domain/xlsx'
import { escribirLibro } from '../src/domain/libro'
const libro = await abrirLibro(new Uint8Array(readFileSync(process.env.LIBRO_XLSX!)))
// SOLO borrar la 182: la sala archivada dentro de la fusion A181:A183.
const out = await escribirLibro(libro, [{ hoja: 'Estado Aulas y Salas de reunion', filas: { borrar: [182] } }])
writeFileSync(process.env.SALIDA!, out)
