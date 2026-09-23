import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { v7 as uuidv7 } from 'uuid'
import { supabase } from '@/lib/supabase'
import { fechaCorta } from '@/domain/fechas'
import type { Role } from '@/domain/types'
import { UnidadesDeAlmacen } from './UnidadesDeAlmacen'
import { MOTIVO_MIN, faltanParaElMotivo, motivoValido } from './motivo'

interface StockLevel {
  stock_item_id: string
  name: string
  unit: string
  min_threshold: number
  on_hand: number
  total_consumed: number
  below_threshold: boolean
}

/** Un artículo retirado del almacén: fuera de la lista, pero no de la base. */
interface ArticuloRetirado {
  id: string
  name: string
  retired_at: string | null
  retired_reason: string | null
}

/** Lo que el administrador tiene abierto en una fila: el nombre, o el motivo de retirarla. */
type Edicion = { id: string; que: 'renombrar' | 'retirar' }

/**
 * Almacén.
 *
 * `on_hand` no es un campo editable sino `SUM(qty)` sobre los movimientos. Por
 * eso aquí no se "corrige el stock": se registra una entrada, una salida o un
 * ajuste, y el saldo se recalcula solo.
 *
 * Eso descarta el descuadre de teclear una cifra a mano, que es de donde salían
 * los negativos de la hoja Bolsa, pero no el de restar más de lo que hay: de
 * eso se encarga el disparador `stock_movements_no_negativo`. Aquí el `−` sale
 * apagado a cero, que es la mitad amable de la misma regla.
 */
/**
 * El texto del fallo, venga de donde venga.
 *
 * `fetch` lanza un `Error`; PostgREST devuelve un objeto pelado
 * —`{ message, code, hint }`— que supabase-js reenvía tal cual. Preguntar solo
 * por `instanceof Error` daba falso justo para los fallos del servidor, que son
 * los únicos que traen algo que traducir.
 */
function mensajeDe(error: unknown): string {
  if (error instanceof Error) return error.message
  const m = (error as { message?: unknown } | null)?.message
  return typeof m === 'string' ? m : ''
}

function codigoDe(error: unknown): string {
  const c = (error as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : ''
}

/**
 * ¿El fallo es de red o del servidor?
 *
 * Es la única distinción que cambia lo que el técnico hace después: buscar
 * cobertura, o hablar con administración.
 */
function esFalloDeRed(error: unknown): boolean {
  return /fetch|network|failed to fetch|networkerror|load failed/i.test(mensajeDe(error))
}

/**
 * El movimiento dejaría el almacén en negativo.
 *
 * El botón `−` ya sale apagado a cero, así que esto salta cuando la cifra de la
 * pantalla se ha quedado vieja: otro técnico gastó la última unidad hace un
 * minuto. Sin distinguirlo, el mensaje que aparecía era «Solo un supervisor
 * registra compras», que manda a pedir un permiso que no falta.
 */
function esSinExistencias(error: unknown): boolean {
  return /no hay tantas unidades|en negativo/i.test(mensajeDe(error))
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
  if (codigoDe(error) === '23505') return true
  return /duplicate key|stock_items_norm_idx|already exists|ya hay otro artículo/i.test(mensajeDe(error))
}

/** El servidor ha dicho que no por el rol: el botón no debía estar, o el rol cambió después de abrir. */
function esFaltaDePermiso(error: unknown): boolean {
  return codigoDe(error) === '42501' || /solo un administrador|insufficient_privilege/i.test(mensajeDe(error))
}

/**
 * Qué decir cuando retirar, restaurar o renombrar ha fallado. Los mensajes de
 * la base ya vienen en español y dicen qué pasó («Ese artículo ya está
 * retirado»); solo los dos que llegan en jerga se traducen.
 */
function falloDeAdministracion(error: unknown): string {
  if (esFaltaDePermiso(error)) return 'Solo un administrador puede hacer esto.'
  if (esDuplicado(error)) return 'Ya hay otro artículo con ese nombre: búscalo en la lista.'
  if (!navigator.onLine || esFalloDeRed(error)) return 'Sin conexión: no se ha guardado. Busca cobertura y repítelo.'
  return mensajeDe(error) || 'No se ha podido guardar.'
}

export function StockPage({ role }: { role: Role }): React.ReactElement {
  const qc = useQueryClient()
  const [filter, setFilter] = useState('')
  const [onlyLow, setOnlyLow] = useState(false)
  const [alta, setAlta] = useState(false)
  const [edicion, setEdicion] = useState<Edicion | null>(null)
  const [verRetirados, setVerRetirados] = useState(false)
  const [falloAdmin, setFalloAdmin] = useState<string | null>(null)
  const esAdmin = role === 'admin'

  const { data: levels, isPending, isError, refetch } = useQuery({
    queryKey: ['stock-levels'],
    queryFn: async (): Promise<StockLevel[]> => {
      const { data, error } = await supabase.from('stock_levels').select('*').order('name')
      if (error) throw error
      return (data ?? []) as StockLevel[]
    },
  })

  /**
   * El id viaja **dentro** del movimiento, no se genera al enviarlo.
   *
   * Se generaba dentro del `mutationFn`, así que cada reintento llevaba id
   * nuevo. El caso para el que existe el botón «Reintentar» es justo el peor:
   * la inserción llegó al servidor y se perdió la respuesta. Con id nuevo, ese
   * reintento registraba un segundo consumo del mismo cable —y como el saldo es
   * la suma y un movimiento ya no se puede borrar, para arreglarlo hace falta
   * un tercero—. Naciendo el id con la pulsación, reenviarlo es no hacer nada.
   */
  type Movimiento = {
    id: string
    itemId: string
    qty: number
    kind: 'compra' | 'consumo' | 'ajuste'
  }
  const [ultimo, setUltimo] = useState<Movimiento | null>(null)

  const move = useMutation({
    mutationFn: async (input: Movimiento) => {
      const { data } = await supabase.auth.getSession()
      const { error } = await supabase.from('stock_movements').upsert(
        {
          id: input.id,
          stock_item_id: input.itemId,
          qty: input.qty,
          kind: input.kind,
          occurred_at: new Date().toISOString(),
          by_user: data.session?.user.id ?? null,
        },
        // `ignoreDuplicates` y no un upsert normal: el reenvío tiene que ser un
        // no-op, nunca una reescritura del asiento que ya está puesto.
        { onConflict: 'id', ignoreDuplicates: true },
      )
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

  /*
   * Retirar, restaurar y renombrar: de administrador, y lo decide la base
   * (`is_admin()` en cada función). La pantalla esconde los botones al resto
   * por lo mismo que esconde «Nuevo artículo»: un botón que el servidor va a
   * rechazar no es un permiso. Retirar pide un motivo de diez caracteres, que
   * también comprueba la base; aquí solo se evita mandar lo que va a volver.
   *
   * Nada de esto borra: el artículo retirado sale de la lista y deja de
   * contarse, y sus movimientos, las incidencias que lo citan y los
   * ordenadores instalados en las aulas siguen donde estaban. Por eso hay
   * «Restaurar».
   */
  const retirar = useMutation({
    mutationFn: async (input: { id: string; motivo: string }) => {
      const { error } = await supabase.rpc('stock_item_retirar', { p_item: input.id, p_motivo: input.motivo.trim() })
      if (error) throw error
    },
    onSuccess: () => {
      setEdicion(null)
      setFalloAdmin(null)
      void qc.invalidateQueries({ queryKey: ['stock-levels'] })
      void qc.invalidateQueries({ queryKey: ['stock-retirados'] })
    },
    onError: (e: unknown) => setFalloAdmin(falloDeAdministracion(e)),
  })

  const restaurar = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc('stock_item_restaurar', { p_item: id })
      if (error) throw error
    },
    onSuccess: () => {
      setFalloAdmin(null)
      void qc.invalidateQueries({ queryKey: ['stock-levels'] })
      void qc.invalidateQueries({ queryKey: ['stock-retirados'] })
    },
    onError: (e: unknown) => setFalloAdmin(falloDeAdministracion(e)),
  })

  /*
   * El nombre anterior se queda como alias (lo hace la base): el Excel y los
   * partes lo seguirán escribiendo como siempre y se seguirá encontrando.
   */
  const renombrar = useMutation({
    mutationFn: async (input: { id: string; nombre: string }) => {
      const { error } = await supabase.rpc('stock_item_renombrar', { p_item: input.id, p_nombre: input.nombre.trim() })
      if (error) throw error
    },
    onSuccess: () => {
      setEdicion(null)
      setFalloAdmin(null)
      void qc.invalidateQueries({ queryKey: ['stock-levels'] })
    },
    onError: (e: unknown) => setFalloAdmin(falloDeAdministracion(e)),
  })

  /* Los retirados solo se piden cuando el administrador los quiere ver. */
  const retirados = useQuery({
    queryKey: ['stock-retirados'],
    queryFn: async (): Promise<ArticuloRetirado[]> => {
      const { data, error } = await supabase
        .from('stock_items')
        .select('id, name, retired_at, retired_reason')
        .eq('active', false)
        .order('retired_at', { ascending: false, nullsFirst: false })
        .order('name')
      if (error) throw error
      return (data ?? []) as ArticuloRetirado[]
    },
    enabled: esAdmin && verRetirados,
  })

  const ocupadoAdmin = retirar.isPending || restaurar.isPending || renombrar.isPending

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
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base"
              />
            </label>
            <label className="w-24 text-sm">
              <span className="text-muted">Unidad</span>
              <input
                name="unit"
                defaultValue="ud"
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base"
              />
            </label>
            <label className="w-24 text-sm">
              <span className="text-muted">Mínimo</span>
              <input
                name="min_threshold"
                type="number"
                min={0}
                defaultValue={0}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base"
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
                  No se ha podido crear: {mensajeDe(crear.error) || 'error desconocido'}
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
          className="h-11 min-w-48 flex-1 rounded-ctl border border-line bg-surface px-3 text-base"
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
              <FilaDeArticulo
                key={l.stock_item_id}
                nivel={l}
                esAdmin={esAdmin}
                ocupado={move.isPending}
                ocupadoAdmin={ocupadoAdmin}
                edicion={edicion?.id === l.stock_item_id ? edicion.que : null}
                onAbrir={(que) => {
                  setFalloAdmin(null)
                  setEdicion(que ? { id: l.stock_item_id, que } : null)
                }}
                onMover={(qty, kind) => move.mutate({ id: uuidv7(), itemId: l.stock_item_id, qty, kind })}
                onRenombrar={(nombre) => renombrar.mutate({ id: l.stock_item_id, nombre })}
                onRetirar={(motivo) => retirar.mutate({ id: l.stock_item_id, motivo })}
              />
            ))}
          </tbody>
        </table>
      </div>

      {falloAdmin && <p className="mt-3 rounded-ctl bg-crit-fill p-3 text-sm text-crit-ink">{falloAdmin}</p>}

      {esAdmin && (
        <section className="mt-6">
          <button
            type="button"
            onClick={() => setVerRetirados((v) => !v)}
            aria-expanded={verRetirados}
            className="key key-quiet min-h-11 px-3 text-sm"
          >
            {verRetirados ? 'Ocultar los artículos retirados' : 'Ver los artículos retirados'}
          </button>
          {verRetirados && (
            <div className="mt-3">
              {retirados.isPending && <p className="text-sm text-muted">Cargando…</p>}
              {retirados.isError && <p className="text-sm text-crit">No se han podido leer los artículos retirados.</p>}
              {retirados.data && retirados.data.length === 0 && (
                <p className="text-sm text-muted">No hay ningún artículo retirado.</p>
              )}
              {retirados.data && retirados.data.length > 0 && (
                <ul className="divide-y divide-hair">
                  {retirados.data.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                      <span className="text-sm">{a.name}</span>
                      <span className="text-xs text-muted">
                        {a.retired_at ? `Retirado el ${fechaCorta(a.retired_at)}` : 'Retirado'}
                        {a.retired_reason ? ` · ${a.retired_reason}` : ''}
                      </span>
                      <button
                        type="button"
                        disabled={ocupadoAdmin}
                        onClick={() => restaurar.mutate(a.id)}
                        className="key key-quiet ml-auto h-10 px-3 text-sm"
                      >
                        Restaurar
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

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
          {esSinExistencias(move.error) ? (
            <>
              <p className="text-sm text-crit">
                No quedan tantas unidades: el movimiento no se ha registrado.
              </p>
              <p className="mt-1 text-sm text-muted">
                Las existencias no pueden quedar en negativo. Si el material está en el almacén
                pero la cifra dice que no, falta por apuntar la compra que lo trajo.
              </p>
            </>
          ) : !navigator.onLine || esFalloDeRed(move.error) ? (
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
              move.mutate({ id: uuidv7(), itemId: ultimo.itemId, qty: -ultimo.qty, kind: 'ajuste' })
              setUltimo(null)
            }}
            className="key key-quiet min-h-11 shrink-0 px-3 text-sm"
          >
            Deshacer
          </button>
        </div>
      )}

      <UnidadesDeAlmacen role={role} />
    </div>
  )
}

/**
 * Una fila del almacén: el artículo, sus existencias y los botones de mover.
 * Para el administrador, además, «Renombrar» y «Retirar», que se abren debajo
 * de la fila —como el instalar y la baja de los ordenadores— en vez de en un
 * diálogo que tape la lista.
 */
function FilaDeArticulo({
  nivel,
  esAdmin,
  ocupado,
  ocupadoAdmin,
  edicion,
  onAbrir,
  onMover,
  onRenombrar,
  onRetirar,
}: {
  nivel: StockLevel
  esAdmin: boolean
  ocupado: boolean
  ocupadoAdmin: boolean
  edicion: Edicion['que'] | null
  onAbrir: (que: Edicion['que'] | null) => void
  onMover: (qty: number, kind: 'compra' | 'consumo') => void
  onRenombrar: (nombre: string) => void
  onRetirar: (motivo: string) => void
}): React.ReactElement {
  const l = nivel
  const [nombre, setNombre] = useState(l.name)
  const [motivo, setMotivo] = useState('')
  const idMotivo = `retirar-motivo-${l.stock_item_id}`
  const nombreCambiado = nombre.trim() !== '' && nombre.trim() !== l.name

  return (
    <>
      <tr>
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
          {esAdmin && edicion === null && (
            <span className="mt-1 flex flex-wrap gap-x-3 text-xs">
              <button
                type="button"
                disabled={ocupadoAdmin}
                onClick={() => {
                  setNombre(l.name)
                  onAbrir('renombrar')
                }}
                className="min-h-8 text-muted underline-offset-2 hover:underline"
              >
                Renombrar
              </button>
              <button
                type="button"
                disabled={ocupadoAdmin}
                onClick={() => {
                  setMotivo('')
                  onAbrir('retirar')
                }}
                className="min-h-8 text-muted underline-offset-2 hover:text-crit hover:underline"
              >
                Retirar
              </button>
            </span>
          )}
        </td>
        <td className={`py-2 text-right font-mono tabular ${l.below_threshold ? 'text-crit' : ''}`}>
          {l.on_hand}
        </td>
        <td className="py-2 text-right font-mono text-muted tabular">{l.min_threshold || '—'}</td>
        <td className="py-2 text-right">
          <span className="inline-flex gap-2">
            {/* Deshabilitados mientras vuela el anterior: la cifra no se
                movía hasta que volvía el servidor, así que el técnico
                pulsaba otra vez y se registraban dos movimientos. */}
            {/* Y a cero, el `−` no lleva a ningún sitio: el servidor lo
                rechaza. Enseñarlo pulsable es prometer algo que no va a
                pasar, y el técnico se entera cuatro toques después. */}
            <button
              type="button"
              disabled={ocupado || l.on_hand <= 0}
              onClick={() => onMover(-1, 'consumo')}
              className="key key-quiet h-11 w-11"
              aria-label={l.on_hand <= 0 ? `No quedan unidades de ${l.name}` : `Consumir una unidad de ${l.name}`}
            >
              −
            </button>
            <button
              type="button"
              disabled={ocupado}
              onClick={() => onMover(1, 'compra')}
              className="key key-quiet h-11 w-11"
              aria-label={`Añadir una unidad de ${l.name}`}
            >
              +
            </button>
          </span>
        </td>
      </tr>

      {edicion === 'renombrar' && (
        <tr>
          <td colSpan={4} className="pb-3">
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (nombreCambiado) onRenombrar(nombre)
              }}
            >
              <input
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                aria-label={`Nuevo nombre de ${l.name}`}
                autoFocus
                required
                className="h-10 min-w-56 flex-1 rounded-ctl border border-line bg-surface px-2 text-base"
              />
              <button type="submit" disabled={ocupadoAdmin || !nombreCambiado} className="key key-accent h-10 px-3 text-sm">
                Guardar el nombre
              </button>
              <button type="button" className="key key-quiet h-10 px-3 text-sm" onClick={() => onAbrir(null)}>
                Cancelar
              </button>
              <p className="basis-full text-xs text-muted">
                El nombre de ahora se queda como alias: el Excel y los partes que lo escriban como siempre lo
                seguirán encontrando.
              </p>
            </form>
          </td>
        </tr>
      )}

      {edicion === 'retirar' && (
        <tr>
          <td colSpan={4} className="pb-3">
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (motivoValido(motivo)) onRetirar(motivo)
              }}
            >
              <input
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder={`Por qué se retira (mínimo ${MOTIVO_MIN} caracteres)`}
                aria-label={`Motivo para retirar ${l.name}`}
                aria-describedby={idMotivo}
                minLength={MOTIVO_MIN}
                required
                autoFocus
                className="h-10 min-w-56 flex-1 rounded-ctl border border-line bg-surface px-2 text-base"
              />
              <button type="submit" disabled={ocupadoAdmin || !motivoValido(motivo)} className="key key-quiet h-10 px-3 text-sm">
                Retirar del almacén
              </button>
              <button type="button" className="key key-quiet h-10 px-3 text-sm" onClick={() => onAbrir(null)}>
                Cancelar
              </button>
              {/* Qué va a pasar, y cuánto falta, en vez de un botón apagado sin explicación. */}
              <p id={idMotivo} className="basis-full text-xs text-muted">
                {faltanParaElMotivo(motivo) > 0
                  ? `El motivo es obligatorio: faltan ${faltanParaElMotivo(motivo)} caracteres.`
                  : 'Con este motivo el artículo sale del almacén y deja de contarse.'}{' '}
                No se borra nada: sus movimientos, las incidencias que lo citan y lo ya instalado en las aulas
                siguen igual, y se puede restaurar.
                {l.on_hand > 0 && ` Ahora mismo quedan ${l.on_hand} ${l.unit}: dejarán de verse hasta que se restaure.`}
              </p>
            </form>
          </td>
        </tr>
      )}
    </>
  )
}
