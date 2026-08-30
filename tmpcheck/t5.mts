import { readFileSync, writeFileSync } from 'node:fs'
import { abrirLibro } from '../src/domain/xlsx'
import { escribirLibro } from '../src/domain/libro'

const libro = await abrirLibro(new Uint8Array(readFileSync(process.env.LIBRO_XLSX!)))
// 20 partes nuevos al final de 'Material Instalado 2026', que es lo que hace
// sincronizarPartes: todos con tras = ultimaFilaConDatos = 100.
const insertar = Array.from({ length: 20 }, (_, i) => ({
  tras: 100,
  celdas: [{ celda: 'D101', valor: `I2607${String(i).padStart(2, '0')}_0001` }],
  estiloDe: 100,
}))
const out = await escribirLibro(libro, [{ hoja: 'Material Instalado 2026', filas: { insertar } }])
writeFileSync(process.env.SALIDA!, out)
console.log('ok')
