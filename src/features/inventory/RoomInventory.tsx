import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { labelAvailable, resolveType, searchCatalog } from '@/domain/inventory'
import {
  ASSET_STATUS_LABELS,
  REMOVAL_DESTINO_HINTS,
  REMOVAL_DESTINO_LABELS,
  type Asset,
  type AssetRemoval,
  type AssetType,
  type RemovalDestino,
} from '@/domain/types'
import { typeRank } from '@/features/inspection/useInspection'
import { LevantarInventario } from './LevantarInventario'
import { OrigenDelEquipo } from './OrigenDelEquipo'
import { useRoomInventory, type Origen } from './useRoomInventory'

/**
 * El inventario de la sala, dentro de la propia revisión.
 *
 * Va aquí y no en una pantalla aparte por una razón sola: el momento en que
 * alguien descubre que el inventario está mal es cuando está delante del
 * aparato. Si para corregirlo hay que salir de la revisión, volver, buscar la
 * sala y encontrar el equipo, no se corrige — y el inventario se degrada hasta
 * que deja de servir para nada.
 *
 * Nace plegado. Lo normal es revisar y salir; esto es para el día que algo no
 * cuadra.
 */

interface Props {
  roomId: string
  userId: string | null
  assets: Asset[]
  types: AssetType[]
  typesById: Map<string, AssetType>
}

export function RoomInventory({ roomId, userId, assets, types, typesById }: Props): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [fixing, setFixing] = useState<string | null>(null)
  /* Lo que se va a añadir, esperando a que se diga de dónde sale. */
  const [eligiendo, setEligiendo] = useState<{ nombre: string; tipo: AssetType | null } | null>(null)

  const { addAssetConOrigen, cancelarRetirada, confirmarInventario, patchAsset, setStatus, solicitarRetirada } =
    useRoomInventory(roomId, userId)

  /* Las retiradas vivas de esta sala, por equipo. Del espejo: la marca tiene que
     verse en el aula sin cobertura, o quien la pidió ayer la vuelve a pedir. */
  const retiradas = useLiveQuery(
    async () => {
      const vivas = await db.assetRemovals.where('state').equals('pendiente').toArray()
      return new Map(vivas.map((r) => [r.asset_id, r]))
    },
    [],
    new Map<string, AssetRemoval>(),
  )

  /* Cuándo se confirmó por última vez que el inventario de esta sala está
     completo. Se lee del espejo para que confirmar se vea al instante. */
  const levantadoEl = useLiveQuery(
    async () => (await db.rooms.get(roomId))?.last_inventory_at ?? null,
    [roomId],
    null,
  )

  /*
   * Cuántas unidades hay en el almacén de cada tipo de equipo.
   *
   * Se calcula una vez para todo el panel y se enseña en la propia sugerencia,
   * antes de tocarla. Es la mitad barata de «que se señale bien si es de
   * stock»: quien busca «proyector» ve en la misma línea que hay doce en el
   * almacén, y eso ya cambia lo que va a hacer.
   */
  const stockPorTipo = useLiveQuery(async () => {
    const [items, niveles] = await Promise.all([db.stockItems.toArray(), db.stockLevels.toArray()])
    const onHand = new Map(niveles.map((n) => [n.stock_item_id, n.on_hand]))
    const total = new Map<string, number>()
    for (const i of items) {
      if (!i.asset_type_id) continue
      total.set(i.asset_type_id, (total.get(i.asset_type_id) ?? 0) + (onHand.get(i.id) ?? 0))
    }
    return total
  }, [], new Map<string, number>())

  // Mismo orden que las filas de arriba. Sin esto, el mismo equipamiento salía
  // dos veces en la misma pantalla en dos órdenes distintos.
  const live = assets
    .filter((a) => a.status !== 'retirado')
    .sort(
      (a, b) =>
        typeRank(typesById, a.asset_type_id) - typeRank(typesById, b.asset_type_id) ||
        (a.label ?? '').localeCompare(b.label ?? '', 'es', { numeric: true }),
    )
  const hits = searchCatalog(types, query)
  const raw = query.trim()

  async function add(origen: Origen): Promise<void> {
    if (!eligiendo) return
    const { nombre, tipo } = eligiendo
    const result = await addAssetConOrigen(nombre, tipo, origen)

    setEligiendo(null)
    setQuery('')
    setNote(
      !result.ok
        ? (result.error ?? 'No se pudo añadir.')
        : origen.tipo === 'traslado'
          ? `Trasladado «${result.label}» a esta sala.`
          : origen.tipo === 'almacen'
            ? `Añadido «${result.label}» y descontado del almacén.`
            : tipo
              ? `Añadido «${result.label}».`
              : `Añadido «${result.label}». Sale en naranja hasta que un coordinador lo valide.`,
    )
  }

  /** El equipo elegido, y si su tipo tiene existencias que enseñar. */
  const stockDe = useMemo(
    () => (tipo: AssetType | null): number | null =>
      tipo ? (stockPorTipo.get(tipo.id) ?? null) : null,
    [stockPorTipo],
  )

  return (
    <section className="border-t border-line">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="eyebrow">Equipos de la sala</span>
          {/*
            La marca de «sin inventariar» va en gris y no en naranja a
            propósito. Son 41 salas: en naranja, el color de aviso dejaría de
            significar nada en el resto de la aplicación. Aquí no hay nada roto,
            hay algo por hacer.
          */}
          {levantadoEl === null && (
            <span className="shrink-0 rounded-tag bg-sunken px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted">
              sin inventariar
            </span>
          )}
        </span>
        <span className="shrink-0 text-sm text-muted">
          {live.length} · {open ? 'cerrar' : 'añadir o corregir'}
        </span>
      </button>

      <div className="collapse-y" data-open={open} inert={!open}>
        <div>
          <div className="section-tail px-4 pb-4">
            {/* Alta. Buscar antes de crear es lo que impide que el catálogo se
                llene de sinónimos: quien escribe «jab» encuentra el micrófono
                que ya existe y nunca llega a la opción de crear. */}
            <label className="block">
              <span className="sr-only">Añadir equipo</span>
              <input
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setNote(null)
                }}
                placeholder="Añadir equipo: proyector, pantalla…"
                enterKeyHint="done"
                autoCorrect="off"
                /* La tecla de retorno acepta la primera sugerencia, que es lo
                   que promete decir «hecho». */
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  const primero = hits[0]
                  if (primero) setEligiendo({ nombre: primero.type.name, tipo: primero.type })
                  else if (raw.length >= 2) setEligiendo({ nombre: raw, tipo: null })
                }}
                className="h-touch w-full rounded-ctl border border-line bg-surface px-3"
              />
            </label>

            {raw && !eligiendo && (
              <div className="mt-2 flex flex-col gap-1">
                {hits.map((hit) => {
                  const enAlmacen = stockDe(hit.type)
                  return (
                    <button
                      key={hit.type.id}
                      type="button"
                      onClick={() => setEligiendo({ nombre: hit.type.name, tipo: hit.type })}
                      className="key key-quiet flex items-center justify-between gap-2 px-3 py-2 text-left text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate">{hit.type.name}</span>
                      {/*
                        La marca de almacén va en la propia sugerencia y no dos
                        pantallas más adentro: es lo que decide si el técnico va
                        a por una caja o busca en el aula de al lado, y esa
                        decisión se toma aquí.
                      */}
                      {enAlmacen !== null && enAlmacen > 0 && (
                        <span className="shrink-0 rounded-tag bg-accent-tint px-1.5 py-0.5 text-[0.6875rem] font-semibold text-accent">
                          {enAlmacen} en almacén
                        </span>
                      )}
                      <span className="shrink-0 text-xs font-normal text-muted">
                        {hit.why || (hit.type.confirmed ? 'del catálogo' : 'sin validar')}
                      </span>
                    </button>
                  )
                })}

                {hits.length === 0 && (
                  <button
                    type="button"
                    onClick={() => setEligiendo({ nombre: raw, tipo: null })}
                    className="key flex items-center justify-between border border-warn/40 bg-warn-tint px-3 py-2 text-left text-sm text-warn"
                  >
                    <span>Crear «{raw}»</span>
                    <span className="text-xs font-normal">pendiente de validar</span>
                  </button>
                )}
              </div>
            )}

            {eligiendo && (
              <OrigenDelEquipo
                typeName={eligiendo.nombre}
                type={eligiendo.tipo}
                roomId={roomId}
                inventariando={levantadoEl === null}
                onCancelar={() => setEligiendo(null)}
                onConfirmar={(origen) => void add(origen)}
              />
            )}

            {note && <p className="mt-2 text-xs text-muted">{note}</p>}

            <ul className="mt-3 divide-y divide-line-soft">
              {live.map((asset) => {
                const type = resolveType(typesById, asset.asset_type_id)
                const pending = type ? !type.confirmed : false
                const detail = [asset.model, asset.serial].filter(Boolean).join(' · ')

                return (
                  <li key={asset.id} className="py-2">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {asset.label ?? type?.name ?? 'Equipo'}
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {detail || 'Sin modelo ni serie'}
                        </span>
                      </span>

                      {pending && (
                        <span className="shrink-0 rounded-tag bg-warn-tint px-1.5 py-0.5 text-[0.6875rem] font-medium text-warn">
                          Sin validar
                        </span>
                      )}
                      {/* En gris y no en naranja: aquí no hay nada roto, hay
                          algo pedido y esperando a otra persona. */}
                      {retiradas.get(asset.id) && (
                        <span className="shrink-0 rounded-tag bg-sunken px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted">
                          retirada pedida
                        </span>
                      )}
                      {asset.status === 'averiado' && (
                        <span className="shrink-0 rounded-tag bg-crit-tint px-1.5 py-0.5 text-[0.6875rem] font-medium text-crit">
                          {ASSET_STATUS_LABELS.averiado}
                        </span>
                      )}

                      <button
                        type="button"
                        onClick={() => setFixing(fixing === asset.id ? null : asset.id)}
                        className="key key-quiet min-h-11 shrink-0 px-3 text-xs"
                      >
                        Corregir
                      </button>
                    </div>

                    {/* Se monta solo al abrirlo. Una sala de ocho equipos tenía
                        ocho formularios completos —24 campos y 16 botones— vivos
                        dentro de un panel que nace cerrado. */}
                    <div className="collapse-y" data-open={fixing === asset.id}>
                      <div>
                        {fixing === asset.id && (
                          <AssetFixer
                            asset={asset}
                            assetsInRoom={assets}
                            retirada={retiradas.get(asset.id) ?? null}
                            onPatch={(patch) => void patchAsset(asset, patch)}
                            onStatus={(status) => void setStatus(asset, status)}
                            onSolicitar={(destino, motivo) => {
                              void solicitarRetirada(asset, destino, motivo).then((r) =>
                                setNote(
                                  r.ok
                                    ? `Retirada pedida para «${asset.label ?? 'el equipo'}». Sigue en la sala hasta que la autoricen.`
                                    : (r.error ?? 'No se pudo pedir la retirada.'),
                                ),
                              )
                            }}
                            onCancelar={(id) => void cancelarRetirada(id)}
                          />
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}

              {live.length === 0 && levantadoEl !== null && (
                <li className="py-3 text-sm text-muted">
                  Esta sala no tiene equipos registrados. Añádelos arriba.
                </li>
              )}
            </ul>

            {/* Y al final del todo, la única pregunta que la aplicación no puede
                contestarse sola: ¿está esto completo? */}
            <LevantarInventario
              levantadoEl={levantadoEl}
              equipos={live.length}
              onConfirmar={(nota) => void confirmarInventario(live.length, nota ?? undefined)}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

/**
 * Correcciones de un elemento.
 *
 * La etiqueta se puede reescribir porque «Pantalla 2» no dice cuál de las dos
 * es: el técnico que está delante sabe que una es la del atril, y esa palabra
 * vale más que el número.
 */
function AssetFixer({
  asset,
  assetsInRoom,
  retirada,
  onPatch,
  onStatus,
  onSolicitar,
  onCancelar,
}: {
  asset: Asset
  assetsInRoom: Asset[]
  /** La solicitud viva de este equipo, si la hay. */
  retirada: AssetRemoval | null
  onPatch: (patch: Partial<Asset>) => void
  onStatus: (status: 'averiado') => void
  onSolicitar: (destino: RemovalDestino, motivo: string) => void
  onCancelar: (solicitudId: string) => void
}): React.ReactElement {
  const [label, setLabel] = useState(asset.label ?? '')
  const [model, setModel] = useState(asset.model ?? '')
  const [serial, setSerial] = useState(asset.serial ?? '')
  const [pidiendo, setPidiendo] = useState(false)
  /* El almacén por defecto: la retirada que más se pierde hoy es justo la del
     aparato que está bien y vuelve a la estantería sin que nadie lo ingrese. */
  const [destino, setDestino] = useState<RemovalDestino>('almacen')
  const [motivo, setMotivo] = useState('')

  const clash = label.trim() !== '' && !labelAvailable(assetsInRoom, label, asset.id)

  return (
    <div className="mt-2 rounded-ctl border border-line bg-sunken p-3">
      <div className="grid gap-2">
        <label className="text-xs text-muted">
          Nombre en esta sala
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => {
              const next = label.trim()
              if (next && !clash && next !== asset.label) onPatch({ label: next })
            }}
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
          />
        </label>
        {clash && (
          <p className="text-xs text-crit">
            Ya hay otro equipo con ese nombre en esta sala.
          </p>
        )}

        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-muted">
            Modelo
            <input
              type="text"
              value={model}
              autoCapitalize="off"
              autoCorrect="off"
              enterKeyHint="done"
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => model.trim() !== (asset.model ?? '') && onPatch({ model: model.trim() || null })}
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
            />
          </label>
          <label className="text-xs text-muted">
            Nº de serie
            {/* Un número de serie no es una frase: sin esto iOS lo capitaliza y
                el corrector reescribe cadenas alfanuméricas cortas. */}
            <input
              type="text"
              value={serial}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              onChange={(e) => setSerial(e.target.value)}
              onBlur={() => serial.trim() !== (asset.serial ?? '') && onPatch({ serial: serial.trim() || null })}
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 font-mono text-sm text-ink"
            />
          </label>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onStatus('averiado')}
            className={`key min-h-11 flex-1 px-2 text-xs ${
              asset.status === 'averiado' ? 'key-crit' : 'key-quiet text-muted'
            }`}
          >
            Averiado
          </button>
          <button
            type="button"
            disabled={retirada !== null}
            onClick={() => setPidiendo((v) => !v)}
            className="key key-quiet min-h-11 flex-1 px-2 text-xs text-muted"
          >
            {retirada ? 'Retirada pedida' : 'Sacar de la sala'}
          </button>
        </div>

        {/*
          Sacar un equipo pasa por una pregunta, y la pregunta es a dónde va.
          Antes esto era un botón que retiraba el aparato en el acto: el
          inventario perdía una fila sin que nadie pudiera decir que no, y un
          proyector perfectamente bueno que volvía a la estantería no llegaba
          nunca al almacén. Son los dos únicos destinos que existen y pesan
          distinto, así que se eligen antes de firmar nada.
        */}
        {pidiendo && retirada === null && (
          <div className="rounded-ctl border border-line bg-surface p-3">
            <p className="text-xs font-medium">¿A dónde va?</p>

            <div role="radiogroup" aria-label="Destino del equipo" className="mt-2 grid gap-2">
              {(['baja', 'almacen'] as RemovalDestino[]).map((d) => (
                <button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={destino === d}
                  onClick={() => setDestino(d)}
                  className={`key px-3 py-2 text-left text-xs ${
                    destino === d ? 'key-accent' : 'key-quiet text-muted'
                  }`}
                >
                  <span className="block font-semibold">{REMOVAL_DESTINO_LABELS[d]}</span>
                  <span className="mt-0.5 block font-normal opacity-80">
                    {REMOVAL_DESTINO_HINTS[d]}
                  </span>
                </button>
              ))}
            </div>

            <label className="mt-2 block text-xs text-muted">
              Por qué
              <input
                type="text"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="No enciende, sobra en el aula…"
                enterKeyHint="done"
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
              />
            </label>

            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  onSolicitar(destino, motivo)
                  setPidiendo(false)
                  setMotivo('')
                }}
                className="key key-accent min-h-11 flex-1 px-2 text-xs"
              >
                Pedir la retirada
              </button>
              <button
                type="button"
                onClick={() => setPidiendo(false)}
                className="key key-quiet min-h-11 px-3 text-xs text-muted"
              >
                Cancelar
              </button>
            </div>

            {/* Lo que va a pasar y lo que no. Sin esto, el técnico se va del
                aula creyendo que el equipo ya no cuenta, y sigue contando. */}
            <p className="mt-2 text-xs text-muted">
              El equipo se queda en la sala hasta que un coordinador lo autorice.
            </p>
          </div>
        )}

        {retirada && (
          <div className="rounded-ctl border border-line bg-sunken p-3">
            <p className="text-xs text-muted">
              Retirada pedida ({REMOVAL_DESTINO_LABELS[retirada.destino].toLowerCase()})
              {retirada.reason ? `: ${retirada.reason}` : ''}. Esperando a que un coordinador la
              autorice.
            </p>
            <button
              type="button"
              onClick={() => onCancelar(retirada.id)}
              className="key key-quiet mt-2 min-h-11 px-3 text-xs text-muted"
            >
              Ya no hace falta
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
