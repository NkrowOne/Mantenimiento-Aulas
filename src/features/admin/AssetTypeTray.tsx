import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { AssetType } from '@/domain/types'

/**
 * Bandeja de tipos de equipo sin validar.
 *
 * La contrapartida de dejar que el técnico cree tipos desde el aula. Sin esta
 * pantalla, «crear sobre la marcha» acaba siendo un catálogo con «Cañón»,
 * «Proyector» y «proyector aula» como tres cosas distintas, y a partir de ahí
 * ningún informe agrupa nada.
 *
 * Tres salidas para cada uno, y ninguna es «borrar»: lo que un técnico apuntó
 * porque lo tenía delante existe de verdad.
 *
 *  - **Confirmar**: era un tipo nuevo legítimo.
 *  - **Corregir el nombre**: estaba bien pero mal escrito. El nombre viejo se
 *    queda de alias, así que quien lo teclee mañana encuentra el corregido.
 *  - **Fusionar**: ya existía con otra palabra. Los equipos se mueven al tipo
 *    bueno y el nombre absorbido pasa a ser alias suyo.
 */
export function AssetTypeTray(): React.ReactElement {
  const qc = useQueryClient()
  const [renaming, setRenaming] = useState<Record<string, string>>({})
  const [mergeInto, setMergeInto] = useState<Record<string, string>>({})

  const { data: pending } = useQuery({
    queryKey: ['asset-types', 'pending'],
    queryFn: async (): Promise<AssetType[]> => {
      const { data } = await supabase
        .from('asset_types')
        .select('*')
        .eq('confirmed', false)
        .is('merged_into', null)
        .order('created_at')
      return (data ?? []) as AssetType[]
    },
  })

  const { data: confirmed } = useQuery({
    queryKey: ['asset-types', 'confirmed'],
    queryFn: async (): Promise<AssetType[]> => {
      const { data } = await supabase
        .from('asset_types')
        .select('*')
        .eq('confirmed', true)
        .is('merged_into', null)
        .order('name')
      return (data ?? []) as AssetType[]
    },
  })

  // Cuántos equipos usa cada tipo. Sin esto se confirma a ciegas: no es lo mismo
  // validar algo que alguien apuntó una vez que algo instalado en treinta aulas.
  const { data: usage } = useQuery({
    queryKey: ['asset-types', 'usage'],
    queryFn: async (): Promise<Record<string, number>> => {
      const { data } = await supabase.from('assets').select('asset_type_id').neq('status', 'retirado')
      const counts: Record<string, number> = {}
      for (const row of (data ?? []) as Array<{ asset_type_id: string }>) {
        counts[row.asset_type_id] = (counts[row.asset_type_id] ?? 0) + 1
      }
      return counts
    },
  })

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['asset-types'] })
  }

  const act = useMutation({
    mutationFn: async (input:
      | { kind: 'confirm'; id: string }
      | { kind: 'rename'; id: string; name: string }
      | { kind: 'merge'; from: string; into: string }) => {
      const { error } =
        input.kind === 'confirm'
          ? await supabase.rpc('confirm_asset_type', { p_id: input.id })
          : input.kind === 'rename'
            ? await supabase.rpc('rename_asset_type', { p_id: input.id, p_name: input.name })
            : await supabase.rpc('merge_asset_type', { p_from: input.from, p_into: input.into })
      if (error) throw error
    },
    onSuccess: invalidate,
  })

  if (!pending) return <p className="text-sm text-muted">Cargando el catálogo…</p>

  return (
    <section className="mt-8">
      <h2 className="font-semibold">Equipos sin validar</h2>
      <p className="mt-1 text-sm text-muted">
        Creados desde un aula. Se están usando ya; esto solo ordena el catálogo.
      </p>

      {pending.length === 0 && (
        <p className="mt-3 text-sm text-muted">Nada pendiente de validar.</p>
      )}

      <ul className="mt-3 divide-y divide-line">
        {pending.map((type) => (
          <li key={type.id} className="py-3">
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{type.name}</span>
              <span className="rounded-tag bg-warn-tint px-1.5 py-0.5 text-xs font-medium text-warn">
                Sin validar
              </span>
              <span className="text-xs text-muted">
                {usage?.[type.id] ?? 0} en salas
              </span>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => act.mutate({ kind: 'confirm', id: type.id })}
                className="key key-accent h-10 px-3 text-sm"
              >
                Confirmar
              </button>

              <input
                type="text"
                value={renaming[type.id] ?? type.name}
                onChange={(e) => setRenaming((r) => ({ ...r, [type.id]: e.target.value }))}
                aria-label={`Nombre corregido de ${type.name}`}
                className="h-10 min-w-40 flex-1 rounded-ctl border border-line bg-surface px-2 text-sm"
              />
              <button
                type="button"
                disabled={(renaming[type.id] ?? type.name).trim() === type.name}
                onClick={() =>
                  act.mutate({
                    kind: 'rename',
                    id: type.id,
                    name: (renaming[type.id] ?? type.name).trim(),
                  })
                }
                className="key key-quiet h-10 px-3 text-sm"
              >
                Corregir nombre
              </button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                value={mergeInto[type.id] ?? ''}
                onChange={(e) => setMergeInto((m) => ({ ...m, [type.id]: e.target.value }))}
                aria-label={`Fusionar ${type.name} con`}
                className="h-10 min-w-40 flex-1 rounded-ctl border border-line bg-surface px-2 text-sm"
              >
                <option value="">Fusionar con…</option>
                {(confirmed ?? [])
                  .filter((c) => c.id !== type.id)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                disabled={!mergeInto[type.id]}
                onClick={() =>
                  act.mutate({ kind: 'merge', from: type.id, into: mergeInto[type.id]! })
                }
                className="key key-quiet h-10 px-3 text-sm"
              >
                Fusionar
              </button>
            </div>
          </li>
        ))}
      </ul>

      {act.isError && (
        <p className="mt-3 text-sm text-crit">
          No se pudo aplicar. Solo un coordinador puede tocar el catálogo.
        </p>
      )}

      <details className="mt-6">
        <summary className="cursor-pointer text-sm text-muted">
          Catálogo confirmado ({confirmed?.length ?? 0})
        </summary>
        <ul className="mt-2 divide-y divide-line-soft text-sm">
          {(confirmed ?? []).map((type) => (
            <li key={type.id} className="flex items-baseline justify-between gap-3 py-2">
              <span>
                {type.name}
                {type.aliases.length > 0 && (
                  <span className="ml-2 text-xs text-muted">
                    también: {type.aliases.join(', ')}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs text-muted">{usage?.[type.id] ?? 0}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}
