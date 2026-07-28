import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { supabase } from '@/lib/supabase'

interface ProvisionalBuilding {
  id: string
  code: string
  name: string
  review_note: string | null
}

interface QuarantineRow {
  id: number
  source: string
  row_ref: string | null
  raw: Record<string, unknown>
  reason: string
}

/**
 * Depuración de los datos importados.
 *
 * El importador no adivina. Cuando el Excel dice `BC` y no existe tal edificio,
 * inventarse que es el CRAI metería datos falsos en el inventario. En su lugar
 * el edificio entra marcado y aquí se resuelve con un clic: fusionarlo con el
 * correcto o confirmarlo como propio.
 */
export function CleanupPage(): React.ReactElement {
  const qc = useQueryClient()
  const [mergeInto, setMergeInto] = useState<Record<string, string>>({})

  const { data: provisional } = useQuery({
    queryKey: ['buildings', 'provisional'],
    queryFn: async (): Promise<ProvisionalBuilding[]> => {
      const { data } = await supabase
        .from('buildings')
        .select('id, code, name, review_note')
        .eq('needs_review', true)
        .order('code')
      return (data ?? []) as ProvisionalBuilding[]
    },
  })

  const { data: known } = useQuery({
    queryKey: ['buildings', 'known'],
    queryFn: async () => {
      const { data } = await supabase
        .from('buildings')
        .select('id, code, name')
        .eq('needs_review', false)
        .order('code')
      return (data ?? []) as Array<{ id: string; code: string; name: string }>
    },
  })

  const { data: quarantine } = useQuery({
    queryKey: ['quarantine'],
    queryFn: async (): Promise<QuarantineRow[]> => {
      const { data } = await supabase
        .from('import_quarantine')
        .select('*')
        .eq('resolved', false)
        .limit(100)
      return (data ?? []) as QuarantineRow[]
    },
  })

  const merge = useMutation({
    mutationFn: async (input: { fromId: string; intoId: string }) => {
      const { error } = await supabase.rpc('merge_building', {
        from_building: input.fromId,
        into_building: input.intoId,
      })
      if (error) throw error
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['buildings'] }),
  })

  const confirm = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('buildings')
        .update({ needs_review: false, review_note: null })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['buildings'] }),
  })

  const dismiss = useMutation({
    mutationFn: async (id: number) => {
      const { data: user } = await supabase.auth.getUser()
      const { error } = await supabase
        .from('import_quarantine')
        .update({
          resolved: true,
          resolved_by: user.user?.id ?? null,
          resolved_at: new Date().toISOString(),
        })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['quarantine'] }),
  })

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-4">
      <section>
        <h1 className="text-xl font-semibold">Edificios sin identificar</h1>
        <p className="mt-1 text-sm text-muted">Están en el histórico pero no en el maestro.</p>

        <ul className="mt-4 space-y-3">
          {(provisional ?? []).map((b) => (
            <li key={b.id} className="card p-4">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-lg font-semibold">{b.code}</span>
                <span className="text-sm text-muted">{b.name}</span>
              </div>
              {b.review_note && <p className="mt-1 text-sm text-muted">{b.review_note}</p>}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <select
                  value={mergeInto[b.id] ?? ''}
                  onChange={(e) => setMergeInto((m) => ({ ...m, [b.id]: e.target.value }))}
                  className="h-10 rounded-ctl border border-line bg-surface px-2 text-sm"
                >
                  <option value="">Fusionar con…</option>
                  {(known ?? []).map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.code} — {k.name}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  disabled={!mergeInto[b.id]}
                  onClick={() => merge.mutate({ fromId: b.id, intoId: mergeInto[b.id]! })}
                  className="h-10 rounded-ctl bg-accent px-3 text-sm font-semibold text-accent-ink disabled:opacity-40"
                >
                  Fusionar
                </button>

                <button
                  type="button"
                  onClick={() => confirm.mutate(b.id)}
                  className="h-10 rounded-ctl border border-line px-3 text-sm font-medium"
                >
                  Es un edificio propio
                </button>
              </div>
            </li>
          ))}
        </ul>

        {provisional?.length === 0 && (
          <p className="mt-4 text-sm text-muted">Ninguno pendiente.</p>
        )}
      </section>

      <section>
        <h2 className="text-xl font-semibold">Cuarentena de importación</h2>
        <p className="mt-1 text-sm text-muted">No se pudieron interpretar al importar.</p>

        <ul className="mt-4 divide-y divide-line">
          {(quarantine ?? []).map((q) => (
            <li key={q.id} className="flex items-start gap-3 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="text-muted">{q.reason}</p>
                <p className="mt-1 truncate font-mono text-xs">
                  {Object.values(q.raw).filter(Boolean).join(' · ')}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {q.source} · {q.row_ref}
                </p>
              </div>
              <button
                type="button"
                onClick={() => dismiss.mutate(q.id)}
                className="shrink-0 rounded-ctl border border-line px-2 py-1 text-xs"
              >
                Revisada
              </button>
            </li>
          ))}
        </ul>

        {quarantine?.length === 0 && <p className="mt-4 text-sm text-muted">Nada pendiente de revisar.</p>}
      </section>
    </div>
  )
}
