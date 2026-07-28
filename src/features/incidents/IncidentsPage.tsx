import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { displayRoomCode, norm } from '@/domain/normalize'
import type { IncidentState } from '@/domain/types'

interface IncidentRow {
  id: string
  title: string
  description: string | null
  severity: string
  state: IncidentState
  opened_at: string
  resolved_at: string | null
  external_ref: string | null
  room_id: string | null
}

const STATE_STYLE: Record<IncidentState, string> = {
  abierta: 'bg-crit-tint text-crit',
  en_curso: 'bg-warn-tint text-warn',
  resuelta: 'bg-ok-tint text-ok',
}

const STATE_LABEL: Record<IncidentState, string> = {
  abierta: 'Abierta',
  en_curso: 'En curso',
  resuelta: 'Resuelta',
}

export function IncidentsPage(): React.ReactElement {
  const qc = useQueryClient()
  const [showResolved, setShowResolved] = useState(false)
  const [query, setQuery] = useState('')

  /*
   * La sala de cada incidencia, resuelta desde el espejo local.
   *
   * La lista traía `room_id` y no lo pintaba, así que una incidencia decía qué
   * pasa pero no dónde — que es la mitad del dato. Se resuelve contra Dexie y no
   * con un `join` en el servidor porque así también funciona con la copia que ya
   * está en el dispositivo.
   */
  const salas = useLiveQuery(async () => {
    const [rooms, zones, buildings] = await Promise.all([
      db.rooms.toArray(),
      db.zones.toArray(),
      db.buildings.toArray(),
    ])
    const zoneById = new Map(zones.map((z) => [z.id, z]))
    const buildingById = new Map(buildings.map((b) => [b.id, b]))

    return new Map(
      rooms.map((r) => {
        const zone = zoneById.get(r.zone_id)
        const building = zone ? buildingById.get(zone.building_id) : undefined
        return [r.id, `${building?.code ?? ''} ${displayRoomCode(r.code)}`.trim()]
      }),
    )
  }, [])

  const LIMITE = 200

  const { data: incidents, isPending, isError, refetch } = useQuery({
    queryKey: ['incidents', showResolved],
    queryFn: async (): Promise<IncidentRow[]> => {
      let q = supabase
        .from('incidents')
        .select('*')
        .order('opened_at', { ascending: false })
        .limit(LIMITE)
      if (!showResolved) q = q.neq('state', 'resuelta')
      const { data, error } = await q
      // Sin esto un fallo de red devolvía lista vacía y la pantalla decía
      // «Ninguna abierta», que es exactamente lo contrario de la verdad.
      if (error) throw error
      return (data ?? []) as IncidentRow[]
    },
  })

  const visibles = useMemo(() => {
    const q = norm(query)
    if (!q) return incidents ?? []
    return (incidents ?? []).filter(
      (i) =>
        norm(i.title).includes(q) ||
        norm(i.external_ref ?? '').includes(q) ||
        norm(i.room_id ? (salas?.get(i.room_id) ?? '') : '').includes(q),
    )
  }, [incidents, query, salas])

  const advance = useMutation({
    mutationFn: async (input: { id: string; state: IncidentState; resolution?: string }) => {
      const { data: user } = await supabase.auth.getUser()
      const patch: Record<string, unknown> = { state: input.state }

      if (input.state === 'resuelta') {
        patch['resolved_at'] = new Date().toISOString()
        patch['resolved_by'] = user.user?.id ?? null
        if (input.resolution) patch['resolution'] = input.resolution
      }

      const { error } = await supabase.from('incidents').update(patch).eq('id', input.id)
      if (error) throw error
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['incidents'] }),
  })

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">Incidencias</h1>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          Incluir resueltas
        </label>
      </div>

      <label className="mt-3 block">
        <span className="sr-only">Buscar incidencia</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por descripción, referencia o sala"
          enterKeyHint="search"
          className="h-touch w-full rounded-ctl border border-line bg-surface px-3"
        />
      </label>

      <ul className="mt-3 divide-y divide-line">
        {visibles.map((i) => {
          const days = Math.floor((Date.now() - new Date(i.opened_at).getTime()) / 86_400_000)
          const stale = i.state !== 'resuelta' && days > 7
          const sala = i.room_id ? (salas?.get(i.room_id) ?? null) : null

          return (
            <li key={i.id} className="py-3">
              <div className="flex items-start gap-3">
                {/* Rectángulo, no píldora: esto es una etiqueta de un parte de
                    trabajo. La cápsula en todo es el tic más repetido. */}
                <span
                  className={`shrink-0 rounded-tag px-2 py-0.5 text-xs font-medium ${STATE_STYLE[i.state]}`}
                >
                  {STATE_LABEL[i.state]}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="font-medium">{i.title}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {sala && <span className="font-mono font-semibold text-ink-2">{sala} · </span>}
                    {i.external_ref && <span className="font-mono">{i.external_ref} · </span>}
                    abierta hace{' '}
                    <span className={stale ? 'font-semibold text-crit' : ''}>{days} días</span>
                  </p>
                </div>

                {i.state !== 'resuelta' && (
                  <div className="flex shrink-0 gap-2">
                    {i.state === 'abierta' && (
                      <button
                        type="button"
                        onClick={() => advance.mutate({ id: i.id, state: 'en_curso' })}
                        className="key key-quiet min-h-11 px-3 text-xs"
                      >
                        Empezar
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => advance.mutate({ id: i.id, state: 'resuelta' })}
                      className="key key-accent min-h-11 px-3 text-xs"
                    >
                      Resolver
                    </button>
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {isPending && <p className="mt-6 text-sm text-muted">Cargando incidencias…</p>}

      {isError && (
        <div className="card mt-6 p-4">
          <p className="text-sm text-crit">No se han podido leer las incidencias.</p>
          <p className="mt-1 text-sm text-muted">
            Esta pantalla necesita conexión. Lo que revises sin cobertura sí se guarda.
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="key key-quiet mt-3 min-h-11 px-3 text-sm"
          >
            Reintentar
          </button>
        </div>
      )}

      {!isPending && !isError && visibles.length === 0 && (
        <p className="mt-6 text-sm text-muted">
          {query
            ? `Ninguna incidencia coincide con «${query}».`
            : showResolved
              ? 'No hay incidencias.'
              : 'Ninguna abierta.'}
        </p>
      )}

      {/* Que el listado esté recortado tiene que verse: con 283 incidencias, 83
          desaparecían sin que nada lo dijera. */}
      {incidents?.length === LIMITE && (
        <p className="mt-4 text-xs text-muted">
          Mostrando las {LIMITE} más recientes. Afina la búsqueda para ver el resto.
        </p>
      )}

      {advance.isError && (
        <p className="mt-4 text-sm text-crit">
          Solo un supervisor cierra incidencias.
        </p>
      )}
    </div>
  )
}
