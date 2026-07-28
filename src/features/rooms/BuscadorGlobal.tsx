import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { displayRoomCode } from '@/domain/normalize'
import type { Building, Room } from '@/domain/types'
import { daysSince, roomMatches } from './orden'

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
  onPick: (building: Building, room: Room) => void
}

export function BuscadorGlobal({ onPick }: Props): React.ReactElement {
  const [query, setQuery] = useState('')

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
    return indice
      .filter((e) => e.building && roomMatches(e.room, query, e.zone))
      // Diez caben en pantalla sin desplazarse. Si hay más, es que hay que
      // teclear otra letra, no que haya que hacer scroll en un desplegable.
      .slice(0, 10)
  }, [indice, query])

  return (
    <div className="border-b border-line bg-surface px-4 py-3">
      <label className="block">
        <span className="sr-only">Buscar un aula en todos los edificios</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar aula en todo el campus"
          enterKeyHint="search"
          className="h-touch w-full rounded-ctl border border-line bg-ground px-3"
        />
      </label>

      {query.trim() && (
        <ul className="mt-2 divide-y divide-line-soft">
          {resultados.map(({ room, zone, building }) => {
            const days = daysSince(room.last_inspection_at)
            return (
              <li key={room.id}>
                <button
                  type="button"
                  onClick={() => onPick(building!, room)}
                  className="flex w-full items-center gap-3 py-2.5 text-left transition-colors duration-100 active:bg-raised"
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
            <li className="py-3 text-sm text-muted">Ningún aula coincide.</li>
          )}
        </ul>
      )}
    </div>
  )
}
