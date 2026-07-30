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

import {
  diasDelPeriodo,
  etiquetaDia,
  nombreComparacion,
  nombrePeriodo,
  periodFor,
  periodoAnterior,
} from '../reports-worker/src/periods.js'

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

/*
 * EL SEMANAL, que es el informe automático.
 *
 * Sale el viernes a las 07:00 y cubre la semana de trabajo entera, de lunes a
 * viernes. Lo que se comprueba aquí es cada día de la semana por separado,
 * porque la regla tiene una excepción —el lunes— y una excepción sin prueba se
 * pierde en la siguiente refactorización.
 */

// El caso normal: viernes a las 07:00 de Madrid (05:00 UTC en verano).
comprueba(
  'el viernes a las 07:00 cubre de lunes a viernes de esa semana',
  periodFor('semanal', new Date('2026-07-31T05:00:00Z')),
  { start: '2026-07-27', end: '2026-07-31' },
)

// A mitad de semana sale lo que hay hasta hoy. Estirarlo al viernes añadiría
// dos jornadas vacías que se leerían como «no se ha revisado nada».
comprueba(
  'un miércoles cubre de lunes a ese miércoles',
  periodFor('semanal', new Date('2026-07-29T10:00:00Z')),
  { start: '2026-07-27', end: '2026-07-29' },
)

// LA EXCEPCIÓN. Un semanal pedido un lunes por la mañana no puede ser el de una
// jornada que aún no ha empezado: quien lo pide quiere el cierre de la anterior.
comprueba(
  'el lunes se entiende como la semana pasada, no como el propio lunes',
  periodFor('semanal', new Date('2026-07-27T09:00:00Z')),
  { start: '2026-07-20', end: '2026-07-24' },
)

comprueba(
  'el sábado cubre la semana que acaba de terminar',
  periodFor('semanal', new Date('2026-08-01T09:00:00Z')),
  { start: '2026-07-27', end: '2026-07-31' },
)

comprueba(
  'y el domingo, la misma',
  periodFor('semanal', new Date('2026-08-02T09:00:00Z')),
  { start: '2026-07-27', end: '2026-07-31' },
)

// La semana del cambio de hora de marzo tiene un día de 23 horas. Sumando
// milisegundos sobre la medianoche, un día se habría quedado corto y la fecha
// habría retrocedido uno de menos.
comprueba(
  'la semana del cambio de hora sigue empezando en lunes',
  periodFor('semanal', new Date('2026-03-27T06:00:00Z')),
  { start: '2026-03-23', end: '2026-03-27' },
)

/*
 * CONTRA QUÉ SE COMPARA. Es donde es fácil hacerse trampas sin querer.
 *
 * Una semana laboral contra la semana laboral anterior. Los cinco días
 * anteriores a un lunes serían de miércoles a domingo: comparar una semana de
 * trabajo con dos jornadas de campus cerrado hace que cualquier semana parezca
 * buenísima, y el informe lo diría con toda su cara.
 */
comprueba(
  'una semana laboral se compara con la semana laboral anterior',
  periodoAnterior({ start: '2026-07-27', end: '2026-07-31' }),
  { start: '2026-07-20', end: '2026-07-24' },
)

comprueba(
  'con un solo día, es el día anterior',
  periodoAnterior({ start: '2026-07-31', end: '2026-07-31' }),
  { start: '2026-07-30', end: '2026-07-30' },
)

// Un mes completo, con el mes completo anterior: los treinta días anteriores al
// 1 de junio empiezan el 2 de mayo y dejarían el día 1 fuera de la cuenta.
comprueba(
  'un mes completo se compara con el mes anterior entero',
  periodoAnterior({ start: '2026-06-01', end: '2026-06-30' }),
  { start: '2026-05-01', end: '2026-05-31' },
)

comprueba(
  'y febrero con enero, sin desviarse por los días que faltan',
  periodoAnterior({ start: '2026-02-01', end: '2026-02-28' }),
  { start: '2026-01-01', end: '2026-01-31' },
)

// Cualquier otro rango va por la regla general: misma duración, justo antes.
comprueba(
  'un rango cualquiera se compara con el tramo de al lado',
  periodoAnterior({ start: '2026-07-08', end: '2026-07-16' }),
  { start: '2026-06-29', end: '2026-07-07' },
)

comprueba('un mes de marzo tiene 31 días', diasDelPeriodo({ start: '2026-03-01', end: '2026-03-31' }), 31)

/*
 * Y cómo se escribe, que es lo que va en la portada de un documento que alguien
 * va a archivar. «2026-07-27 — 2026-07-31» es lo que devuelve la base de datos,
 * no lo que se pone en un informe.
 */
comprueba(
  'el periodo se escribe sin repetir el mes',
  nombrePeriodo({ start: '2026-07-27', end: '2026-07-31' }),
  'del 27 al 31 de julio de 2026',
)
comprueba(
  'a caballo entre dos meses, el mes se dice dos veces',
  nombrePeriodo({ start: '2026-06-29', end: '2026-07-03' }),
  'del 29 de junio al 3 de julio de 2026',
)
comprueba(
  'y entre dos años, también el año',
  nombrePeriodo({ start: '2025-12-29', end: '2026-01-02' }),
  'del 29 de diciembre de 2025 al 2 de enero de 2026',
)
comprueba(
  'un solo día lleva su día de la semana',
  nombrePeriodo({ start: '2026-07-30', end: '2026-07-30' }),
  'jueves 30 de julio de 2026',
)
comprueba('el eje del gráfico usa la inicial del día', etiquetaDia('2026-07-29'), 'X 29')
comprueba(
  'la comparación se nombra en palabras',
  nombreComparacion({ start: '2026-07-27', end: '2026-07-31' }),
  'la semana anterior',
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
