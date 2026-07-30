import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { displayRoomCode } from '@/domain/normalize'
import { diaEnMadrid } from '@/domain/fechas'
import { identifyAsset } from '@/domain/inventory'
import type { AssetModel, AssetType } from '@/domain/types'
import { SelectorDeModelo } from './SelectorDeModelo'
import type { AltaDeEquipo, ModeloElegido, Origen } from './useRoomInventory'

/**
 * ¿De dónde sale este equipo?
 *
 * Es la pregunta que faltaba. Hasta ahora dar de alta un proyector en un aula
 * no movía nada más: el almacén seguía diciendo que tenía doce y el aula de al
 * lado seguía diciendo que tenía el suyo. Un inventario que solo suma no cuadra
 * nunca.
 *
 * El panel abre con la respuesta más probable ya elegida —del almacén si hay
 * existencias de ese tipo, «ya estaba» si no— para que el caso normal sea
 * confirmar y no rellenar. Es la diferencia entre un paso más y un formulario.
 *
 * Las existencias salen del espejo local, así que la cifra se ve también sin
 * cobertura. Puede tener horas: la buena la tiene el servidor, que rechaza el
 * consumo si no llegan las unidades. Por eso la cifra se enseña como dato y
 * nunca como permiso — no bloquea el botón.
 */

type Modo = 'almacen' | 'traslado' | 'sin_origen'

export function OrigenDelEquipo({
  typeName,
  type,
  roomId,
  inventariando,
  onCancelar,
  onConfirmar,
}: {
  typeName: string
  type: AssetType | null
  roomId: string
  /**
   * La sala está sin inventariar, así que lo que se está haciendo es un
   * levantamiento y no una instalación. Cambia la respuesta que viene elegida:
   * durante un barrido, todo «ya estaba», y preguntar de dónde sale veinte
   * veces seguidas es justo lo que hace que se deje de apuntar.
   */
  inventariando: boolean
  onCancelar: () => void
  onConfirmar: (alta: AltaDeEquipo) => void
}): React.ReactElement {
  // --- Almacén ---------------------------------------------------------------
  const articulos = useLiveQuery(
    async () => {
      if (!type) return []
      const items = await db.stockItems.toArray()
      const niveles = new Map((await db.stockLevels.toArray()).map((n) => [n.stock_item_id, n]))
      return items
        .filter((i) => i.asset_type_id === type.id)
        .map((i) => ({ id: i.id, name: i.name, onHand: niveles.get(i.id)?.on_hand ?? null }))
        .sort((a, b) => (b.onHand ?? -1) - (a.onHand ?? -1) || a.name.localeCompare(b.name, 'es'))
    },
    [type?.id],
    [],
  )

  const conExistencias = articulos.filter((a) => (a.onHand ?? 0) > 0)
  const [stockItemId, setStockItemId] = useState('')
  const [unidades, setUnidades] = useState(1)

  // --- Traslado --------------------------------------------------------------
  const [buildingId, setBuildingId] = useState('')
  const [origenRoomId, setOrigenRoomId] = useState('')
  const [assetId, setAssetId] = useState('')

  const buildings = useLiveQuery(() => db.buildings.orderBy('sort_order').toArray(), [], [])

  const salas = useLiveQuery(
    async () => {
      if (!buildingId) return []
      const zones = await db.zones.where('building_id').equals(buildingId).toArray()
      const zoneIds = new Set(zones.map((z) => z.id))
      const rooms = await db.rooms.filter((r) => zoneIds.has(r.zone_id) && r.id !== roomId).toArray()
      return rooms.sort((a, b) => a.code.localeCompare(b.code, 'es', { numeric: true }))
    },
    [buildingId, roomId],
    [],
  )

  const equipos = useLiveQuery(
    async () => {
      if (!origenRoomId) return []
      const enSala = await db.assets.where('room_id').equals(origenRoomId).toArray()
      const tipos = new Map((await db.assetTypes.toArray()).map((t) => [t.id, t]))
      const modelos = new Map<string, AssetModel>(
        (await db.assetModels.toArray()).map((m) => [m.id, m]),
      )
      return enSala
        .filter((a) => a.status !== 'retirado')
        .map((a) => {
          const id = identifyAsset(a, tipos, modelos)
          return {
            id: a.id,
            label: id.etiqueta,
            esDelTipo: a.asset_type_id === type?.id,
            // Marca, modelo y serie: es lo que distingue un ordenador de otro en
            // una lista donde todos se llaman «Ordenador».
            detalle: id.ficha,
          }
        })
        // Los del tipo que se está añadiendo, primero: es lo que casi siempre
        // se busca, y en una sala con ocho equipos ahorra leerlos todos.
        .sort((a, b) => Number(b.esDelTipo) - Number(a.esDelTipo) || a.label.localeCompare(b.label, 'es'))
    },
    [origenRoomId, type?.id],
    [],
  )

  // --- Modo ------------------------------------------------------------------
  const sugerido: Modo =
    inventariando || conExistencias.length === 0 ? 'sin_origen' : 'almacen'
  const [modo, setModo] = useState<Modo>(sugerido)

  // Las existencias llegan del espejo un instante después del primer pintado,
  // así que el modo sugerido se recalcula cuando aparecen. Solo mientras nadie
  // haya tocado nada: cambiarle la elección al técnico bajo el dedo sería peor
  // que empezar en el modo que no toca.
  const [tocado, setTocado] = useState(false)
  useEffect(() => {
    if (!tocado) setModo(sugerido)
  }, [sugerido, tocado])

  useEffect(() => {
    if (!stockItemId && conExistencias[0]) setStockItemId(conExistencias[0].id)
  }, [conExistencias, stockItemId])

  useEffect(() => setOrigenRoomId(''), [buildingId])
  useEffect(() => setAssetId(''), [origenRoomId])

  const elegido = articulos.find((a) => a.id === stockItemId) ?? null
  const disponibles = elegido?.onHand ?? null

  // --- Identidad del aparato -------------------------------------------------
  const [modelo, setModelo] = useState<ModeloElegido | null>(null)
  const [serial, setSerial] = useState('')
  /*
   * Desde cuándo está puesto.
   *
   * Hoy por defecto, que es lo correcto al instalar algo. Durante un
   * levantamiento casi nunca lo es —el aparato lleva años ahí— y por eso el
   * campo está a la vista en vez de escondido: preguntar es barato, corregir 276
   * fechas después no lo es.
   */
  const [instaladoEl, setInstaladoEl] = useState(() => diaEnMadrid())

  const listo = useMemo(() => {
    if (modo === 'almacen') return Boolean(stockItemId) && unidades >= 1
    if (modo === 'traslado') return Boolean(assetId)
    return true
  }, [modo, stockItemId, unidades, assetId])

  function confirmar(): void {
    const origen: Origen =
      modo === 'almacen'
        ? { tipo: 'almacen', stockItemId, unidades }
        : modo === 'traslado'
          ? { tipo: 'traslado', assetId, desdeRoomId: origenRoomId }
          : { tipo: 'sin_origen' }

    onConfirmar({
      origen,
      modelo,
      // Mediodía y no medianoche: con un campo de fecha sin hora, la medianoche
      // en UTC cae en el día anterior para media Europa y la fecha se ve movida
      // un día en la ficha del equipo.
      instaladoEl: new Date(`${instaladoEl}T12:00:00`).toISOString(),
      serial: serial.trim() || null,
    })
  }

  /* En un traslado no se pregunta ni marca ni serie: el aparato ya existe y las
     trae consigo. Cambiárselas aquí sería reescribir el inventario de la sala de
     origen desde la de destino, que es justo lo que un traslado no es. */
  const pideIdentidad = modo !== 'traslado'
  const unaSola = modo !== 'almacen' || unidades === 1

  const MODOS: Array<{ id: Modo; label: string; disponible: boolean }> = [
    { id: 'almacen', label: 'Del almacén', disponible: articulos.length > 0 },
    { id: 'traslado', label: 'De otra sala', disponible: true },
    { id: 'sin_origen', label: 'Ya estaba', disponible: true },
  ]

  return (
    <div className="mt-2 rounded-ctl border border-accent/30 bg-sunken p-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">Añadir «{typeName}»</p>
        <button
          type="button"
          onClick={onCancelar}
          className="shrink-0 text-xs text-muted underline-offset-4 hover:underline"
        >
          Cancelar
        </button>
      </div>

      {/* Control segmentado: las tres respuestas se ven a la vez y se compara
          entre ellas. Con un desplegable habría que abrirlo para saber que
          existe la opción de traslado. */}
      <div className="mt-2 flex gap-1 rounded-ctl border border-line bg-surface p-1">
        {MODOS.filter((m) => m.disponible).map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              setTocado(true)
              setModo(m.id)
            }}
            aria-pressed={modo === m.id}
            className={`min-h-11 flex-1 rounded-ctl px-2 text-xs font-semibold ${
              modo === m.id ? 'key key-accent' : 'text-muted'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {modo === 'almacen' && (
        <div className="mt-3">
          {articulos.length === 0 ? (
            <p className="text-xs text-muted">
              Este tipo de equipo no tiene ningún artículo asociado en el almacén.
            </p>
          ) : (
            <>
              <label className="block text-xs text-muted">
                Artículo del almacén
                <select
                  value={stockItemId}
                  onChange={(e) => setStockItemId(e.target.value)}
                  className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
                >
                  {articulos.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.onHand !== null ? ` · ${a.onHand} en almacén` : ''}
                    </option>
                  ))}
                </select>
              </label>

              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-xs text-muted">Unidades</span>
                <span className="inline-flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setUnidades((n) => Math.max(1, n - 1))}
                    className="key key-quiet h-11 w-11"
                    aria-label="Una unidad menos"
                  >
                    −
                  </button>
                  <span className="w-6 text-center font-mono tabular">{unidades}</span>
                  <button
                    type="button"
                    onClick={() => setUnidades((n) => n + 1)}
                    className="key key-quiet h-11 w-11"
                    aria-label="Una unidad más"
                  >
                    +
                  </button>
                </span>
              </div>

              {/*
                El aviso es aviso y no bloqueo. La cifra del espejo puede tener
                horas —otro técnico pudo gastar la última esta mañana— y quien
                está delante del aparato sabe mejor que este número si la caja
                estaba ahí. El servidor tiene la palabra final.
              */}
              {disponibles !== null && unidades > disponibles && (
                <p className="mt-2 text-xs text-warn">
                  Según la última descarga solo quedan {disponibles}. Si no llegan, el descuento se
                  quedará pendiente y lo verás en el chip de sincronización.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {modo === 'traslado' && (
        <div className="mt-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-muted">
              Edificio
              <select
                value={buildingId}
                onChange={(e) => setBuildingId(e.target.value)}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
              >
                <option value="">Elige…</option>
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} — {b.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs text-muted">
              Sala
              <select
                value={origenRoomId}
                onChange={(e) => setOrigenRoomId(e.target.value)}
                disabled={!buildingId}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink disabled:opacity-40"
              >
                <option value="">{buildingId ? 'Elige…' : '—'}</option>
                {salas.map((r) => (
                  <option key={r.id} value={r.id}>
                    {displayRoomCode(r.code)} — {r.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {origenRoomId && (
            <label className="mt-2 block text-xs text-muted">
              Equipo que se trae
              <select
                value={assetId}
                onChange={(e) => setAssetId(e.target.value)}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
              >
                <option value="">Elige…</option>
                {equipos.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                    {a.detalle ? ` · ${a.detalle}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          {origenRoomId && equipos.length === 0 && (
            <p className="mt-2 text-xs text-muted">Esa sala no tiene equipos registrados.</p>
          )}

          <p className="mt-2 text-xs text-muted">
            El equipo se mueve con su modelo, su número de serie y su histórico, y deja de estar en
            la sala de origen.
          </p>
        </div>
      )}

      {modo === 'sin_origen' && (
        <p className="mt-3 text-xs text-muted">
          {inventariando
            ? 'Esta sala está sin inventariar, así que viene elegido lo más probable: el aparato ya estaba y solo faltaba apuntarlo. Si lo acabas de traer, dilo arriba.'
            : 'Se apunta el equipo sin tocar el almacén. Es lo que toca cuando el aparato ya estaba en la sala y solo faltaba registrarlo.'}
        </p>
      )}

      {/*
        Marca, modelo, serie y fecha, en el mismo paso y no dos pantallas más
        adentro.

        Es la diferencia entre un inventario que dice «hay un ordenador» y uno
        que dice «hay un Lenovo U3302, número de serie tal, desde marzo». Y tiene
        que ser aquí: quien está delante del aparato lee la pegatina de un
        vistazo; obligarle a añadir primero y corregir después significa que la
        segunda mitad no se hace nunca.

        Todo es opcional a propósito. «No consta» es una respuesta legítima y
        frecuente, y bloquear el alta por un modelo ilegible haría que el equipo
        no se apuntara — que es infinitamente peor.
      */}
      {pideIdentidad && (
        <div className="mt-3 border-t border-line pt-3">
          <p className="eyebrow">Qué aparato es</p>

          <div className="mt-2 text-xs text-muted">
            Marca y modelo
            <div className="mt-1">
              <SelectorDeModelo
                typeId={type?.id ?? null}
                value={modelo && 'id' in modelo ? modelo.id : null}
                onChange={setModelo}
                autoFocus={false}
              />
            </div>
            {modelo && !('id' in modelo) && (
              <p className="mt-1 text-xs text-warn">
                Se creará «{[modelo.brand, modelo.model].filter(Boolean).join(' ')}» al añadirlo.
              </p>
            )}
            {!type && (
              <p className="mt-1 text-xs text-muted">
                El tipo se está creando ahora, así que el modelo se podrá elegir al corregir el
                equipo.
              </p>
            )}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            {unaSola && (
              <label className="text-xs text-muted">
                Nº de serie
                <input
                  type="text"
                  value={serial}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="done"
                  onChange={(e) => setSerial(e.target.value)}
                  className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 font-mono text-sm text-ink"
                />
              </label>
            )}
            <label className={`text-xs text-muted ${unaSola ? '' : 'col-span-2'}`}>
              Instalado el
              <input
                type="date"
                value={instaladoEl}
                max={diaEnMadrid()}
                onChange={(e) => setInstaladoEl(e.target.value || diaEnMadrid())}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
              />
            </label>
          </div>

          {!unaSola && (
            <p className="mt-2 text-xs text-muted">
              Son {unidades} aparatos, así que el número de serie se apunta después en cada uno.
            </p>
          )}
          {inventariando && (
            <p className="mt-2 text-xs text-muted">
              Si el aparato lleva años puesto, cambia la fecha: es lo que hace que el inventario
              diga desde cuándo está y no cuándo se apuntó.
            </p>
          )}
        </div>
      )}

      <button
        type="button"
        disabled={!listo}
        onClick={confirmar}
        className="key key-accent mt-3 min-h-touch w-full px-4 text-sm"
      >
        {modo === 'traslado' ? 'Trasladar aquí' : 'Añadir a la sala'}
      </button>
    </div>
  )
}
