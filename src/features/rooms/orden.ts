/**
 * Orden y búsqueda de salas, en un solo sitio.
 *
 * Vive aparte porque lo usan tres pantallas que **tienen que coincidir**: la
 * lista de salas, la búsqueda global y el salto a «la siguiente sala» al
 * terminar una revisión. Si cada una ordenara por su cuenta, «la siguiente»
 * sería una sala distinta de la que el técnico ve primera en la lista, que es
 * la peor clase de fallo: el que solo se nota cuando ya te has equivocado de
 * aula.
 */

import { norm } from '@/domain/normalize'
import type { Room, Zone } from '@/domain/types'

/**
 * Los dos órdenes que pide el trabajo real, y por qué hacen falta los dos.
 *
 * - `antiguedad` — la que lleva más tiempo sin revisar arriba. Convierte la
 *   lista en una cola de trabajo: bajas y vas haciendo, sin decidir nada.
 * - `planta` — agrupada por planta y por código. Es como se recorre un edificio
 *   de verdad. Con el orden por antigüedad puro, dos salas consecutivas pueden
 *   estar en la planta −2 y en la 2ª, y la ronda se convierte en subir y bajar
 *   escaleras.
 *
 * Ninguno es «el correcto»: el primero sirve para la ronda periódica y el
 * segundo para vaciar un edificio. Por eso se elige, y se ve cuál está activo.
 */
export type RoomOrder = 'antiguedad' | 'planta'

export const ROOM_ORDER_LABELS: Record<RoomOrder, string> = {
  antiguedad: 'Más antiguas',
  planta: 'Por planta',
}

/** Días desde la última revisión. `null` si no consta ninguna. */
export function daysSince(iso: string | null): number | null {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
}

/**
 * Compara códigos de sala como los lee una persona.
 *
 * `localeCompare` con `numeric` es lo que hace que `0.2` vaya antes que `0.10`
 * en vez de después, y que `−2.1` no acabe en medio de la primera planta.
 */
function byCode(a: Room, b: Room): number {
  return a.code.localeCompare(b.code, 'es', { numeric: true, sensitivity: 'base' })
}

export function sortRooms(rooms: Room[], zones: Map<string, Zone>, order: RoomOrder): Room[] {
  const copy = [...rooms]

  if (order === 'planta') {
    return copy.sort((a, b) => {
      const za = zones.get(a.zone_id)
      const zb = zones.get(b.zone_id)
      return (za?.sort_order ?? 0) - (zb?.sort_order ?? 0) || byCode(a, b)
    })
  }

  return copy.sort((a, b) => {
    // Sin revisar nunca va primero: es el vacío más caro de la lista.
    if (!a.last_inspection_at && b.last_inspection_at) return -1
    if (a.last_inspection_at && !b.last_inspection_at) return 1
    if (!a.last_inspection_at && !b.last_inspection_at) return byCode(a, b)
    return a.last_inspection_at!.localeCompare(b.last_inspection_at!) || byCode(a, b)
  })
}

/**
 * ¿Coincide la sala con lo que se ha tecleado?
 *
 * Busca en el código y en el nombre, normalizando los dos lados: quien escribe
 * `criminologia` sin tilde tiene que encontrar el «Lab Criminología», y quien
 * escribe `2.1` no debe tener que acordarse de si lleva guion delante.
 */
export function roomMatches(room: Room, query: string, zoneName?: string): boolean {
  const q = norm(query)
  if (!q) return true

  return (
    norm(room.code).includes(q) ||
    norm(room.name).includes(q) ||
    norm(zoneName ?? '').includes(q) ||
    // `-2.1` tecleado sin el guion, que es como se dice en voz alta.
    norm(room.code).replace(/^-/, '').includes(q)
  )
}

/**
 * La sala que toca después de terminar una.
 *
 * Se calcula con el mismo orden que ve el técnico en la lista, y se excluye la
 * que acaba de cerrar. Esto **depende** de que `complete()` haya escrito ya
 * `last_inspection_at` en local: sin eso la recién terminada seguiría siendo la
 * primera y «siguiente sala» devolvería a la misma aula.
 */
export function nextRoom(
  rooms: Room[],
  zones: Map<string, Zone>,
  order: RoomOrder,
  currentId: string,
): Room | null {
  return sortRooms(rooms, zones, order).find((r) => r.id !== currentId) ?? null
}
