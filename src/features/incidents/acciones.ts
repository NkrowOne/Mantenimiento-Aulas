/**
 * Empezar y cerrar una incidencia, desde donde se esté.
 *
 * Estaba escrito dentro de la pestaña de Incidencias y solo servía allí, que era
 * medio problema; el otro medio es que **iba directo contra el servidor**. Los
 * dos se notan en el mismo momento: el técnico —o el supervisor, que también
 * pisa aulas— acaba de cambiar el cable en el −2.1, y para cerrar el parte tiene
 * que salir del sótano, ir a otra pestaña, buscar la incidencia entre cuarenta y
 * pulsar un botón que sin cobertura no hace nada. Se cierra luego. «Luego» es la
 * palabra que llenó de partes viejos la lista de la que se venía huyendo.
 *
 * Así que esto vive aparte de cualquier pantalla y **pasa por la cola de
 * salida**: el cierre se guarda en el dispositivo, la sala deja de contar la
 * avería en el momento y la orden sube cuando haya red, como todo lo demás.
 *
 * Lo que NO cambia es quién puede: cerrar una incidencia sigue siendo cosa de un
 * supervisor, y lo decide el servidor. Aquí solo se procura que eso se sepa
 * antes de pulsar (`puedeCerrar`) en vez de después, y que si aun así el
 * servidor dice que no, la cola lo cuente con esas palabras.
 */

import { db, enqueueUpdate } from '@/db/dexie'
import { flush } from '@/sync/outbox'
import type { IncidentState, Role } from '@/domain/types'

/**
 * Los motivos de cierre que se ofrecen de un toque.
 *
 * `resolution` era una columna que la aplicación nunca rellenaba: el botón
 * «Resolver» mandaba el estado y nada más, así que el histórico de la sala
 * enseñaba «Resuelta: Proyector: no da imagen» sin decir qué se hizo — que es la
 * única parte útil para quien se encuentre el mismo aparato dentro de tres
 * meses.
 *
 * Van como teclas y no como un cuadro de texto en blanco porque se cierran de
 * pie: escribir una frase con una mano es exactamente la fricción que hace que
 * el campo se quede vacío. El detalle sigue estando a un toque para el caso en
 * que haga falta.
 */
export const MOTIVOS_DE_CIERRE: string[] = [
  'Reparado',
  'Pieza sustituida',
  'Ajuste o reinicio',
  'Ya funcionaba',
  'No procede',
]

/** Cerrar y empezar incidencias es de supervisor. Lo dice el servidor; esto lo repite. */
export function puedeCerrar(role: Role): boolean {
  return role === 'supervisor' || role === 'admin'
}

export interface AvanceDeIncidencia {
  id: string
  estado: Extract<IncidentState, 'en_curso' | 'resuelta'>
  /** Qué se hizo. Obligatoria al cerrar: es la mitad del valor del cierre. */
  resolucion?: string
  /** Quién lo hace, para firmar el cierre sin preguntárselo a la red. */
  userId: string | null
  /** Se inyecta para poder probar sin reloj. */
  ahora?: string
}

/**
 * Cambia el estado de una incidencia: en el espejo y en la cola.
 *
 * El espejo primero y a propósito: es lo que hace que la sala deje de contar la
 * avería y que la lista se redibuje sin esperar a nadie. La cola manda el
 * cambio en cuanto haya red y, si el servidor lo rechaza, lo dice con su motivo
 * en la pantalla de pendientes en vez de dejar al dispositivo creyéndose algo
 * que arriba no ha pasado.
 *
 * Se manda un **parche** y no la fila entera: dos personas que toquen la misma
 * incidencia no se pisan campos que ninguna de las dos ha cambiado.
 */
export async function avanzarIncidencia(entrada: AvanceDeIncidencia): Promise<void> {
  const ahora = entrada.ahora ?? new Date().toISOString()

  const parche: Record<string, unknown> =
    entrada.estado === 'resuelta'
      ? {
          state: 'resuelta',
          resolved_at: ahora,
          resolved_by: entrada.userId,
          resolution: entrada.resolucion?.trim() || null,
        }
      : { state: 'en_curso' }

  /*
   * El espejo solo guarda lo que no está resuelto, así que la fila puede no
   * estar —una incidencia vieja que se abre desde la búsqueda—. No es un error:
   * en ese caso el cambio viaja igual por la cola y llega igual.
   */
  if (await db.incidents.get(entrada.id)) {
    await db.incidents.update(entrada.id, parche)
  }

  // Mismo sufijo para los dos estados: pulsar «Empezar» y luego «Resolver» es
  // una sola orden con el estado final, no dos que compiten por la misma fila.
  await enqueueUpdate('incident', entrada.id, 'estado', parche)
  void flush()
}
