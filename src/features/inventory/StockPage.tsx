import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { v7 as uuidv7 } from 'uuid'
import { supabase } from '@/lib/supabase'
import { fechaCorta } from '@/domain/fechas'
import { norm } from '@/domain/normalize'
import type { Role } from '@/domain/types'
import { coincideUnidad, resumenDeCondiciones, serialComparable, type UnidadDeAlmacen } from '@/domain/unidades'
import { ExportarConVistaPrevia } from './ExportarConVistaPrevia'
import { FilaDeUnidad, HojaDelArticulo, type ArticuloDeLaLista } from './HojaDelArticulo'
import { prepararExportacionDelAlmacen } from './exportarAlmacen'
import { esDuplicado, esFalloDeRed, esSinExistencias, falloDeAdministracion, mensajeDe } from './fallos'
import { useUnidades } from './unidadesDatos'

/** Una fila de `stock_levels`. Lo que se lee de la vista está entre sus columnas: lo comprueba `contrato-saldos`. */
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

type Filtro = 'todo' | 'bajo' | 'serie' | 'cero'

/** La hoja abierta: de un artículo, o del grupo de unidades sin artículo, y quizá ya en una unidad. */
type Abierta = { articulo: string | null; unidad?: string } | null

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
 *
 * **La lista es para recorrerla.** Cada fila dice cómo se llama el artículo y
 * cuántos hay —en rojo si está bajo mínimo— y, si tiene unidades con número de
 * serie, cómo están. Lo demás —sus unidades, instalarlas, los ajustes— se abre
 * tocando la fila, en una hoja desde abajo. Los artículos que solo se cuentan
 * llevan el menos y el más en la propia fila, porque gastar un cable es el
 * gesto más frecuente de esta pantalla y no merece dos toques.
 *
 * **El buscador encuentra también números de serie.** Se teclean cuatro cifras
 * de la pegatina y salen las unidades que coinciden, encima de los artículos;
 * tocarla abre su ficha directamente.
 */
export function StockPage({ role }: { role: Role }): React.ReactElement {
  const qc = useQueryClient()
  const [consulta, setConsulta] = useState('')
  const [filtro, setFiltro] = useState<Filtro>('todo')
  const [alta, setAlta] = useState(false)
  const [abierta, setAbierta] = useState<Abierta>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [verRetirados, setVerRetirados] = useState(false)
  const [falloAdmin, setFalloAdmin] = useState<string | null>(null)
  const esAdmin = role === 'admin'
  const esSupervisor = role === 'supervisor' || role === 'admin'

  const { data: levels, isPending, isError, refetch } = useQuery({
    queryKey: ['stock-levels'],
    queryFn: async (): Promise<StockLevel[]> => {
      const { data, error } = await supabase.from('stock_levels').select('*').order('name')
      if (error) throw error
      return (data ?? []) as StockLevel[]
    },
  })
  const unidades = useUnidades()

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
    nombre: string
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
      setUltimo(input.kind === 'ajuste' ? null : input)
      void qc.invalidateQueries({ queryKey: ['stock-levels'] })
    },
  })

  function mover(l: ArticuloDeLaLista, qty: number, kind: 'compra' | 'consumo'): void {
    setAviso(null)
    move.mutate({ id: uuidv7(), itemId: l.stock_item_id, nombre: l.name, qty, kind })
  }

  /**
   * Alta de artículo.
   *
   * Es de admin porque así lo dice RLS: la política «admin escribe stock_items»
   * es la que decide de verdad, y ofrecer el botón a un supervisor solo serviría
   * para que el servidor le dijera que no.
   */
  const crear = useMutation({
    mutationFn: async (input: { name: string; unit: string }) => {
      const { error } = await supabase.from('stock_items').insert({
        name: input.name,
        unit: input.unit || 'ud',
        active: true,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setAlta(false)
      void qc.invalidateQueries({ queryKey: ['stock-levels'] })
    },
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

  // --- Lo que se enseña ---------------------------------------------------------
  const todasLasUnidades = useMemo(() => unidades.data ?? [], [unidades.data])
  const idsVivos = useMemo(() => new Set((levels ?? []).map((l) => l.stock_item_id)), [levels])
  const porArticulo = useMemo(() => {
    const m = new Map<string, UnidadDeAlmacen[]>()
    for (const u of todasLasUnidades) {
      if (!u.stock_item_id || !idsVivos.has(u.stock_item_id)) continue
      m.set(u.stock_item_id, [...(m.get(u.stock_item_id) ?? []), u])
    }
    return m
  }, [todasLasUnidades, idsVivos])
  // Las unidades que no cuelgan de ningún artículo vivo: sin casar, o de uno retirado.
  const sinArticulo = useMemo(
    () => todasLasUnidades.filter((u) => !u.stock_item_id || !idsVivos.has(u.stock_item_id)),
    [todasLasUnidades, idsVivos],
  )

  const cuenta = useMemo(() => {
    const ls = levels ?? []
    return {
      todo: ls.length,
      bajo: ls.filter((l) => l.below_threshold).length,
      serie: ls.filter((l) => (porArticulo.get(l.stock_item_id)?.length ?? 0) > 0).length,
      cero: ls.filter((l) => l.on_hand <= 0).length,
    }
  }, [levels, porArticulo])

  const q = consulta.trim()
  const filas = useMemo(() => {
    const palabras = norm(q).split(' ').filter(Boolean)
    return (levels ?? []).filter((l) => {
      if (filtro === 'bajo' && !l.below_threshold) return false
      if (filtro === 'serie' && (porArticulo.get(l.stock_item_id)?.length ?? 0) === 0) return false
      if (filtro === 'cero' && l.on_hand > 0) return false
      if (palabras.length === 0) return true
      const nombre = norm(l.name)
      return (
        palabras.every((p) => nombre.includes(p)) ||
        (porArticulo.get(l.stock_item_id) ?? []).some((u) => coincideUnidad(u, q))
      )
    })
  }, [levels, filtro, q, porArticulo])

  /* Los números de serie que coinciden con lo tecleado: desde tres caracteres,
     que con menos coinciden todos. */
  const porSerie = useMemo(
    () =>
      serialComparable(q).length >= 3
        ? todasLasUnidades.filter((u) => serialComparable(u.serial).includes(serialComparable(q))).slice(0, 8)
        : [],
    [todasLasUnidades, q],
  )

  const articuloAbierto =
    abierta && abierta.articulo !== null ? ((levels ?? []).find((l) => l.stock_item_id === abierta.articulo) ?? null) : null
  const unidadesAbiertas =
    abierta === null ? [] : abierta.articulo === null ? sinArticulo : (porArticulo.get(abierta.articulo) ?? [])

  function abrirUnidad(u: UnidadDeAlmacen): void {
    setAbierta({ articulo: u.stock_item_id && idsVivos.has(u.stock_item_id) ? u.stock_item_id : null, unidad: u.id })
  }

  const FILTROS: Array<{ id: Filtro; label: string }> = [
    { id: 'todo', label: 'Todo' },
    { id: 'bajo', label: 'Bajo mínimo' },
    { id: 'serie', label: 'Con n.º de serie' },
    { id: 'cero', label: 'Sin existencias' },
  ]

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Almacén</h1>
        {esAdmin && (
          <button
            type="button"
            onClick={() => setAlta((v) => !v)}
            className="key key-quiet min-h-11 shrink-0 px-3 text-sm"
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
            const name = String(f.get('nombre-del-articulo') ?? '').trim()
            if (!name) return
            crear.mutate({
              name,
              unit: String(f.get('unidad-del-articulo') ?? '').trim(),
            })
          }}
        >
          <div className="flex flex-wrap gap-3">
            <label className="flex-1 text-sm">
              <span className="text-muted">Nombre</span>
              <input
                name="nombre-del-articulo"
                required
                autoFocus
                autoComplete="off"
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base"
              />
            </label>
            <label className="w-24 text-sm">
              <span className="text-muted">Unidad</span>
              <input
                name="unidad-del-articulo"
                defaultValue="ud"
                autoComplete="off"
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base"
              />
            </label>
          </div>
          {crear.isError && (
            <p className="mt-3 text-sm text-crit">
              {esDuplicado(crear.error)
                ? 'Ese artículo ya está en la lista, escrito con otras mayúsculas o tildes. Búscalo arriba en vez de crearlo otra vez.'
                : `No se ha podido crear: ${mensajeDe(crear.error) || 'error desconocido'}`}
            </p>
          )}
          <button type="submit" disabled={crear.isPending} className="key key-accent mt-3 min-h-11 px-4 text-sm">
            {crear.isPending ? 'Creando…' : 'Crear artículo'}
          </button>
        </form>
      )}

      {/* Sin `name` y sin autocompletar: Safari ofrecía rellenar un contacto. */}
      <input
        type="search"
        value={consulta}
        onChange={(e) => setConsulta(e.target.value)}
        placeholder="Buscar artículo o número de serie"
        aria-label="Buscar artículo o número de serie"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="mt-4 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base"
      />

      <div className="scroll-x -mx-1 mt-3 flex gap-2 px-1 pb-1">
        {FILTROS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFiltro(f.id)}
            aria-pressed={filtro === f.id}
            className={`key min-h-11 shrink-0 px-3 text-sm ${filtro === f.id ? 'key-accent' : 'key-quiet text-muted'}`}
          >
            {f.label}
            {levels && <span className="ml-1.5 font-mono text-xs opacity-80">{cuenta[f.id]}</span>}
          </button>
        ))}
      </div>

      {aviso && (
        <p role="status" className="mt-3 rounded-ctl bg-ok-tint p-3 text-sm text-ok">
          {aviso}
        </p>
      )}

      {porSerie.length > 0 && (
        <section aria-label="Números de serie" className="mt-4">
          <p className="eyebrow">Números de serie</p>
          <ul className="mt-2 divide-y divide-hair rounded-ctl border border-line bg-surface">
            {porSerie.map((u) => (
              <li key={u.id}>
                <FilaDeUnidad unidad={u} onAbrir={() => abrirUnidad(u)} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {isPending && <p className="mt-6 text-sm text-muted">Cargando el almacén…</p>}

      {isError && (
        <div className="card mt-6 p-4">
          <p className="text-sm text-crit">No se ha podido leer el almacén.</p>
          <p className="mt-1 text-sm text-muted">Esta pantalla necesita conexión.</p>
          <button type="button" onClick={() => void refetch()} className="key key-quiet mt-3 min-h-11 px-3 text-sm">
            Reintentar
          </button>
        </div>
      )}

      {filas.length > 0 && (
        <ul className="mt-3 divide-y divide-hair">
          {filas.map((l) => (
            <FilaDeArticulo
              key={l.stock_item_id}
              nivel={l}
              unidades={porArticulo.get(l.stock_item_id) ?? []}
              esSupervisor={esSupervisor}
              ocupado={move.isPending}
              onAbrir={() => setAbierta({ articulo: l.stock_item_id })}
              onMover={(qty, kind) => mover(l, qty, kind)}
            />
          ))}
        </ul>
      )}

      {sinArticulo.length > 0 && filtro !== 'bajo' && filtro !== 'cero' && !q && (
        <button
          type="button"
          onClick={() => setAbierta({ articulo: null })}
          className="mt-2 flex min-h-14 w-full items-center gap-3 border-t border-hair py-2 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[0.9375rem] font-medium">Unidades sin artículo</span>
            <span className="block text-xs text-warn">
              {sinArticulo.length} con número de serie que no están en ningún artículo del almacén
            </span>
          </span>
          <span aria-hidden className="w-6 text-center text-muted">
            ›
          </span>
        </button>
      )}

      {unidades.isError && (
        <p className="mt-3 text-xs text-muted">
          No se han podido leer las unidades con número de serie: {mensajeDe(unidades.error)}
        </p>
      )}

      {/*
        «Ningún artículo coincide» decía lo mismo con el filtro puesto que con el
        almacén entero vacío, y son dos problemas distintos: uno se arregla
        borrando lo escrito y el otro no se arregla desde aquí. Con cero
        artículos y sin filtro, además, casi nunca es que el almacén esté vacío:
        es que el servidor no ha dejado leerlo —RLS devuelve una lista vacía sin
        error—, y eso hay que decirlo o no hay forma de averiguarlo.
      */}
      {!isPending && !isError && filas.length === 0 && (
        <div className="mt-6 text-sm text-muted">
          {(levels?.length ?? 0) > 0 ? (
            <p>{porSerie.length > 0 ? 'Ningún artículo se llama así: arriba están las unidades con ese número.' : 'Ningún artículo coincide.'}</p>
          ) : (
            <>
              <p>El almacén no tiene ningún artículo.</p>
              <p className="mt-1">
                Si debería tenerlos, el servidor no te está dejando leerlos: revisa que tu token lleve el rol (claim{' '}
                <span className="font-mono">app_role</span>) y que tu perfil tenga uno asignado.
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
              <p className="text-sm text-crit">No quedan tantas unidades: el movimiento no se ha registrado.</p>
              <p className="mt-1 text-sm text-muted">
                Las existencias no pueden quedar en negativo. Si el material está en el almacén pero la cifra dice que
                no, falta por apuntar la compra que lo trajo.
              </p>
            </>
          ) : !navigator.onLine || esFalloDeRed(move.error) ? (
            <>
              <p className="text-sm text-crit">Sin conexión: el movimiento no se ha registrado.</p>
              <p className="mt-1 text-sm text-muted">
                El almacén se apunta contra el servidor en el momento, a diferencia de las revisiones. Busca cobertura
                y repítelo.
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
            <p className="text-sm text-crit">Solo un supervisor registra entradas en el almacén.</p>
          )}
        </div>
      )}

      {/* Deshacer: el movimiento contrario, que es la única forma de corregir un
          saldo que se calcula sumando. */}
      {ultimo && !move.isPending && !move.isError && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-ctl border border-line bg-surface px-3 py-2">
          <span className="min-w-0 text-sm text-muted">
            {ultimo.qty > 0 ? 'Metida' : 'Sacada'}
            {Math.abs(ultimo.qty) === 1 ? ' 1 unidad' : `s ${Math.abs(ultimo.qty)} unidades`} de {ultimo.nombre}.
          </span>
          <button
            type="button"
            onClick={() => {
              move.mutate({ ...ultimo, id: uuidv7(), qty: -ultimo.qty, kind: 'ajuste' })
              setUltimo(null)
            }}
            className="key key-quiet min-h-11 shrink-0 px-3 text-sm"
          >
            Deshacer
          </button>
        </div>
      )}

      {falloAdmin && <p className="mt-3 rounded-ctl bg-crit-fill p-3 text-sm text-crit-ink">{falloAdmin}</p>}

      {esAdmin && (
        <section className="mt-6">
          <button
            type="button"
            onClick={() => setVerRetirados((v) => !v)}
            aria-expanded={verRetirados}
            className="min-h-11 text-sm text-accent underline-offset-4 hover:underline"
          >
            {verRetirados ? 'Ocultar los artículos retirados' : 'Ver los artículos retirados'}
          </button>
          {verRetirados && (
            <div className="mt-2">
              {retirados.isPending && <p className="text-sm text-muted">Cargando…</p>}
              {retirados.isError && <p className="text-sm text-crit">No se han podido leer los artículos retirados.</p>}
              {retirados.data && retirados.data.length === 0 && (
                <p className="text-sm text-muted">No hay ningún artículo retirado.</p>
              )}
              {retirados.data && retirados.data.length > 0 && (
                <ul className="divide-y divide-hair">
                  {retirados.data.map((a) => (
                    <li key={a.id} className="flex items-center gap-3 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm">{a.name}</span>
                        <span className="block text-xs text-muted">
                          {a.retired_at ? `Retirado el ${fechaCorta(a.retired_at)}` : 'Retirado'}
                          {a.retired_reason ? ` · ${a.retired_reason}` : ''}
                        </span>
                      </span>
                      <button
                        type="button"
                        disabled={restaurar.isPending}
                        onClick={() => restaurar.mutate(a.id)}
                        className="key key-quiet min-h-11 shrink-0 px-3 text-sm"
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

      {/*
        Al final del almacén: se lee después de ver la lista y no la desplaza.
        Es una copia de hoy para mirar fuera de la aplicación, no la
        sincronización con SharePoint, que vive en Datos → Excel.
      */}
      <ExportarConVistaPrevia
        titulo="Inventario del almacén: Excel y PDF"
        descripcion="Las existencias (también los artículos retirados), los movimientos con su saldo y las unidades con número de serie y su estado. Se ven antes de descargar."
        preparar={prepararExportacionDelAlmacen}
      />

      {abierta && (abierta.articulo === null || articuloAbierto) && (
        <HojaDelArticulo
          key={`${abierta.articulo ?? 'sin'}-${abierta.unidad ?? ''}`}
          articulo={articuloAbierto}
          unidades={unidadesAbiertas}
          unidadInicial={abierta.unidad ?? null}
          role={role}
          articulos={(levels ?? []).map((l) => ({ id: l.stock_item_id, name: l.name }))}
          ocupado={move.isPending}
          onMover={(qty, kind) => articuloAbierto && mover(articuloAbierto, qty, kind)}
          onCerrar={() => setAbierta(null)}
          onAviso={setAviso}
        />
      )}
    </div>
  )
}

/**
 * Una fila del almacén: cómo se llama, cuántos hay y, si tiene unidades con
 * número de serie, cómo están. Tocarla abre su hoja. Los que solo se cuentan
 * llevan además el menos —y el más, para quien puede meter— a mano.
 */
function FilaDeArticulo({
  nivel: l,
  unidades,
  esSupervisor,
  ocupado,
  onAbrir,
  onMover,
}: {
  nivel: StockLevel
  unidades: UnidadDeAlmacen[]
  esSupervisor: boolean
  ocupado: boolean
  onAbrir: () => void
  onMover: (qty: number, kind: 'compra' | 'consumo') => void
}): React.ReactElement {
  const conSerie = unidades.filter((u) => u.status === 'disponible')
  const detalle = [
    l.below_threshold ? `Bajo mínimo (${l.min_threshold})` : null,
    unidades.length > 0
      ? `${conSerie.length} con n.º de serie${conSerie.length > 0 ? ` · ${resumenDeCondiciones(unidades)}` : ''}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <li className="flex items-center gap-2">
      <button
        type="button"
        onClick={onAbrir}
        aria-haspopup="dialog"
        className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.9375rem] font-medium">{l.name}</span>
          {detalle && (
            <span className={`block truncate text-xs ${l.below_threshold ? 'text-crit' : 'text-muted'}`}>{detalle}</span>
          )}
        </span>
        <span className={`shrink-0 font-mono text-lg tabular ${l.below_threshold ? 'text-crit' : ''}`}>{l.on_hand}</span>
      </button>
      {unidades.length > 0 ? (
        <span aria-hidden className="w-6 shrink-0 text-center text-muted">
          ›
        </span>
      ) : (
        <span className="flex shrink-0 gap-1.5">
          {/* Deshabilitados mientras vuela el anterior: la cifra no se movía
              hasta que volvía el servidor, así que el técnico pulsaba otra vez
              y se registraban dos movimientos. Y a cero, el `−` no lleva a
              ningún sitio: el servidor lo rechaza. */}
          <button
            type="button"
            disabled={ocupado || l.on_hand <= 0}
            onClick={() => onMover(-1, 'consumo')}
            className="key key-quiet h-11 w-11"
            aria-label={l.on_hand <= 0 ? `No quedan unidades de ${l.name}` : `Sacar una unidad de ${l.name}`}
          >
            −
          </button>
          {esSupervisor && (
            <button
              type="button"
              disabled={ocupado}
              onClick={() => onMover(1, 'compra')}
              className="key key-quiet h-11 w-11"
              aria-label={`Meter una unidad de ${l.name}`}
            >
              +
            </button>
          )}
        </span>
      )}
    </li>
  )
}
