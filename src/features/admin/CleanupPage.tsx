import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { AssetTypeTray } from './AssetTypeTray'
import { EquipoPorDefecto } from './EquipoPorDefecto'
import { EquiposPendientes } from './EquiposPendientes'
import { MaestroSalas } from './MaestroSalas'
import { RecuperarCopia } from './RecuperarCopia'
import { RetiradasPendientes } from './RetiradasPendientes'
import { UsersPage } from './UsersPage'

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
 * El panel de administración.
 *
 * Está ordenado por con qué frecuencia se entra a cada cosa, que no es lo mismo
 * que por importancia:
 *
 *  1. **Usuarios y roles** — lo que se viene a buscar cuando algo va mal.
 *  2. **Retiradas, equipos y tipos sin validar** — lo único que crece solo:
 *     cada ronda de revisiones deja trabajo aquí.
 *  3. **Equipamiento por defecto y maestro** — se tocan cuando cambia el campus.
 *  4. **Depuración de la importación** — importante, pero se hace una vez.
 *
 * Lo de abajo del todo es lo que resuelve que el importador no adivine. Cuando
 * el Excel dice `BC` y no existe tal edificio, inventarse que es el CRAI metería
 * datos falsos en el inventario. En su lugar el edificio entra marcado y aquí se
 * resuelve con un clic: fusionarlo con el correcto o confirmarlo como propio.
 */
export function CleanupPage({ yo }: { yo: string | null }): React.ReactElement {
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
        // Sin `order`, Postgres no garantiza ninguno y el `update` de «Revisada»
        // puede mover la fila dentro del heap: la lista se reordenaba bajo el
        // dedo del coordinador.
        .order('at', { ascending: true })
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
      {/*
        Los usuarios van los PRIMEROS de la pantalla de administración.
        Lo demás —edificios sin identificar, cuarentena, tipos sin validar— es
        depuración de la importación: importante, pero se hace una vez. Esto es
        lo que se viene a buscar cuando algo va mal, y lo que hasta ahora obligaba
        a abrir una terminal.
      */}
      <UsersPage yo={yo} />

      {/* Lo que llega solo, y por eso va antes que nada de lo que hay debajo.
          Las retiradas van las primeras de las tres: bloquean a alguien que ya
          no puede tocar ese equipo hasta que se decidan. */}
      <RetiradasPendientes />
      <EquiposPendientes />
      <AssetTypeTray />

      <EquipoPorDefecto />
      <MaestroSalas />

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
                  className="key key-accent h-10 px-3 text-sm"
                >
                  Fusionar
                </button>

                <button
                  type="button"
                  onClick={() => confirm.mutate(b.id)}
                  className="key key-quiet h-10 px-3 text-sm"
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

      <RecuperarCopia />

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
                className="key key-quiet shrink-0 px-2 py-1 text-xs"
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
