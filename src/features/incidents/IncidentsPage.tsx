import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
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

  const { data: incidents } = useQuery({
    queryKey: ['incidents', showResolved],
    queryFn: async (): Promise<IncidentRow[]> => {
      let q = supabase.from('incidents').select('*').order('opened_at', { ascending: false }).limit(200)
      if (!showResolved) q = q.neq('state', 'resuelta')
      const { data } = await q
      return (data ?? []) as IncidentRow[]
    },
  })

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

      <ul className="mt-4 divide-y divide-line">
        {(incidents ?? []).map((i) => {
          const days = Math.floor((Date.now() - new Date(i.opened_at).getTime()) / 86_400_000)
          const stale = i.state !== 'resuelta' && days > 7

          return (
            <li key={i.id} className="py-3">
              <div className="flex items-start gap-3">
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATE_STYLE[i.state]}`}
                >
                  {STATE_LABEL[i.state]}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="font-medium">{i.title}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {i.external_ref && <span className="font-mono">{i.external_ref} · </span>}
                    abierta hace{' '}
                    <span className={stale ? 'font-semibold text-crit' : ''}>{days} días</span>
                  </p>
                </div>

                {i.state !== 'resuelta' && (
                  <div className="flex shrink-0 gap-1">
                    {i.state === 'abierta' && (
                      <button
                        type="button"
                        onClick={() => advance.mutate({ id: i.id, state: 'en_curso' })}
                        className="rounded-ctl border border-line px-2 py-1 text-xs font-medium"
                      >
                        Empezar
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => advance.mutate({ id: i.id, state: 'resuelta' })}
                      className="rounded-ctl bg-accent px-2 py-1 text-xs font-medium text-accent-ink"
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

      {incidents?.length === 0 && (
        <p className="mt-6 text-sm text-muted">
          {showResolved ? 'No hay incidencias.' : 'Ninguna abierta.'}
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
