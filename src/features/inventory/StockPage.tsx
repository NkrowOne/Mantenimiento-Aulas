import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { v7 as uuidv7 } from 'uuid'
import { supabase } from '@/lib/supabase'

interface StockLevel {
  stock_item_id: string
  name: string
  unit: string
  min_threshold: number
  on_hand: number
  total_consumed: number
  below_threshold: boolean
}

/**
 * Almacén.
 *
 * `on_hand` no es un campo editable sino `SUM(qty)` sobre los movimientos. Por
 * eso aquí no se "corrige el stock": se registra una entrada, una salida o un
 * ajuste, y el saldo se recalcula solo. Es lo que impide que vuelva a haber
 * saldos negativos como los de la hoja Bolsa.
 */
export function StockPage(): React.ReactElement {
  const qc = useQueryClient()
  const [filter, setFilter] = useState('')
  const [onlyLow, setOnlyLow] = useState(false)

  const { data: levels } = useQuery({
    queryKey: ['stock-levels'],
    queryFn: async (): Promise<StockLevel[]> => {
      const { data } = await supabase.from('stock_levels').select('*').order('name')
      return (data ?? []) as StockLevel[]
    },
  })

  const move = useMutation({
    mutationFn: async (input: { itemId: string; qty: number; kind: 'compra' | 'consumo' | 'ajuste' }) => {
      const { data: user } = await supabase.auth.getUser()
      const { error } = await supabase.from('stock_movements').insert({
        id: uuidv7(),
        stock_item_id: input.itemId,
        qty: input.qty,
        kind: input.kind,
        occurred_at: new Date().toISOString(),
        by_user: user.user?.id ?? null,
      })
      if (error) throw error
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['stock-levels'] }),
  })

  const rows = (levels ?? [])
    .filter((l) => l.name.toLowerCase().includes(filter.toLowerCase()))
    .filter((l) => !onlyLow || l.below_threshold)

  return (
    <div className="mx-auto max-w-4xl p-4">
      <h1 className="text-xl font-semibold">Almacén</h1>


      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Buscar artículo"
          className="h-11 min-w-48 flex-1 rounded-ctl border border-line bg-surface px-3 text-sm"
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} />
          Solo bajo mínimo
        </label>
      </div>

      <div className="scroll-x mt-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="py-2 font-medium text-muted">Artículo</th>
              <th className="py-2 text-right font-medium text-muted">Existencias</th>
              <th className="py-2 text-right font-medium text-muted">Mínimo</th>
              <th className="py-2 text-right font-medium text-muted">Movimiento</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((l) => (
              <tr key={l.stock_item_id}>
                <td className="py-2 pr-2">
                  <span className="flex items-center gap-2">
                    {l.below_threshold && (
                      <span
                        aria-label="Bajo mínimo"
                        className="rounded-tag bg-crit-tint px-1.5 py-0.5 text-xs font-semibold text-crit"
                      >
                        !
                      </span>
                    )}
                    {l.name}
                  </span>
                </td>
                <td
                  className={`py-2 text-right font-mono tabular ${
                    l.below_threshold ? 'text-crit' : ''
                  }`}
                >
                  {l.on_hand}
                </td>
                <td className="py-2 text-right font-mono text-muted tabular">
                  {l.min_threshold || '—'}
                </td>
                <td className="py-2 text-right">
                  <span className="inline-flex gap-1">
                    <button
                      type="button"
                      onClick={() => move.mutate({ itemId: l.stock_item_id, qty: -1, kind: 'consumo' })}
                      className="h-9 w-9 rounded-ctl border border-line font-semibold"
                      aria-label={`Consumir una unidad de ${l.name}`}
                    >
                      −
                    </button>
                    <button
                      type="button"
                      onClick={() => move.mutate({ itemId: l.stock_item_id, qty: 1, kind: 'compra' })}
                      className="h-9 w-9 rounded-ctl border border-line font-semibold"
                      aria-label={`Añadir una unidad de ${l.name}`}
                    >
                      +
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && <p className="mt-6 text-sm text-muted">Ningún artículo coincide.</p>}
      {move.isError && (
        <p className="mt-4 text-sm text-crit">
          Solo un supervisor registra compras.
        </p>
      )}
    </div>
  )
}
