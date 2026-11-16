/**
 * El parte del día: lo que se ha abierto hoy y lo que se ha cerrado hoy.
 *
 * Al acabar la jornada alguien se sienta delante de EasyVista y pasa lo del
 * día: da de alta lo que se abrió y cierra lo que se arregló. Con la lista
 * normal eso era ir fila a fila buscando fechas —la lista ordena por apertura
 * y esconde las resueltas—, y lo que se cerró hoy pero se abrió el martes no
 * salía por ningún lado.
 *
 * Aquí vive qué entra en el parte y qué texto se lleva a EasyVista. Sin React
 * y sin red, para poder probarlo con filas en la mano: la regla «creada hoy o
 * cerrada hoy» tiene dos bordes —la medianoche de Madrid y el cierre que aún
 * no ha subido— y los dos se rompen sin que nada lo diga.
 */

import { fechaCorta, horaCorta, inicioDelDia } from './fechas'
import type { IncidentKind, IncidentState } from './types'

/** Lo que el parte necesita de una incidencia, venga del servidor o del espejo. */
export interface IncidenciaDelParte {
  id: string
  title: string | null
  description: string | null
  severity: string
  state: IncidentState
  kind: IncidentKind
  opened_at: string
  opened_by: string | null
  resolved_at: string | null
  resolved_by: string | null
  resolution: string | null
  external_ref: string | null
  easyvista_ref: string | null
  room_id: string | null
}

/** Una fila del parte: la incidencia y lo que le ha pasado ese día. */
export interface FilaDelParte extends IncidenciaDelParte {
  /** Se abrió ese día. */
  abiertaHoy: boolean
  /** Se cerró ese día. */
  cerradaHoy: boolean
  /** Algo de esto está todavía en la cola del dispositivo. */
  sinSubir: boolean
}

/** El cierre tal y como viaja en la cola de salida. */
export interface CierreEnCola {
  incident_id: string
  resolution: string
  resolved_at: string
  resolved_by: string | null
  easyvista_ref?: string | null
}

export interface Limites {
  /** Medianoche de Madrid de ese día, en ISO. Entra. */
  desde: string
  /** Medianoche de Madrid del siguiente. No entra. */
  hasta: string
}

/** El día de al lado, `n` días adelante o atrás, como `AAAA-MM-DD`. */
export function moverDia(dia: string, n: number): string {
  const [a, m, d] = dia.split('-').map(Number)
  // El calendario se mueve en UTC a propósito: aquí solo se suman días a una
  // fecha suelta, y así el cambio de hora no puede comerse ni repetir ninguno.
  return new Date(Date.UTC(a!, m! - 1, d! + n)).toISOString().slice(0, 10)
}

/** De qué instante a qué instante va un día de Madrid. */
export function limitesDelDia(dia: string): Limites {
  return {
    desde: inicioDelDia(dia).toISOString(),
    hasta: inicioDelDia(moverDia(dia, 1)).toISOString(),
  }
}

function dentro(iso: string | null, limites: Limites): boolean {
  if (!iso) return false
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return false
  return t >= new Date(limites.desde).getTime() && t < new Date(limites.hasta).getTime()
}

/**
 * Las filas del parte de un día.
 *
 * Tres fuentes, porque la verdad del día está repartida:
 *
 *  - `servidor`: lo que la base dice que se abrió o se cerró ese día.
 *  - `espejo`: las incidencias del dispositivo. Una abierta en un aula sin
 *    cobertura todavía no existe arriba, y es justo de hoy.
 *  - `cierres`: los cierres que esperan en la cola. Para el servidor esa
 *    avería sigue abierta; para quien la arregló, se cerró a las 11:40.
 *
 * Quedan fuera los borradores y las observaciones, igual que en la lista: ni
 * unos ni otras son un ticket.
 */
export function filasDelParte(entrada: {
  servidor: IncidenciaDelParte[]
  espejo: IncidenciaDelParte[]
  cierres: CierreEnCola[]
  /** Ids de incidencias cuya alta sigue en la cola. */
  altasEnCola: ReadonlySet<string>
  limites: Limites
}): FilaDelParte[] {
  const { servidor, espejo, cierres, altasEnCola, limites } = entrada

  const porId = new Map<string, IncidenciaDelParte>()
  const sinSubir = new Set<string>()

  for (const i of servidor) porId.set(i.id, i)

  const delEspejo = new Map(espejo.map((i) => [i.id, i]))
  for (const i of espejo) {
    if (porId.has(i.id)) continue
    if (!dentro(i.opened_at, limites)) continue
    porId.set(i.id, i)
    if (altasEnCola.has(i.id)) sinSubir.add(i.id)
  }

  for (const c of cierres) {
    if (!dentro(c.resolved_at, limites)) continue
    const base = porId.get(c.incident_id) ?? delEspejo.get(c.incident_id)
    if (!base) continue
    // Si el servidor ya la da por resuelta, el cierre ha subido y la cola solo
    // no se ha vaciado todavía: manda lo de arriba.
    if (base.state === 'resuelta') continue
    porId.set(c.incident_id, {
      ...base,
      state: 'resuelta',
      resolved_at: c.resolved_at,
      resolved_by: c.resolved_by,
      resolution: c.resolution,
      easyvista_ref: c.easyvista_ref ?? base.easyvista_ref,
    })
    sinSubir.add(c.incident_id)
  }

  const filas: FilaDelParte[] = []
  for (const i of porId.values()) {
    if (i.state === 'borrador' || i.kind === 'observacion') continue
    const abiertaHoy = dentro(i.opened_at, limites)
    const cerradaHoy = i.state === 'resuelta' && dentro(i.resolved_at, limites)
    if (!abiertaHoy && !cerradaHoy) continue
    filas.push({ ...i, abiertaHoy, cerradaHoy, sinSubir: sinSubir.has(i.id) })
  }

  // En el orden en que pasó el día: así se pasa a EasyVista de arriba abajo
  // sin saltar, y lo primero que se abrió es lo primero que se teclea.
  return filas.sort(
    (a, b) => momentoDe(a, limites) - momentoDe(b, limites) || a.id.localeCompare(b.id),
  )
}

/** Cuándo entró la fila en el día: al abrirse, o al cerrarse si venía de antes. */
function momentoDe(f: FilaDelParte, limites: Limites): number {
  const iso = f.abiertaHoy ? f.opened_at : (f.resolved_at ?? limites.desde)
  return new Date(iso).getTime()
}

export interface ResumenDelParte {
  abiertas: number
  cerradas: number
  /** Las que todavía no tienen código de EasyVista. */
  porPasar: number
}

export function resumenDelParte(filas: FilaDelParte[]): ResumenDelParte {
  return {
    abiertas: filas.filter((f) => f.abiertaHoy).length,
    cerradas: filas.filter((f) => f.cerradaHoy).length,
    porPasar: filas.filter((f) => !f.easyvista_ref).length,
  }
}

const ESTADO: Record<IncidentState, string> = {
  borrador: 'Borrador',
  abierta: 'Abierta',
  en_curso: 'En curso',
  resuelta: 'Resuelta',
}

/** Fecha y hora juntas, para leer: `16 nov 2026, 09:12`. */
export function cuando(iso: string): string {
  return `${fechaCorta(iso)}, ${horaCorta(iso)}`
}

/**
 * La incidencia en texto, lista para pegar en EasyVista.
 *
 * Una línea por dato y la etiqueta delante, sin adornos: se pega en un campo
 * de texto de otra aplicación, y lo que allí no se lee solo estorba. Las
 * líneas sin dato no salen —un «Solución:» vacío en una avería abierta parece
 * un fallo de quien lo pegó—.
 */
export function textoParaEasyVista(
  f: IncidenciaDelParte,
  quien: { sala: string | null; abrio: string | null; cerro: string | null },
): string {
  const lineas: string[] = []
  const titulo = (f.title ?? '').trim() || '(sin título)'
  lineas.push(quien.sala ? `${quien.sala} — ${titulo}` : titulo)
  lineas.push(`Estado: ${ESTADO[f.state]}`)
  lineas.push(`Abierta: ${cuando(f.opened_at)}${quien.abrio ? ` · ${quien.abrio}` : ''}`)
  const descripcion = (f.description ?? '').trim()
  if (descripcion) lineas.push(`Descripción: ${descripcion}`)
  if (f.state === 'resuelta' && f.resolved_at) {
    lineas.push(`Cerrada: ${cuando(f.resolved_at)}${quien.cerro ? ` · ${quien.cerro}` : ''}`)
  }
  const solucion = (f.resolution ?? '').trim()
  if (f.state === 'resuelta' && solucion) lineas.push(`Solución: ${solucion}`)
  if (f.external_ref) lineas.push(`Ref. Aulas: ${f.external_ref}`)
  return lineas.join('\n')
}
