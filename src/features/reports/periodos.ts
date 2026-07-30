/**
 * Los periodos que se pueden pedir, y cómo se llaman en español.
 *
 * Gemelo de `reports-worker/src/periods.ts`, y a propósito: el worker calcula
 * los suyos porque el informe automático no pasa por aquí, y esta pantalla
 * calcula los mismos para poder ENSEÑAR qué va a cubrir el informe antes de
 * pedirlo. Un botón que dice «esta semana» y no dice qué días son eso obliga a
 * generar un PDF para averiguarlo.
 *
 * La regla que mantiene a los dos de acuerdo: las fechas se calculan aquí y se
 * MANDAN. El worker solo calcula por su cuenta cuando no le llega ninguna, que
 * es el caso del viernes a las 07:00.
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
