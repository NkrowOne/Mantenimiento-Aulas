import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { pullMaster } from '@/sync/pull'
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
 *    queda de alias, así que quien lo teclee mañana encuentra el corregido, y
 *    el nuevo baja hasta las etiquetas de cada sala: si en el aula sigue
 *    poniendo «Jabra», el renombrado no ha llegado a donde se lee.
 *  - **Agrupar**: ya existía con otras palabras. Se marcan los que son lo
 *    mismo, se elige cuál sobrevive y, si hace falta, se le pone el nombre
 *    bueno de una vez.
 *
 * Agrupar en bloque, y no fusionar de uno en uno, porque así es como llegan:
 * «Jabra», «Mic Jabra» y «Micro jabra» aparecen la misma semana y son el mismo
 * micrófono. De uno en uno hay que acertar primero cuál sobrevive para poder
 * renombrarlo después, y son tres pasadas para una sola decisión.
 */
export function AssetTypeTray(): React.ReactElement {
  const qc = useQueryClient()
  const [renaming, setRenaming] = useState<Record<string, string>>({})
  /** Los marcados para agrupar. */
  const [marcados, setMarcados] = useState<Set<string>>(new Set())
  const [destino, setDestino] = useState('')
  const [nombreFinal, setNombreFinal] = useState('')

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
    // Renombrar y agrupar cambian las etiquetas de los equipos en las salas, así
    // que el espejo de este dispositivo deja de ser cierto en el momento en que
    // se pulsa.
    void pullMaster()
  }

  const act = useMutation({
    mutationFn: async (input:
      | { kind: 'confirm'; id: string }
      | { kind: 'rename'; id: string; name: string }
      | { kind: 'group'; ids: string[]; into: string; name: string | null }) => {
      const { error } =
        input.kind === 'confirm'
          ? await supabase.rpc('confirm_asset_type', { p_id: input.id })
          : input.kind === 'rename'
            ? await supabase.rpc('rename_asset_type', { p_id: input.id, p_name: input.name })
            : await supabase.rpc('group_asset_types', {
                p_ids: input.ids,
                p_into: input.into,
                p_name: input.name,
              })
      if (error) throw error
    },
    onSuccess: () => {
      setMarcados(new Set())
      setDestino('')
      setNombreFinal('')
      invalidate()
    },
  })

  if (!pending) return <p className="text-sm text-muted">Cargando el catálogo…</p>

  const marcar = (id: string): void =>
    setMarcados((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const seleccionados = pending.filter((t) => marcados.has(t.id))
  /* Puede sobrevivir uno de los marcados —lo normal, porque todos son
     propuestas— o un tipo que ya estaba en el catálogo. */
  const destinos = [...seleccionados, ...(confirmed ?? [])]
  const tipoDestino = destinos.find((t) => t.id === destino) ?? null

  return (
    <section aria-labelledby="sec-tipos" className="mt-8">
      <div className="section-head">
        <h2 id="sec-tipos" className="eyebrow">
          Tipos de equipo sin validar
        </h2>
      </div>
      <p className="text-sm text-muted">
        Creados desde un aula. Se están usando ya; esto solo ordena el catálogo.
      </p>

      {pending.length === 0 && <p className="mt-3 text-sm text-muted">Nada pendiente de validar.</p>}

      <ul className="mt-3 divide-y divide-line">
        {pending.map((type) => (
          <li key={type.id} className="py-3">
            <label className="flex items-baseline gap-2">
              <input
                type="checkbox"
                checked={marcados.has(type.id)}
                onChange={() => marcar(type.id)}
                className="size-5 shrink-0 self-center accent-accent"
              />
              <span className="font-medium">{type.name}</span>
              <span className="rounded-tag bg-warn-tint px-1.5 py-0.5 text-xs font-medium text-warn">
                Sin validar
              </span>
              <span className="text-xs text-muted">{usage?.[type.id] ?? 0} en salas</span>
            </label>

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
          </li>
        ))}
      </ul>

      {/*
        El panel de agrupar aparece solo cuando hay algo marcado.
        Montado siempre sería un formulario de tres campos apagado en mitad de
        la pantalla, y lo que enseña —«estos tres son lo mismo»— no tiene
        sentido hasta que alguien ha dicho cuáles.
      */}
      {seleccionados.length > 0 && (
        <div className="card mt-4 p-4">
          <p className="text-sm font-medium">
            Agrupar {seleccionados.length} {seleccionados.length === 1 ? 'tipo' : 'tipos'}:{' '}
            <span className="font-normal text-muted">
              {seleccionados.map((t) => t.name).join(', ')}
            </span>
          </p>

          <div className="mt-3 grid gap-2">
            <label className="text-xs text-muted">
              Cuál sobrevive
              <select
                value={destino}
                onChange={(e) => setDestino(e.target.value)}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
              >
                <option value="">Elige el equipo bueno…</option>
                {seleccionados.length > 0 && (
                  <optgroup label="De los marcados">
                    {seleccionados.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Del catálogo ya validado">
                  {(confirmed ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>

            <label className="text-xs text-muted">
              Nombre definitivo (opcional)
              <input
                type="text"
                value={nombreFinal}
                onChange={(e) => setNombreFinal(e.target.value)}
                placeholder={tipoDestino ? `Se queda como «${tipoDestino.name}»` : 'Se queda como está'}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
              />
            </label>
          </div>

          {/*
            Lo que va a pasar, dicho antes de pulsar. Fusionar mueve equipos de
            treinta aulas y no tiene botón de deshacer: la cifra de al lado es lo
            único que distingue «junta dos propuestas de ayer» de «reescribe el
            inventario de medio campus».
          */}
          <p className="mt-3 text-xs text-muted">
            Los{' '}
            {seleccionados.reduce((n, t) => n + (usage?.[t.id] ?? 0), 0)} equipos de los marcados
            pasan a{' '}
            {nombreFinal.trim() || tipoDestino?.name || 'el que elijas'}, en todas las salas y con
            su etiqueta. Los nombres absorbidos se quedan como alias, así que quien los teclee
            seguirá encontrándolo.
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!destino || act.isPending}
              onClick={() =>
                act.mutate({
                  kind: 'group',
                  ids: seleccionados.map((t) => t.id),
                  into: destino,
                  name: nombreFinal.trim() || null,
                })
              }
              className="key key-accent min-h-11 px-3 text-sm"
            >
              Agrupar y validar
            </button>
            <button
              type="button"
              onClick={() => setMarcados(new Set())}
              className="key key-quiet min-h-11 px-3 text-sm text-muted"
            >
              Desmarcar
            </button>
          </div>
        </div>
      )}

      {act.isError && (
        <p className="mt-3 text-sm text-crit">
          {act.error instanceof Error
            ? act.error.message
            : 'No se pudo aplicar. Solo un coordinador puede tocar el catálogo.'}
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
                  <span className="ml-2 text-xs text-muted">también: {type.aliases.join(', ')}</span>
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
