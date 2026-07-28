import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { pendingSummary } from '@/db/dexie'
import { flush, onSyncState, retryRejected, type SyncState } from '@/sync/outbox'

/**
 * La lámpara de estado.
 *
 * Responde a la única pregunta que importa cuando no hay cobertura —*¿se ha
 * guardado mi trabajo?*— y, casi siempre, la responde **callándose**.
 *
 * Antes era una píldora verde permanente con un punto brillante y un texto
 * tranquilizador. Un panel de instrumentos no lleva un piloto que diga «AUDIO
 * CORRECTO»: lleva uno rojo que se enciende cuando algo va mal. Algo que está en
 * pantalla el 100% del tiempo no debe decir nada cuando no tiene nada que decir,
 * porque entonces deja de leerse y se lleva por delante la atención que hará
 * falta el día que sí importe.
 *
 * Así que: cuadrado gris apagado cuando todo está subido; se enciende con su
 * color y gana la cuenta en cuanto hay algo pendiente, sin conexión o
 * rechazado. Sigue siendo pulsable en los dos casos, así que no se pierde el
 * acceso al detalle ni al «Sincronizar» manual.
 *
 * La confirmación explícita de que el trabajo está a salvo la da la barra de la
 * revisión («Guardado» / «Guardando…»), que es donde el técnico la necesita.
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

  const { label, lamp } =
    rejected > 0
      ? { label: `${rejected} sin enviar`, lamp: 'bg-crit' }
      : stuck
        ? { label: `${pending} atascados`, lamp: 'bg-crit' }
        : state === 'sin-conexion'
          ? {
              label: pending > 0 ? `${pending} sin conexión` : 'Sin conexión',
              lamp: 'bg-warn',
            }
          : state === 'sincronizando'
            ? { label: 'Guardando…', lamp: 'bg-accent' }
            : pending > 0
              ? { label: `${pending} pendientes`, lamp: 'bg-warn' }
              : { label: null, lamp: 'bg-muted/50' }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-1 py-1.5 text-xs font-medium text-ink-2"
        aria-expanded={open}
        aria-label={label ?? 'Todo guardado'}
      >
        {/* Cuadrado, no círculo: un piloto de panel, no un punto de notificación. */}
        <span aria-hidden className={`h-2 w-2 rounded-[1px] ${lamp}`} />
        {label}
      </button>

      {/*
        El panel crece desde la lámpara, no desde su propio centro. Un popover
        anclado que aparece del centro se lee como una capa suelta; anclado al
        origen se lee como el detalle de lo que acabas de tocar.
      */}
      {open && (
        <div
          className="card absolute right-0 z-20 mt-2 w-72 origin-top-right p-4 text-sm"
          style={{ animation: 'pop 150ms var(--ease-out)' }}
        >
          <p className="text-muted">
            {pending === 0 && rejected === 0
              ? 'Todo guardado en el servidor.'
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
              className="key key-accent flex-1 px-3 py-2 text-xs"
            >
              Sincronizar
            </button>
            {rejected > 0 && (
              <button
                type="button"
                onClick={() => void retryRejected()}
                className="key key-quiet flex-1 px-3 py-2 text-xs"
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
