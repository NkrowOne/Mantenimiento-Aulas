import type { CheckResult } from '@/domain/types'

/**
 * El control que el técnico toca cientos de veces al día.
 *
 * Tres decisiones deliberadas:
 *  - 56px de alto: se pulsa con el pulgar, de pie, en un aula, sin mirar mucho.
 *  - El estado se codifica en forma y texto además de en color, para que se lea
 *    igual con daltonismo y a pleno sol.
 *  - Un solo control para las cuatro comprobaciones: cuatro controles distintos
 *    para cuatro preguntas equivalentes se rellenan más lento y hacen los
 *    informes incomparables entre sí.
 */

const OPTIONS: Array<{ value: CheckResult; label: string; symbol: string }> = [
  { value: 'ok', label: 'OK', symbol: '✓' },
  { value: 'incidencia', label: 'Incidencia', symbol: '!' },
  { value: 'na', label: 'No aplica', symbol: '–' },
]

const STYLES: Record<CheckResult, string> = {
  ok: 'bg-ok text-white border-ok',
  incidencia: 'bg-crit text-white border-crit',
  na: 'bg-muted/15 text-muted border-muted/30',
}

interface Props {
  value: CheckResult | null
  onChange: (value: CheckResult) => void
  label: string
  /** Cuando la sala no tiene ese equipo, se explica por qué está en No aplica. */
  disabledReason?: string
}

export function TriState({ value, onChange, label, disabledReason }: Props): React.ReactElement {
  return (
    <div className="py-3">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <span className="font-medium">{label}</span>
        {disabledReason && <span className="text-xs text-muted">{disabledReason}</span>}
      </div>

      <div role="radiogroup" aria-label={label} className="grid grid-cols-3 gap-2">
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
                'h-touch rounded-lg border-2 font-semibold transition-colors',
                'flex items-center justify-center gap-2 text-sm',
                selected
                  ? STYLES[opt.value]
                  : 'bg-surface border-line text-muted hover:border-muted/50',
              ].join(' ')}
            >
              <span aria-hidden className="text-base font-bold">
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
