import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { v7 as uuidv7 } from 'uuid'
import { HojaDeAcciones } from '@/components/HojaDeAcciones'
import { supabase } from '@/lib/supabase'
import { pullMaster } from '@/sync/pull'
import type { Role } from '@/domain/types'
import { UnidadesDeAlmacen } from './UnidadesDeAlmacen'

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
  return /duplicate key|stock_items_norm_idx|already exists/i.test(mensajeDe(error))
}

/**
 * Por qué no se ha cambiado el nombre, en una frase.
 *
 * Lo que dice `rename_stock_item` va tal cual: está escrito para esta pantalla
 * y nombra el artículo con el que choca. Solo se traducen los dos fallos que no
 * redacta ella: la red, y el índice único cuando dos administradores ponen el
 * mismo nombre a la vez y los dos pasan su comprobación antes de guardar.
 */
function falloDelRenombrado(error: unknown): string {
  if (!navigator.onLine || esFalloDeRed(error)) {
    return 'Sin conexión: el nombre no se ha cambiado. Busca cobertura y repítelo.'
  }
  if (esDuplicado(error)) {
    return 'Ya hay otro artículo con ese nombre, escrito con otras mayúsculas o tildes.'
  }
  return mensajeDe(error) || 'No se ha podido cambiar el nombre.'
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

  /**
   * Cambiar el nombre de un artículo.
   *
   * Por `rename_stock_item` y no con un `update` de la fila, aunque la política
   * deje al admin escribir la tabla: el nombre es la llave con la que el Excel
   * encuentra el artículo. La función deja el de antes como alias y no deja
   * quitarle el nombre a otro artículo; un `update` a secas dejaría la fila del
   * libro sin artículo en la siguiente pasada, y esa pasada ofrecería darlo de
   * alta otra vez.
   */
  const [renombrando, setRenombrando] = useState<{ id: string; nombre: string } | null>(null)
  const [nombreNuevo, setNombreNuevo] = useState('')
  /* Lo marca el propio campo al cambiar, como en `HojaDeMaestro`: con algo
     tecleado, un roce en el velo no puede llevárselo. */
  const [tocado, setTocado] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)

  const renombrar = useMutation({
    mutationFn: async (input: { id: string; antes: string; nombre: string }) => {
      const { error } = await supabase.rpc('rename_stock_item', {
        p_id: input.id,
        p_name: input.nombre,
      })
      if (error) throw error
    },
    onSuccess: (_data, input) => {
      // Solo si la hoja abierta sigue siendo la de este artículo: se puede
      // cancelar con el guardado en vuelo y abrir la de otro.
      setRenombrando((r) => (r?.id === input.id ? null : r))
      // La lista vuelve ordenada por nombre, así que la fila cambia de sitio
      // —o sale de la lista, si el filtro ya no la recoge—: la frase dice qué
      // ha pasado aunque la fila ya no esté donde se pulsó.
      setAviso(`«${input.antes}» pasa a llamarse «${input.nombre}».`)
      void qc.invalidateQueries({ queryKey: ['stock-levels'] })
      // El buscador de material de los partes no lee esta lista sino el
      // espejo local, que sin esto seguiría ofreciendo el nombre viejo hasta el
      // siguiente refresco.
      void pullMaster()
    },
  })

  const abrirRenombrado = (l: StockLevel): void => {
    renombrar.reset()
    setAviso(null)
    setTocado(false)
    setNombreNuevo(l.name)
    setRenombrando({ id: l.stock_item_id, nombre: l.name })
  }

  const nombreLimpio = nombreNuevo.trim()
  const puedeRenombrar =
    renombrando !== null &&
    !renombrar.isPending &&
    nombreLimpio !== '' &&
    nombreLimpio !== renombrando.nombre

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

      {/* Montada siempre, vacía hasta que hay algo que decir: una región viva
          que nace a la vez que su texto es justo la que VoiceOver se salta. */}
      <p role="status" className={aviso ? 'mt-3 text-sm text-ok' : 'sr-only'}>
        {aviso ?? ''}
      </p>

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
                    {/* El nombre se corrige donde se lee mal. Sigue pareciendo
                        texto —es la columna que se lee, no un botón más de la
                        fila— y el subrayado punteado es la única pista de que
                        se puede tocar. */}
                    {esAdmin ? (
                      <button
                        type="button"
                        onClick={() => abrirRenombrado(l)}
                        aria-label={`Cambiar el nombre de ${l.name}`}
                        className="min-h-11 text-left underline decoration-muted/60 decoration-dotted underline-offset-4"
                      >
                        {l.name}
                      </button>
                    ) : (
                      l.name
                    )}
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
                    {/* Y a cero, el `−` no lleva a ningún sitio: el servidor lo
                        rechaza. Enseñarlo pulsable es prometer algo que no va a
                        pasar, y el técnico se entera cuatro toques después. */}
                    <button
                      type="button"
                      disabled={move.isPending || l.on_hand <= 0}
                      onClick={() =>
                        move.mutate({
                          id: uuidv7(),
                          itemId: l.stock_item_id,
                          qty: -1,
                          kind: 'consumo',
                        })
                      }
                      className="key key-quiet h-11 w-11"
                      aria-label={
                        l.on_hand <= 0
                          ? `No quedan unidades de ${l.name}`
                          : `Consumir una unidad de ${l.name}`
                      }
                    >
                      −
                    </button>
                    <button
                      type="button"
                      disabled={move.isPending}
                      onClick={() =>
                        move.mutate({
                          id: uuidv7(),
                          itemId: l.stock_item_id,
                          qty: 1,
                          kind: 'compra',
                        })
                      }
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

      {renombrando && (
        <HojaDeAcciones
          titulo="Cambiar el nombre"
          subtitulo={renombrando.nombre}
          acciones={[]}
          cierrePorFondo={!tocado}
          onCerrar={() => setRenombrando(null)}
        >
          {/* Un `form` para que el retorno del teclado guarde. Con «Guardar»
              apagado —vacío, sin cambios o en vuelo— el navegador ni lo envía,
              y el `if` de dentro lo repite por si acaso. */}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!puedeRenombrar) return
              renombrar.mutate({
                id: renombrando.id,
                antes: renombrando.nombre,
                nombre: nombreLimpio,
              })
            }}
          >
            <label className="mt-2 block text-xs text-muted">
              Nombre
              <input
                type="text"
                value={nombreNuevo}
                onChange={(e) => {
                  setTocado(true)
                  setNombreNuevo(e.target.value)
                }}
                enterKeyHint="done"
                autoCorrect="off"
                spellCheck={false}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base text-ink"
              />
            </label>
            <p className="mt-2 text-xs text-muted">
              El nombre de antes se queda como alias: el Excel y quien lo busque así lo siguen
              encontrando.
            </p>
            {renombrar.isError && (
              <p className="mt-3 text-sm text-crit">{falloDelRenombrado(renombrar.error)}</p>
            )}
            <button
              type="submit"
              disabled={!puedeRenombrar}
              className="key key-accent mt-3 min-h-touch w-full px-4 text-sm"
            >
              {renombrar.isPending ? 'Guardando…' : 'Guardar'}
            </button>
          </form>
        </HojaDeAcciones>
      )}
    </div>
  )
}
