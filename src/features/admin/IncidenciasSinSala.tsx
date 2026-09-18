import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { displayRoomCode } from '@/domain/normalize'
import { fechaCorta } from '@/domain/fechas'
import { Cargando, EstadoVacio, FalloDeCarga, Nota, Seccion, mensajeDe } from './Seccion'
import { useRefrescarPendientes } from './pendientes'

/**
 * Las incidencias importadas que quedaron sin sala, y su camino de vuelta.
 *
 * La importación no pudo identificar el aula de 118 incidencias («0.1 BC»,
 * «2.3 TM», «Ventanilla Única»…) e hizo lo correcto: guardarlas sin sala en
 * vez de inventarles una. Lo que no existía era esto: verlas con el texto que
 * traía el Excel y ponerles su sala con dos toques. Cada asignación además
 * ENSEÑA: el texto original queda como alias de la sala, así que la próxima
 * importación —y el buscador— lo resuelven solos.
 *
 * Agrupadas por el texto del aula: las 118 son unas veinte aulas escritas de
 * formas distintas, y «0.1 BC» aparece doce veces. Asignar el grupo entero de
 * una vez es doce decisiones que son la misma.
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

function Grupo({
  aula,
  filas,
  salas,
  edificios,
  ocupado,
  onAsignar,
}: {
  aula: string | null
  filas: SinSala[]
  salas: SalaElegible[]
  edificios: Array<{ id: string; code: string; name: string }>
  ocupado: boolean
  onAsignar: (roomId: string) => void
}): React.ReactElement {
  const [buildingId, setBuildingId] = useState('')
  const [roomId, setRoomId] = useState('')

  const delEdificio = salas.filter((s) => s.buildingId === buildingId)

  return (
    <li className="card p-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {/* El texto de aula del Excel, delante y destacado: es el dato con el
            que se decide, y el que se convertirá en alias al asignar. */}
        <span className="rounded-tag bg-raised px-2 py-0.5 font-mono text-sm font-semibold">
          {aula ?? '(sin aula en la cuarentena)'}
        </span>
        <span className="text-xs text-muted">
          {filas.length === 1 ? '1 incidencia' : `${filas.length} incidencias`}
        </span>
      </div>

      <ul className="mt-2 divide-y divide-line-soft">
        {filas.slice(0, 5).map((f) => (
          <li key={f.incidencia} className="py-1.5 text-sm">
            <span className="text-xs text-muted">
              {fechaCorta(f.abierta_el)}
              {f.ref ? ` · ${f.ref}` : ''} · {f.estado} ·{' '}
            </span>
            {f.titulo}
          </li>
        ))}
        {filas.length > 5 && <li className="py-1.5 text-xs text-muted">y {filas.length - 5} más.</li>}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={buildingId}
          onChange={(e) => {
            setBuildingId(e.target.value)
            setRoomId('')
          }}
          aria-label="Edificio de la sala"
          className="h-11 rounded-ctl border border-line bg-surface px-2 text-base"
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
          className="h-11 rounded-ctl border border-line bg-surface px-2 text-base disabled:opacity-40"
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
          className="key key-accent min-h-11 px-3 text-sm"
        >
          {filas.length === 1 ? 'Asignar' : `Asignar las ${filas.length}`}
        </button>
      </div>
    </li>
  )
}

export function IncidenciasSinSala(): React.ReactElement {
  const qc = useQueryClient()
  const refrescar = useRefrescarPendientes()
  const [nota, setNota] = useState<string | null>(null)

  const { data: filas, isPending, isError, error, refetch } = useQuery({
    queryKey: ['incidencias-sin-sala'],
    queryFn: async (): Promise<SinSala[]> => {
      const { data, error: err } = await supabase.rpc('incidencias_sin_sala')
      if (err) throw err
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
    mutationFn: async (input: { filas: SinSala[]; roomId: string }): Promise<string> => {
      let etiqueta = ''
      // Una a una y en orden: la función del servidor asigna una incidencia y
      // deja el alias; con el grupo entero la primera lo deja y las demás lo
      // encuentran ya puesto.
      for (const fila of input.filas) {
        const { data, error: err } = await supabase.rpc('asignar_sala_a_incidencia', {
          p_incidencia: fila.incidencia,
          p_room: input.roomId,
          p_alias: fila.aula_original,
        })
        if (err) throw err
        etiqueta = (data as string) ?? etiqueta
      }
      return etiqueta
    },
    onSuccess: (etiqueta, input) => {
      const aula = input.filas[0]?.aula_original ?? input.filas[0]?.titulo ?? ''
      setNota(
        `${input.filas.length === 1 ? 'Asignada' : `${input.filas.length} asignadas`} a ${etiqueta}. «${aula}» queda de alias: la próxima importación acertará sola.`,
      )
      void qc.invalidateQueries({ queryKey: ['incidencias-sin-sala'] })
      void qc.invalidateQueries({ queryKey: ['incidents'] })
      void qc.invalidateQueries({ queryKey: ['quarantine'] })
      refrescar()
    },
  })

  // Por el texto del aula, con las más numerosas primero: son las que más
  // trabajo quitan de una vez.
  const grupos = new Map<string, SinSala[]>()
  for (const f of filas ?? []) {
    const clave = f.aula_original ?? ''
    grupos.set(clave, [...(grupos.get(clave) ?? []), f])
  }
  const ordenados = [...grupos.entries()].sort((a, b) => b[1].length - a[1].length)

  return (
    <Seccion
      id="sec-sin-sala"
      titulo="Incidencias sin sala"
      texto="El histórico las trajo con aulas que el maestro no conoce, y se guardaron sin sala en vez de inventarles una. Sin su sala no salen en ninguna ficha ni cuentan en ningún edificio. Asignarla las devuelve a todas las vistas, y el texto original queda de alias para que la próxima importación acierte sola."
      pendientes={filas?.length ?? 0}
    >
      {isPending && <Cargando texto="Buscando incidencias sin sala…" />}
      {isError && <FalloDeCarga que="las incidencias sin sala" error={error} onReintentar={() => void refetch()} />}
      {filas && filas.length === 0 && <EstadoVacio titulo="Todas las incidencias tienen su sala" />}

      <ul className="space-y-3">
        {ordenados.map(([aula, lista]) => (
          <Grupo
            key={aula || '(sin aula)'}
            aula={aula || null}
            filas={lista}
            salas={maestro?.salas ?? []}
            edificios={maestro?.edificios ?? []}
            ocupado={asignar.isPending}
            onAsignar={(roomId) => asignar.mutate({ filas: lista, roomId })}
          />
        ))}
      </ul>

      <Nota texto={asignar.isError ? mensajeDe(asignar.error, 'No se ha podido asignar.') : nota} tono={asignar.isError ? 'crit' : 'ok'} />
    </Seccion>
  )
}
