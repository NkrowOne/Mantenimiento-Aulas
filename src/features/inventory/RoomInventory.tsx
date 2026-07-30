import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useConfirmar } from '@/components/Confirmar'
import { db } from '@/db/dexie'
import { identifyAsset, labelAvailable, searchCatalog } from '@/domain/inventory'
import { fechaCorta } from '@/domain/fechas'
import { ASSET_STATUS_LABELS, type Asset, type AssetModel, type AssetType } from '@/domain/types'
import { typeRank } from '@/features/inspection/useInspection'
import { LevantarInventario } from './LevantarInventario'
import { OrigenDelEquipo } from './OrigenDelEquipo'
import { SelectorDeModelo } from './SelectorDeModelo'
import { CamposPropios } from './CamposPropios'
import { useRoomInventory, type AltaDeEquipo, type ModeloElegido } from './useRoomInventory'

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
  const { pedir, dialogo } = useConfirmar()

  const { addAssetConOrigen, confirmarInventario, patchAsset, setModelo, setStatus } =
    useRoomInventory(roomId, userId)

  /* El catálogo de modelos, para poder decir «Lenovo U3302» y no «Ordenador».
     Sale del espejo, así que se lee igual en un sótano. */
  const modelos = useLiveQuery(() => db.assetModels.toArray(), [], [])
  const modelosById = useMemo(
    () => new Map<string, AssetModel>(modelos.map((m) => [m.id, m])),
    [modelos],
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

  async function add(alta: AltaDeEquipo): Promise<void> {
    if (!eligiendo) return
    const { nombre, tipo } = eligiendo
    const result = await addAssetConOrigen(nombre, tipo, alta)
    const { origen } = alta

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
                onConfirmar={(alta) => void add(alta)}
              />
            )}

            {note && <p className="mt-2 text-xs text-muted">{note}</p>}

            <ul className="mt-3 divide-y divide-line-soft">
              {live.map((asset) => {
                const type = typesById.get(asset.asset_type_id) ?? null
                const pending = type ? !type.confirmed : false
                const id = identifyAsset(asset, typesById, modelosById)

                return (
                  <li key={asset.id} className="py-2">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{id.etiqueta}</span>
                        {/*
                          Marca, modelo y número de serie, en la segunda línea y
                          en este orden. Es lo que contesta «¿cuál de los dos
                          ordenadores es?» sin abrir nada: antes ponía el texto
                          libre del modelo, que en la mitad de los equipos estaba
                          vacío y en la otra mitad decía «M403H *».
                        */}
                        <span className="block truncate text-xs text-muted">
                          {id.ficha || 'Sin modelo ni serie'}
                        </span>
                      </span>

                      {id.modeloSinValidar && !pending && (
                        <span className="shrink-0 rounded-tag bg-warn-tint px-1.5 py-0.5 text-[0.6875rem] font-medium text-warn">
                          Modelo sin validar
                        </span>
                      )}
                      {pending && (
                        <span className="shrink-0 rounded-tag bg-warn-tint px-1.5 py-0.5 text-[0.6875rem] font-medium text-warn">
                          Sin validar
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
                        aria-expanded={fixing === asset.id}
                        className="key key-quiet min-h-11 shrink-0 px-3 text-xs"
                      >
                        Corregir
                      </button>
                    </div>

                    {/* Se monta solo al abrirlo. Una sala de ocho equipos tenía
                        ocho formularios completos —24 campos y 16 botones— vivos
                        dentro de un panel que nace cerrado.
                        `inert` cuando está plegado: sin él, el tabulador entra en
                        un formulario de alto cero y el foco se va a un sitio que
                        no se ve. */}
                    <div className="collapse-y" data-open={fixing === asset.id} inert={fixing !== asset.id}>
                      <div>
                        {fixing === asset.id && (
                          <AssetFixer
                            asset={asset}
                            assetsInRoom={assets}
                            tipo={type}
                            onPatch={(patch) => void patchAsset(asset, patch)}
                            onModelo={(m) => void setModelo(asset, m)}
                            onStatus={(status) => void setStatus(asset, status)}
                            onRetirar={() =>
                              void pedir({
                                titulo: `¿Retirar «${id.etiqueta}» de la sala?`,
                                detalle: id.ficha ? `${id.completo} · ${id.ficha}` : id.completo,
                                consecuencias: [
                                  'Deja de contar en las revisiones de esta sala.',
                                  'El equipo y su historial se conservan: no se borra nada.',
                                  'Si vuelve, se da de alta como traslado desde esta sala.',
                                ],
                                confirmar: 'Retirar',
                                tono: 'crit',
                              }).then((si) => {
                                if (si) void setStatus(asset, 'retirado')
                              })
                            }
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

      {dialogo}
    </section>
  )
}

/**
 * Correcciones de un elemento.
 *
 * La etiqueta se puede reescribir porque «Pantalla 2» no dice cuál de las dos
 * es: el técnico que está delante sabe que una es la del atril, y esa palabra
 * vale más que el número.
 *
 * El modelo ya no es un campo de texto: es el catálogo. Es el cambio que hace
 * que el inventario pueda contestar «¿cuántos EB-992F tenemos?», y de paso el
 * que impide que el mismo aparato entre como «ME403U», «ME-403U» y «ME403U *»
 * desde tres aulas distintas.
 */
function AssetFixer({
  asset,
  assetsInRoom,
  tipo,
  onPatch,
  onModelo,
  onStatus,
  onRetirar,
}: {
  asset: Asset
  assetsInRoom: Asset[]
  tipo: AssetType | null
  onPatch: (patch: Partial<Asset>) => void
  onModelo: (modelo: ModeloElegido | null) => void
  onStatus: (status: 'averiado' | 'retirado') => void
  onRetirar: () => void
}): React.ReactElement {
  const [label, setLabel] = useState(asset.label ?? '')
  const [serial, setSerial] = useState(asset.serial ?? '')
  const [notes, setNotes] = useState(asset.notes ?? '')
  const [mas, setMas] = useState(false)

  const clash = label.trim() !== '' && !labelAvailable(assetsInRoom, label, asset.id)

  /*
   * El número de serie es único en TODA la base, no por sala.
   *
   * Sin este aviso, teclear uno que ya existe se acepta aquí, se sube, y el
   * servidor lo rechaza horas después y a kilómetros del aula, donde ya no hay
   * forma de saber cuál de los dos aparatos era. Se avisa y no se bloquea: quien
   * está delante lee la pegatina mejor que esta comprobación, y puede ser que el
   * duplicado sea el equipo viejo, mal apuntado.
   */
  const serialRepetido = useLiveQuery(
    async () => {
      const s = serial.trim()
      if (!s) return null
      const otros = await db.assets.where('serial').equals(s).toArray()
      const choca = otros.find((a) => a.id !== asset.id && a.status !== 'retirado')
      if (!choca) return null
      const sala = choca.room_id ? await db.rooms.get(choca.room_id) : null
      return sala ? `${sala.code} — ${sala.name}` : 'otro equipo'
    },
    [serial, asset.id],
    null,
  )

  /** `AAAA-MM-DD` para el campo de fecha, o vacío si no consta. */
  const instalado = asset.installed_at ? asset.installed_at.slice(0, 10) : ''

  return (
    <div className="mt-2 rounded-ctl border border-line bg-sunken p-3">
      <div className="grid gap-3">
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
          <p className="-mt-2 text-xs text-crit">
            Ya hay otro equipo con ese nombre en esta sala.
          </p>
        )}

        <div className="text-xs text-muted">
          Marca y modelo
          <div className="mt-1">
            <SelectorDeModelo
              typeId={asset.asset_type_id}
              value={asset.asset_model_id}
              onChange={onModelo}
              autoFocus={false}
            />
          </div>
          {/* Lo que se escribió a mano antes de que existiera el catálogo. Se
              enseña mientras no haya modelo elegido: es la pista de qué hay que
              elegir, y tirarla dejaría el aparato sin ninguna. */}
          {!asset.asset_model_id && asset.model?.trim() && (
            <p className="mt-1 text-xs text-muted">
              Antes ponía «{asset.model.trim()}». Elígelo del catálogo o créalo.
            </p>
          )}
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
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

          <label className="text-xs text-muted">
            Instalado el
            <input
              type="date"
              value={instalado}
              onChange={(e) =>
                onPatch({
                  installed_at: e.target.value
                    ? new Date(`${e.target.value}T12:00:00`).toISOString()
                    : null,
                })
              }
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
            />
          </label>
        </div>

        {serialRepetido && (
          <p className="-mt-1 text-xs text-warn">
            Ese número de serie ya está en {serialRepetido}. Si es el mismo aparato, tráelo con
            «De otra sala» en vez de darlo de alta otra vez.
          </p>
        )}

        <button
          type="button"
          onClick={() => setMas((v) => !v)}
          aria-expanded={mas}
          className="text-left text-xs text-muted underline-offset-4 hover:underline"
        >
          {mas ? 'Menos detalles' : 'Más detalles: garantía, observaciones…'}
        </button>

        <div className="collapse-y" data-open={mas} inert={!mas}>
          <div className="grid gap-2">
            <label className="text-xs text-muted">
              Garantía hasta
              <input
                type="date"
                value={asset.warranty_until ?? ''}
                onChange={(e) => onPatch({ warranty_until: e.target.value || null })}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
              />
            </label>

            <CamposPropios
              campos={(tipo?.spec_fields ?? []).filter((c) => c.en !== 'modelo')}
              valores={asset.specs ?? {}}
              onChange={(specs) => onPatch({ specs })}
            />

            <label className="text-xs text-muted">
              Observaciones
              <textarea
                value={notes}
                rows={2}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={() => notes.trim() !== (asset.notes ?? '') && onPatch({ notes: notes.trim() || null })}
                className="mt-1 w-full rounded-ctl border border-line bg-surface px-2 py-1.5 text-sm text-ink"
              />
            </label>

            {asset.installed_at && (
              <p className="text-xs text-muted">
                Puesto en esta sala el {fechaCorta(asset.installed_at)}.
              </p>
            )}
          </div>
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
          {/*
            Se confirma, y va en su propia fila.
            Retirar un equipo lo saca de la revisión y del inventario, y estaba
            pegado a «Averiado» en un objetivo de 32px: el fallo de pulsación era
            cuestión de tiempo. Cerrar sesión ya se confirmaba; esto pesa más.
          */}
          <button
            type="button"
            onClick={onRetirar}
            className="key key-quiet min-h-11 flex-1 px-2 text-xs text-muted"
          >
            Retirar de la sala
          </button>
        </div>
      </div>
    </div>
  )
}
