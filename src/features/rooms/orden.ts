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
 * - `planta` — agrupada por planta y por código. Es como se recorre un edificio
 *   de verdad, y es **el orden de partida**: quien abre un edificio va a
 *   recorrerlo, y la lista tiene que parecerse al camino que van a hacer sus
 *   pies. Con el orden por antigüedad de partida, dos salas consecutivas podían
 *   estar en la planta −2 y en la 2ª, y la ronda empezaba subiendo y bajando
 *   escaleras sin que nadie hubiera pedido nada raro.
 * - `antiguedad` — la que lleva más tiempo sin revisar arriba. Convierte la
 *   lista en una cola de trabajo: bajas y vas haciendo, sin decidir nada. Es lo
 *   que hace falta el día que se persigue el retraso y no el edificio.
 *
 * Ninguno es «el correcto»: el primero sirve para vaciar un edificio y el
 * segundo para la ronda periódica. Por eso se elige, y se ve cuál está activo.
 *
 * El orden de las claves de aquí abajo NO es cosmético: es el que pinta el grupo
 * de botones de la lista (recorre `Object.keys`). El que manda por defecto tiene
 * que ser también el primero que se lee, o la pantalla contradice a la pantalla.
 */
export type RoomOrder = 'planta' | 'antiguedad'

export const ROOM_ORDER_LABELS: Record<RoomOrder, string> = {
  planta: 'Por planta',
  antiguedad: 'Más antiguas',
}

/** El orden con el que se abre un edificio mientras nadie diga lo contrario. */
export const ROOM_ORDER_POR_DEFECTO: RoomOrder = 'planta'

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
 * ¿Coincide esta sala con lo que se ha tecleado en el buscador del campus?
 *
 * El aviso llega siempre con el edificio delante: «falla el proyector del 1.12
 * del H». Y `roomMatches` solo miraba la sala —código, nombre, planta—, así que
 * teclear «h 1.12» no encontraba NADA: había que saber quitar el edificio de la
 * frase, buscar «1.12» y luego distinguir a ojo entre los seis 1.12 que hay en
 * el campus, uno por aulario.
 *
 * Aquí la búsqueda se parte en palabras y TODAS tienen que estar en algún sitio
 * de la sala: en su código, su nombre, su planta, o en el código o el nombre de
 * su edificio. «h 1.12», «1.12 h» y «crai sala 3» encuentran lo que dicen.
 *
 * El código del edificio se compara ENTERO y no como trozo: una «h» suelta
 * dentro de cualquier palabra —«hemeroteca», «laboratorio h»— haría que la letra
 * del edificio coincidiera con medio campus. El nombre sí admite trozos, que es
 * como se busca «biblio».
 */
export function salaCoincide(
  room: Room,
  query: string,
  zoneName: string | undefined,
  building: { code: string; name: string } | undefined,
): boolean {
  const palabras = norm(query).split(' ').filter(Boolean)
  if (palabras.length === 0) return true

  const codigoDeEdificio = norm(building?.code ?? '')
  const nombreDeEdificio = norm(building?.name ?? '')

  return palabras.every(
    (p) =>
      roomMatches(room, p, zoneName) || p === codigoDeEdificio || nombreDeEdificio.includes(p),
  )
}

/** Lo que cuenta como «ya revisada en esta ronda»: las últimas dieciocho horas,
    que cubren una jornada sin alcanzar a la de ayer. */
const REVISADA_HOY_MS = 18 * 3_600_000

/**
 * La sala que toca después de terminar una.
 *
 * Se calcula con el mismo orden que ve el técnico en la lista, pero **la
 * pregunta no se contesta igual en los dos**, y eso no es un detalle: es lo que
 * hace que «Guardar y siguiente sala» encadene o dé vueltas.
 *
 * - `antiguedad` es una cola que se reordena sola. `complete()` escribe
 *   `last_inspection_at` en local antes de llegar aquí, así que la recién
 *   cerrada cae al final y la primera del resto es la que toca. Depender de eso
 *   es lo que ya estaba escrito y sigue siendo cierto.
 * - `planta` es una ruta física y no se mueve al revisar. Ahí «la primera que no
 *   sea esta» devuelve siempre al aula de la esquina de la planta: terminar la
 *   primera llevaba a la segunda, terminar la segunda volvía a la primera, y
 *   encadenar era un bucle entre dos aulas. La siguiente de una ruta es la de al
 *   lado, no la de la cabeza.
 *
 * Se hizo visible al pasar `planta` a ser el orden de partida, pero el fallo ya
 * estaba: bastaba con elegir «Por planta» a mano.
 */
export function nextRoom(
  rooms: Room[],
  zones: Map<string, Zone>,
  order: RoomOrder,
  currentId: string,
): Room | null {
  const ordenadas = sortRooms(rooms, zones, order)

  if (order === 'planta') {
    const i = ordenadas.findIndex((r) => r.id === currentId)
    // Si la sala que se acaba de cerrar ya no está en la lista —la ha archivado
    // otro dispositivo mientras se revisaba— no hay posición desde la que
    // seguir, y se cae al comportamiento de la cola: mejor una sala razonable
    // que ninguna.
    if (i === -1) return ordenadas.find((r) => r.id !== currentId) ?? null
    // Y al llegar al final del edificio se acaba. Volver a empezar por arriba
    // haría revisar dos veces las mismas aulas sin que nada lo dijera; `null`
    // devuelve a la lista, que es donde se ve que el edificio está hecho.
    /*
     * …y la siguiente es la siguiente de la ruta que NO se haya revisado ya hoy.
     *
     * Por planta el orden no se mueve al revisar, así que «la siguiente» era
     * la siguiente a secas: quien había hecho la 0.4 antes que la 0.3 —porque
     * la 0.3 estaba ocupada y volvió luego— cerraba la 0.3 y aterrizaba en la
     * 0.4, recién hecha, a darle a «Volver» y buscar la 0.5 a mano. Las de
     * hoy se saltan; las demás no, aunque vayan al día: quien encadena por
     * planta está recorriendo el edificio entero, y eso lo decide él.
     */
    const hoy = Date.now() - REVISADA_HOY_MS
    return (
      ordenadas
        .slice(i + 1)
        .find((r) => !r.last_inspection_at || new Date(r.last_inspection_at).getTime() < hoy) ??
      null
    )
  }

  return ordenadas.find((r) => r.id !== currentId) ?? null
}
