/**
 * Abrir una incidencia o una solicitud desde el inicio.
 *
 * Hasta ahora una incidencia solo se abría desde la ficha de su aula: había que
 * llegar primero al aula —edificio, lista, fila— y allí dar con el botón. Es el
 * camino natural cuando ya se está delante de la puerta, y el más largo cuando
 * el aviso llega por teléfono y lo que se quiere es apuntarlo antes de que se
 * olvide.
 *
 * Esta hoja pregunta las tres cosas que hacen falta para empezar —qué es, en
 * qué edificio y en qué sala— y lleva al formulario del aula ya abierto y con
 * el tipo puesto. El formulario es el MISMO de la ficha, a propósito: la
 * descripción, la foto, el código de EasyVista y el cierre inmediato viven
 * allí, y una segunda copia aquí acabaría pidiendo cosas distintas.
 *
 * El edificio se recuerda mientras la aplicación siga abierta: quien apunta
 * tres avisos seguidos casi siempre los apunta del mismo aulario.
 */

import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { HojaDeAcciones } from '@/components/HojaDeAcciones'
import { db } from '@/db/dexie'
import { displayRoomCode } from '@/domain/normalize'
import {
  INCIDENT_KIND_LABELS,
  type Building,
  type IncidentKind,
  type Room,
} from '@/domain/types'
import { useEstadoDeSesion } from '@/lib/estado-de-sesion'

/** Lo que se puede abrir a mano. Una observación se apunta en la revisión. */
const TIPOS: IncidentKind[] = ['incidencia', 'solicitud']

/** Para qué es cada tipo, en una línea, debajo del selector. */
const PARA_QUE: Record<string, string> = {
  incidencia: 'Algo no funciona o está roto.',
  solicitud: 'Se pide algo: un cable, un cambio, una instalación.',
}

const CAMPO = 'mt-1 h-touch w-full rounded-ctl border border-line bg-surface px-3 text-base text-ink'

interface Props {
  onElegida: (building: Building, room: Room, tipo: IncidentKind) => void
  onCerrar: () => void
}

export function NuevaIncidencia({ onElegida, onCerrar }: Props): React.ReactElement {
  const [tipo, setTipo] = useState<IncidentKind>('incidencia')
  const [buildingId, setBuildingId] = useEstadoDeSesion('nueva-incidencia.edificio', '')
  const [roomId, setRoomId] = useState('')

  const buildings = useLiveQuery(() => db.buildings.orderBy('sort_order').toArray(), [], [])

  /*
   * Las salas del edificio, agrupadas por planta y en el orden de la lista de
   * salas: plantas por su orden, y dentro los códigos como números («0.2» antes
   * que «0.10»). Con treinta y nueve salas en un desplegable, sin grupos hay que
   * leerlas todas para dar con una.
   */
  const plantas = useLiveQuery(
    async () => {
      if (!buildingId) return []
      const zonas = await db.zones.where('building_id').equals(buildingId).toArray()
      zonas.sort((a, b) => a.sort_order - b.sort_order)
      const salas = await db.rooms
        .where('zone_id')
        .anyOf(zonas.map((z) => z.id))
        .toArray()
      return zonas
        .map((zona) => ({
          zona,
          salas: salas
            .filter((r) => r.zone_id === zona.id)
            .sort((a, b) => a.code.localeCompare(b.code, 'es', { numeric: true })),
        }))
        .filter((g) => g.salas.length > 0)
    },
    [buildingId],
    [],
  )

  const building = buildings.find((b) => b.id === buildingId)
  const room = useMemo(
    () => plantas.flatMap((g) => g.salas).find((r) => r.id === roomId),
    [plantas, roomId],
  )

  return (
    <HojaDeAcciones
      titulo="Nueva incidencia o solicitud"
      subtitulo="Elige el tipo y el aula."
      acciones={[]}
      onCerrar={onCerrar}
    >
      <div className="mt-3">
        <div role="group" aria-label="Tipo" className="segmento grid w-full grid-cols-2">
          {TIPOS.map((t) => (
            <button key={t} type="button" aria-pressed={tipo === t} onClick={() => setTipo(t)}>
              {INCIDENT_KIND_LABELS[t]}
            </button>
          ))}
        </div>
        <p className="mt-1.5 px-1 text-xs text-muted">{PARA_QUE[tipo]}</p>
      </div>

      <label className="mt-3 block text-sm text-muted">
        Edificio
        <select
          value={buildingId}
          onChange={(e) => {
            setBuildingId(e.target.value)
            setRoomId('')
          }}
          className={CAMPO}
        >
          <option value="">Elige un edificio…</option>
          {buildings.map((b) => (
            <option key={b.id} value={b.id}>
              {b.code} — {b.name}
            </option>
          ))}
        </select>
      </label>

      <label className="mt-3 block text-sm text-muted">
        Sala
        <select
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          disabled={!buildingId}
          className={`${CAMPO} disabled:opacity-50`}
        >
          <option value="">{buildingId ? 'Elige una sala…' : 'Elige antes el edificio'}</option>
          {plantas.map(({ zona, salas }) => (
            <optgroup key={zona.id} label={zona.name}>
              {salas.map((r) => (
                <option key={r.id} value={r.id}>
                  {displayRoomCode(r.code)}
                  {r.name !== r.code ? ` — ${r.name}` : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <button
        type="button"
        data-principal
        disabled={!building || !room}
        onClick={() => building && room && onElegida(building, room, tipo)}
        className="key key-accent mt-4 min-h-touch w-full px-4"
      >
        Continuar
      </button>
    </HojaDeAcciones>
  )
}
