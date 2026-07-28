import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { OVERDUE_INSPECTION_DAYS, type Building, type Room } from '@/domain/types'

interface Props {
  building: Building
  onPick: (room: Room) => void
  onBack: () => void
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
}

/**
 * Lista de salas ordenada por *la que lleva más tiempo sin revisar primero*.
 *
 * Es la decisión de diseño que convierte la lista en una ruta de trabajo: el
 * técnico baja por ella y va haciendo, en vez de tener que decidir por dónde
 * empezar cada vez.
 */
export function RoomListPage({ building, onPick, onBack }: Props): React.ReactElement {
  const rooms = useLiveQuery(async () => {
    const zones = await db.zones.where('building_id').equals(building.id).toArray()
    const zoneIds = new Set(zones.map((z) => z.id))
    const all = await db.rooms.filter((r) => zoneIds.has(r.zone_id)).toArray()

    return all.sort((a, b) => {
      // Sin revisar nunca va primero: es el vacío más caro de la lista.
      if (!a.last_inspection_at && b.last_inspection_at) return -1
      if (a.last_inspection_at && !b.last_inspection_at) return 1
      if (!a.last_inspection_at && !b.last_inspection_at) return a.code.localeCompare(b.code)
      return a.last_inspection_at!.localeCompare(b.last_inspection_at!)
    })
  }, [building.id])

  const drafts = useLiveQuery(
    () => db.inspections.filter((i) => i.status === 'borrador').toArray(),
    [],
  )
  const draftRoomIds = new Set((drafts ?? []).map((d) => d.room_id))

  return (
    <div>
      <header className="border-b border-line bg-surface px-4 py-3">
        <button type="button" onClick={onBack} className="text-sm text-accent">
          ← Edificios
        </button>
        <h1 className="mt-1 text-xl font-semibold">{building.name}</h1>
        <p className="text-sm text-muted">{rooms?.length ?? 0} salas · las más antiguas primero</p>
      </header>

      <ul className="divide-y divide-line">
        {(rooms ?? []).map((room) => {
          const days = daysSince(room.last_inspection_at)
          const overdue = days === null || days > OVERDUE_INSPECTION_DAYS
          const hasDraft = draftRoomIds.has(room.id)

          return (
            <li key={room.id}>
              <button
                type="button"
                onClick={() => onPick(room)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left"
              >
                <span
                  aria-hidden
                  className={`h-8 w-1 shrink-0 rounded-full ${overdue ? 'bg-warn' : 'bg-ok'}`}
                />

                <span className="min-w-0 flex-1">
                  <span className="block font-mono font-semibold">{room.code}</span>
                  {room.name !== room.code && (
                    <span className="block truncate text-sm text-muted">{room.name}</span>
                  )}
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
