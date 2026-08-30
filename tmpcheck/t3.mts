import { readFileSync } from 'node:fs'
import { abrirLibro, leerHoja } from '../src/domain/xlsx'
import { sincronizarBolsa } from '../src/domain/sincronizar'
import { BOLSA_2026 } from '../src/domain/mapa'

const libro = await abrirLibro(new Uint8Array(readFileSync(process.env.LIBRO_XLSX!)))
const filas = await leerHoja(libro, 'Bolsa 2026')

const articulos = [{ id: 'a1', nombre: 'Cable HDMI 3 mts', meses: [0,0,3,0,0,0,0,0,0,0,0,0], comprado: 38 }]
const plan = sincronizarBolsa({
  hoja: BOLSA_2026,
  filas,
  articulos,
  resolver: (n) => (n.trim() === 'Cable HDMI 3 mts' ? 'a1' : null),
})
console.log('desajustes', plan.desajustes)
console.log('celdas', JSON.stringify(plan.celdas, null, 1))
console.log('avisos', plan.avisos)
