import type { CheckResult } from '@/domain/types'

/**
 * El control que el técnico toca cientos de veces al día.
 *
 * Fila continua, no tarjeta: etiqueta a la izquierda y los tres estados a la
 * derecha. Así las siete comprobaciones caben en una pantalla sin desplazarse,
 * y el conjunto se lee como un parte de trabajo, que es lo que es.
 *
 * Tres decisiones que no se negocian:
 *  - 44px de alto mínimo: se pulsa con el pulgar, de pie, en un aula.
 *  - El estado va en icono y texto además de en color. Hay daltonismo en
 *    cualquier equipo, y una pantalla con el proyector encendido lava los tonos.
 *  - Un solo control para las siete comprobaciones: controles distintos para
 *    preguntas equivalentes se rellenan más lento y hacen los informes
 *    incomparables entre sí.
 */

const OPTIONS: Array<{ value: CheckResult; label: string; symbol: string }> = [
  { value: 'ok', label: 'OK', symbol: '✓' },
  { value: 'incidencia', label: 'Falla', symbol: '✕' },
  { value: 'na', label: 'N/A', symbol: '–' },
]

const SELECTED: Record<CheckResult, string> = {
  ok: 'bg-ok text-white border-ok',
  incidencia: 'bg-crit text-white border-crit',
  na: 'bg-na-tint text-na border-na/40',
}

/** El estado tiñe la fila entera: se ve de un vistazo qué queda por tocar. */
const ROW: Partial<Record<CheckResult, string>> = {
  incidencia: 'bg-crit-tint',
  na: 'opacity-55',
}

interface Props {
  value: CheckResult | null
  onChange: (value: CheckResult) => void
  label: string
  hint: string
}

export function TriState({ value, onChange, label, hint }: Props): React.ReactElement {
  return (
    <div className={`flex items-center gap-3 py-2.5 ${value ? (ROW[value] ?? '') : ''}`}>
      <div className="min-w-0 flex-1">
        <p className="font-semibold leading-tight">{label}</p>
        <p className="mt-0.5 font-mono text-[0.6875rem] uppercase leading-tight tracking-wide text-muted">
          {hint}
        </p>
      </div>

      <div role="radiogroup" aria-label={label} className="flex shrink-0 gap-1">
        {OPTIONS.map((opt) => {
          const selected = value === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(opt.value)}
              className={[
                'flex h-11 w-[3.25rem] flex-col items-center justify-center rounded-ctl border',
                'text-[0.625rem] font-semibold leading-none transition-colors',
                selected ? SELECTED[opt.value] : 'border-line bg-surface text-muted',
              ].join(' ')}
            >
              <span aria-hidden className="mb-0.5 text-sm font-bold">
                {opt.symbol}
              </span>
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
