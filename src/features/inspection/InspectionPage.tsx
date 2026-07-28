import { useRef, useState } from 'react'
import { TriState } from '@/components/TriState'
import { PHOTO_ACCEPT, capturePhoto } from '@/lib/photos'
import { CHECK_LABELS, CHECK_MEASURE, type CheckKey, type Room, type Severity } from '@/domain/types'
import { checksForRoom, useInspection } from './useInspection'

interface Props {
  room: Room
  userId: string | null
  buildingName: string
  onDone: (nextRoom: boolean) => void
  onBack: () => void
}

const SEVERITIES: Array<{ value: Severity; label: string }> = [
  { value: 'baja', label: 'Leve' },
  { value: 'media', label: 'Molesta' },
  { value: 'alta', label: 'Impide la clase' },
]

export function InspectionPage({ room, userId, buildingName, onDone, onBack }: Props): React.ReactElement {
  const { draft, saving, setCheck, setNotes, complete } = useInspection(room, userId)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [photoCount, setPhotoCount] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)

  if (!draft) {
    return <p className="p-6 text-muted">Preparando la revisión…</p>
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
      <header className="border-b border-line bg-surface px-4 py-3">
        <button type="button" onClick={onBack} className="text-sm text-accent">
          ← {buildingName}
        </button>
        <h1 className="mt-1 font-mono text-2xl font-semibold">{room.code}</h1>
        {room.name !== room.code && <p className="text-sm text-muted">{room.name}</p>}
      </header>

      <div className="divide-y divide-line px-4">
        {applicable.map(({ key, applicable: isApplicable }) => {
          const check = draft.checks.get(key)
          const measure = CHECK_MEASURE[key]

          return (
            <div key={key}>
              <TriState
                label={CHECK_LABELS[key]}
                value={check?.result ?? null}
                onChange={(result) => setCheck(key, result)}
                {...(!isApplicable ? { disabledReason: 'La sala no lo tiene' } : {})}
              />

              {check?.result === 'incidencia' && (
                <div className="mb-4 rounded-lg border border-crit/30 bg-crit/5 p-3">
                  <p className="eyebrow mb-2">Gravedad</p>
                  <div className="grid grid-cols-3 gap-2">
                    {SEVERITIES.map((s) => (
                      <button
                        key={s.value}
                        type="button"
                        onClick={() => setCheck(key, 'incidencia', { severity: s.value })}
                        className={`rounded-md border px-2 py-2 text-xs font-medium ${
                          check.severity === s.value
                            ? 'border-crit bg-crit text-white'
                            : 'border-line bg-surface text-muted'
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>

                  <textarea
                    value={check.note ?? ''}
                    onChange={(e) => setCheck(key, 'incidencia', { note: e.target.value })}
                    placeholder="¿Qué has visto?"
                    rows={2}
                    className="mt-3 w-full rounded-md border border-line bg-surface p-2 text-sm"
                  />
                </div>
              )}

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
                    className="w-24 rounded-md border border-line bg-surface p-2 text-right font-mono tabular"
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
            className="h-touch w-full rounded-lg border-2 border-dashed border-line font-medium text-muted"
          >
            {photoCount > 0 ? `${photoCount} foto${photoCount === 1 ? '' : 's'} · añadir otra` : 'Añadir foto'}
          </button>

          {photoError && <p className="mt-2 text-sm text-crit">{photoError}</p>}
          {needsPhoto && (
            <p className="mt-2 text-sm text-warn">
              Has marcado una incidencia: una foto ayuda mucho a quien vaya a repararla.
            </p>
          )}

          <textarea
            value={draft.inspection.notes ?? ''}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Observaciones (opcional)"
            rows={3}
            className="mt-3 w-full rounded-md border border-line bg-surface p-3 text-sm"
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
            className="h-touch flex-1 rounded-lg border border-line font-semibold disabled:opacity-40"
          >
            Guardar
          </button>
          <button
            type="button"
            disabled={missing.length > 0}
            onClick={() => void complete().then(() => onDone(true))}
            className="h-touch flex-[2] rounded-lg bg-accent font-semibold text-accent-ink disabled:opacity-40"
          >
            Guardar y siguiente sala
          </button>
        </div>
      </div>
    </div>
  )
}

export type { CheckKey }
