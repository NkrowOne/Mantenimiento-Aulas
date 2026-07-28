import { useRef, useState } from 'react'
import { RoomPlate } from '@/components/RoomPlate'
import { TriState } from '@/components/TriState'
import { PHOTO_ACCEPT, capturePhoto } from '@/lib/photos'
import {
  CHECK_HINTS,
  CHECK_LABELS,
  CHECK_MEASURE,
  type CheckKey,
  type Room,
  type Severity,
} from '@/domain/types'
import { displayRoomCode } from '@/domain/normalize'
import { checksForRoom, useInspection } from './useInspection'

interface Props {
  room: Room
  userId: string | null
  buildingName: string
  /** Nombre de la planta o módulo. Sin esto, «-2.1» se lee como un sótano. */
  zoneName: string
  onDone: (nextRoom: boolean) => void
  onBack: () => void
}

const SEVERITIES: Array<{ value: Severity; label: string }> = [
  { value: 'baja', label: 'Leve' },
  { value: 'media', label: 'Molesta' },
  { value: 'alta', label: 'Impide la clase' },
]

export function InspectionPage({
  room,
  userId,
  buildingName,
  zoneName,
  onDone,
  onBack,
}: Props): React.ReactElement {
  const { draft, saving, setCheck, setNotes, markRestOk, complete } = useInspection(room, userId)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [photoCount, setPhotoCount] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)

  if (!draft) {
    return <p className="p-6 text-muted">Preparando…</p>
  }

  const applicable = checksForRoom(room)
  const missing = applicable.filter(
    ({ key, applicable: ok }) => ok && !draft.checks.get(key),
  )
  const incidents = [...draft.checks.values()].filter((c) => c.result === 'incidencia')
  const needsPhoto = incidents.length > 0 && photoCount === 0

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0]
    if (!file || !draft) return
    setPhotoError(null)

    const result = await capturePhoto(file, 'inspection', draft.inspection.id)
    if (result.ok) setPhotoCount((n) => n + 1)
    else setPhotoError(result.error ?? 'No se pudo guardar la foto.')

    if (fileInput.current) fileInput.current.value = ''
  }

  return (
    <div className="pb-32">
      <RoomPlate
        building={buildingName}
        zone={zoneName}
        title={room.name === room.code ? `Sala ${displayRoomCode(room.code)}` : room.name}
        code={displayRoomCode(room.code)}
        onBack={onBack}
      />

      {/* Revisión por excepción: primero la vía rápida, y solo se baja al
          detalle quien tenga algo que reportar.

          Se queda montado y colapsa en vez de desaparecer: al pulsarlo se va y
          la lista entera saltaba setenta píxeles hacia arriba, justo debajo del
          dedo. `inert` lo saca del orden de tabulación mientras está cerrado. */}
      <div className="collapse-y" data-open={missing.length > 0} inert={missing.length === 0}>
        <div>
          <div className="px-4 pt-4">
            <button
              type="button"
              onClick={markRestOk}
              className="key key-ok flex h-touch w-full items-center justify-center gap-2"
            >
              <span aria-hidden className="text-lg">✓</span>
              {draft.checks.size === 0
                ? 'Todo correcto'
                : `Marcar OK las ${missing.length} restantes`}
            </button>
          </div>
        </div>
      </div>

      <div className="divide-y divide-line px-4">
        {applicable.map(({ key, applicable: isApplicable }) => {
          const check = draft.checks.get(key)
          const measure = CHECK_MEASURE[key]

          return (
            <div
              key={key}
              /*
                Cuando hay incidencia, la fila y su detalle son UN panel con un
                borde y un radio. Antes eran dos formas apiladas —fila teñida
                cuadrada y caja redondeada encima— y el marco cojeaba.
              */
              className={
                check?.result === 'incidencia'
                  ? '-mx-1 my-2 rounded-ctl border border-crit/25 bg-crit-tint px-3'
                  : ''
              }
            >
              <TriState
                label={CHECK_LABELS[key]}
                hint={isApplicable ? CHECK_HINTS[key] : 'La sala no lo tiene'}
                value={check?.result ?? null}
                onChange={(result) => setCheck(key, result)}
              />

              {/* El detalle de la incidencia se despliega, no aparece de golpe.
                  Marcar «Falla» insertaba de repente ochenta píxeles en mitad de
                  la lista y todo lo de abajo se teleportaba. */}
              <div
                className="collapse-y"
                data-open={check?.result === 'incidencia'}
                inert={check?.result !== 'incidencia'}
              >
                <div>
                  <div className="pb-3">
                    <p className="eyebrow mb-2">Gravedad</p>
                    <div className="grid grid-cols-3 gap-2">
                      {SEVERITIES.map((s) => (
                        <button
                          key={s.value}
                          type="button"
                          onClick={() => setCheck(key, 'incidencia', { severity: s.value })}
                          className={`key px-2 py-2 text-xs ${
                            check?.severity === s.value ? 'key-crit' : 'key-quiet text-muted'
                          }`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>

                    <textarea
                      value={check?.note ?? ''}
                      onChange={(e) => setCheck(key, 'incidencia', { note: e.target.value })}
                      placeholder="¿Qué has visto?"
                      rows={2}
                      className="mt-2 w-full rounded-ctl border border-crit/25 bg-surface p-2 text-sm"
                    />
                  </div>
                </div>
              </div>

              {check?.result === 'ok' && measure && (
                <label className="mb-4 flex items-center gap-3 text-sm">
                  <span className="text-muted">{measure.label}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={check.measure ?? ''}
                    onChange={(e) =>
                      setCheck(key, 'ok', {
                        measure: e.target.value === '' ? null : Number(e.target.value),
                        measure_unit: measure.unit,
                      })
                    }
                    className="w-24 rounded-ctl border border-line bg-surface p-2 text-right font-mono tabular"
                  />
                  <span className="text-muted">{measure.unit}</span>
                </label>
              )}
            </div>
          )
        })}

        <div className="py-4">
          <p className="eyebrow mb-2">Fotos y observaciones</p>

          <input
            ref={fileInput}
            type="file"
            accept={PHOTO_ACCEPT}
            onChange={(e) => void onPickPhoto(e)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="key h-touch w-full border-2 border-dashed border-line bg-transparent text-muted shadow-none"
          >
            {photoCount > 0 ? `${photoCount} foto${photoCount === 1 ? '' : 's'} · añadir otra` : 'Añadir foto'}
          </button>

          {photoError && <p className="mt-2 text-sm text-crit">{photoError}</p>}
          {needsPhoto && (
            <p className="mt-2 text-sm text-warn">Añade una foto de la incidencia.</p>
          )}

          <textarea
            value={draft.inspection.notes ?? ''}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Observaciones (opcional)"
            rows={3}
            className="mt-3 w-full rounded-ctl border border-line bg-surface p-3 text-sm"
          />
        </div>
      </div>

      {/* Barra fija: el pulgar la encuentra sin mirar, y respeta la zona de
          gestos del iPhone. */}
      <div
        className="fixed inset-x-0 bottom-0 border-t border-line bg-surface px-4 py-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
      >
        <div className="mb-2 flex items-center justify-between text-xs text-muted">
          <span>
            {missing.length === 0
              ? 'Todo comprobado'
              : `Faltan ${missing.length} comprobacion${missing.length === 1 ? '' : 'es'}`}
          </span>
          <span>{saving ? 'Guardando…' : 'Guardado'}</span>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            disabled={missing.length > 0}
            onClick={() => void complete().then(() => onDone(false))}
            className="key key-quiet h-touch flex-1"
          >
            Guardar
          </button>
          <button
            type="button"
            disabled={missing.length > 0}
            onClick={() => void complete().then(() => onDone(true))}
            className="key key-accent h-touch flex-[2]"
          >
            Guardar y siguiente sala
          </button>
        </div>
      </div>
    </div>
  )
}

export type { CheckKey }
