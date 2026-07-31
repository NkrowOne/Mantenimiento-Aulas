import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { displayRoomCode } from '@/domain/normalize'
import { fechaCorta } from '@/domain/fechas'

/**
 * Las incidencias importadas que quedaron sin sala, y su camino de vuelta.
 *
 * La importación no pudo identificar el aula de 118 incidencias («0.1 BC»,
 * «2.3 TM», «Ventanilla Única»…) e hizo lo correcto: guardarlas sin sala en
 * vez de inventarles una. Lo que no existía era esto: verlas con el texto que
 * traía el Excel y ponerles su sala con dos toques. Cada asignación además
 * ENSEÑA: el texto original queda como alias de la sala, así que la próxima
 * importación —y el buscador— lo resuelven solos.
 */

interface SinSala {
  incidencia: string
  ref: string | null
  titulo: string
  descripcion: string | null
  estado: string
  abierta_el: string
  aula_original: string | null
}

interface SalaElegible {
  id: string
  buildingId: string
  etiqueta: string
}

function Fila({
  fila,
  salas,
  edificios,
  ocupado,
  onAsignar,
}: {
  fila: SinSala
  salas: SalaElegible[]
  edificios: Array<{ id: string; code: string; name: string }>
  ocupado: boolean
  onAsignar: (roomId: string) => void
}): React.ReactElement {
  const [buildingId, setBuildingId] = useState('')
  const [roomId, setRoomId] = useState('')

  const delEdificio = salas.filter((s) => s.buildingId === buildingId)

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {/* El texto de aula del Excel, delante y destacado: es el dato con el
            que se decide, y el que se convertirá en alias al asignar. */}
        <span className="font-mono text-sm font-semibold">
          {fila.aula_original ?? '(sin aula en la cuarentena)'}
        </span>
        <span className="text-xs text-muted">
          {fechaCorta(fila.abierta_el)}
          {fila.ref ? ` · ${fila.ref}` : ''} · {fila.estado}
        </span>
      </div>
      <p className="mt-0.5 text-sm">{fila.titulo}</p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={buildingId}
          onChange={(e) => {
            setBuildingId(e.target.value)
            setRoomId('')
          }}
          aria-label="Edificio de la sala"
          className="h-10 rounded-ctl border border-line bg-surface px-2 text-sm"
        >
          <option value="">Edificio…</option>
          {edificios.map((b) => (
            <option key={b.id} value={b.id}>
              {b.code} — {b.name}
            </option>
          ))}
        </select>

        <select
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          disabled={!buildingId}
          aria-label="Sala que le corresponde"
          className="h-10 rounded-ctl border border-line bg-surface px-2 text-sm disabled:opacity-40"
        >
          <option value="">{buildingId ? 'Sala…' : '—'}</option>
          {delEdificio.map((s) => (
            <option key={s.id} value={s.id}>
              {s.etiqueta}
            </option>
          ))}
        </select>

        <button
          type="button"
          disabled={!roomId || ocupado}
          onClick={() => onAsignar(roomId)}
          className="key key-accent h-10 px-3 text-sm"
        >
          Asignar
        </button>
      </div>
    </li>
  )
}

export function IncidenciasSinSala(): React.ReactElement {
  const qc = useQueryClient()
  const [nota, setNota] = useState<string | null>(null)

  const { data: filas, isPending } = useQuery({
    queryKey: ['incidencias-sin-sala'],
    queryFn: async (): Promise<SinSala[]> => {
      const { data, error } = await supabase.rpc('incidencias_sin_sala')
      if (error) throw error
      return (data ?? []) as SinSala[]
    },
  })

  /* Salas y edificios del espejo, listos para elegir. */
  const maestro = useLiveQuery(async () => {
    const [rooms, zones, buildings] = await Promise.all([
      db.rooms.toArray(),
      db.zones.toArray(),
      db.buildings.orderBy('sort_order').toArray(),
    ])
    const zonaEdificio = new Map(zones.map((z) => [z.id, z.building_id]))
    const salas: SalaElegible[] = rooms
      .map((r) => ({
        id: r.id,
        buildingId: zonaEdificio.get(r.zone_id) ?? '',
        etiqueta: `${displayRoomCode(r.code)}${r.name && r.name !== r.code ? ` — ${r.name}` : ''}`,
      }))
      .sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, 'es', { numeric: true }))
    return { salas, edificios: buildings.map((b) => ({ id: b.id, code: b.code, name: b.name })) }
  }, [])

  const asignar = useMutation({
    mutationFn: async (input: { fila: SinSala; roomId: string }): Promise<string> => {
      const { data, error } = await supabase.rpc('asignar_sala_a_incidencia', {
        p_incidencia: input.fila.incidencia,
        p_room: input.roomId,
        p_alias: input.fila.aula_original,
      })
      if (error) throw error
      return (data as string) ?? ''
    },
    onSuccess: (etiqueta, input) => {
      setNota(
        `Asignada a ${etiqueta}. «${input.fila.aula_original ?? input.fila.titulo}» queda de alias: la próxima importación acertará sola.`,
      )
      void qc.invalidateQueries({ queryKey: ['incidencias-sin-sala'] })
      void qc.invalidateQueries({ queryKey: ['incidents'] })
      void qc.invalidateQueries({ queryKey: ['quarantine'] })
    },
  })

  return (
    <section aria-labelledby="sec-sin-sala" className="mt-8">
      <div className="section-head">
        <h2 id="sec-sin-sala" className="eyebrow">
          Incidencias sin sala
        </h2>
        {(filas?.length ?? 0) > 0 && (
          <span className="rounded-tag bg-warn-tint px-2 py-0.5 text-xs font-semibold text-warn">
            {filas!.length}
          </span>
        )}
      </div>
      <p className="max-w-prose text-sm text-muted">
        El histórico las trajo con aulas que el maestro no conoce, y se guardaron sin sala en vez
        de inventarles una. Sin su sala no salen en ninguna ficha ni cuentan en ningún edificio:
        asignarla aquí las devuelve a todas las vistas, y el texto original queda de alias para que
        la próxima importación acierte sola.
      </p>

      {isPending && <p className="mt-3 text-sm text-muted">Buscando huérfanas…</p>}
      {!isPending && (filas?.length ?? 0) === 0 && (
        <p className="mt-3 text-sm text-muted">Ninguna: todas las incidencias tienen su sala.</p>
      )}

      <ul className="mt-3 divide-y divide-line">
        {(filas ?? []).map((f) => (
          <Fila
            key={f.incidencia}
            fila={f}
            salas={maestro?.salas ?? []}
            edificios={maestro?.edificios ?? []}
            ocupado={asignar.isPending}
            onAsignar={(roomId) => asignar.mutate({ fila: f, roomId })}
          />
        ))}
      </ul>

      {asignar.isError && (
        <p role="alert" className="mt-3 text-sm text-crit">
          {asignar.error instanceof Error ? asignar.error.message : 'No se ha podido asignar.'}
        </p>
      )}
      {nota && !asignar.isPending && (
        <p aria-live="polite" className="mt-3 text-sm text-ok">
          {nota}
        </p>
      )}
    </section>
  )
}
