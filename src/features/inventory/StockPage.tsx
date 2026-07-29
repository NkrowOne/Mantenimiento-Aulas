import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { v7 as uuidv7 } from 'uuid'
import { supabase } from '@/lib/supabase'
import type { Role } from '@/domain/types'

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
/**
 * ¿El fallo es de red o del servidor?
 *
 * Es la única distinción que cambia lo que el técnico hace después: buscar
 * cobertura, o hablar con administración.
 */
function esFalloDeRed(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /fetch|network|failed to fetch|networkerror|load failed/i.test(error.message)
}

/**
 * El nombre ya existe con otras mayúsculas o tildes.
 *
 * Lo frena el índice único sobre el nombre normalizado, que es lo que impide
 * que vuelvan a convivir «Teclado» y «teclado». Sin traducirlo, el técnico ve
 * `duplicate key value violates unique constraint "stock_items_norm_idx"` y
 * concluye que la aplicación está rota, cuando lo que pasa es que el artículo
 * que quiere crear ya está en la lista dos filas más arriba.
 */
function esDuplicado(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  if (code === '23505') return true
  if (!(error instanceof Error)) return false
  return /duplicate key|stock_items_norm_idx|already exists/i.test(error.message)
}

export function StockPage({ role }: { role: Role }): React.ReactElement {
  const qc = useQueryClient()
  const [filter, setFilter] = useState('')
  const [onlyLow, setOnlyLow] = useState(false)
  const [alta, setAlta] = useState(false)
  const esAdmin = role === 'admin'

  const { data: levels, isPending, isError, refetch } = useQuery({
    queryKey: ['stock-levels'],
    queryFn: async (): Promise<StockLevel[]> => {
      const { data, error } = await supabase.from('stock_levels').select('*').order('name')
      if (error) throw error
      return (data ?? []) as StockLevel[]
    },
  })

  type Movimiento = { itemId: string; qty: number; kind: 'compra' | 'consumo' | 'ajuste' }
  const [ultimo, setUltimo] = useState<Movimiento | null>(null)

  const move = useMutation({
    mutationFn: async (input: Movimiento) => {
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
    onSuccess: (_data, input) => {
      // Un movimiento no se puede editar ni borrar —el saldo es la suma— así que
      // lo único que puede deshacerlo es el movimiento contrario. Se ofrece
      // durante unos segundos, que es cuando uno se da cuenta del dedazo.
      setUltimo(input)
      void qc.invalidateQueries({ queryKey: ['stock-levels'] })
    },
  })

  /**
   * Alta de artículo.
   *
   * Faltaba entera: el almacén sabía sumar y restar unidades de lo que ya
   * existía, pero no había forma —desde la aplicación— de crear el artículo
   * primero. Con la lista vacía eso dejaba la pantalla en un callejón sin
   * salida, y con datos obligaba a entrar en la base de datos a mano para algo
   * tan corriente como empezar a llevar la cuenta de un consumible nuevo.
   *
   * Es de admin porque así lo dice RLS: la política «admin escribe stock_items»
   * es la que decide de verdad, y ofrecer el botón a un supervisor solo serviría
   * para que el servidor le dijera que no.
   */
  const crear = useMutation({
    mutationFn: async (input: { name: string; unit: string; min_threshold: number }) => {
      const { error } = await supabase.from('stock_items').insert({
        name: input.name,
        unit: input.unit || 'ud',
        min_threshold: input.min_threshold,
        active: true,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setAlta(false)
      void qc.invalidateQueries({ queryKey: ['stock-levels'] })
    },
  })

  const rows = (levels ?? [])
    .filter((l) => l.name.toLowerCase().includes(filter.toLowerCase()))
    .filter((l) => !onlyLow || l.below_threshold)

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Almacén</h1>
        {esAdmin && (
          <button
            type="button"
            onClick={() => setAlta((v) => !v)}
            className="key key-accent min-h-11 shrink-0 px-3 text-sm"
          >
            {alta ? 'Cancelar' : 'Nuevo artículo'}
          </button>
        )}
      </div>

      {alta && (
        <form
          className="card mt-4 p-4"
          onSubmit={(e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            const name = String(f.get('name') ?? '').trim()
            if (!name) return
            crear.mutate({
              name,
              unit: String(f.get('unit') ?? '').trim(),
              min_threshold: Number(f.get('min_threshold') ?? 0) || 0,
            })
          }}
        >
          <div className="flex flex-wrap gap-3">
            <label className="flex-1 text-sm">
              <span className="text-muted">Nombre</span>
              <input
                name="name"
                required
                autoFocus
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-sm"
              />
            </label>
            <label className="w-24 text-sm">
              <span className="text-muted">Unidad</span>
              <input
                name="unit"
                defaultValue="ud"
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-sm"
              />
            </label>
            <label className="w-24 text-sm">
              <span className="text-muted">Mínimo</span>
              <input
                name="min_threshold"
                type="number"
                min={0}
                defaultValue={0}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-sm"
              />
            </label>
          </div>
          {crear.isError && (
            <p className="mt-3 text-sm text-crit">
              {esDuplicado(crear.error) ? (
                <>
                  Ese artículo ya está en la lista, escrito con otras mayúsculas o tildes.
                  Búscalo arriba en vez de crearlo otra vez.
                </>
              ) : (
                <>
                  No se ha podido crear:{' '}
                  {crear.error instanceof Error ? crear.error.message : String(crear.error)}
                </>
              )}
            </p>
          )}
          <button
            type="submit"
            disabled={crear.isPending}
            className="key key-accent mt-3 min-h-11 px-4 text-sm"
          >
            {crear.isPending ? 'Creando…' : 'Crear artículo'}
          </button>
        </form>
      )}


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
                  <span className="inline-flex gap-2">
                    {/* Deshabilitados mientras vuela el anterior: la cifra no se
                        movía hasta que volvía el servidor, así que el técnico
                        pulsaba otra vez y se registraban dos movimientos. */}
                    <button
                      type="button"
                      disabled={move.isPending}
                      onClick={() => move.mutate({ itemId: l.stock_item_id, qty: -1, kind: 'consumo' })}
                      className="key key-quiet h-11 w-11"
                      aria-label={`Consumir una unidad de ${l.name}`}
                    >
                      −
                    </button>
                    <button
                      type="button"
                      disabled={move.isPending}
                      onClick={() => move.mutate({ itemId: l.stock_item_id, qty: 1, kind: 'compra' })}
                      className="key key-quiet h-11 w-11"
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

      {isPending && <p className="mt-6 text-sm text-muted">Cargando el almacén…</p>}

      {isError && (
        <div className="card mt-6 p-4">
          <p className="text-sm text-crit">No se ha podido leer el almacén.</p>
          <p className="mt-1 text-sm text-muted">Esta pantalla necesita conexión.</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="key key-quiet mt-3 min-h-11 px-3 text-sm"
          >
            Reintentar
          </button>
        </div>
      )}

      {/*
        «Ningún artículo coincide» decía lo mismo con el filtro puesto que con el
        almacén entero vacío, y son dos problemas distintos: uno se arregla
        borrando lo escrito y el otro no se arregla desde aquí. Con cero
        artículos y sin filtro, además, casi nunca es que el almacén esté vacío:
        es que el servidor no ha dejado leerlo —RLS devuelve una lista vacía sin
        error—, y eso hay que decirlo o no hay forma de averiguarlo.
      */}
      {!isPending && !isError && rows.length === 0 && (
        <div className="mt-6 text-sm text-muted">
          {(levels?.length ?? 0) > 0 ? (
            <p>Ningún artículo coincide con el filtro.</p>
          ) : (
            <>
              <p>El almacén no tiene ningún artículo.</p>
              <p className="mt-1">
                Si debería tenerlos, el servidor no te está dejando leerlos: revisa que tu token
                lleve el rol (claim <span className="font-mono">app_role</span>) y que tu perfil
                tenga uno asignado.
              </p>
              {esAdmin && !alta && (
                <button
                  type="button"
                  onClick={() => setAlta(true)}
                  className="key key-accent mt-3 min-h-11 px-3 text-sm"
                >
                  Crear el primer artículo
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/*
        El mensaje distinguía nada: decía «Solo un supervisor registra compras»
        tanto si faltaba el permiso como si el técnico estaba en un sótano sin
        cobertura, que es el caso frecuente. Se iba convencido de que le faltaba
        un rol. Esta pantalla escribe directa contra el servidor, sin cola.
      */}
      {move.isError && (
        <div className="card mt-4 p-4">
          {!navigator.onLine || esFalloDeRed(move.error) ? (
            <>
              <p className="text-sm text-crit">
                Sin conexión: el movimiento no se ha registrado.
              </p>
              <p className="mt-1 text-sm text-muted">
                El almacén se apunta contra el servidor en el momento, a diferencia de
                las revisiones. Busca cobertura y repítelo.
              </p>
              <button
                type="button"
                disabled={!move.variables}
                onClick={() => move.variables && move.mutate(move.variables)}
                className="key key-quiet mt-3 min-h-11 px-3 text-sm"
              >
                Reintentar
              </button>
            </>
          ) : (
            <p className="text-sm text-crit">Solo un supervisor registra compras.</p>
          )}
        </div>
      )}

      {/* Deshacer: el movimiento contrario, que es la única forma de corregir un
          saldo que se calcula sumando. */}
      {ultimo && !move.isPending && !move.isError && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-ctl border border-line bg-surface px-3 py-2">
          <span className="text-sm text-muted">
            {ultimo.qty > 0 ? 'Añadida' : 'Consumida'} 1 unidad.
          </span>
          <button
            type="button"
            onClick={() => {
              move.mutate({ itemId: ultimo.itemId, qty: -ultimo.qty, kind: 'ajuste' })
              setUltimo(null)
            }}
            className="key key-quiet min-h-11 shrink-0 px-3 text-sm"
          >
            Deshacer
          </button>
        </div>
      )}
    </div>
  )
}
