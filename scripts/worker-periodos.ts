/**
 * Los periodos del worker, en hora de Madrid.
 *
 *   npm run worker:periodos
 *
 * El fallo que esto vigila es silencioso: `toISOString()` devuelve la fecha
 * UTC, así que en verano, a partir de las 22:00 hora peninsular, «ayer» se
 * corría un día y el informe diario cubría la jornada equivocada. El PDF salía
 * bien formado y con un título creíble.
 */

import { periodFor } from '../reports-worker/src/data.js'

let fallos = 0

function comprueba(nombre: string, real: unknown, esperado: unknown): void {
  const ok = JSON.stringify(real) === JSON.stringify(esperado)
  if (!ok) fallos++
  console.log(
    `  ${ok ? '✓' : '✗'} ${nombre}` +
      (ok ? '' : `\n      esperado ${JSON.stringify(esperado)}\n      obtenido ${JSON.stringify(real)}`),
  )
}

// 23:00 en Madrid del 15 de julio son las 21:00 UTC del mismo día: los dos
// relojes coinciden en la fecha y no hay trampa.
comprueba(
  'a las 23:00 de Madrid, el diario cubre el día anterior',
  periodFor('diario', new Date('2026-07-15T21:00:00Z')),
  { start: '2026-07-14', end: '2026-07-14' },
)

// EL CASO QUE FALLABA. 00:30 del 16 de julio en Madrid son las 22:30 del 15 en
// UTC: para UTC todavía es día 15, así que «ayer» daba el 14 en vez del 15.
comprueba(
  'a las 00:30 de Madrid ya cuenta como el día siguiente',
  periodFor('diario', new Date('2026-07-15T22:30:00Z')),
  { start: '2026-07-15', end: '2026-07-15' },
)

// La hora a la que dispara el cron: 07:00 de Madrid en verano = 05:00 UTC.
comprueba(
  'el diario de las 07:00 cubre la jornada de ayer',
  periodFor('diario', new Date('2026-07-15T05:00:00Z')),
  { start: '2026-07-14', end: '2026-07-14' },
)

// En invierno el desfase es de una hora, no de dos.
comprueba(
  'en invierno el desfase es de una hora',
  periodFor('diario', new Date('2026-01-15T23:30:00Z')),
  { start: '2026-01-15', end: '2026-01-15' },
)

comprueba(
  'el semanal cubre los siete días que terminan ayer',
  periodFor('semanal', new Date('2026-07-20T05:30:00Z')),
  { start: '2026-07-13', end: '2026-07-19' },
)

// La semana que contiene el cambio de hora de marzo tiene un día de 23 horas.
// Restando milisegundos sin más, el séptimo día se habría quedado corto y la
// fecha habría retrocedido uno de menos.
comprueba(
  'la semana del cambio de hora sigue siendo de siete días',
  periodFor('semanal', new Date('2026-04-01T05:30:00Z')),
  { start: '2026-03-25', end: '2026-03-31' },
)

// `personalizado` no tiene periodo propio: si llega aquí es que no llegaron sus
// fechas, y devolver ayer en silencio produce un PDF que miente.
try {
  periodFor('personalizado')
  console.log('  ✗ un informe a medida sin fechas debería fallar')
  fallos++
} catch {
  console.log('  ✓ un informe a medida sin fechas falla en vez de inventarse el día')
}

console.log(
  fallos === 0
    ? '\n✓ Los periodos del worker van en hora de Madrid'
    : `\n✗ ${fallos} fallos`,
)
process.exit(fallos === 0 ? 0 : 1)
