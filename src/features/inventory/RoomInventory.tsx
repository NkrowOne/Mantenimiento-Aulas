import { useState } from 'react'
import { labelAvailable, resolveType, searchCatalog } from '@/domain/inventory'
import { ASSET_STATUS_LABELS, type Asset, type AssetType } from '@/domain/types'
import { useRoomInventory } from './useRoomInventory'

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

  const { addAsset, patchAsset, setStatus } = useRoomInventory(roomId, userId)

  const live = assets.filter((a) => a.status !== 'retirado')
  const hits = searchCatalog(types, query)
  const raw = query.trim()

  async function add(typeName: string, existing: AssetType | null): Promise<void> {
    const result = await addAsset(typeName, existing)
    setQuery('')
    setNote(
      result.ok
        ? existing
          ? `Añadido «${result.label}».`
          : `Añadido «${result.label}». Sale en naranja hasta que un coordinador lo valide.`
        : (result.error ?? 'No se pudo añadir.'),
    )
  }

  return (
    <section className="border-t border-line">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="eyebrow">Equipos de la sala</span>
        <span className="text-sm text-muted">
          {live.length} · {open ? 'cerrar' : 'añadir o corregir'}
        </span>
      </button>

      <div className="collapse-y" data-open={open} inert={!open}>
        <div>
          <div className="px-4 pb-4">
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
                className="h-touch w-full rounded-ctl border border-line bg-surface px-3"
              />
            </label>

            {raw && (
              <div className="mt-2 flex flex-col gap-1">
                {hits.map((hit) => (
                  <button
                    key={hit.type.id}
                    type="button"
                    onClick={() => void add(hit.type.name, hit.type)}
                    className="key key-quiet flex items-center justify-between px-3 py-2 text-left text-sm"
                  >
                    <span>{hit.type.name}</span>
                    <span className="text-xs font-normal text-muted">
                      {hit.why || (hit.type.confirmed ? 'del catálogo' : 'sin validar')}
                    </span>
                  </button>
                ))}

                {hits.length === 0 && (
                  <button
                    type="button"
                    onClick={() => void add(raw, null)}
                    className="key flex items-center justify-between border border-warn/40 bg-warn-tint px-3 py-2 text-left text-sm text-warn"
                  >
                    <span>Crear «{raw}»</span>
                    <span className="text-xs font-normal">pendiente de validar</span>
                  </button>
                )}
              </div>
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
                            onPatch={(patch) => void patchAsset(asset, patch)}
                            onStatus={(status) => void setStatus(asset, status)}
                          />
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}

              {live.length === 0 && (
                <li className="py-3 text-sm text-muted">
                  Esta sala no tiene equipos registrados. Añádelos arriba.
                </li>
              )}
            </ul>
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
  onPatch,
  onStatus,
}: {
  asset: Asset
  assetsInRoom: Asset[]
  onPatch: (patch: Partial<Asset>) => void
  onStatus: (status: 'averiado' | 'retirado') => void
}): React.ReactElement {
  const [label, setLabel] = useState(asset.label ?? '')
  const [model, setModel] = useState(asset.model ?? '')
  const [serial, setSerial] = useState(asset.serial ?? '')

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
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => model.trim() !== (asset.model ?? '') && onPatch({ model: model.trim() || null })}
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
            />
          </label>
          <label className="text-xs text-muted">
            Nº de serie
            <input
              type="text"
              value={serial}
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
          {/*
            Se confirma, y va en su propia fila.
            Retirar un equipo lo saca de la revisión y del inventario, y estaba
            pegado a «Averiado» en un objetivo de 32px: el fallo de pulsación era
            cuestión de tiempo. Cerrar sesión ya se confirmaba; esto pesa más.
          */}
          <button
            type="button"
            onClick={() => {
              if (confirm(`¿Retirar «${asset.label ?? 'este equipo'}» de la sala?`)) {
                onStatus('retirado')
              }
            }}
            className="key key-quiet min-h-11 flex-1 px-2 text-xs text-muted"
          >
            Retirar de la sala
          </button>
        </div>
      </div>
    </div>
  )
}
