/**
 * Los cuatro verbos de una incidencia, desde donde se esté.
 *
 * Estaba escrito dentro de la pestaña de Incidencias y solo servía allí, que era
 * medio problema; el otro medio es que **iba directo contra el servidor**. Los
 * dos se notan en el mismo momento: el técnico acaba de cambiar el cable en el
 * −2.1, y para cerrar el parte tenía que salir del sótano, ir a otra pestaña,
 * buscar la incidencia entre cuarenta y pulsar un botón que sin cobertura no
 * hacía nada. Se cierra luego. «Luego» es la palabra que llenó de partes viejos
 * la lista de la que se venía huyendo.
 *
 * Y había un tercer medio, que era el de verdad: **el técnico no podía cerrar**.
 * Quien arregla el proyector es él; quien firmaba el cierre, un supervisor que
 * no había visto la reparación.
 *
 * Los verbos, y por qué son cuatro y no dos estados:
 *
 *  - **Coger** — la pone en curso Y a tu nombre. Antes «en curso» decía que
 *    alguien la había empezado sin decir quién, que con varios técnicos es dos
 *    personas subiendo al mismo aula el mismo día.
 *  - **Cerrar** — exige escribir qué se ha hecho. Ese texto es lo que sustituye
 *    a la firma del supervisor.
 *  - **Soltar** — deshacer lo tuyo: vuelve a la cola de todos, sin dueño.
 *  - **Reabrir** — revisar la decisión de otro. Es de supervisor, pide motivo, y
 *    lo que se cerró no desaparece: baja a la descripción.
 *
 * Todo pasa por la cola de salida y por una sola función del servidor
 * (`avanzar_incidencia`), que es la única puerta por la que el personal puede
 * tocar una incidencia: la tabla sigue cerrada a UPDATE para quien no sea
 * supervisor.
 */

import { db, enqueueRpc } from '@/db/dexie'
import { flush } from '@/sync/outbox'
import type { Incident, IncidentKind, Role } from '@/domain/types'

/**
 * Los motivos de cierre que se ofrecen de un toque, según qué se cierra.
 *
 * No sustituyen a la descripción, la encabezan: se pulsa el motivo —que además
 * clasifica— y se escribe al lado lo que se ha hecho de verdad. El campo en
 * blanco y una mano libre es un campo que se queda vacío; el motivo solo, un
 * cierre que no explica nada.
 *
 * Y cambian con el tipo, porque «Pieza sustituida» aplicado a «instalar una
 * cámara» no significa nada: una solicitud no se repara, se hace o no procede.
 */
export const MOTIVOS_DE_CIERRE: Record<IncidentKind, string[]> = {
  incidencia: ['Reparado', 'Pieza sustituida', 'Ajuste o reinicio', 'Ya funcionaba', 'No procede'],
  solicitud: ['Instalado', 'Hecho', 'No procede'],
  // Ya no se crean, pero hay cientos importadas del Excel y alguna se cerrará.
  observacion: ['Hecho', 'No procede'],
}

/**
 * Los motivos que además preguntan CUÁL, y abren el almacén.
 *
 * Era la costura que faltaba: se cerraba «Pieza sustituida» sin decir qué pieza
 * y sin descontar nada, porque el apunte de material vivía detrás de otro botón.
 * Son las dos mitades del mismo gesto.
 */
export const MOTIVOS_CON_MATERIAL = new Set(['Pieza sustituida', 'Instalado'])

/**
 * Lo mínimo que se acepta como «qué has hecho».
 *
 * Tres caracteres no son una descripción y no pretenden serlo: son el suelo que
 * impide cerrar con un punto o con una equis. Lo mismo que comprueba el servidor
 * en `avanzar_incidencia`, y aquí para no gastar un viaje a la red en decir que
 * no — sobre todo cuando ese viaje puede tardar horas en salir del sótano.
 */
export const RESOLUCION_MIN = 3

/** ¿Sirve esto como descripción de lo que se ha hecho, o como motivo de reapertura? */
export function resolucionSuficiente(texto: string): boolean {
  return texto.trim().length >= RESOLUCION_MIN
}

/** Reabrir es revisar la decisión de otro, y eso sigue siendo de supervisor. */
export function puedeReabrir(role: Role): boolean {
  return role === 'supervisor' || role === 'admin'
}

/**
 * Añade a lo escrito la pieza que se acaba de sacar del almacén.
 *
 * El nombre del artículo es la mejor descripción posible de «qué has hecho»
 * —«Lámpara Epson ELPLP96» dice bastante más que «cambiada la lámpara»— así que
 * se escribe en el campo en vez de quedarse solo en el movimiento de almacén.
 * Y se AÑADE, no se sustituye: en una avería se cambian dos cosas más veces de
 * las que parece, y lo que el técnico haya escrito a mano es suyo.
 */
export function conLaPieza(texto: string, nombre: string, qty: number): string {
  const linea = qty > 1 ? `${nombre} ×${qty}` : nombre
  const base = texto.trim()
  return base ? `${base} · ${linea}` : linea
}

export type AccionDeIncidencia = 'coger' | 'cerrar' | 'soltar' | 'reabrir'

/** A qué estado lleva cada verbo. La función del servidor habla de estados. */
const ESTADO_DE: Record<AccionDeIncidencia, 'abierta' | 'en_curso' | 'resuelta'> = {
  coger: 'en_curso',
  cerrar: 'resuelta',
  soltar: 'abierta',
  reabrir: 'abierta',
}

/** Los dos verbos que exigen texto, y con qué palabras se pide. */
const EXIGE_TEXTO: Partial<Record<AccionDeIncidencia, string>> = {
  cerrar: 'Para cerrar una incidencia hay que escribir qué se ha hecho.',
  reabrir: 'Para reabrir una incidencia hay que decir por qué.',
}

export interface AvanceDeIncidencia {
  id: string
  accion: AccionDeIncidencia
  /** Qué se ha hecho (al cerrar) o por qué se vuelve a ella (al reabrir). */
  texto?: string
  /** Quién lo hace, para firmar sin preguntárselo a la red. */
  userId: string | null
  /**
   * La fila entera, si quien llama la tiene.
   *
   * Solo hace falta al reabrir: una incidencia cerrada no está en el espejo
   * —solo guarda lo que sigue vivo—, así que sin ella la pantalla no tendría de
   * dónde sacar la fila que acaba de volver a la cola y seguiría enseñándola
   * cerrada hasta la siguiente descarga.
   */
  fila?: Incident
  /** Se inyecta para poder probar sin reloj. */
  ahora?: string
}

/**
 * Mueve una incidencia: en el espejo y en la cola.
 *
 * El espejo primero y a propósito: es lo que hace que la sala deje de contar la
 * avería y que la lista se redibuje sin esperar a nadie. La cola llama después a
 * `avanzar_incidencia`, que vuelve a comprobarlo todo con los permisos de
 * verdad. Si el servidor lo rechaza, lo dice con su motivo en la pantalla de
 * pendientes en vez de dejar al dispositivo creyéndose algo que arriba no ha
 * pasado.
 */
export async function avanzarIncidencia(entrada: AvanceDeIncidencia): Promise<void> {
  const ahora = entrada.ahora ?? new Date().toISOString()
  const texto = entrada.texto?.trim() ?? ''

  const exige = EXIGE_TEXTO[entrada.accion]
  if (exige && !resolucionSuficiente(texto)) throw new Error(exige)

  const parche: Partial<Incident> =
    entrada.accion === 'cerrar'
      ? {
          state: 'resuelta',
          resolved_at: ahora,
          resolved_by: entrada.userId,
          resolution: texto,
        }
      : entrada.accion === 'coger'
        ? { state: 'en_curso', assigned_to: entrada.userId, assigned_at: ahora }
        : entrada.accion === 'soltar'
          ? { state: 'abierta', assigned_to: null, assigned_at: null }
          : {
              /*
               * Reabrir deja la fila como estaba antes de cerrarse. La línea que
               * cuenta qué se había hecho y por qué se vuelve a ella la escribe
               * el servidor en la descripción: aquí se escribiría con otro reloj
               * y otro formato, y la siguiente descarga la pisaría con la suya.
               */
              state: 'abierta',
              resolution: null,
              resolved_at: null,
              resolved_by: null,
              assigned_to: null,
              assigned_at: null,
            }

  /*
   * El espejo solo guarda lo que no está resuelto, así que la fila puede no
   * estar. Reabriendo eso es lo normal —viene de la lista del servidor— y por
   * eso se acepta la fila entera: vuelve a estar viva, así que vuelve al espejo.
   */
  if (await db.incidents.get(entrada.id)) {
    await db.incidents.update(entrada.id, parche)
  } else if (entrada.fila) {
    await db.incidents.put({ ...entrada.fila, ...parche })
  }

  // Mismo sufijo para los cuatro: pulsar «La cojo yo» y luego «Resolver» es una
  // sola orden con el estado final, no dos que compiten por la misma fila.
  await enqueueRpc('incident', 'avanzar_incidencia', entrada.id, 'estado', {
    p_id: entrada.id,
    p_estado: ESTADO_DE[entrada.accion],
    p_resolucion: texto || null,
  })
  void flush()
}
