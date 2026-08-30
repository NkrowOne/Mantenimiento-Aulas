import { readFileSync } from 'node:fs'
import { abrirLibro, leerHoja } from '../src/domain/xlsx'
import { escribirLibro } from '../src/domain/libro'
import { hojaDeRevisiones } from '../src/domain/hojasNuevas'

const rev = (n: number) => ({
  shortRef: `SALA-00000${n}`, edificio: 'EDIFICIO H', zona: 'PLANTA -1', sala: `A-10${n}`,
  cuando: `2026-01-1${n}T10:00:00Z`, quien: 'Ana', estado: 'cerrada', resultado: 'ok',
  horasProyector: 100 * n, lampara: 0.9, comprobaciones: 'altavoces: ok', incidenciasAbiertas: 0, notas: null,
})
const hoja = hojaDeRevisiones([rev(1), rev(2)] as any)

let bytes = await escribirLibro(await abrirLibro(new Uint8Array(readFileSync(process.env.LIBRO_XLSX!))), [], [hoja])
console.log('pasada 1: filas =', (await leerHoja(await abrirLibro(bytes), 'Revisiones')).length)

function letra(n: number): string { let s='',x=n; while(x>0){const r=(x-1)%26; s=String.fromCharCode(65+r)+s; x=Math.floor((x-1)/26)} return s }
const rehacer = (h: any) => ({ hoja: h.nombre, filas: { insertar: h.filas.slice(1).map((valores: any[]) => ({
  tras: 1, celdas: valores.map((v, i) => ({ celda: `${letra(i+1)}2`, valor: v })).filter((c:any)=>c.valor!==null),
})) } })

for (const n of [2, 3, 4]) {
  bytes = await escribirLibro(await abrirLibro(bytes), [rehacer(hoja)], [])
  const f = await leerHoja(await abrirLibro(bytes), 'Revisiones')
  console.log(`pasada ${n}: filas =`, f.length, ' A:', f.map(x => x.celdas.A ?? '-').join(','))
}
