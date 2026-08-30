import { readFileSync, writeFileSync } from 'node:fs'
import { abrirLibro } from '../src/domain/xlsx'
import { escribirLibro } from '../src/domain/libro'

const libro = await abrirLibro(new Uint8Array(readFileSync(process.env.LIBRO_XLSX!)))
// Borrar la fila 182 (sala archivada dentro de la fusion A181:A183) y la 205
// (la del comentario), e insertar una fila nueva detras de la 100, todo a la vez.
const out = await escribirLibro(libro, [{
  hoja: 'Estado Aulas y Salas de reunion',
  filas: {
    borrar: [182, 205],
    insertar: [{ tras: 100, celdas: [
      { celda: 'A101', valor: 'EDIFICIO Z' },
      { celda: 'C101', valor: 'AULA NUEVA' },
      { celda: 'Y101', valor: 'SALA-000999' },
    ] }],
  },
}])
writeFileSync(process.env.SALIDA!, out)
console.log('ok', out.length)
