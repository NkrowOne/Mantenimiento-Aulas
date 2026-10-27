import { useId, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { diaEnMadrid, fechaCorta } from '@/domain/fechas'
import { ASSET_STATUS_LABELS, type AssetStatus } from '@/domain/types'
import {
  CAMPOS_DE_FICHA,
  DESTINO_LABEL,
  ESTADO_DE_VIDA_LABEL,
  GRUPO_LABEL,
  MOVIMIENTO_LABEL,
  borradorDe,
  cambiosDeFicha,
  esOrdenador,
  estadoDeVida,
  finDeVida,
  leerPrecio,
  problemasDeFicha,
  type BorradorDeFicha,
  type CampoDeFicha,
  type EquipoDelRegistro,
  type EstadoDeVida,
  type GrupoDeFicha,
} from '@/domain/fichaDeEquipo'
import { MOTIVO_MIN, faltanParaElMotivo, motivoValido } from './motivo'
import {
  mensajeDeFallo,
  refrescarTrasCambio,
  useHistorialDeEquipo,
  type EdificioElegible,
  type SalaElegible,
} from './equiposDatos'

/**
 * La ficha de un equipo: todo lo que se sabe de él, y desde aquí se cambia.
 *
 * Se abre debajo de su fila en la lista de Equipos, como el cierre de una
 * avería se abre debajo de la avería: la fila que se tocó sigue a la vista y no
 * hay una pantalla nueva de la que volver.
 *
 * **Editar es de supervisor y de administrador**, y lo decide la base: la
 * pantalla solo esconde las casillas a quien no puede, y un técnico ve la ficha
 * entera para leerla —el número de serie, la garantía, el hostname— porque es
 * quien está delante del aparato cuando hace falta saberlo.
 *
 * **Necesita conexión**, como el resto de lo que se toca desde un despacho: la
 * ficha de compra no nace en el aula y no hay nada que guardar sin red.
 *
 * Los tres verbos que mueven un equipo —guardar, trasladar, dar de baja— van
 * cada uno por su sitio y no en un solo «Guardar»: un traslado y una baja dejan
 * un evento en el histórico de las salas, y la baja además puede devolver una
 * unidad al almacén. Son actos, no casillas.
 */
export function FichaDeEquipo({
  equipo,
  puedeEditar,
  salas,
  edificios,
  onCerrar,
}: {
  equipo: EquipoDelRegistro
  puedeEditar: boolean
  salas: SalaElegible[]
  edificios: EdificioElegible[]
  onCerrar: () => void
}): React.ReactElement {
  const qc = useQueryClient()
  const [borrador, setBorrador] = useState<BorradorDeFicha>(() => borradorDe(equipo))
  const [estado, setEstado] = useState<AssetStatus>(equipo.status)
  const [tocado, setTocado] = useState(false)
  const [accion, setAccion] = useState<'trasladar' | 'baja' | null>(null)
  const [hecho, setHecho] = useState<string | null>(null)
  const [conOrdenador, setConOrdenador] = useState(
    () => esOrdenador(equipo) || CAMPOS_DE_FICHA.some((c) => c.grupo === 'ordenador' && borrador[c.clave] !== ''),
  )

  const retirado = equipo.status === 'retirado'
  const editable = puedeEditar && !retirado
  const problemas = problemasDeFicha(borrador)
  const hayProblemas = Object.keys(problemas).length > 0
  const cambios = useMemo(() => {
    const c: Record<string, string | number | null> = { ...cambiosDeFicha(equipo, borrador) }
    if (estado !== equipo.status) c['status'] = estado
    return c
  }, [equipo, borrador, estado])
  const hayCambios = Object.keys(cambios).length > 0

  // El fin de vida y su estado, calculados mientras se escribe: lo que se va a
  // guardar, no lo que había.
  const fin = finDeVida({
    acquired_at: borrador.acquired_at || null,
    end_of_life: borrador.end_of_life || null,
    vida_util_anyos: equipo.vida_util_anyos,
  })
  const vida = estadoDeVida(fin, diaEnMadrid())

  const guardar = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.from('assets').update(cambios).eq('id', equipo.id).select('id')
      if (error) throw error
      // Un UPDATE que la política no deja pasar no da error: no toca ninguna
      // fila. Sin esta comprobación la ficha diría «guardado» y no lo estaría.
      if (!data || data.length === 0) throw new Error('No tienes permiso para cambiar este equipo.')

      // El espejo de este dispositivo, si tiene el equipo: la próxima
      // corrección desde el aula sale de él, y con el modelo viejo pisaría el
      // que se acaba de guardar.
      const local = await db.assets.get(equipo.id)
      if (local) await db.assets.put({ ...local, ...cambios } as typeof local)
    },
    onSuccess: () => {
      setHecho('Guardado.')
      setTocado(false)
      refrescarTrasCambio(qc, [equipo.room_id])
    },
  })

  function cambiar(clave: keyof BorradorDeFicha, valor: string): void {
    setBorrador((b) => ({ ...b, [clave]: valor }))
    setHecho(null)
  }

  const grupos: GrupoDeFicha[] = ['identidad', 'compra', 'vida', 'ordenador', 'notas']

  return (
    <div className="mt-3 rounded-ctl border border-line bg-raised p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="eyebrow">Ficha del equipo</p>
          <p className="mt-1 text-sm font-medium">
            {equipo.type_name}
            {equipo.label && equipo.label !== equipo.type_name ? ` · ${equipo.label}` : ''}
            <span className="text-muted">
              {' · '}
              {equipo.room_code ? `${equipo.room_code}${equipo.building_code ? ` ${equipo.building_code}` : ''}` : 'Sin sala'}
            </span>
          </p>
        </div>
        <button type="button" onClick={onCerrar} className="key key-quiet min-h-11 px-3 text-sm">
          Cerrar
        </button>
      </div>

      {retirado && (
        <p className="mt-2 rounded-ctl bg-sunken p-2 text-sm text-muted">
          Retirado{equipo.baja_at ? ` el ${fechaCorta(equipo.baja_at)}` : ''}. Se conserva para poder
          buscarlo por número de serie; ya no cuenta en el inventario de ninguna sala.
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          setTocado(true)
          if (!hayProblemas && hayCambios) guardar.mutate()
        }}
      >
        {grupos.map((g) => {
          if (g === 'ordenador' && !conOrdenador) {
            return editable ? (
              <button
                key={g}
                type="button"
                onClick={() => setConOrdenador(true)}
                className="key key-quiet mt-3 min-h-11 w-full px-3 text-sm"
              >
                ¿Es un ordenador? Añade sus datos
              </button>
            ) : null
          }
          const campos = CAMPOS_DE_FICHA.filter((c) => c.grupo === g)
          return (
            <fieldset key={g} className="mt-4">
              <legend className="eyebrow">{GRUPO_LABEL[g]}</legend>
              {g === 'vida' && (
                <VidaUtil fin={fin} vida={vida} anyos={equipo.vida_util_anyos} tipo={equipo.type_name} />
              )}
              {editable ? (
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  {campos.map((c) => (
                    <Casilla
                      key={c.clave}
                      campo={c}
                      valor={borrador[c.clave]}
                      problema={tocado || borrador[c.clave] !== borradorDe(equipo)[c.clave] ? problemas[c.clave] : undefined}
                      onCambio={(v) => cambiar(c.clave, v)}
                    />
                  ))}
                  {g === 'identidad' && (
                    <label className="block text-sm">
                      <span className="text-muted">Estado</span>
                      <select
                        value={estado}
                        onChange={(e) => {
                          setEstado(e.target.value as AssetStatus)
                          setHecho(null)
                        }}
                        className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base"
                      >
                        <option value="instalado">{ASSET_STATUS_LABELS.instalado}</option>
                        <option value="averiado">{ASSET_STATUS_LABELS.averiado}</option>
                      </select>
                    </label>
                  )}
                </div>
              ) : (
                <Lectura campos={campos} equipo={equipo} conEstado={g === 'identidad'} />
              )}
            </fieldset>
          )
        })}

        {guardar.isError && (
          <p role="alert" className="mt-3 text-sm text-crit">
            {mensajeDeFallo(guardar.error)}
          </p>
        )}
        {tocado && hayProblemas && (
          <p role="alert" className="mt-3 text-sm text-crit">
            Hay casillas mal escritas: están señaladas arriba.
          </p>
        )}
        {hecho && <p className="mt-3 text-sm text-ok">{hecho}</p>}

        {editable && (
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={guardar.isPending || !hayCambios}
              className="key key-accent min-h-11 flex-1 px-3 text-sm"
            >
              {guardar.isPending ? 'Guardando…' : hayCambios ? 'Guardar cambios' : 'Sin cambios'}
            </button>
            {hayCambios && (
              <button
                type="button"
                onClick={() => {
                  setBorrador(borradorDe(equipo))
                  setEstado(equipo.status)
                  setTocado(false)
                }}
                className="key key-quiet min-h-11 px-3 text-sm"
              >
                Deshacer
              </button>
            )}
          </div>
        )}
      </form>

      {editable && (
        <div className="mt-4 border-t border-hair pt-3">
          <p className="eyebrow">Mover el equipo</p>
          {accion === null && (
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={() => setAccion('trasladar')} className="key key-quiet min-h-11 px-3 text-sm">
                Trasladar a otra sala
              </button>
              <button type="button" onClick={() => setAccion('baja')} className="key key-quiet min-h-11 px-3 text-sm">
                Dar de baja
              </button>
            </div>
          )}
          {accion === 'trasladar' && (
            <Trasladar equipo={equipo} salas={salas} edificios={edificios} onFin={(m) => {
              setAccion(null)
              if (m) setHecho(m)
            }} />
          )}
          {accion === 'baja' && (
            <DarDeBaja equipo={equipo} onFin={(m) => {
              setAccion(null)
              if (m) {
                setHecho(m)
                onCerrar()
              }
            }} />
          )}
        </div>
      )}

      <Historial assetId={equipo.id} />
    </div>
  )
}

function Casilla({
  campo,
  valor,
  problema,
  onCambio,
}: {
  campo: CampoDeFicha
  valor: string
  problema: string | undefined
  onCambio: (v: string) => void
}): React.ReactElement {
  const ayuda = useId()
  const clase = `mt-1 w-full rounded-ctl border bg-surface px-3 text-base ${problema ? 'border-crit' : 'border-line'} ${
    campo.codigo ? 'font-mono uppercase' : ''
  }`
  return (
    <label className={`block text-sm ${campo.tipo === 'largo' ? 'sm:col-span-2' : ''}`}>
      <span className="text-muted">{campo.etiqueta}</span>
      {campo.tipo === 'largo' ? (
        <textarea
          value={valor}
          onChange={(e) => onCambio(e.target.value)}
          rows={3}
          className={`${clase} py-2`}
        />
      ) : (
        <input
          value={valor}
          onChange={(e) => onCambio(e.target.value)}
          type={campo.tipo === 'fecha' ? 'date' : 'text'}
          inputMode={campo.tipo === 'precio' ? 'decimal' : campo.tipo === 'ip' ? 'decimal' : undefined}
          placeholder={campo.pista}
          autoCapitalize={campo.codigo ? 'characters' : undefined}
          autoCorrect={campo.codigo || campo.tipo === 'mac' || campo.tipo === 'ip' ? 'off' : undefined}
          spellCheck={campo.codigo ? false : undefined}
          aria-invalid={problema !== undefined}
          aria-describedby={problema ? ayuda : undefined}
          className={`${clase} h-11`}
        />
      )}
      {problema && (
        <span id={ayuda} role="alert" className="mt-1 block text-xs text-crit">
          {problema}
        </span>
      )}
    </label>
  )
}

/** La ficha para quien solo puede leerla: lo que hay, sin casillas vacías. */
function Lectura({
  campos,
  equipo,
  conEstado,
}: {
  campos: CampoDeFicha[]
  equipo: EquipoDelRegistro
  conEstado: boolean
}): React.ReactElement {
  const filas: Array<[string, string]> = []
  if (conEstado) filas.push(['Estado', ASSET_STATUS_LABELS[equipo.status]])
  for (const c of campos) {
    const v = equipo[c.clave]
    if (v === null || v === undefined || v === '') continue
    if (c.tipo === 'fecha') filas.push([c.etiqueta, fechaCorta(String(v).slice(0, 10))])
    else if (c.tipo === 'precio') {
      const n = typeof v === 'number' ? v : leerPrecio(String(v).replace('.', ','))
      filas.push([c.etiqueta, n !== null && Number.isFinite(n) ? `${n.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €` : String(v)])
    } else filas.push([c.etiqueta, String(v)])
  }
  if (filas.length === 0) return <p className="mt-2 text-sm text-muted">Sin datos.</p>
  return (
    <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
      {filas.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="break-words">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

const TONO_DE_VIDA: Record<EstadoDeVida, string> = {
  obsoleto: 'bg-crit-tint text-crit',
  proximo: 'bg-warn-tint text-warn',
  vigente: 'bg-ok-tint text-ok-ink',
  sin_datos: 'bg-sunken text-muted',
}

export function EtiquetaDeVida({ vida, fin }: { vida: EstadoDeVida; fin?: string | null }): React.ReactElement {
  return (
    <span className={`shrink-0 rounded-tag px-1.5 py-0.5 text-[0.6875rem] font-medium ${TONO_DE_VIDA[vida]}`}>
      {vida === 'sin_datos' ? 'Sin vida útil' : vida === 'proximo' ? 'Caduca pronto' : ESTADO_DE_VIDA_LABEL[vida]}
      {fin && vida !== 'sin_datos' ? ` · ${fechaCorta(fin)}` : ''}
    </span>
  )
}

function VidaUtil({
  fin,
  vida,
  anyos,
  tipo,
}: {
  fin: string | null
  vida: EstadoDeVida
  anyos: number | null
  tipo: string
}): React.ReactElement {
  return (
    <div className="mt-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <EtiquetaDeVida vida={vida} fin={fin} />
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        {anyos
          ? `Los equipos de tipo «${tipo}» duran ${anyos} ${anyos === 1 ? 'año' : 'años'}: el fin de vida es la fecha de adquisición más eso. Si este se acaba antes, fíjalo a mano.`
          : `El tipo «${tipo}» no tiene vida útil definida. Ponla en «Vida útil por tipo», o fija aquí la fecha a mano.`}
      </p>
    </div>
  )
}

function Trasladar({
  equipo,
  salas,
  edificios,
  onFin,
}: {
  equipo: EquipoDelRegistro
  salas: SalaElegible[]
  edificios: EdificioElegible[]
  onFin: (mensaje: string | null) => void
}): React.ReactElement {
  const qc = useQueryClient()
  const [buildingId, setBuildingId] = useState(equipo.building_id ?? '')
  const [roomId, setRoomId] = useState('')
  const [motivo, setMotivo] = useState('')
  const delEdificio = salas.filter((s) => s.buildingId === buildingId && s.id !== equipo.room_id)
  const destino = salas.find((s) => s.id === roomId)

  const trasladar = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('asset_trasladar', {
        p_asset: equipo.id,
        p_room: roomId,
        p_motivo: motivo.trim() || null,
      })
      if (error) throw error
    },
    onSuccess: () => {
      refrescarTrasCambio(qc, [equipo.room_id, roomId])
      onFin(`Trasladado a ${destino?.etiqueta ?? 'la sala elegida'}. Queda en el histórico de las dos salas.`)
    },
  })

  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      <select
        value={buildingId}
        onChange={(e) => {
          setBuildingId(e.target.value)
          setRoomId('')
        }}
        aria-label="Edificio de destino"
        className="h-11 rounded-ctl border border-line bg-surface px-2 text-base"
      >
        <option value="">Edificio…</option>
        {edificios.map((b) => (
          <option key={b.id} value={b.id}>
            {b.code} — {b.name}
          </option>
        ))}
      </select>
      <select
        value={roomId}
        onChange={(e) => setRoomId(e.target.value)}
        disabled={!buildingId}
        aria-label="Sala de destino"
        className="h-11 rounded-ctl border border-line bg-surface px-2 text-base"
      >
        <option value="">{buildingId ? 'Sala…' : 'Elige edificio'}</option>
        {delEdificio.map((s) => (
          <option key={s.id} value={s.id}>
            {s.etiqueta}
          </option>
        ))}
      </select>
      <input
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        placeholder="Por qué (opcional)"
        aria-label="Motivo del traslado"
        className="h-11 rounded-ctl border border-line bg-surface px-3 text-base sm:col-span-2"
      />
      {trasladar.isError && (
        <p role="alert" className="text-sm text-crit sm:col-span-2">
          {mensajeDeFallo(trasladar.error)}
        </p>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <button
          type="button"
          disabled={!roomId || trasladar.isPending}
          onClick={() => trasladar.mutate()}
          className="key key-accent min-h-11 flex-1 px-3 text-sm"
        >
          {trasladar.isPending ? 'Trasladando…' : 'Trasladar'}
        </button>
        <button type="button" onClick={() => onFin(null)} className="key key-quiet min-h-11 px-3 text-sm">
          Cancelar
        </button>
      </div>
    </div>
  )
}

function DarDeBaja({
  equipo,
  onFin,
}: {
  equipo: EquipoDelRegistro
  onFin: (mensaje: string | null) => void
}): React.ReactElement {
  const qc = useQueryClient()
  const ayuda = useId()
  const [destino, setDestino] = useState<'baja' | 'almacen'>('baja')
  const [motivo, setMotivo] = useState('')

  const baja = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('asset_dar_de_baja', {
        p_asset: equipo.id,
        p_destino: destino,
        p_motivo: motivo.trim(),
      })
      if (error) throw error
    },
    onSuccess: () => {
      refrescarTrasCambio(qc, [equipo.room_id])
      onFin(destino === 'almacen' ? 'Devuelto al almacén: suma una unidad a su artículo.' : 'Dado de baja.')
    },
  })

  return (
    <div className="mt-2">
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">A dónde va</legend>
        {(['baja', 'almacen'] as const).map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={destino === d}
            onClick={() => setDestino(d)}
            className={`key min-h-11 px-3 text-sm ${destino === d ? 'key-accent' : 'key-quiet text-muted'}`}
          >
            {DESTINO_LABEL[d]}
          </button>
        ))}
      </fieldset>
      <input
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        placeholder={`Por qué (mínimo ${MOTIVO_MIN} caracteres)`}
        aria-label="Motivo de la baja"
        aria-describedby={ayuda}
        className="mt-2 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base"
      />
      <p id={ayuda} className="mt-1 text-xs leading-relaxed text-muted">
        {faltanParaElMotivo(motivo) > 0
          ? `El motivo es obligatorio: faltan ${faltanParaElMotivo(motivo)} caracteres.`
          : destino === 'almacen'
            ? 'Sale de la sala, se queda sin sala y suma una unidad al almacén, igual que una retirada autorizada.'
            : 'Sale del inventario, conserva la sala en la que estuvo y la baja queda en su histórico.'}
      </p>
      {baja.isError && (
        <p role="alert" className="mt-2 text-sm text-crit">
          {mensajeDeFallo(baja.error)}
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={!motivoValido(motivo) || baja.isPending}
          onClick={() => baja.mutate()}
          className="key key-accent min-h-11 flex-1 px-3 text-sm"
        >
          {baja.isPending ? 'Guardando…' : 'Confirmar la baja'}
        </button>
        <button type="button" onClick={() => onFin(null)} className="key key-quiet min-h-11 px-3 text-sm">
          Cancelar
        </button>
      </div>
    </div>
  )
}

function Historial({ assetId }: { assetId: string }): React.ReactElement {
  const { data, isPending, isError, error } = useHistorialDeEquipo(assetId)
  return (
    <div className="mt-4 border-t border-hair pt-3">
      <p className="eyebrow">Historial del equipo</p>
      {isPending && <p className="mt-2 text-sm text-muted">Cargando…</p>}
      {isError && <p className="mt-2 text-sm text-crit">{mensajeDeFallo(error)}</p>}
      {data && data.length === 0 && (
        <p className="mt-2 text-sm text-muted">
          Sin entradas, salidas ni traslados registrados. Los equipos que trajo el importador no
          tienen evento de alta.
        </p>
      )}
      {data && data.length > 0 && (
        <ul className="mt-2 space-y-2">
          {data.map((m) => (
            <li key={m.id} className="text-sm">
              <span className="font-medium">{MOVIMIENTO_LABEL[m.kind] ?? m.kind}</span>
              <span className="text-muted">
                {' · '}
                {fechaCorta(m.occurred_at)}
                {m.room_code ? ` · ${m.room_code}${m.building_code ? ` ${m.building_code}` : ''}` : ''}
                {m.by_name ? ` · ${m.by_name}` : ''}
              </span>
              {m.destino && <span className="text-muted"> · {DESTINO_LABEL[m.destino] ?? m.destino}</span>}
              {m.motivo && <p className="text-xs text-muted">{m.motivo}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
