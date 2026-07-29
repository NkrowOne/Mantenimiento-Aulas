import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { displayRoomCode } from '@/domain/normalize'
import { OVERDUE_INSPECTION_DAYS, type Building, type Room } from '@/domain/types'
import {
  ROOM_ORDER_LABELS,
  daysSince,
  roomMatches,
  sortRooms,
  type RoomOrder,
} from './orden'

interface Props {
  building: Building
  onPick: (room: Room) => void
  onBack: () => void
  order: RoomOrder
  onOrderChange: (order: RoomOrder) => void
}

/**
 * Lista de salas: la ruta de trabajo del día.
 *
 * Dos cosas la hacen usable con 39 salas en un edificio y 276 en total:
 * **se puede buscar** y **se puede elegir el orden**. Antes solo había un orden
 * fijo y ningún filtro, así que llegar a un aula concreta —el caso de «falla el
 * proyector del −2.1 del H», que llega por radio— era bajar leyendo fila a fila.
 */
export function RoomListPage({
  building,
  onPick,
  onBack,
  order,
  onOrderChange,
}: Props): React.ReactElement {
  const [query, setQuery] = useState('')

  /*
   * Una sola consulta, y por índice.
   *
   * Eran dos, y las dos leían las zonas del edificio. Y `db.rooms.filter()` no
   * es un `where`: deserializa las 276 salas y ejecuta la lambda sobre cada una
   * teniendo el índice `zone_id` delante.
   */
  const datos = useLiveQuery(async () => {
    const zonas = await db.zones.where('building_id').equals(building.id).toArray()
    const ids = zonas.map((z) => z.id)
    return {
      zones: new Map(zonas.map((z) => [z.id, z])),
      rooms: await db.rooms.where('zone_id').anyOf(ids).toArray(),
    }
  }, [building.id])

  const zones = datos?.zones
  const rooms = datos?.rooms

  const drafts = useLiveQuery(
    () => db.inspections.where('status').equals('borrador').toArray(),
    [],
  )
  const draftRoomIds = useMemo(
    () => new Set((drafts ?? []).map((d) => d.room_id)),
    [drafts],
  )

  const visible = useMemo(() => {
    if (!rooms || !zones) return []
    const filtered = rooms.filter((r) => roomMatches(r, query, zones.get(r.zone_id)?.name))
    return sortRooms(filtered, zones, order)
  }, [rooms, zones, order, query])

  const cargando = rooms === undefined || zones === undefined

  return (
    <div>
      <header className="border-b border-line bg-surface px-4 pb-3 pt-2">
        <button type="button" onClick={onBack} className="-ml-2 min-h-11 px-2 text-sm text-accent">
          ← Edificios
        </button>
        <h1 className="text-xl font-semibold">{building.name}</h1>

        <label className="mt-2 block">
          <span className="sr-only">Buscar sala en {building.name}</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar sala"
            enterKeyHint="search"
            className="h-touch w-full rounded-ctl border border-line bg-ground px-3"
          />
        </label>

        {/* El orden se elige y se ve. Antes era fijo y solo lo decía un texto. */}
        <div className="mt-2 flex items-center justify-between gap-2">
          <div role="group" aria-label="Orden de la lista" className="flex gap-1">
            {(Object.keys(ROOM_ORDER_LABELS) as RoomOrder[]).map((o) => (
              <button
                key={o}
                type="button"
                aria-pressed={order === o}
                onClick={() => onOrderChange(o)}
                className={`key min-h-11 px-3 text-xs ${
                  order === o ? 'key-accent' : 'key-quiet text-muted'
                }`}
              >
                {ROOM_ORDER_LABELS[o]}
              </button>
            ))}
          </div>
          <span className="shrink-0 text-sm text-muted">
            {visible.length}
            {query && rooms ? ` de ${rooms.length}` : ' salas'}
          </span>
        </div>
      </header>

      {cargando && <p className="p-6 text-sm text-muted">Cargando las salas…</p>}

      {!cargando && visible.length === 0 && (
        <p className="p-6 text-sm text-muted">
          {query
            ? `Ninguna sala coincide con «${query}».`
            : 'Este edificio no tiene salas. Conéctate una vez para descargarlas.'}
        </p>
      )}

      <ul className="divide-y divide-line">
        {visible.map((room, i) => {
          const days = daysSince(room.last_inspection_at)
          const overdue = days === null || days > OVERDUE_INSPECTION_DAYS
          const hasDraft = draftRoomIds.has(room.id)

          /*
             Cabecera de planta, solo en el orden por planta.
             Es lo que convierte la lista en un recorrido: se ve dónde acaba una
             planta y empieza la siguiente sin tener que leer la línea gris de
             cada fila. En el orden por antigüedad no se pone, porque ahí las
             plantas se mezclan a propósito.
          */
          const zona = zones?.get(room.zone_id)?.name ?? ''
          const zonaAnterior = i > 0 ? (zones?.get(visible[i - 1]!.zone_id)?.name ?? '') : null
          const abreZona = order === 'planta' && zona !== zonaAnterior

          return (
            <li key={room.id}>
              {abreZona && (
                <p className="eyebrow sticky top-0 z-[1] border-y border-line bg-sunken px-4 py-1.5">
                  {zona}
                </p>
              )}
              <button
                type="button"
                onClick={() => onPick(room)}
                /* Responde al toque. Era el objetivo más pulsado del día y el
                   único sin ninguna señal al pulsarlo. */
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-100 active:bg-raised"
              >
                {/* Raíl recto, no cápsula: mismo lenguaje que `StatTile`. */}
                <span
                  aria-hidden
                  className={`h-8 w-[3px] shrink-0 ${overdue ? 'bg-warn' : 'bg-ok'}`}
                />

                <span className="min-w-0 flex-1">
                  <span className="block font-mono font-semibold tabular">
                    {displayRoomCode(room.code)}
                  </span>
                  {/* La planta va en cada fila: aquí el código aparece suelto,
                      y `−2.1` sin contexto se lee como una errata. */}
                  <span className="block truncate text-sm text-muted">
                    {order === 'planta' ? '' : zona}
                    {room.name !== room.code && `${order === 'planta' ? '' : ' · '}${room.name}`}
                  </span>
                </span>

                <span className="shrink-0 text-right text-xs">
                  {hasDraft && (
                    <span className="mb-1 block rounded-tag bg-accent-tint px-2 py-0.5 font-medium text-accent">
                      A medias
                    </span>
                  )}
                  <span className={overdue ? 'text-warn' : 'text-muted'}>
                    {days === null ? 'Sin revisar' : `Hace ${days} d`}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
