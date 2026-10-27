import { useMemo, useState } from 'react'
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
export function EntradaDeEquipo({
  tipos,
  salas,
  edificios,
  onFin,
}: {
  tipos: TipoElegible[]
  salas: SalaElegible[]
  edificios: EdificioElegible[]
  onFin: (mensaje: string | null) => void
}): React.ReactElement {
  const qc = useQueryClient()
  const [id] = useState(() => uuidv7())
  const [tipoId, setTipoId] = useState('')
  const [buildingId, setBuildingId] = useState('')
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
      onFin(`Entrada registrada: ${tipo?.name ?? 'equipo'} en ${sala?.etiqueta ?? 'la sala'}.`)
    },
  })

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

      {grupos.map((g) => (
        <fieldset key={g} className="mt-4">
          <legend className="eyebrow">{GRUPO_LABEL[g]}</legend>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {CAMPOS_DE_FICHA.filter((c) => c.grupo === g).map((c) => (
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
            ))}
          </div>
        </fieldset>
      ))}

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

      <div className="mt-4 flex gap-2">
        <button type="submit" disabled={registrar.isPending} className="key key-accent min-h-11 flex-1 px-3 text-sm">
          {registrar.isPending ? 'Registrando…' : 'Registrar la entrada'}
        </button>
        <button type="button" onClick={() => onFin(null)} className="key key-quiet min-h-11 px-3 text-sm">
          Cancelar
        </button>
      </div>
    </form>
  )
}
