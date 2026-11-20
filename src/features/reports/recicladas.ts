/**
 * Las casillas y las instrucciones, para no volver a ponerlas cada vez.
 *
 * Quien pide el informe de la semana pide casi siempre EL MISMO informe: las
 * mismas secciones, para la misma audiencia, con las mismas instrucciones para
 * la IA —«este lo lee el vicerrector: que se note lo que se ha cerrado»—. La
 * pantalla arrancaba siempre de cero, así que cada lunes había que abrir las
 * opciones, desmarcar las tres de siempre y volver a escribir media página.
 *
 * Tres caminos, y los tres acaban en el mismo formulario:
 *
 *  1. LA ÚLTIMA VEZ, sola. Lo que se marcó al pedir el último informe se
 *     guarda en este dispositivo y la pantalla arranca con ello.
 *  2. LAS DE UN INFORME DEL ARCHIVO. Cada informe guarda cómo se hizo —es lo
 *     que hay en `reports.params`—, así que cualquier fila del archivo puede
 *     devolver sus casillas y sus instrucciones al formulario. Este viaja con
 *     la cuenta, no con el dispositivo: sirve igual en el iPad que en el
 *     ordenador.
 *  3. UNAS INSTRUCCIONES ANTERIORES, sueltas. Las últimas que se escribieron,
 *     sin repetir, a un toque de la caja.
 *
 * LO QUE NO SE RECUERDA SOLO es la nota de la portada. Se imprime tal cual en
 * la primera página de un documento que va al cliente, y con las opciones
 * plegadas no se ve: «Para la reunión del lunes 16» saldría en el informe del
 * 23 sin que nadie lo hubiera decidido. La nota vuelve solo cuando alguien la
 * pide, con «Repetir» sobre el informe que la llevaba. El periodo tampoco: el
 * mismo informe, casi por definición, es de otros días.
 *
 * Todo pasa por las casillas que EXISTEN HOY para esa audiencia: una sección
 * que se retiró, o que ya no se puede pedir para dirección, no vuelve por
 * haber estado marcada en marzo.
 */

import type { Audiencia } from './informe/opciones'
import { TOPE_ENFOQUE } from './informe/opciones'
import type { Eleccion } from './peticion'
import { porDefectoDe, seccionesDe } from './secciones'

/** Lo que se devuelve al formulario. */
export interface Reciclada {
  audiencia: Audiencia
  secciones: string[]
  comparar: boolean
  ia: boolean
  enfoque: string
  nota: string
}

const EN_ESTE_DISPOSITIVO = 'informes.ultima-eleccion'

/**
 * Lee unas opciones de donde vengan —el almacenamiento, una fila del archivo—
 * sin fiarse de nada, y las deja como las quiere el formulario.
 */
export function reciclar(bruto: unknown): Reciclada | null {
  if (typeof bruto !== 'object' || bruto === null) return null
  const p = bruto as Record<string, unknown>

  const audiencia: Audiencia = p['audiencia'] === 'equipo' ? 'equipo' : 'direccion'
  const ofrecidas = new Set(seccionesDe(audiencia).map((s) => s.clave))
  const marcadas = Array.isArray(p['secciones'])
    ? [...new Set(p['secciones'].filter((s): s is string => typeof s === 'string' && ofrecidas.has(s)))]
    : []

  return {
    audiencia,
    // Sin ninguna que siga existiendo, las de siempre: un formulario sin una
    // sola casilla marcada es un botón apagado y nadie sabe por qué.
    secciones: marcadas.length ? marcadas : porDefectoDe(audiencia),
    comparar: p['comparar'] !== false,
    // El archivo guarda dos cosas: si SALIÓ con IA (`ia`) y si se PIDIÓ
    // (`ia_pedida`). Lo que se recicla es lo que se pidió: un informe al que
    // la IA le falló aquel día no es un informe que se quisiera sin IA.
    ia: (typeof p['ia_pedida'] === 'boolean' ? p['ia_pedida'] : p['ia']) !== false,
    enfoque: typeof p['enfoque'] === 'string' ? p['enfoque'].slice(0, TOPE_ENFOQUE) : '',
    nota: typeof p['nota'] === 'string' ? p['nota'].slice(0, 300) : '',
  }
}

/** Lo de la última vez en este dispositivo, o `null` si no hay o no se puede leer. */
export function ultimaEleccion(): Reciclada | null {
  try {
    const guardado = localStorage.getItem(EN_ESTE_DISPOSITIVO)
    if (!guardado) return null
    const r = reciclar(JSON.parse(guardado))
    // La nota no se guarda, pero por si alguien la dejó ahí a mano.
    return r ? { ...r, nota: '' } : null
  } catch {
    // Modo privado, almacenamiento bloqueado o un JSON a medias: se arranca de
    // cero, que es lo que pasaba siempre.
    return null
  }
}

/** Guarda lo que se acaba de pedir, sin la nota y sin el periodo. */
export function recordarEleccion(e: Eleccion): void {
  try {
    localStorage.setItem(
      EN_ESTE_DISPOSITIVO,
      JSON.stringify({
        audiencia: e.audiencia,
        secciones: e.secciones,
        comparar: e.comparar,
        ia: e.ia,
        enfoque: e.enfoque.trim(),
      }),
    )
  } catch {
    // Sin almacenamiento no se recuerda. El informe sale igual.
  }
}

export function olvidarEleccion(): void {
  try {
    localStorage.removeItem(EN_ESTE_DISPOSITIVO)
  } catch {
    // Nada que olvidar.
  }
}

/** Una instrucción que ya se usó, y en qué informe. */
export interface InstruccionAnterior {
  texto: string
  /** El informe más reciente que la llevó: su periodo, para reconocerla. */
  periodo: { start: string; end: string }
  generado: string
}

/**
 * Las últimas instrucciones que se le dieron a la IA, sin repetir.
 *
 * Se comparan sin mirar mayúsculas ni espacios de más: la misma frase pegada
 * dos lunes seguidos es una instrucción, no dos. Las filas llegan ya ordenadas
 * de la más reciente a la más antigua, y así salen.
 */
export function instruccionesAnteriores(
  filas: ReadonlyArray<{
    period_start: string
    period_end: string
    generated_at: string
    params: { enfoque?: unknown } | null
  }>,
  tope = 5,
): InstruccionAnterior[] {
  const vistas = new Set<string>()
  const out: InstruccionAnterior[] = []
  for (const f of filas) {
    const texto = typeof f.params?.enfoque === 'string' ? f.params.enfoque.trim() : ''
    if (!texto) continue
    const clave = texto.toLowerCase().replace(/\s+/g, ' ')
    if (vistas.has(clave)) continue
    vistas.add(clave)
    out.push({
      texto: texto.slice(0, TOPE_ENFOQUE),
      periodo: { start: f.period_start, end: f.period_end },
      generado: f.generated_at,
    })
    if (out.length >= tope) break
  }
  return out
}

/** ¿Es exactamente lo que saldría sin tocar nada? Para no ofrecer «empezar de cero» desde cero. */
export function esLaDeSiempre(r: Omit<Reciclada, 'nota'> & { nota?: string }): boolean {
  const defecto = porDefectoDe(r.audiencia)
  return (
    r.audiencia === 'direccion' &&
    r.comparar &&
    r.ia &&
    !r.enfoque.trim() &&
    !(r.nota ?? '').trim() &&
    r.secciones.length === defecto.length &&
    defecto.every((s) => r.secciones.includes(s))
  )
}
