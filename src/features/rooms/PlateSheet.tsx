/**
 * Hoja de placas de un edificio, lista para imprimir.
 *
 * Es lo que convierte el QR de un adorno en una herramienta: el técnico escanea
 * al llegar a la puerta y la revisión se abre en esa sala, sin elegir edificio
 * ni planta. Es el camino más corto que existe entre llegar al aula y empezar a
 * trabajar — y en una ronda de 276 salas, quitar dos toques y dos rastreos
 * visuales por sala es media mañana.
 *
 * Se imprime desde el propio navegador y no se genera un PDF en servidor a
 * propósito: esto se hace una vez por sala y para siempre, y montar un pipeline
 * de PDF para eso sería construir una máquina para un solo uso. El CSS de
 * `@media print` ya deja la hoja como tiene que salir.
 *
 * Sale de Dexie, así que la hoja se puede preparar sin cobertura.
 */

import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { DoorPlate } from '@/components/DoorPlate'
import { displayRoomCode } from '@/domain/normalize'
import { sortRooms } from './orden'
import type { Building } from '@/domain/types'

interface Props {
  building: Building
  onBack: () => void
}

export function PlateSheet({ building, onBack }: Props): React.ReactElement {
  const salas = useLiveQuery(async () => {
    const zones = await db.zones.where('building_id').equals(building.id).toArray()
    const zonePorId = new Map(zones.map((z) => [z.id, z]))
    const rooms = await db.rooms.filter((r) => zonePorId.has(r.zone_id)).toArray()

    // El mismo orden que la lista de salas, y por planta: una hoja ordenada
    // distinta que la pantalla obliga a buscar cada placa, y son 39 en el
    // edificio más grande. Por planta, además, se recorta y se reparte por
    // pisos sin volver a ordenar nada a mano.
    return sortRooms(rooms, zonePorId, 'planta').map((r) => ({
      room: r,
      zone: zonePorId.get(r.zone_id),
    }))
  }, [building.id])

  const listas = (salas ?? []).filter((s) => s.room.short_ref)
  const sinMatricula = (salas ?? []).length - listas.length

  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="solo-pantalla">
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 mb-1 inline-flex min-h-11 items-center px-2 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-accent"
        >
          ← Volver
        </button>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Placas de {building.name}</h1>
            <p className="mt-1 text-sm text-muted">
              {listas.length} salas. Cada placa lleva su código: al escanearlo, la revisión se abre
              directamente en esa sala.
            </p>
          </div>
          <button
            type="button"
            onClick={() => window.print()}
            className="key key-accent min-h-11 px-4 text-sm"
          >
            Imprimir
          </button>
        </div>

        {sinMatricula > 0 && (
          <p className="mt-3 text-sm text-warn">
            {sinMatricula} salas todavía no tienen matrícula en este dispositivo. Sincroniza para
            traerla y vuelve a abrir esta hoja.
          </p>
        )}

        <p className="mt-3 text-xs text-muted">
          Imprime en papel adhesivo o plastifica. El código apunta al identificador interno de la
          sala, así que renombrarla más adelante no invalida las placas ya puestas.
        </p>

        <hr className="mt-4 border-line" />
      </div>

      <div className="hoja-placas mt-6 grid gap-4 sm:grid-cols-2">
        {listas.map(({ room, zone }) => (
          <DoorPlate
            key={room.id}
            building={building.name}
            zone={zone?.name ?? ''}
            title={room.name || displayRoomCode(room.code)}
            ref={room.short_ref!}
            id={room.id}
            compacta
          />
        ))}
      </div>

      {salas && listas.length === 0 && (
        <p className="mt-6 text-sm text-muted">
          No hay salas con matrícula en este edificio todavía.
        </p>
      )}
    </div>
  )
}
