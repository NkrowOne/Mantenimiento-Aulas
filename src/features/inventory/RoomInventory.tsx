import { useId, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useConfirmar } from '@/components/Confirmar'
import { db } from '@/db/dexie'
import {
  identifyAsset,
  labelAvailable,
  resolveModel,
  resolveType,
  searchCatalog,
  sugerenciasDe,
  vocabularioDeTipo,
  type AssetIdentity,
  type Sugerencia,
} from '@/domain/inventory'
import { fechaCorta } from '@/domain/fechas'
import {
  ASSET_STATUS_LABELS,
  REMOVAL_DESTINO_HINTS,
  REMOVAL_DESTINO_LABELS,
  type Asset,
  type AssetModel,
  type AssetRemoval,
  type AssetType,
  type RemovalDestino,
} from '@/domain/types'
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

  const {
    addAssetConOrigen,
    cancelarRetirada,
    confirmarInventario,
    patchAsset,
    setModelo,
    setStatus,
    solicitarRetirada,
  } = useRoomInventory(roomId, userId)

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
                const type = resolveType(typesById, asset.asset_type_id)
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
                            retirada={retiradas.get(asset.id) ?? null}
                            tipo={type}
                            modelo={resolveModel(modelosById, asset.asset_model_id)}
                            identidad={id}
                            onPatch={(patch) => void patchAsset(asset, patch)}
                            onModelo={(m) => void setModelo(asset, m)}
                            onStatus={(status) => void setStatus(asset, status)}
                            /*
                              Pedir la retirada pasa por el diálogo y no solo por
                              el panel, y lo que se enseña ahí es el aparato
                              entero —tipo, marca, modelo y número de serie—. Es
                              justo la decisión donde importa: «¿Retirar el
                              Ordenador de la sala?» en un aula con dos no dice
                              cuál, y quien autoriza al otro lado tampoco lo
                              sabrá. Con la baja se sube el listón a teclear una
                              palabra: dar de baja no se deshace.
                            */
                            onSolicitar={(destino, motivo) => {
                              const baja = destino === 'baja'
                              void pedir({
                                titulo: baja
                                  ? `¿Pedir la baja de «${id.etiqueta}»?`
                                  : `¿Pedir la retirada de «${id.etiqueta}»?`,
                                detalle: id.ficha ? `${id.completo} · ${id.ficha}` : id.completo,
                                consecuencias: baja
                                  ? [
                                      'Al autorizarla, el equipo sale del inventario de la sala.',
                                      'Se da por perdido: no vuelve al almacén ni suma existencias.',
                                      'El equipo y su historial se conservan: no se borra nada.',
                                    ]
                                  : [
                                      'Al autorizarla, el equipo sale de la sala y entra en el almacén.',
                                      'Hasta entonces sigue contando en las revisiones de esta sala.',
                                      'El equipo y su historial se conservan: no se borra nada.',
                                    ],
                                confirmar: baja ? 'Pedir la baja' : 'Pedir la retirada',
                                tono: baja ? 'crit' : 'warn',
                                escribir: baja ? 'BAJA' : undefined,
                              }).then((si) => {
                                if (!si) return
                                void solicitarRetirada(asset, destino, motivo).then((r) =>
                                  setNote(
                                    r.ok
                                      ? `Retirada pedida para «${id.etiqueta}»${id.ficha ? ` (${id.ficha})` : ''}. Sigue en la sala hasta que la autoricen.`
                                      : (r.error ?? 'No se pudo pedir la retirada.'),
                                  ),
                                )
                              })
                            }}
                            onCancelar={(solicitudId) => void cancelarRetirada(solicitudId)}
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
 * El nombre se autocompleta con lo que ya está escrito en el parque. Al alta se
 * buscaba en el catálogo antes de crear —es lo que impide que se llene de
 * sinónimos— y al corregir no se buscaba nada: el campo que más se teclea estaba
 * en blanco, a mano, de pie y con una mano.
 *
 * Y el modelo ya no es un campo de texto: es el catálogo. Es el cambio que hace
 * que el inventario pueda contestar «¿cuántos EB-992F tenemos?», y de paso el
 * que impide que el mismo aparato entre como «ME403U», «ME-403U» y «ME403U *»
 * desde tres aulas distintas. Por eso aquí ya no hay sugerencias de modelo: no
 * se sugiere lo que se elige de una lista.
 */
function AssetFixer({
  asset,
  assetsInRoom,
  retirada,
  tipo,
  modelo,
  identidad,
  onPatch,
  onModelo,
  onStatus,
  onSolicitar,
  onCancelar,
}: {
  asset: Asset
  assetsInRoom: Asset[]
  /** La solicitud viva de este equipo, si la hay. */
  retirada: AssetRemoval | null
  /** Su tipo: de ahí sale el primer nombre que le toca y sus campos propios. */
  tipo: AssetType | null
  /** Su modelo del catálogo, del que heredan los campos «ambos». */
  modelo: AssetModel | null
  /** Tipo, marca, modelo y serie ya resueltos, para no volver a cruzarlos aquí. */
  identidad: AssetIdentity
  onPatch: (patch: Partial<Asset>) => void
  onModelo: (modelo: ModeloElegido | null) => void
  onStatus: (status: 'averiado') => void
  onSolicitar: (destino: RemovalDestino, motivo: string) => void
  onCancelar: (solicitudId: string) => void
}): React.ReactElement {
  const [label, setLabel] = useState(asset.label ?? '')
  const [serial, setSerial] = useState(asset.serial ?? '')
  const [notes, setNotes] = useState(asset.notes ?? '')
  const [mas, setMas] = useState(false)
  const [pidiendo, setPidiendo] = useState(false)
  /* El almacén por defecto: la retirada que más se pierde hoy es justo la del
     aparato que está bien y vuelve a la estantería sin que nadie lo ingrese. */
  const [destino, setDestino] = useState<RemovalDestino>('almacen')
  const [motivo, setMotivo] = useState('')

  const clash = label.trim() !== '' && !labelAvailable(assetsInRoom, label, asset.id)

  /*
   * Los equipos de ese mismo tipo en todo el parque.
   *
   * Consulta por el índice `asset_type_id` y no `db.assets.toArray()`: son 1.094
   * equipos en el espejo y de ellos interesan los cuarenta que son proyectores.
   * Y solo se lanza al abrir este bloque —el formulario se monta al pulsar
   * «Corregir»—, así que una sala de ocho equipos no dispara ocho consultas.
   */
  const delTipo = useLiveQuery(
    async () => db.assets.where('asset_type_id').equals(asset.asset_type_id).toArray(),
    [asset.asset_type_id],
    [] as Asset[],
  )

  /*
   * El vocabulario de nombres lleva delante el del propio tipo.
   *
   * Es el nombre que le toca al primero de su clase en una sala, y en un parque
   * recién inventariado puede que no haya ningún otro nombre escrito todavía: sin
   * esto, el campo que más se corrige sería justo el que no ofrece nada.
   */
  const vocEtiqueta = useMemo(() => {
    const delParque = vocabularioDeTipo(delTipo, asset.asset_type_id, 'label')
    const nombreTipo = tipo?.name ?? null
    if (!nombreTipo || delParque.some((s) => s.valor === nombreTipo)) return delParque
    return [...delParque, { valor: nombreTipo, veces: 0 }]
  }, [delTipo, asset.asset_type_id, tipo])

  /*
   * Y las que ya están cogidas en ESTA sala se caen de la lista.
   *
   * `labelAvailable` espeja el índice único de la base, así que ofrecer «Pantalla
   * 2» en una sala que ya tiene una «Pantalla 2» sería ofrecer una sugerencia que
   * al pulsarla enciende un error en rojo. La ayuda no puede llevar a la trampa.
   */
  const sugEtiqueta = useMemo(
    () =>
      sugerenciasDe(vocEtiqueta, label, {
        excluir: [
          label,
          ...assetsInRoom
            .filter((a) => a.id !== asset.id && a.status !== 'retirado')
            .map((a) => a.label ?? ''),
        ],
      }),
    [vocEtiqueta, label, assetsInRoom, asset.id],
  )

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
        <CampoSugerido
          etiqueta="Nombre en esta sala"
          valor={label}
          onValor={setLabel}
          /* El choque se recalcula con el valor que se confirma y no con el del
             render: elegir una sugerencia cambia el estado y lo lee en la misma
             pasada, cuando `clash` todavía habla del texto anterior. */
          onCommit={(v) => {
            const next = v.trim()
            if (next && next !== asset.label && labelAvailable(assetsInRoom, next, asset.id)) {
              onPatch({ label: next })
            }
          }}
          sugerencias={sugEtiqueta}
          inputClassName="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
        />
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
                el corrector reescribe cadenas alfanuméricas cortas.

                Y no se autocompleta, a diferencia del nombre. No es un olvido:
                una serie identifica UN aparato, así que toda sugerencia sería la
                de otro equipo y aceptarla sería duplicar una identidad. Aquí
                ayudar de más hace daño. */}
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

            {/* `heredados`: lo que dice el modelo para los campos «ambos», que es
                lo que hace que ese nivel signifique algo. El técnico ve «del
                modelo: 8 GB» y solo escribe si en ESTE aparato es otra cosa. */}
            <CamposPropios
              campos={(tipo?.spec_fields ?? []).filter((c) => c.en !== 'modelo')}
              valores={asset.specs ?? {}}
              heredados={modelo?.specs ?? undefined}
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
            {/* Y de qué aparato estamos hablando. En un aula con dos ordenadores
                «Sacar de la sala» no dice cuál, y el que firma la solicitud es
                el único que tiene la pegatina delante: si aquí no consta el
                modelo y la serie, al otro lado ya no hay forma de saberlo. */}
            <p className="mt-1 text-xs text-muted">
              {identidad.ficha ? `${identidad.completo} · ${identidad.ficha}` : identidad.completo}
            </p>

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

/**
 * Un campo de texto que ofrece lo que ya está escrito.
 *
 * Tres decisiones que no son de estilo:
 *
 * **La lista va en el flujo, no flotando.** Este formulario vive dentro de un
 * `collapse-y`, y eso lleva `overflow: hidden` para poder animar la altura: un
 * desplegable posicionado en absoluto saldría cortado por el borde del panel.
 * Empujar el contenido hacia abajo es además lo que ya hace el campo de alta, así
 * que las dos ayudas de la misma pantalla se comportan igual.
 *
 * **Se abre al enfocar, con el campo vacío.** Es justamente el caso que ahorra
 * trabajo: el técnico delante de un proyector cuyo modelo no ha escrito todavía.
 * Esperar a que teclee tres letras es ayudarle cuando ya ha hecho el trabajo.
 *
 * **La sugerencia no deja escapar el foco.** `preventDefault` en `pointerdown`
 * evita el `blur`, y hace falta: sin él, tocar «Epson EB-1485Fi» disparaba primero
 * el guardado de lo que hubiera a medio teclear —`Epso`— y luego el de la
 * sugerencia. Dos escrituras, y la primera con un modelo que no existe metida en
 * el histórico del equipo.
 */
function CampoSugerido({
  etiqueta,
  valor,
  onValor,
  onCommit,
  sugerencias,
  inputClassName,
  inputProps,
}: {
  etiqueta: string
  valor: string
  onValor: (v: string) => void
  /** Confirmar. Al salir del campo y al elegir una sugerencia. */
  onCommit: (v: string) => void
  sugerencias: Sugerencia[]
  inputClassName: string
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>
}): React.ReactElement {
  const [abierto, setAbierto] = useState(false)
  const listaId = useId()
  const desplegada = abierto && sugerencias.length > 0

  /* La última confirmación, para no repetirla. Elegir una sugerencia confirma, y
     el `blur` que llega detrás confirmaría otra vez el mismo valor. */
  const confirmado = useRef(valor)

  function confirmar(v: string): void {
    if (v === confirmado.current) return
    confirmado.current = v
    onCommit(v)
  }

  function elegir(s: Sugerencia): void {
    onValor(s.valor)
    confirmar(s.valor)
    setAbierto(false)
  }

  return (
    <div>
      <label className="block text-xs text-muted">
        {etiqueta}
        <input
          type="text"
          role="combobox"
          aria-expanded={desplegada}
          aria-controls={listaId}
          aria-autocomplete="list"
          value={valor}
          onChange={(e) => {
            onValor(e.target.value)
            setAbierto(true)
          }}
          onFocus={() => setAbierto(true)}
          onBlur={() => {
            setAbierto(false)
            confirmar(valor)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && desplegada) {
              e.preventDefault()
              setAbierto(false)
              return
            }
            // La tecla de retorno acepta la primera sugerencia, igual que en el
            // campo de alta de ahí arriba: el mismo gesto en la misma pantalla.
            const primera = sugerencias[0]
            if (e.key === 'Enter' && desplegada && primera) {
              e.preventDefault()
              elegir(primera)
            }
          }}
          className={inputClassName}
          {...inputProps}
        />
      </label>

      {/* La caja que colapsa va por fuera y el `listbox` por dentro, pegado a
          sus opciones: ARIA pide que las opciones sean hijas de la lista, y con
          los dos envoltorios de la animación en medio dejaban de serlo. */}
      <div className="collapse-y" data-open={desplegada} inert={!desplegada}>
        <div>
          <div
            id={listaId}
            role="listbox"
            aria-label={`Sugerencias para ${etiqueta}`}
            className="flex flex-col gap-1 pt-1"
          >
            {desplegada &&
              sugerencias.map((s) => (
                <button
                  key={s.valor}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => elegir(s)}
                  className="key key-quiet flex min-h-11 items-center justify-between gap-2 px-3 py-2 text-left text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">{s.valor}</span>
                  {/* Cuántos equipos lo llevan ya. Es la razón por la que está
                      arriba en la lista, y verla es lo que permite fiarse de
                      ella en vez de leerse las cinco. */}
                  {s.veces > 1 && (
                    <span className="shrink-0 text-xs font-normal text-muted">
                      {s.veces} equipos
                    </span>
                  )}
                </button>
              ))}
          </div>
        </div>
      </div>
    </div>
  )
}
