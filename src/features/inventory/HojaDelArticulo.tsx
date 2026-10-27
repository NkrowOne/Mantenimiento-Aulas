import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { HojaDeAcciones } from '@/components/HojaDeAcciones'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { pullMaster } from '@/sync/pull'
import type { Role } from '@/domain/types'
import {
  coincideUnidad,
  descripcionDeUnidad,
  ordenarUnidades,
  resumenDeCondiciones,
  sinNumeroDeSerie,
  type UnidadDeAlmacen,
} from '@/domain/unidades'
import { EtiquetaDeCondicion } from './ElegirUnidad'
import { Volver } from './ElegirCondicion'
import { FichaDeUnidad } from './FichaDeUnidad'
import { NuevaUnidad } from './NuevaUnidad'
import { MOTIVO_MIN, faltanParaElMotivo, motivoValido } from './motivo'
import { falloDeAdministracion } from './fallos'

/** Lo que la lista sabe de un artículo: la fila de `stock_levels`. */
export interface ArticuloDeLaLista {
  stock_item_id: string
  name: string
  unit: string
  min_threshold: number
  on_hand: number
  below_threshold: boolean
}

type Vista =
  | { tipo: 'articulo' }
  | { tipo: 'unidad'; id: string }
  | { tipo: 'nueva' }
  | { tipo: 'ajustes' }
  | { tipo: 'renombrar' }
  | { tipo: 'retirar' }

/**
 * Todo lo de un artículo, en una hoja que sube desde abajo.
 *
 * La lista del almacén era una tabla con cuatro controles por fila —menos, más,
 * renombrar, retirar— y, al pulsar uno de los de administrar, un formulario
 * abierto en medio de la tabla. Con sesenta artículos eso es un muro de botones
 * en el que cuesta encontrar el nombre. Ahora la fila dice lo que se busca al
 * recorrerla —cómo se llama y cuántos hay— y todo lo demás vive aquí, a un toque:
 *
 *  - **Arriba, la cantidad**, con el menos y el más grandes, y «varias» para
 *    la caja de veinte cables que no se cuentan de uno en uno.
 *  - **Después, las unidades** con su número de serie y su estado, si el
 *    artículo las tiene: cuál está, cómo está, y desde cada una, instalarla.
 *  - **Al final, los ajustes**, que se tocan una vez: el tipo de equipo, el
 *    mínimo, el nombre, retirarlo. Detrás de un botón, para que no estorben.
 *
 * Cada cosa abre su vista dentro de la misma hoja, con «Volver»: nada se abre
 * encima de nada.
 */
export function HojaDelArticulo({
  articulo,
  unidades,
  unidadInicial,
  role,
  articulos,
  ocupado,
  onMover,
  onCerrar,
  onAviso,
}: {
  /** `null` es el grupo de las unidades que no están en ningún artículo. */
  articulo: ArticuloDeLaLista | null
  unidades: UnidadDeAlmacen[]
  /** Abrir directamente en una unidad: la que se encontró buscando su número de serie. */
  unidadInicial?: string | null
  role: Role
  articulos: Array<{ id: string; name: string }>
  ocupado: boolean
  onMover: (qty: number, kind: 'compra' | 'consumo') => void
  onCerrar: () => void
  onAviso: (mensaje: string) => void
}): React.ReactElement {
  const esSupervisor = role === 'supervisor' || role === 'admin'
  const esAdmin = role === 'admin'
  const [vista, setVista] = useState<Vista>(unidadInicial ? { tipo: 'unidad', id: unidadInicial } : { tipo: 'articulo' })

  const enAlmacen = unidades.filter((u) => u.status === 'disponible')
  const titulo = articulo?.name ?? 'Unidades sin artículo'
  const subtitulo = articulo
    ? `${articulo.on_hand} ${articulo.unit} en el almacén${articulo.min_threshold > 0 ? ` · mínimo ${articulo.min_threshold}` : ''}`
    : `${enAlmacen.length} en el almacén sin artículo`

  const ultima = ordenarUnidades(unidades).find((u) => u.brand || u.model)

  let contenido: React.ReactNode
  if (vista.tipo === 'unidad') {
    const u = unidades.find((x) => x.id === vista.id)
    contenido = u ? (
      <FichaDeUnidad
        unidad={u}
        articulos={articulos}
        puedeCorregir={esSupervisor}
        puedeDarDeBaja={esAdmin}
        onVolver={() => setVista({ tipo: 'articulo' })}
        // Instalada o dada de baja, la unidad ya no está en esta lista: se cierra
        // la hoja y el aviso queda en la pantalla del almacén, a la vista.
        onAviso={(m) => {
          onAviso(m)
          onCerrar()
        }}
      />
    ) : (
      <div>
        <Volver onVolver={() => setVista({ tipo: 'articulo' })} />
        <p className="text-sm text-muted">Esa unidad ya no está en la lista.</p>
      </div>
    )
  } else if (vista.tipo === 'nueva' && articulo) {
    contenido = (
      <NuevaUnidad
        stockItemId={articulo.stock_item_id}
        articulo={articulo.name}
        existencias={articulo.on_hand}
        conSerieEnAlmacen={enAlmacen.length}
        puedeSumar={esSupervisor}
        sugerencia={{ marca: ultima?.brand ?? '', modelo: ultima?.model ?? '' }}
        onVolver={() => setVista({ tipo: 'articulo' })}
      />
    )
  } else if (vista.tipo === 'ajustes' && articulo) {
    contenido = <Ajustes articulo={articulo} onVolver={() => setVista({ tipo: 'articulo' })} onVista={setVista} />
  } else if (vista.tipo === 'renombrar' && articulo) {
    contenido = (
      <Renombrar
        articulo={articulo}
        onVolver={() => setVista({ tipo: 'ajustes' })}
        onHecho={(nombre) => {
          onAviso(`Ahora se llama «${nombre}».`)
          onCerrar()
        }}
      />
    )
  } else if (vista.tipo === 'retirar' && articulo) {
    contenido = (
      <Retirar
        articulo={articulo}
        onVolver={() => setVista({ tipo: 'ajustes' })}
        onHecho={() => {
          onAviso(`«${articulo.name}» retirado del almacén.`)
          onCerrar()
        }}
      />
    )
  } else {
    contenido = (
      <Resumen
        articulo={articulo}
        unidades={unidades}
        esSupervisor={esSupervisor}
        esAdmin={esAdmin}
        ocupado={ocupado}
        onMover={onMover}
        onUnidad={(id) => setVista({ tipo: 'unidad', id })}
        onNueva={() => setVista({ tipo: 'nueva' })}
        onAjustes={() => setVista({ tipo: 'ajustes' })}
      />
    )
  }

  return (
    <HojaDeAcciones
      titulo={titulo}
      subtitulo={subtitulo}
      acciones={[]}
      // Con un formulario a medias, tocar fuera no puede llevarse lo escrito.
      cierrePorFondo={vista.tipo === 'articulo'}
      etiquetaDeCierre="Cerrar"
      onCerrar={onCerrar}
    >
      <div className="mt-2">{contenido}</div>
    </HojaDeAcciones>
  )
}

function Resumen({
  articulo,
  unidades,
  esSupervisor,
  esAdmin,
  ocupado,
  onMover,
  onUnidad,
  onNueva,
  onAjustes,
}: {
  articulo: ArticuloDeLaLista | null
  unidades: UnidadDeAlmacen[]
  esSupervisor: boolean
  esAdmin: boolean
  ocupado: boolean
  onMover: (qty: number, kind: 'compra' | 'consumo') => void
  onUnidad: (id: string) => void
  onNueva: () => void
  onAjustes: () => void
}): React.ReactElement {
  const [consulta, setConsulta] = useState('')
  const [todas, setTodas] = useState(false)
  const [varias, setVarias] = useState(false)
  const [cuantas, setCuantas] = useState('')

  const enAlmacen = unidades.filter((u) => u.status === 'disponible')
  const fuera = unidades.length - enAlmacen.length
  const lista = useMemo(
    () => ordenarUnidades(todas ? unidades : enAlmacen).filter((u) => coincideUnidad(u, consulta)),
    [unidades, enAlmacen, todas, consulta],
  )
  const sinNumero = articulo ? sinNumeroDeSerie(articulo.on_hand, enAlmacen.length) : 0
  const n = Number.parseInt(cuantas, 10)
  const nValido = Number.isInteger(n) && n > 0

  return (
    <>
      {articulo && (
        <section aria-label="Existencias" className="rounded-ctl border border-line bg-surface p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className={`font-mono text-3xl font-semibold tabular ${articulo.below_threshold ? 'text-crit' : ''}`}>
                {articulo.on_hand}
              </p>
              <p className="text-xs text-muted">
                {articulo.unit} en el almacén
                {articulo.below_threshold ? ' · por debajo del mínimo' : ''}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={ocupado || articulo.on_hand <= 0}
                onClick={() => onMover(-1, 'consumo')}
                className="key key-quiet h-14 w-14 text-xl"
                aria-label={`Sacar una unidad de ${articulo.name}`}
              >
                −
              </button>
              {esSupervisor && (
                <button
                  type="button"
                  disabled={ocupado}
                  onClick={() => onMover(1, 'compra')}
                  className="key key-quiet h-14 w-14 text-xl"
                  aria-label={`Meter una unidad de ${articulo.name}`}
                >
                  +
                </button>
              )}
            </div>
          </div>

          {!varias ? (
            <button
              type="button"
              onClick={() => setVarias(true)}
              className="mt-2 min-h-11 text-sm text-accent underline-offset-4 hover:underline"
            >
              Varias de golpe…
            </button>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                value={cuantas}
                onChange={(e) => setCuantas(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                placeholder="Cuántas"
                aria-label="Cuántas unidades"
                autoComplete="off"
                autoFocus
                className="h-11 w-24 rounded-ctl border border-line bg-raised px-3 text-center font-mono text-base"
              />
              <button
                type="button"
                disabled={!nValido || ocupado || n > articulo.on_hand}
                onClick={() => {
                  onMover(-n, 'consumo')
                  setCuantas('')
                }}
                className="key key-quiet min-h-11 px-3 text-sm"
              >
                Sacar
              </button>
              {esSupervisor && (
                <button
                  type="button"
                  disabled={!nValido || ocupado}
                  onClick={() => {
                    onMover(n, 'compra')
                    setCuantas('')
                  }}
                  className="key key-accent min-h-11 px-3 text-sm"
                >
                  Meter
                </button>
              )}
              {nValido && n > articulo.on_hand && (
                <p className="basis-full text-xs text-muted">Solo quedan {articulo.on_hand}: no se pueden sacar {n}.</p>
              )}
            </div>
          )}
        </section>
      )}

      {(unidades.length > 0 || (esSupervisor && articulo)) && (
        <section aria-label="Unidades con número de serie" className="mt-4">
          <div className="flex items-baseline justify-between gap-2">
            <p className="eyebrow">Con número de serie</p>
            {unidades.length > 0 && (
              <p className="text-xs text-muted">{enAlmacen.length} en el almacén</p>
            )}
          </div>
          {unidades.length === 0 ? (
            <p className="mt-1 text-sm text-muted">
              Apunta cada aparato con su número de serie y su estado, y al instalar se podrá elegir cuál.
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted">
              {[resumenDeCondiciones(unidades), sinNumero > 0 ? `${sinNumero} sin número de serie` : null]
                .filter(Boolean)
                .join(' · ') || 'Ninguna en el almacén ahora mismo.'}
            </p>
          )}

          {unidades.length > 5 && (
            <input
              type="search"
              value={consulta}
              onChange={(e) => setConsulta(e.target.value)}
              placeholder="Buscar número de serie o modelo"
              aria-label="Buscar unidad"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="mt-2 h-11 w-full rounded-ctl border border-line bg-surface px-3 font-mono text-base"
            />
          )}

          {lista.length > 0 && (
            <ul className="mt-2 divide-y divide-hair rounded-ctl border border-line bg-surface">
              {lista.map((u) => (
                <li key={u.id}>
                  <FilaDeUnidad unidad={u} onAbrir={() => onUnidad(u.id)} />
                </li>
              ))}
            </ul>
          )}
          {consulta && lista.length === 0 && (
            <p className="mt-2 text-xs text-muted">Ninguna coincide con «{consulta}».</p>
          )}

          {fuera > 0 && (
            <button
              type="button"
              onClick={() => setTodas((v) => !v)}
              aria-pressed={todas}
              className="mt-2 min-h-11 text-sm text-accent underline-offset-4 hover:underline"
            >
              {todas ? 'Ver solo las del almacén' : `Ver también las instaladas y las de baja (${fuera})`}
            </button>
          )}

          {esSupervisor && articulo && (
            <button type="button" onClick={onNueva} className="key key-accent mt-2 min-h-touch w-full px-4 text-sm">
              Añadir unidades con número de serie
            </button>
          )}
        </section>
      )}

      {esAdmin && articulo && (
        <button type="button" onClick={onAjustes} className="key key-quiet mt-4 min-h-11 w-full px-4 text-left text-sm">
          Ajustes del artículo
          <span className="block text-xs font-normal text-muted">Tipo de equipo, mínimo, nombre y retirarlo.</span>
        </button>
      )}
    </>
  )
}

/** Una unidad en la lista de su artículo: el número, qué es y cómo está. */
export function FilaDeUnidad({ unidad: u, onAbrir }: { unidad: UnidadDeAlmacen; onAbrir: () => void }): React.ReactElement {
  const donde =
    u.status === 'instalado'
      ? [u.room_code, u.building_code].filter(Boolean).join(' ') || 'Instalada'
      : u.status === 'baja'
        ? 'De baja'
        : null
  return (
    <button
      type="button"
      onClick={onAbrir}
      className={`flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left ${u.status === 'baja' ? 'opacity-60' : ''}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-sm font-semibold">{u.serial}</span>
        <span className="block truncate text-xs text-muted">
          {[descripcionDeUnidad(u), donde].filter(Boolean).join(' · ') || u.item_name || u.articulo}
        </span>
      </span>
      <EtiquetaDeCondicion condicion={u.condicion} />
      <span aria-hidden className="text-muted">
        ›
      </span>
    </button>
  )
}

// -----------------------------------------------------------------------------
// Ajustes: de administrador
// -----------------------------------------------------------------------------

function Ajustes({
  articulo,
  onVolver,
  onVista,
}: {
  articulo: ArticuloDeLaLista
  onVolver: () => void
  onVista: (v: Vista) => void
}): React.ReactElement {
  const qc = useQueryClient()
  const item = useLiveQuery(() => db.stockItems.get(articulo.stock_item_id), [articulo.stock_item_id])
  const tipos = useLiveQuery(
    async () =>
      (await db.assetTypes.toArray())
        .filter((t) => !t.merged_into)
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
    [],
    [],
  )
  const [tipo, setTipo] = useState<string | null>(null)
  const [minimo, setMinimo] = useState<string>(String(articulo.min_threshold))
  const [hecho, setHecho] = useState<string | null>(null)
  const tipoActual = item?.asset_type_id ?? ''
  const tipoElegido = tipo ?? tipoActual
  const minimoN = Number.parseInt(minimo, 10)

  const guardar = useMutation({
    mutationFn: async (cambios: { asset_type_id?: string | null; min_threshold?: number }) => {
      const { data, error } = await supabase
        .from('stock_items')
        .update(cambios)
        .eq('id', articulo.stock_item_id)
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) throw new Error('Solo un administrador puede hacer esto.')
    },
    onSuccess: (_d, cambios) => {
      setHecho('asset_type_id' in cambios ? 'Tipo de equipo guardado.' : 'Mínimo guardado.')
      void qc.invalidateQueries({ queryKey: ['stock-levels'] })
      void pullMaster()
    },
  })

  return (
    <div>
      <Volver onVolver={onVolver} />
      <p className="text-base font-semibold">Ajustes del artículo</p>

      <label className="mt-3 block text-xs text-muted">
        Tipo de equipo
        <select
          value={tipoElegido}
          onChange={(e) => {
            setTipo(e.target.value)
            setHecho(null)
          }}
          className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base text-ink"
        >
          <option value="">Ninguno: es material que se gasta</option>
          {tipos.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-1 text-xs text-muted">
        Con un tipo puesto, al añadir ese equipo en un aula se ofrece sacarlo de este artículo, y sus unidades se
        instalan como ese tipo.
      </p>
      {tipoElegido !== tipoActual && (
        <button
          type="button"
          disabled={guardar.isPending}
          onClick={() => guardar.mutate({ asset_type_id: tipoElegido || null })}
          className="key key-accent mt-2 min-h-11 px-3 text-sm"
        >
          Guardar el tipo
        </button>
      )}

      <label className="mt-4 block text-xs text-muted">
        Avisar cuando queden
        <span className="mt-1 flex items-center gap-2">
          <input
            value={minimo}
            onChange={(e) => {
              setMinimo(e.target.value.replace(/\D/g, ''))
              setHecho(null)
            }}
            inputMode="numeric"
            autoComplete="off"
            className="h-11 w-24 rounded-ctl border border-line bg-surface px-3 text-center font-mono text-base text-ink"
          />
          <span className="text-sm text-ink">o menos. 0 es no avisar.</span>
        </span>
      </label>
      {Number.isInteger(minimoN) && minimoN !== articulo.min_threshold && (
        <button
          type="button"
          disabled={guardar.isPending}
          onClick={() => guardar.mutate({ min_threshold: minimoN })}
          className="key key-accent mt-2 min-h-11 px-3 text-sm"
        >
          Guardar el mínimo
        </button>
      )}

      {guardar.isError && (
        <p role="alert" className="mt-2 text-sm text-crit">
          {falloDeAdministracion(guardar.error)}
        </p>
      )}
      {hecho && <p className="mt-2 text-sm text-ok">{hecho}</p>}

      <div className="mt-4 space-y-2 border-t border-hair pt-3">
        <button
          type="button"
          onClick={() => onVista({ tipo: 'renombrar' })}
          className="key key-quiet min-h-11 w-full px-4 text-left text-sm"
        >
          Cambiar el nombre
        </button>
        <button
          type="button"
          onClick={() => onVista({ tipo: 'retirar' })}
          className="key key-quiet min-h-11 w-full px-4 text-left text-sm text-crit"
        >
          Retirar del almacén
          <span className="block text-xs font-normal text-muted">Deja de contarse. No borra nada y se puede restaurar.</span>
        </button>
      </div>
    </div>
  )
}

function Renombrar({
  articulo,
  onVolver,
  onHecho,
}: {
  articulo: ArticuloDeLaLista
  onVolver: () => void
  onHecho: (nombre: string) => void
}): React.ReactElement {
  const qc = useQueryClient()
  const [nombre, setNombre] = useState(articulo.name)
  const cambiado = nombre.trim() !== '' && nombre.trim() !== articulo.name
  /*
   * El nombre anterior se queda como alias (lo hace la base): el Excel y los
   * partes lo seguirán escribiendo como siempre y se seguirá encontrando.
   */
  const renombrar = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('stock_item_renombrar', {
        p_item: articulo.stock_item_id,
        p_nombre: nombre.trim(),
      })
      if (error) throw error
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stock-levels'] })
      // El buscador de material de los partes no lee esta lista sino el espejo
      // del dispositivo, que sin esto seguiría ofreciendo el nombre viejo hasta
      // la siguiente bajada.
      void pullMaster()
      onHecho(nombre.trim())
    },
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (cambiado) renombrar.mutate()
      }}
    >
      <Volver onVolver={onVolver} />
      <p className="text-base font-semibold">Cambiar el nombre</p>
      {/* `autoComplete="off"` y un nombre de campo que no suene a persona: con
          `name` a secas, Safari ofrecía «Autorrellenar contacto» encima del
          teclado, como si se estuviera rellenando una agenda. */}
      <input
        name="nombre-del-articulo"
        value={nombre}
        onChange={(e) => setNombre(e.target.value)}
        aria-label={`Nuevo nombre de ${articulo.name}`}
        autoComplete="off"
        autoCorrect="off"
        autoFocus
        required
        className="mt-3 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base text-ink"
      />
      <p className="mt-1 text-xs text-muted">
        El nombre de ahora se queda como alias: el Excel y los partes que lo escriban como siempre lo seguirán
        encontrando.
      </p>
      {renombrar.isError && (
        <p role="alert" className="mt-2 text-sm text-crit">
          {falloDeAdministracion(renombrar.error)}
        </p>
      )}
      <button
        type="submit"
        disabled={!cambiado || renombrar.isPending}
        className="key key-accent mt-4 min-h-touch w-full px-4 text-sm"
      >
        {renombrar.isPending ? 'Guardando…' : 'Guardar el nombre'}
      </button>
    </form>
  )
}

function Retirar({
  articulo,
  onVolver,
  onHecho,
}: {
  articulo: ArticuloDeLaLista
  onVolver: () => void
  onHecho: () => void
}): React.ReactElement {
  const qc = useQueryClient()
  const [motivo, setMotivo] = useState('')
  /*
   * Retirar es de administrador y lo decide la base (`is_admin()`). Nada se
   * borra: el artículo sale de la lista y deja de contarse, y sus movimientos,
   * las incidencias que lo citan y lo instalado en las aulas siguen donde
   * estaban. Por eso hay «Restaurar».
   */
  const retirar = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('stock_item_retirar', {
        p_item: articulo.stock_item_id,
        p_motivo: motivo.trim(),
      })
      if (error) throw error
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stock-levels'] })
      void qc.invalidateQueries({ queryKey: ['stock-retirados'] })
      onHecho()
    },
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (motivoValido(motivo)) retirar.mutate()
      }}
    >
      <Volver onVolver={onVolver} />
      <p className="text-base font-semibold">Retirar «{articulo.name}»</p>
      <input
        name="motivo-de-la-retirada"
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        placeholder={`Por qué se retira (mínimo ${MOTIVO_MIN} caracteres)`}
        aria-label={`Motivo para retirar ${articulo.name}`}
        autoComplete="off"
        autoFocus
        className="mt-3 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base text-ink"
      />
      <p className="mt-1 text-xs text-muted">
        {faltanParaElMotivo(motivo) > 0
          ? `El motivo es obligatorio: faltan ${faltanParaElMotivo(motivo)} caracteres.`
          : 'Con este motivo el artículo sale del almacén y deja de contarse.'}{' '}
        No se borra nada y se puede restaurar.
        {articulo.on_hand > 0 && ` Ahora mismo quedan ${articulo.on_hand} ${articulo.unit}: dejarán de verse hasta que se restaure.`}
      </p>
      {retirar.isError && (
        <p role="alert" className="mt-2 text-sm text-crit">
          {falloDeAdministracion(retirar.error)}
        </p>
      )}
      <button
        type="submit"
        disabled={!motivoValido(motivo) || retirar.isPending}
        className="key key-crit mt-4 min-h-touch w-full px-4 text-sm"
      >
        {retirar.isPending ? 'Retirando…' : 'Retirar del almacén'}
      </button>
    </form>
  )
}
