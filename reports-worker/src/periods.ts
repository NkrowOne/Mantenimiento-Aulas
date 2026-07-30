/**
 * Los periodos que cubre cada informe, en hora de Madrid.
 *
 * Vive aparte de `data.ts` a propósito. Son fechas puras: no tocan la base de
 * datos y no deben arrastrar `postgres` a quien solo quiera calcular un rango.
 * `scripts/worker-periodos.ts` los prueba desde la raíz del proyecto, donde esa
 * dependencia —declarada solo en `reports-worker/package.json`— no existe, y
 * bastaba el import para que `tsc -b` fallase con «Cannot find module
 * 'postgres'» en un clon limpio.
 */

/** La zona en la que trabaja el equipo. Los instantes se guardan en UTC. */
export const ZONA = 'Europe/Madrid'

export interface Periodo {
  start: string
  end: string
}

/**
 * La fecha del calendario **de Madrid**, no la de UTC.
 *
 * `toISOString()` devuelve la fecha UTC: en verano, a partir de las 22:00 hora
 * peninsular ya es el día siguiente en UTC, así que «ayer» se corría un día y
 * el informe diario cubría el día equivocado.
 *
 * El truco del formato `sv-SE` es que su fecha corta ya es `AAAA-MM-DD`, así
 * que no hay que recomponerla a mano a partir de las partes.
 */
export function fechaEnMadrid(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: ZONA, dateStyle: 'short' }).format(d)
}

/**
 * Aritmética de fechas sobre `AAAA-MM-DD`, ancladas al mediodía UTC.
 *
 * El mediodía no es superstición: sumar días sobre la medianoche local se
 * tropieza con los dos domingos del año que no tienen 24 horas, y el resultado
 * retrocede o se salta un día. A mediodía sobran doce horas de margen por cada
 * lado, así que el cambio de hora no llega a mover la fecha.
 */
function aInstante(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d, 12)
}

export function sumaDias(iso: string, n: number): string {
  return new Date(aInstante(iso) + n * 86_400_000).toISOString().slice(0, 10)
}

/** Días que cubre el rango, contando los dos extremos. */
export function diasDelPeriodo(p: Periodo): number {
  return Math.round((aInstante(p.end) - aInstante(p.start)) / 86_400_000) + 1
}

/** 1 = lunes … 7 = domingo. Como la semana ISO, no como `getDay()`. */
export function diaDeLaSemana(iso: string): number {
  const dow = new Date(aInstante(iso)).getUTCDay()
  return dow === 0 ? 7 : dow
}

/** Todas las fechas del rango, en orden. La serie diaria del informe sale de aquí. */
export function diasDe(p: Periodo): string[] {
  const dias: string[] = []
  for (let d = p.start; d <= p.end; d = sumaDias(d, 1)) dias.push(d)
  return dias
}

/**
 * Rango de fechas de cada tipo de informe.
 *
 * `personalizado` no tiene rango propio: sus fechas llegan en la petición. Si
 * llega aquí es que no llegaron, y devolver calladamente el día de ayer produce
 * un PDF con datos que nadie ha pedido y una etiqueta que dice otra cosa.
 */
export function periodFor(kind: string, today = new Date()): Periodo {
  if (kind === 'personalizado') {
    throw new Error('Un informe a medida necesita fecha de inicio y de fin')
  }

  const hoy = fechaEnMadrid(today)

  if (kind === 'semanal') return semanaLaboral(hoy)

  // El informe diario cubre la jornada anterior: emitido a las 07:00, hablar
  // de "hoy" sería hablar de una hora de actividad.
  const ayer = sumaDias(hoy, -1)
  return { start: ayer, end: ayer }
}

/**
 * La semana de trabajo que se está contando, de lunes a viernes.
 *
 * El informe automático sale **el viernes a las 07:00**, así que el caso normal
 * es el de abajo: lunes de esta semana → hoy, viernes. Los otros tres salen de
 * generarlo a mano, y cada uno tiene una respuesta y un motivo:
 *
 *   martes a viernes  lunes → hoy. Sale una semana incompleta, y está bien: es
 *                     lo que hay hasta ahora y el informe lo dice en el título.
 *                     Estirarlo hasta el viernes daría dos o tres días vacíos
 *                     que se leerían como «no se ha revisado nada».
 *   sábado y domingo  la semana que acaba de terminar, ya completa.
 *   lunes             la semana PASADA. Un semanal pedido un lunes por la
 *                     mañana no puede ser el de una jornada que aún no ha
 *                     empezado: quien lo pide quiere el cierre de la anterior.
 *
 * Para cualquier otro corte —quincenas, un mes, un trimestre— está el informe a
 * medida, que no tiene que adivinar nada porque las fechas llegan puestas.
 */
export function semanaLaboral(hoy: string): Periodo {
  const dow = diaDeLaSemana(hoy)
  const lunes = dow === 1 ? sumaDias(hoy, -7) : sumaDias(hoy, 1 - dow)
  const viernes = sumaDias(lunes, 4)
  return { start: lunes, end: hoy < viernes ? hoy : viernes }
}

/**
 * El periodo comparable anterior.
 *
 * Un número solo no dice nada: «18 revisiones» es bueno o es malo según lo que
 * hubiera antes. Lo que cuesta acertar es contra QUÉ.
 *
 * El caso general es el tramo de igual duración que termina justo antes, para
 * que un informe de nueve días se compare con nueve y no con siete. Pero hay dos
 * periodos que se piden constantemente y a los que esa regla les hace trampa:
 *
 *   SEMANA LABORAL   Los cinco días anteriores a un lunes son miércoles a
 *                    domingo, sábado y domingo incluidos. Comparar una semana
 *                    de trabajo con dos jornadas en las que el campus está
 *                    cerrado hace que cualquier semana parezca buenísima. Se
 *                    compara con la semana laboral anterior, día por día.
 *   MES COMPLETO     Los treinta días anteriores al 1 de junio empiezan el 2 de
 *                    mayo: se queda fuera el día 1 y el informe dice que mayo
 *                    tuvo una incidencia menos de las que tuvo. Se compara con
 *                    el mes de calendario anterior, entero.
 *
 * Cualquier otro rango —una quincena, un trimestre, tres días sueltos— va por la
 * regla general, que no engaña a nadie porque nadie espera otra cosa.
 */
export function periodoAnterior(p: Periodo): Periodo {
  const dias = diasDelPeriodo(p)

  if (dias <= 7 && diaDeLaSemana(p.start) === 1) {
    return { start: sumaDias(p.start, -7), end: sumaDias(p.end, -7) }
  }

  if (esMesCompleto(p)) {
    const { y, m } = partes(p.start)
    const inicio = new Date(Date.UTC(y, m - 2, 1, 12))
    const fin = new Date(Date.UTC(y, m - 1, 0, 12))
    return {
      start: inicio.toISOString().slice(0, 10),
      end: fin.toISOString().slice(0, 10),
    }
  }

  const end = sumaDias(p.start, -1)
  return { start: sumaDias(end, -(dias - 1)), end }
}

/** Del día 1 al último, sea de 28, 29, 30 o 31. */
function esMesCompleto(p: Periodo): boolean {
  const a = partes(p.start)
  const b = partes(p.end)
  if (a.d !== 1 || a.y !== b.y || a.m !== b.m) return false
  const ultimo = new Date(Date.UTC(a.y, a.m, 0, 12)).getUTCDate()
  return b.d === ultimo
}

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo']

function partes(iso: string): { d: number; m: number; y: number } {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return { d, m, y }
}

/**
 * El periodo escrito como lo escribiría una persona.
 *
 * «2026-07-27 — 2026-07-31» es lo que devuelve la base de datos, no lo que se
 * pone en la portada de un documento que alguien va a archivar y citar. Se
 * omite lo que se repite: el mes cuando es el mismo, el año cuando es el mismo.
 */
export function nombrePeriodo(p: Periodo): string {
  const a = partes(p.start)
  const b = partes(p.end)

  if (p.start === p.end) {
    return `${DIAS[diaDeLaSemana(p.start) - 1]} ${a.d} de ${MESES[a.m - 1]} de ${a.y}`
  }
  if (a.y !== b.y) {
    return `del ${a.d} de ${MESES[a.m - 1]} de ${a.y} al ${b.d} de ${MESES[b.m - 1]} de ${b.y}`
  }
  if (a.m !== b.m) {
    return `del ${a.d} de ${MESES[a.m - 1]} al ${b.d} de ${MESES[b.m - 1]} de ${b.y}`
  }
  return `del ${a.d} al ${b.d} de ${MESES[a.m - 1]} de ${a.y}`
}

/** «miércoles 19 de noviembre», para la cabecera de una jornada del diario. */
export function nombreDia(iso: string): string {
  const { d, m } = partes(iso)
  return `${DIAS[diaDeLaSemana(iso) - 1]} ${d} de ${MESES[m - 1]}`
}

/** `L 27`, `M 28`… para el eje del gráfico diario, que no cabe más. */
export function etiquetaDia(iso: string): string {
  const inicial = ['L', 'M', 'X', 'J', 'V', 'S', 'D'][diaDeLaSemana(iso) - 1]
  return `${inicial} ${partes(iso).d}`
}

/**
 * Cómo se titula el tramo comparado, para el pie de los indicadores.
 * «frente a la semana anterior» se entiende; «frente a 2026-07-20/2026-07-24», no.
 */
export function nombreComparacion(p: Periodo): string {
  const dias = diasDelPeriodo(p)
  if (dias === 1) return 'el día anterior'
  if (dias === 7) return 'la semana anterior'
  if (dias >= 5 && dias <= 6) return 'la semana anterior'
  if (dias >= 28 && dias <= 31) return 'el mes anterior'
  return `los ${dias} días anteriores`
}
