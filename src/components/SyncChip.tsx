import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { pendingSummary } from '@/db/dexie'
import { flush, onSyncState, retryRejected, type SyncState } from '@/sync/outbox'

/**
 * El indicador que responde a la única pregunta que importa cuando no hay
 * cobertura: *¿se ha guardado mi trabajo?*
 *
 * Dice "Guardado en servidor", no "Sincronizado": es lo que el técnico
 * necesita saber, en sus términos.
 */
export function SyncChip(): React.ReactElement {
  const [state, setState] = useState<SyncState>('inactivo')
  const [open, setOpen] = useState(false)
  const summary = useLiveQuery(() => pendingSummary(), [], null)

  useEffect(() => onSyncState(setState), [])

  const pending = summary?.total ?? 0
  const rejected = summary?.rejected ?? 0

  // Un pendiente que lleva horas ahí ya no es "en camino", es un problema.
  const stuckHours = summary?.oldestAt ? (Date.now() - summary.oldestAt) / 3_600_000 : 0
  const stuck = pending > 0 && stuckHours > 6

  const { label, tone } =
    rejected > 0
      ? { label: `${rejected} sin enviar`, tone: 'crit' as const }
      : stuck
        ? { label: `${pending} pendientes`, tone: 'crit' as const }
        : state === 'sin-conexion'
          ? { label: pending > 0 ? `${pending} sin conexión` : 'Sin conexión', tone: 'warn' as const }
          : state === 'sincronizando'
            ? { label: 'Guardando…', tone: 'accent' as const }
            : pending > 0
              ? { label: `${pending} pendientes`, tone: 'warn' as const }
              : { label: 'Guardado en servidor', tone: 'ok' as const }

  const toneClass = {
    ok: 'bg-ok-tint text-ok border-ok/30',
    warn: 'bg-warn-tint text-warn border-warn/30',
    crit: 'bg-crit-tint text-crit border-crit/30',
    accent: 'bg-accent-tint text-accent border-accent/30',
  }[tone]

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ${toneClass}`}
        aria-expanded={open}
      >
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${
            tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : tone === 'crit' ? 'bg-crit' : 'bg-accent'
          }`}
        />
        {label}
      </button>

      {open && (
        <div className="card absolute right-0 z-20 mt-2 w-72 p-4 text-sm">
          <p className="text-muted">
            {pending === 0 && rejected === 0
              ? 'Todo guardado.'
              : `${pending} sin subir${summary?.photos ? ` · ${summary.photos} fotos` : ''}`}
          </p>

          {stuck && (
            <p className="mt-2 text-crit">
              {Math.floor(stuckHours)} h sin subir. Busca cobertura.
            </p>
          )}

          {rejected > 0 && (
            <p className="mt-2 text-crit">
              {rejected} rechazados. Avisa a administración.
            </p>
          )}

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void flush()}
              className="flex-1 rounded-ctl bg-accent px-3 py-2 text-xs font-semibold text-accent-ink"
            >
              Sincronizar
            </button>
            {rejected > 0 && (
              <button
                type="button"
                onClick={() => void retryRejected()}
                className="flex-1 rounded-ctl border border-line px-3 py-2 text-xs font-semibold"
              >
                Reintentar
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
