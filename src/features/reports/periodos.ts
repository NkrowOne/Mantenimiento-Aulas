/**
 * Los periodos que se pueden pedir, y cómo se llaman en español.
 *
 * Aquí se calculan las fechas **una vez** y se usan para todo: para ENSEÑAR qué
 * va a cubrir el informe antes de pedirlo —un botón que dice «esta semana» y no
 * dice qué días son eso obliga a generar el informe para averiguarlo— y para
 * consultarlas al armarlo. Mientras había un worker esto era el gemelo de
 * `reports-worker/src/periods.ts` y los dos tenían que coincidir; ahora hay un
 * solo cálculo, que es la forma barata de que no se separen.
 *
 * El fichero sigue sin tocar la red ni la base: son fechas puras, y por eso se
 * pueden comprobar enteras en `peticion.test.ts` sin montar nada.
 */

import { ZONA } from '@/domain/fechas'

export interface Rango {
  start: string
  end: string
}

export type Kind = 'diario' | 'semanal' | 'personalizado'

export interface Preset {
  id: string
  etiqueta: string
  kind: Kind
  rango: (hoy: string) => Rango
}

/** La fecha de Madrid, como `AAAA-MM-DD`. */
export function hoyEnMadrid(instante = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: ZONA, dateStyle: 'short' }).format(instante)
}

/*
 * Aritmética sobre `AAAA-MM-DD` anclada al mediodía UTC. El mediodía no es
 * superstición: sumar días sobre la medianoche local se tropieza con los dos
 * domingos del año que no tienen 24 horas y el resultado retrocede o se salta un
 * día. A mediodía sobran doce horas por cada lado.
 */
function aInstante(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d, 12)
}

export function sumaDias(iso: string, n: number): string {
  return new Date(aInstante(iso) + n * 86_400_000).toISOString().slice(0, 10)
}

/** 1 = lunes … 7 = domingo, como la semana ISO. */
export function diaDeLaSemana(iso: string): number {
  const dow = new Date(aInstante(iso)).getUTCDay()
  return dow === 0 ? 7 : dow
}

/**
 * La semana de trabajo, de lunes a viernes, cortada en «hoy».
 *
 * Mismo criterio que el worker, incluida la excepción del lunes: un semanal
 * pedido un lunes por la mañana es el cierre de la semana anterior, no el de una
 * jornada que aún no ha empezado.
 */
export function semanaLaboral(hoy: string): Rango {
  const dow = diaDeLaSemana(hoy)
  const lunes = dow === 1 ? sumaDias(hoy, -7) : sumaDias(hoy, 1 - dow)
  const viernes = sumaDias(lunes, 4)
  return { start: lunes, end: hoy < viernes ? hoy : viernes }
}

function mes(iso: string, desplazamiento: number): Rango {
  const [y, m] = iso.split('-').map(Number) as [number, number]
  const inicio = new Date(Date.UTC(y, m - 1 + desplazamiento, 1, 12))
  const fin = new Date(Date.UTC(y, m + desplazamiento, 0, 12))
  return { start: inicio.toISOString().slice(0, 10), end: fin.toISOString().slice(0, 10) }
}

export const PRESETS: Preset[] = [
  {
    id: 'semana',
    etiqueta: 'Semana en curso',
    kind: 'semanal',
    rango: (hoy) => semanaLaboral(hoy),
  },
  {
    id: 'semana-pasada',
    etiqueta: 'Semana pasada',
    kind: 'semanal',
    rango: (hoy) => semanaLaboral(sumaDias(hoy, -7)),
  },
  {
    id: 'mes',
    etiqueta: 'Mes en curso',
    kind: 'personalizado',
    // Hasta hoy y no hasta fin de mes: los días que aún no han pasado saldrían
    // en el gráfico diario como jornadas sin actividad.
    rango: (hoy) => ({ start: mes(hoy, 0).start, end: hoy }),
  },
  {
    id: 'mes-pasado',
    etiqueta: 'Mes pasado',
    kind: 'personalizado',
    rango: (hoy) => mes(hoy, -1),
  },
  {
    id: 'ayer',
    etiqueta: 'Ayer',
    kind: 'diario',
    rango: (hoy) => ({ start: sumaDias(hoy, -1), end: sumaDias(hoy, -1) }),
  },
]

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
 * El periodo escrito como lo escribiría una persona: «del 27 al 31 de julio».
 * Gemelo del `nombrePeriodo` del worker, para que la pantalla y la portada del
 * PDF digan lo mismo con las mismas palabras.
 */
export function nombrePeriodo(r: Rango): string {
  if (!r.start || !r.end) return ''
  const a = partes(r.start)
  const b = partes(r.end)

  if (r.start === r.end) {
    return `${DIAS[diaDeLaSemana(r.start) - 1]} ${a.d} de ${MESES[a.m - 1]} de ${a.y}`
  }
  if (a.y !== b.y) {
    return `del ${a.d} de ${MESES[a.m - 1]} de ${a.y} al ${b.d} de ${MESES[b.m - 1]} de ${b.y}`
  }
  if (a.m !== b.m) {
    return `del ${a.d} de ${MESES[a.m - 1]} al ${b.d} de ${MESES[b.m - 1]} de ${b.y}`
  }
  return `del ${a.d} al ${b.d} de ${MESES[a.m - 1]} de ${a.y}`
}

/** Días que cubre el rango, contando los dos extremos. */
export function diasDelRango(r: Rango): number {
  if (!r.start || !r.end) return 0
  return Math.round((aInstante(r.end) - aInstante(r.start)) / 86_400_000) + 1
}

/** Todas las fechas del rango, en orden. La serie diaria del informe sale de aquí. */
export function diasDe(r: Rango): string[] {
  const lista: string[] = []
  if (!r.start || !r.end || r.end < r.start) return lista
  for (let d = r.start; d <= r.end; d = sumaDias(d, 1)) lista.push(d)
  return lista
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
export function periodoAnterior(r: Rango): Rango {
  const dias = diasDelRango(r)

  if (dias <= 7 && diaDeLaSemana(r.start) === 1) {
    return { start: sumaDias(r.start, -7), end: sumaDias(r.end, -7) }
  }

  if (esMesCompleto(r)) {
    const { y, m } = partes(r.start)
    const inicio = new Date(Date.UTC(y, m - 2, 1, 12))
    const fin = new Date(Date.UTC(y, m - 1, 0, 12))
    return {
      start: inicio.toISOString().slice(0, 10),
      end: fin.toISOString().slice(0, 10),
    }
  }

  const end = sumaDias(r.start, -1)
  return { start: sumaDias(end, -(dias - 1)), end }
}

/** Del día 1 al último, sea de 28, 29, 30 o 31. */
function esMesCompleto(r: Rango): boolean {
  const a = partes(r.start)
  const b = partes(r.end)
  if (a.d !== 1 || a.y !== b.y || a.m !== b.m) return false
  const ultimo = new Date(Date.UTC(a.y, a.m, 0, 12)).getUTCDate()
  return b.d === ultimo
}

/**
 * Cómo se titula el tramo comparado, para el pie de los indicadores.
 * «frente a la semana anterior» se entiende; «frente a 2026-07-20/2026-07-24», no.
 */
export function nombreComparacion(r: Rango): string {
  const dias = diasDelRango(r)
  if (dias === 1) return 'el día anterior'
  if (dias === 7) return 'la semana anterior'
  if (dias >= 5 && dias <= 6) return 'la semana anterior'
  if (dias >= 28 && dias <= 31) return 'el mes anterior'
  return `los ${dias} días anteriores`
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
