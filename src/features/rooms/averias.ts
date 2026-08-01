import type { Incident } from '@/domain/types'

/**
 * Qué salas tienen averías vivas, para poder señalarlo en las listas.
 *
 * La regla es LA MISMA que aplica `room_overview.open_incidents` en el
 * servidor y que la pestaña de Incidencias: cuentan las incidencias y las
 * solicitudes que no están resueltas; no cuentan ni los borradores —lo que
 * alguien dejó a medio escribir no es todavía trabajo de nadie— ni las
 * observaciones, que son notas de seguimiento y no averías. Si esta regla y
 * la del servidor divergen, el triángulo de la lista y el recuento de la
 * ficha se contradicen en la misma pantalla.
 *
 * Vive aparte y sin tocar Dexie para poder probarla con filas en la mano.
 */

/** Lo único que la regla necesita leer de una incidencia. */
export type IncidenciaMinima = Pick<Incident, 'room_id' | 'state' | 'kind'>

export function esAveriaViva(i: IncidenciaMinima): boolean {
  return (
    i.room_id !== null &&
    i.state !== 'resuelta' &&
    i.state !== 'borrador' &&
    i.kind !== 'observacion'
  )
}

/** Cuántas averías vivas tiene cada sala. Las salas sanas no aparecen. */
export function averiasPorSala(incidencias: IncidenciaMinima[]): Map<string, number> {
  const acc = new Map<string, number>()
  for (const i of incidencias) {
    if (!esAveriaViva(i)) continue
    acc.set(i.room_id!, (acc.get(i.room_id!) ?? 0) + 1)
  }
  return acc
}

/**
 * Y por edificio, sumando las de sus salas.
 *
 * Recibe el mapa por sala ya hecho —no las incidencias— porque la lista de
 * edificios ya recorre salas y zonas para contar retrasos: así la suma se
 * apoya en lo que ya está en la mano y las dos cifras no pueden discrepar.
 */
export function averiasPorEdificio(
  porSala: Map<string, number>,
  rooms: Array<{ id: string; zone_id: string }>,
  edificioDeZona: Map<string, string>,
): Map<string, number> {
  const acc = new Map<string, number>()
  for (const r of rooms) {
    const n = porSala.get(r.id)
    if (!n) continue
    const edificio = edificioDeZona.get(r.zone_id)
    if (!edificio) continue
    acc.set(edificio, (acc.get(edificio) ?? 0) + n)
  }
  return acc
}
