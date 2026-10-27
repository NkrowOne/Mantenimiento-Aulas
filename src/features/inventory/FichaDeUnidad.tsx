import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { fechaCorta } from '@/domain/fechas'
import {
  SITUACION_LABEL,
  descripcionDeUnidad,
  type Condicion,
  type UnidadDeAlmacen,
} from '@/domain/unidades'
import { ElegirCondicion, Volver } from './ElegirCondicion'
import { InstalarUnidad } from './InstalarUnidad'
import { MOTIVO_MIN, faltanParaElMotivo, motivoValido } from './motivo'
import { falloDeUnidad } from './fallos'
import { darDeBajaUnidad, editarUnidad, refrescarUnidades } from './unidadesDatos'

/**
 * Una unidad del almacén: cuál es, cómo está, dónde está, y qué se hace con ella.
 *
 * Lo de cada día va arriba y a un toque: el **estado** —se cambia tocando uno
 * de los cuatro botones, sin «Guardar»— y, si está en el almacén, **instalarla**.
 * Lo que se hace una vez —corregir el número de serie, darla de baja— va abajo,
 * detrás de su botón, y solo para quien puede.
 */
export function FichaDeUnidad({
  unidad: u,
  articulos,
  puedeCorregir,
  puedeDarDeBaja,
  onVolver,
  onAviso,
}: {
  unidad: UnidadDeAlmacen
  /** Para la unidad que no tiene artículo: a cuál se asigna. */
  articulos: Array<{ id: string; name: string }>
  /** Supervisor: marca, modelo, número de serie y artículo. */
  puedeCorregir: boolean
  /** Administrador: la baja, con su motivo. */
  puedeDarDeBaja: boolean
  onVolver: () => void
  onAviso: (mensaje: string) => void
}): React.ReactElement {
  const qc = useQueryClient()
  const [vista, setVista] = useState<'ficha' | 'instalar' | 'corregir' | 'baja'>('ficha')
  const [notas, setNotas] = useState(u.notes ?? '')
  const [hecho, setHecho] = useState<string | null>(null)
  // El estado cambia en el acto al tocarlo, sin esperar a que vuelva la lista:
  // un botón que tarda medio segundo en encenderse se vuelve a pulsar.
  const [condicion, setCondicion] = useState<Condicion>(u.condicion)
  useEffect(() => setCondicion(u.condicion), [u.condicion])

  const editar = useMutation({
    mutationFn: (cambios: Parameters<typeof editarUnidad>[1]) => editarUnidad(u.id, cambios),
    onSuccess: (_d, cambios) => {
      setHecho('condicion' in cambios ? 'Estado guardado.' : 'Guardado.')
      refrescarUnidades(qc)
    },
    onError: () => setCondicion(u.condicion),
  })

  if (vista === 'instalar') {
    return (
      <InstalarUnidad
        unidad={u}
        onVolver={() => setVista('ficha')}
        onHecho={(m) => {
          onAviso(m)
          onVolver()
        }}
      />
    )
  }
  if (vista === 'corregir') {
    return (
      <Corregir
        unidad={u}
        articulos={articulos}
        onVolver={() => setVista('ficha')}
        onHecho={() => {
          setVista('ficha')
          setHecho('Datos corregidos.')
        }}
      />
    )
  }
  if (vista === 'baja') {
    return (
      <DarDeBaja
        unidad={u}
        onVolver={() => setVista('ficha')}
        onHecho={() => {
          onAviso(`${u.serial} dada de baja.`)
          onVolver()
        }}
      />
    )
  }

  const situacion =
    u.status === 'instalado'
      ? `Instalada en ${[u.room_code, u.building_code].filter(Boolean).join(' ') || 'un aula'}${u.installed_at ? ` desde el ${fechaCorta(u.installed_at)}` : ''}`
      : u.status === 'baja'
        ? `De baja${u.retired_at ? ` desde el ${fechaCorta(u.retired_at)}` : ''}`
        : SITUACION_LABEL.disponible
  const notasCambiadas = (notas.trim() || null) !== (u.notes?.trim() || null)

  return (
    <div>
      <Volver onVolver={onVolver} />
      <p className="break-all font-mono text-xl font-semibold">{u.serial}</p>
      <p className="text-sm text-muted">
        {[u.item_name ?? u.articulo, descripcionDeUnidad(u)].filter(Boolean).join(' · ')}
      </p>
      <p
        className={`mt-1 text-sm font-medium ${
          u.status === 'disponible' ? 'text-ok' : u.status === 'baja' ? 'text-crit' : 'text-muted'
        }`}
      >
        {situacion}
      </p>
      {!u.stock_item_id && (
        <p className="mt-1 text-xs text-warn">
          No está en ningún artículo del almacén: no se descuenta nada al instalarla.
          {puedeCorregir ? ' Asígnala en «Corregir datos».' : ''}
        </p>
      )}

      <ElegirCondicion
        valor={condicion}
        deshabilitado={editar.isPending || u.status === 'baja'}
        onCambio={(c: Exclude<Condicion, 'sin_indicar'>) => {
          if (c === condicion) return
          setCondicion(c)
          editar.mutate({ condicion: c })
        }}
      />

      <label className="mt-3 block text-xs text-muted">
        Observaciones
        <textarea
          value={notas}
          onChange={(e) => {
            setNotas(e.target.value)
            setHecho(null)
          }}
          rows={2}
          autoComplete="off"
          className="mt-1 w-full rounded-ctl border border-line bg-surface px-3 py-2 text-base text-ink"
        />
      </label>
      {notasCambiadas && (
        <button
          type="button"
          disabled={editar.isPending}
          onClick={() => editar.mutate({ observaciones: notas.trim() })}
          className="key key-quiet mt-2 min-h-11 px-3 text-sm"
        >
          Guardar las observaciones
        </button>
      )}

      {editar.isError && (
        <p role="alert" className="mt-2 text-sm text-crit">
          {falloDeUnidad(editar.error)}
        </p>
      )}
      {hecho && !editar.isError && <p className="mt-2 text-sm text-ok">{hecho}</p>}

      {u.status === 'disponible' && (
        <button
          type="button"
          onClick={() => setVista('instalar')}
          className="key key-accent mt-4 min-h-touch w-full px-4 text-sm"
        >
          Instalar en un aula
        </button>
      )}

      {(puedeCorregir || (puedeDarDeBaja && u.status !== 'instalado' && u.status !== 'baja')) && (
        <div className="mt-4 space-y-2 border-t border-hair pt-3">
          {puedeCorregir && (
            <button
              type="button"
              onClick={() => setVista('corregir')}
              className="key key-quiet min-h-11 w-full px-4 text-left text-sm"
            >
              Corregir datos
              <span className="block text-xs font-normal text-muted">
                Número de serie, marca, modelo o artículo del almacén.
              </span>
            </button>
          )}
          {puedeDarDeBaja && u.status !== 'instalado' && u.status !== 'baja' && (
            <button
              type="button"
              onClick={() => setVista('baja')}
              className="key key-quiet min-h-11 w-full px-4 text-left text-sm text-crit"
            >
              Dar de baja
              <span className="block text-xs font-normal text-muted">
                Para la que no se va a instalar nunca: rota sin arreglo, perdida.
              </span>
            </button>
          )}
        </div>
      )}
      {u.status === 'instalado' && (
        <p className="mt-4 text-xs text-muted">
          Para sacarla del aula, pide su retirada desde la sala o desde Equipos: si vuelve al almacén, aparece aquí
          otra vez como usada.
        </p>
      )}
    </div>
  )
}

function Corregir({
  unidad: u,
  articulos,
  onVolver,
  onHecho,
}: {
  unidad: UnidadDeAlmacen
  articulos: Array<{ id: string; name: string }>
  onVolver: () => void
  onHecho: () => void
}): React.ReactElement {
  const qc = useQueryClient()
  const [serial, setSerial] = useState(u.serial)
  const [marca, setMarca] = useState(u.brand ?? '')
  const [modelo, setModelo] = useState(u.model ?? '')
  const [articulo, setArticulo] = useState(u.stock_item_id ?? '')

  const cambios: Parameters<typeof editarUnidad>[1] = {}
  if (serial.trim() && serial.trim() !== u.serial) cambios.serial = serial.trim()
  if (marca.trim() !== (u.brand ?? '')) cambios.marca = marca.trim()
  if (modelo.trim() !== (u.model ?? '')) cambios.modelo = modelo.trim()
  if (articulo && articulo !== (u.stock_item_id ?? '')) cambios.stock_item_id = articulo
  const hayCambios = Object.keys(cambios).length > 0

  const guardar = useMutation({
    mutationFn: () => editarUnidad(u.id, cambios),
    onSuccess: () => {
      refrescarUnidades(qc)
      onHecho()
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (hayCambios) guardar.mutate()
      }}
    >
      <Volver onVolver={onVolver} />
      <p className="text-base font-semibold">Corregir datos</p>
      <label className="mt-3 block text-xs text-muted">
        Número de serie
        <input
          name="numero-de-serie"
          value={serial}
          onChange={(e) => setSerial(e.target.value)}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 font-mono text-base uppercase text-ink"
        />
      </label>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="block text-xs text-muted">
          Marca
          <input
            name="marca-de-la-unidad"
            value={marca}
            onChange={(e) => setMarca(e.target.value)}
            autoComplete="off"
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base text-ink"
          />
        </label>
        <label className="block text-xs text-muted">
          Modelo
          <input
            name="modelo-de-la-unidad"
            value={modelo}
            onChange={(e) => setModelo(e.target.value)}
            autoComplete="off"
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base text-ink"
          />
        </label>
      </div>
      <label className="mt-3 block text-xs text-muted">
        Artículo del almacén
        <select
          value={articulo}
          onChange={(e) => setArticulo(e.target.value)}
          className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base text-ink"
        >
          {!u.stock_item_id && <option value="">Sin artículo</option>}
          {articulos.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      {guardar.isError && (
        <p role="alert" className="mt-3 text-sm text-crit">
          {falloDeUnidad(guardar.error)}
        </p>
      )}
      <button
        type="submit"
        disabled={!hayCambios || guardar.isPending}
        className="key key-accent mt-4 min-h-touch w-full px-4 text-sm"
      >
        {guardar.isPending ? 'Guardando…' : hayCambios ? 'Guardar' : 'Sin cambios'}
      </button>
    </form>
  )
}

function DarDeBaja({
  unidad: u,
  onVolver,
  onHecho,
}: {
  unidad: UnidadDeAlmacen
  onVolver: () => void
  onHecho: () => void
}): React.ReactElement {
  const qc = useQueryClient()
  const [motivo, setMotivo] = useState('')
  const baja = useMutation({
    mutationFn: () => darDeBajaUnidad(u.id, motivo),
    onSuccess: () => {
      refrescarUnidades(qc)
      onHecho()
    },
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (motivoValido(motivo)) baja.mutate()
      }}
    >
      <Volver onVolver={onVolver} />
      <p className="text-base font-semibold">
        Dar de baja <span className="font-mono">{u.serial}</span>
      </p>
      <label className="mt-3 block text-xs text-muted">
        Por qué
        <input
          name="motivo-de-la-baja"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder={`Mínimo ${MOTIVO_MIN} caracteres`}
          autoComplete="off"
          autoFocus
          className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base text-ink"
        />
      </label>
      <p className="mt-1 text-xs text-muted">
        {faltanParaElMotivo(motivo) > 0
          ? `Faltan ${faltanParaElMotivo(motivo)} caracteres. El motivo queda en sus observaciones y en Actividad.`
          : 'La unidad queda de baja con este motivo. No se borra: se sigue encontrando por su número de serie.'}
      </p>
      {baja.isError && (
        <p role="alert" className="mt-3 text-sm text-crit">
          {falloDeUnidad(baja.error)}
        </p>
      )}
      <button
        type="submit"
        disabled={!motivoValido(motivo) || baja.isPending}
        className="key key-crit mt-4 min-h-touch w-full px-4 text-sm"
      >
        {baja.isPending ? 'Guardando…' : 'Confirmar la baja'}
      </button>
    </form>
  )
}
