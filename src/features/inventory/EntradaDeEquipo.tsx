import { useMemo, useState, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { v7 as uuidv7 } from 'uuid'
import { supabase } from '@/lib/supabase'
import {
  CAMPOS_DE_FICHA,
  GRUPO_LABEL,
  borradorDe,
  esOrdenador,
  problemasDeFicha,
  valorAGuardar,
  type BorradorDeFicha,
  type GrupoDeFicha,
} from '@/domain/fichaDeEquipo'
import {
  mensajeDeFallo,
  refrescarTrasCambio,
  type EdificioElegible,
  type SalaElegible,
  type TipoElegible,
} from './equiposDatos'
import { Confirmacion } from '@/components/Confirmacion'

/**
 * Registrar la entrada de un equipo nuevo: lo que llega comprado y se instala.
 *
 * Desde el aula ya se podía dar de alta un aparato, y sigue siendo el camino
 * del técnico: lo apunta quien lo tiene delante, nace sin validar y un
 * coordinador lo confirma. Esto es el otro lado, el del despacho: quien recibe
 * el pedido lo registra **con su ficha de compra desde el primer día** —fecha,
 * proveedor, precio, factura, garantía— y entra ya validado, porque no es una
 * propuesta de nadie.
 *
 * Lo hace `asset_registrar_entrada` en una sola operación: el equipo y su
 * evento de alta, que es lo que lo pone en la lista de entradas y en el
 * histórico de la sala. A medias quedaría un equipo sin entrada o una entrada
 * sin equipo.
 *
 * El id nace aquí, con la pulsación: si la respuesta se pierde y se vuelve a
 * pulsar, la base reconoce el mismo id y no crea otro.
 */
/** Los campos que se ven sin abrir «Más datos»: los dos números del aparato. */
const A_LA_VISTA: readonly string[] = ['serial', 'inventory_tag']

/** Lo que distingue a un aparato de su vecino de lote: se vacía entre uno y otro. */
const DE_CADA_APARATO = ['label', 'serial', 'inventory_tag', 'hostname', 'mac_address', 'ip_address'] as const

export function EntradaDeEquipo({
  tipos,
  salas,
  edificios,
  edificioInicial = '',
  onFin,
}: {
  tipos: TipoElegible[]
  salas: SalaElegible[]
  edificios: EdificioElegible[]
  /** El edificio por el que está filtrada la lista, si lo está: quien registra
      mirando el edificio H casi siempre registra algo del H. */
  edificioInicial?: string
  onFin: (mensaje: string | null) => void
}): React.ReactElement {
  const qc = useQueryClient()
  const [id, setId] = useState(() => uuidv7())
  const [tipoId, setTipoId] = useState('')
  const [buildingId, setBuildingId] = useState(edificioInicial)
  /*
   * «Registrar y otra».
   *
   * Los equipos llegan por lotes —seis proyectores iguales para una planta—, y
   * cada uno era abrir el formulario, elegir el tipo, el edificio y la sala,
   * teclear marca, modelo y los datos de la compra… y al registrar, el
   * formulario se cerraba y había que empezar de cero para el siguiente, que
   * solo se diferencia en el número de serie.
   *
   * Con este botón el formulario se queda abierto con todo lo que comparte el
   * lote —tipo, sitio, marca, modelo, compra, vida útil y la nota— y vacía solo
   * lo que es de CADA aparato: su nombre en el aula, su número de serie, su
   * inventario y, en un ordenador, hostname, MAC e IP. `otra` es una referencia
   * y no un estado porque se lee dentro del `onSuccess`, que se creó antes de
   * que el botón la cambiara.
   */
  const otra = useRef(false)
  const [registradas, setRegistradas] = useState<string | null>(null)
  const [roomId, setRoomId] = useState('')
  const [motivo, setMotivo] = useState('')
  const [borrador, setBorrador] = useState<BorradorDeFicha>(() => borradorDe({}))
  const [tocado, setTocado] = useState(false)

  const tipo = tipos.find((t) => t.id === tipoId)
  const conOrdenador = tipo ? esOrdenador({ category: tipo.category, type_name: tipo.name }) : false
  const delEdificio = salas.filter((s) => s.buildingId === buildingId)
  const problemas = problemasDeFicha(borrador)
  const faltan = [!tipoId && 'el tipo', !roomId && 'la sala'].filter(Boolean)

  const grupos = useMemo<GrupoDeFicha[]>(
    () => (conOrdenador ? ['identidad', 'compra', 'vida', 'ordenador', 'notas'] : ['identidad', 'compra', 'vida', 'notas']),
    [conOrdenador],
  )

  const registrar = useMutation({
    mutationFn: async () => {
      const p: Record<string, unknown> = {
        id,
        asset_type_id: tipoId,
        room_id: roomId,
        motivo: motivo.trim() || null,
      }
      for (const c of CAMPOS_DE_FICHA) {
        if (c.grupo === 'ordenador' && !conOrdenador) continue
        p[c.clave] = valorAGuardar(c, borrador[c.clave])
      }
      const { error } = await supabase.rpc('asset_registrar_entrada', { p })
      if (error) throw error
    },
    onSuccess: () => {
      refrescarTrasCambio(qc, [roomId])
      const sala = salas.find((s) => s.id === roomId)
      const mensaje = `Entrada registrada: ${tipo?.name ?? 'equipo'} en ${sala?.etiqueta ?? 'la sala'}.`
      if (!otra.current) {
        onFin(mensaje)
        return
      }
      otra.current = false
      // Otro aparato: identificador nuevo —con el mismo, el servidor lo tomaría
      // por el que se acaba de registrar— y fuera lo que es de cada unidad.
      setId(uuidv7())
      setBorrador((b) => {
        const siguiente = { ...b }
        for (const clave of DE_CADA_APARATO) siguiente[clave] = ''
        return siguiente
      })
      setTocado(false)
      setRegistradas(mensaje)
    },
  })

  const [masDatos, setMasDatos] = useState(false)
  /* Los campos que no están a la vista: cuántos llevan algo, y si alguno tiene
     un error —en cuyo caso se enseñan, porque un error que no se ve no se
     puede corregir—. */
  const ocultos = CAMPOS_DE_FICHA.filter(
    (c) => !A_LA_VISTA.includes(c.clave) && (c.grupo !== 'ordenador' || conOrdenador),
  )
  const rellenados = ocultos.filter((c) => borrador[c.clave].trim() !== '').length
  const abierto = masDatos || ocultos.some((c) => problemas[c.clave] !== undefined)

  const pintarCampo = (c: (typeof CAMPOS_DE_FICHA)[number]): React.ReactElement => (
    <label key={c.clave} className={`block text-sm ${c.tipo === 'largo' ? 'sm:col-span-2' : ''}`}>
      <span className="text-muted">
        {c.clave === 'label' ? 'Nombre en el aula (si no, el del tipo)' : c.etiqueta}
      </span>
      {c.tipo === 'largo' ? (
        <textarea
          value={borrador[c.clave]}
          onChange={(e) => setBorrador((b) => ({ ...b, [c.clave]: e.target.value }))}
          rows={2}
          className="mt-1 w-full rounded-ctl border border-line bg-surface px-3 py-2 text-base"
        />
      ) : (
        <input
          value={borrador[c.clave]}
          onChange={(e) => setBorrador((b) => ({ ...b, [c.clave]: e.target.value }))}
          type={c.tipo === 'fecha' ? 'date' : 'text'}
          inputMode={c.tipo === 'precio' || c.tipo === 'ip' ? 'decimal' : undefined}
          placeholder={c.pista}
          autoCapitalize={c.codigo ? 'characters' : undefined}
          autoCorrect={c.codigo ? 'off' : undefined}
          spellCheck={c.codigo ? false : undefined}
          aria-invalid={problemas[c.clave] !== undefined}
          className={`mt-1 h-11 w-full rounded-ctl border bg-surface px-3 text-base ${
            problemas[c.clave] ? 'border-crit' : 'border-line'
          } ${c.codigo ? 'font-mono uppercase' : ''}`}
        />
      )}
      {problemas[c.clave] && (
        <span role="alert" className="mt-1 block text-xs text-crit">
          {problemas[c.clave]}
        </span>
      )}
    </label>
  )

  return (
    <form
      className="card mt-4 p-4"
      onSubmit={(e) => {
        e.preventDefault()
        setTocado(true)
        if (faltan.length === 0 && Object.keys(problemas).length === 0) registrar.mutate()
      }}
    >
      <h2 className="text-base font-semibold">Registrar una entrada</h2>
      <p className="mt-1 text-sm text-muted">
        Un equipo nuevo que llega y se instala en una sala. Solo el tipo y la sala son obligatorios;
        lo demás se puede completar después desde su ficha.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="text-muted">Tipo de equipo</span>
          <select
            value={tipoId}
            onChange={(e) => setTipoId(e.target.value)}
            aria-invalid={tocado && !tipoId}
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base"
          >
            <option value="">Elige…</option>
            {tipos.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-muted">Edificio</span>
          <select
            value={buildingId}
            onChange={(e) => {
              setBuildingId(e.target.value)
              setRoomId('')
            }}
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base"
          >
            <option value="">Elige…</option>
            {edificios.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-muted">Sala</span>
          <select
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            disabled={!buildingId}
            aria-invalid={tocado && !roomId}
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base"
          >
            <option value="">{buildingId ? 'Elige…' : 'Elige edificio'}</option>
            {delEdificio.map((s) => (
              <option key={s.id} value={s.id}>
                {s.etiqueta}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/*
        Lo que identifica al aparato, a la vista; lo demás, detrás de un botón.

        El formulario enseñaba de golpe todos los campos de la ficha —hasta
        veinte: identidad, compra, vida útil, y los de un ordenador— aunque su
        propia introducción dice que solo hacen falta el tipo y la sala. Para
        llegar a «Registrar la entrada» había que pasar por quince campos
        vacíos, y en un teléfono eso son tres pantallas.

        Se quedan arriba los dos números que distinguen a un aparato de otro
        —el de serie y el de inventario—, que es lo que se tiene delante al
        desembalarlo. El resto no se pierde: se abre con «Más datos», y el botón
        dice cuántos hay rellenados para que no se queden olvidados dentro. Si
        alguno de los ocultos tiene un error, se abre solo.
      */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {CAMPOS_DE_FICHA.filter((c) => A_LA_VISTA.includes(c.clave)).map(pintarCampo)}
      </div>

      <button
        type="button"
        onClick={() => setMasDatos((v) => !v)}
        aria-expanded={abierto}
        className="key key-quiet mt-3 flex min-h-11 w-full items-center justify-between gap-3 px-3 text-sm sm:w-auto"
      >
        {abierto ? 'Ocultar el resto de datos' : 'Más datos'}{' '}
        <span className="font-normal text-muted">
          {rellenados > 0
            ? `${rellenados} rellenado${rellenados === 1 ? '' : 's'}`
            : 'marca, modelo, compra, vida útil…'}
        </span>
      </button>

      {abierto &&
        grupos.map((g) => {
          const campos = CAMPOS_DE_FICHA.filter(
            (c) => c.grupo === g && !A_LA_VISTA.includes(c.clave),
          )
          if (campos.length === 0) return null
          return (
            <fieldset key={g} className="mt-4">
              <legend className="eyebrow">{GRUPO_LABEL[g]}</legend>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">{campos.map(pintarCampo)}</div>
            </fieldset>
          )
        })}

      <label className="mt-4 block text-sm">
        <span className="text-muted">Nota de la entrada (opcional)</span>
        <input
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="Renovación de proyectores del edificio H"
          className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base"
        />
      </label>

      {tocado && faltan.length > 0 && (
        <p role="alert" className="mt-3 text-sm text-crit">
          Falta {faltan.join(' y ')}.
        </p>
      )}
      {registrar.isError && (
        <p role="alert" className="mt-3 text-sm text-crit">
          {mensajeDeFallo(registrar.error)}
        </p>
      )}

      {registradas && !registrar.isPending && (
        <Confirmacion
          texto={`${registradas} Listo para el siguiente: cambia el número de serie.`}
          className="mt-3"
        />
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button aria-busy={registrar.isPending} type="submit" disabled={registrar.isPending} className="key key-accent min-h-11 flex-1 px-3 text-sm">
          {registrar.isPending ? 'Registrando…' : 'Registrar la entrada'}
        </button>
        <button
          type="button"
          disabled={registrar.isPending}
          onClick={() => {
            setTocado(true)
            if (faltan.length > 0 || Object.keys(problemas).length > 0) return
            otra.current = true
            registrar.mutate()
          }}
          className="key key-quiet min-h-11 flex-1 px-3 text-sm"
        >
          Registrar y otra
        </button>
        <button type="button" onClick={() => onFin(null)} className="key key-quiet min-h-11 px-3 text-sm">
          Cancelar
        </button>
      </div>
    </form>
  )
}
