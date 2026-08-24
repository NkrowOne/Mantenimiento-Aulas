/**
 * Qué averías se han cerrado en este dispositivo y todavía no han subido.
 *
 * Nació de un fallo que se ve desde la primera tarde de uso: **había que
 * resolver la misma incidencia dos veces**.
 *
 * El cierre viaja por la cola de salida, como todo lo que se produce en el
 * aula, así que durante unos segundos —o una mañana entera, sin cobertura— la
 * incidencia sigue abierta EN EL SERVIDOR. Y la pestaña de Incidencias lee del
 * servidor: al cerrar, se volvía a pedir la lista y la avería reaparecía
 * abierta, con su botón de «Resolver» intacto. Cualquiera vuelve a pulsarlo —la
 * pantalla está diciendo que no se ha hecho—, y lo que se consigue con eso es
 * un segundo asiento de cierre para la misma avería. El trabajo estaba bien
 * guardado desde el primer toque; lo que mentía era la lista.
 *
 * Así que la lista pregunta también a la cola, que es quien sabe la verdad
 * mientras el cierre está en camino. Vive aparte porque lo necesitan las dos
 * pantallas que cierran averías —la ficha del aula y la pestaña— y una regla de
 * este tipo escrita dos veces es dos reglas.
 */

import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type OutboxEntry } from '@/db/dexie'

/** Un conjunto vacío estable: sin él, cada render devolvería uno nuevo. */
const NINGUNO: ReadonlySet<string> = new Set<string>()

/**
 * De qué averías hablan los cierres que hay en la cola.
 *
 * Aparte y sin tocar Dexie para poder probarla con filas en la mano. La lee la
 * pantalla que decide si se ofrece «Resolver», así que si un día el contenido
 * de la entrada cambia de forma —y el `payload` es un saco sin tipo— lo que
 * pasa no es un error: es que el botón vuelve a ofrecerse y la avería se cierra
 * dos veces. Eso no se ve mirando; se ve porque esto falla.
 */
export function incidenciasConCierreEnCola(
  entradas: Array<Pick<OutboxEntry, 'entity' | 'payload'>>,
): ReadonlySet<string> {
  const ids = entradas
    .filter((e) => e.entity === 'incident_resolution')
    .map((e) => e.payload['incident_id'])
    .filter((id): id is string => typeof id === 'string' && id !== '')

  return ids.length === 0 ? NINGUNO : new Set(ids)
}

export function useCierresEnCola(): ReadonlySet<string> {
  const qc = useQueryClient()

  const enCola = useLiveQuery(
    async () =>
      incidenciasConCierreEnCola(
        await db.outbox.where('entity').equals('incident_resolution').toArray(),
      ),
    [],
    NINGUNO,
  )

  /*
   * Y cuando un cierre SALE de la cola es que acaba de subir: ahí es cuando hay
   * que volver a preguntarle al servidor, y no antes.
   *
   * Invalidar al pulsar era parte del mismo fallo: pedía la lista en el único
   * momento en que se sabía que el servidor todavía no estaba al día. Ahora se
   * pide cuando la respuesta ya puede ser distinta.
   */
  const antes = useRef<ReadonlySet<string>>(NINGUNO)
  useEffect(() => {
    const subioAlguno = [...antes.current].some((id) => !enCola.has(id))
    antes.current = enCola
    if (!subioAlguno) return

    for (const key of [
      ['incidents'],
      ['incidents-resueltas'],
      ['incidents-total'],
      // Sin prefijo de sala: las dos van por `[clave, roomId]` y esto alcanza a
      // la que esté montada, que es la de la sala que se tiene delante.
      ['room-timeline'],
      ['room-reliability'],
    ]) {
      void qc.invalidateQueries({ queryKey: key })
    }
  }, [enCola, qc])

  return enCola
}
