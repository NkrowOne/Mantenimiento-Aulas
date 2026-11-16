import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { displayRoomCode, norm } from '@/domain/normalize'
import type { Building, Room } from '@/domain/types'
import { daysSince, salaCoincide } from './orden'

/**
 * Buscar un aula entre las 276, desde la pantalla de arranque.
 *
 * El caso que lo justifica no es explorar, es responder: por radio llega «falla
 * el proyector del −2.1 del H». Sin esto hay que acordarse de en qué edificio
 * cae esa sala, abrirlo y bajar leyendo. Con esto son dos toques desde que se
 * abre la aplicación.
 *
 * Vive sobre la lista de edificios y no la sustituye: cuando no se busca nada,
 * no ocupa sitio ni cambia el flujo de siempre.
 */

interface Props {
  /**
   * Qué hacer con la sala elegida.
   *
   * El destino lo decide `App` y no este componente, a propósito: hoy es la
   * ficha de la sala, el mismo sitio al que llevan la fila de la lista y el QR
   * de la puerta, y esa regla tiene que vivir en un solo sitio para que las
   * tres entradas no acaben en tres pantallas distintas.
   */
  onPick: (building: Building, room: Room) => void
  /**
   * Lo tecleado. Lo guarda quien monta la pantalla de inicio, por lo mismo que
   * el de la lista de salas: esto se desmonta al abrir una ficha, y el aviso
   * por radio rara vez es de un aula sola —«falla el −2.1 del H… y el −2.2»—.
   * Al volver, la búsqueda sigue ahí con sus resultados.
   */
  query: string
  onQueryChange: (query: string) => void
}

export function BuscadorGlobal({
  onPick,
  query,
  onQueryChange: setQuery,
}: Props): React.ReactElement {

  const indice = useLiveQuery(async () => {
    const [rooms, zones, buildings] = await Promise.all([
      db.rooms.toArray(),
      db.zones.toArray(),
      db.buildings.toArray(),
    ])
    const zoneById = new Map(zones.map((z) => [z.id, z]))
    const buildingById = new Map(buildings.map((b) => [b.id, b]))

    return rooms.map((room) => {
      const zone = zoneById.get(room.zone_id)
      return {
        room,
        zone: zone?.name ?? '',
        building: zone ? buildingById.get(zone.building_id) : undefined,
      }
    })
  }, [])

  const resultados = useMemo(() => {
    if (!query.trim() || !indice) return []
    const q = norm(query)
    return (
      indice
        // Con el edificio en la búsqueda: «h 1.12» es como llega el aviso.
        .filter((e) => e.building && salaCoincide(e.room, query, e.zone, e.building))
        /*
         * La que se llama EXACTAMENTE así, primero. Buscando «1.1» salían antes
         * la 1.10, la 1.11 y la 1.12 de otro edificio —todas contienen «1.1»—
         * y la 1.1 de verdad quedaba en cualquier puesto, o fuera de los diez.
         * El orden entre las demás no se toca.
         */
        .sort(
          (a, b) =>
            Number(norm(b.room.code) === q || norm(b.room.name) === q) -
            Number(norm(a.room.code) === q || norm(a.room.name) === q),
        )
        // Diez caben en pantalla sin desplazarse. Si hay más, es que hay que
        // teclear otra letra, no que haya que hacer scroll en un desplegable.
        .slice(0, 10)
    )
  }, [indice, query])

  return (
    /*
     * Un `form`, para que «Intro» —o la tecla «Buscar» del teclado del móvil—
     * abra el primer resultado. Antes no hacía nada: se tecleaba «h 1.12», se
     * veía el aula sola en la lista, se pulsaba «Buscar» por costumbre y el
     * teclado se cerraba sin más; había que ir a tocar la fila. Con un solo
     * resultado es un toque menos, y con varios el primero es el que se llama
     * exactamente como lo tecleado.
     */
    <form
      role="search"
      className="mt-2"
      onSubmit={(e) => {
        e.preventDefault()
        const primero = resultados[0]
        if (primero?.building) onPick(primero.building, primero.room)
      }}
    >
      <label className="block">
        <span className="sr-only">Buscar un aula en todos los edificios</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar aula: «h 1.12», «crai sala 3»…"
          enterKeyHint="go"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="h-touch w-full rounded-ctl border border-line bg-surface px-3"
        />
      </label>

      {query.trim() && (
        <ul className="card mt-2 divide-y divide-line-soft overflow-hidden">
          {resultados.map(({ room, zone, building }) => {
            const days = daysSince(room.last_inspection_at)
            return (
              <li key={room.id}>
                <button
                  type="button"
                  onClick={() => onPick(building!, room)}
                  className="fila flex w-full items-center gap-3 px-3.5 py-2.5 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono font-semibold tabular">
                      {displayRoomCode(room.code)}
                    </span>
                    <span className="block truncate text-sm text-muted">
                      {building!.name} · {zone}
                      {room.name !== room.code && ` · ${room.name}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted">
                    {days === null ? 'Sin revisar' : `Hace ${days} d`}
                  </span>
                </button>
              </li>
            )
          })}

          {resultados.length === 0 && (
            <li className="px-3.5 py-3 text-sm text-muted">Ningún aula coincide.</li>
          )}
        </ul>
      )}
    </form>
  )
}
