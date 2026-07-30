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

/**
 * La tecla marcada usa el relleno profundo del estado, no su color de marca.
 *
 * Es la diferencia entre un panel de sala de control y una plantilla: con el
 * color de marca, siete comprobaciones en verde eran siete bloques de menta
 * bajando por la pantalla. Con el relleno, son siete teclas verdes apagadas con
 * el texto encendido.
 */
const SELECTED: Record<CheckResult, string> = {
  ok: 'key-ok border-transparent',
  incidencia: 'key-crit border-transparent',
  na: 'bg-na-tint text-na border-na/40',
}

/**
 * «No aplica» se atenúa para que la vista salte a lo que sí hay que mirar.
 * La incidencia NO se tiñe aquí: de eso se encarga el panel que envuelve fila y
 * detalle, para que sean una sola forma con un solo borde.
 */
const ROW: Partial<Record<CheckResult, string>> = {
  na: 'opacity-55',
}

interface Props {
  value: CheckResult | null
  onChange: (value: CheckResult) => void
  label: string
  hint: string
  /** Marca naranja junto al nombre. La usa el equipo sin validar todavía. */
  flag?: string | null
}

export function TriState({ value, onChange, label, hint, flag }: Props): React.ReactElement {
  return (
    <div className={`flex items-center gap-3 py-2.5 ${value ? (ROW[value] ?? '') : ''}`}>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 font-semibold leading-tight">
          <span className="truncate">{label}</span>
          {flag && (
            <span className="shrink-0 rounded-tag bg-warn-tint px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-warn">
              {flag}
            </span>
          )}
        </p>
        {/*
          Sin `uppercase`, y es un arreglo, no un gusto.

          Esta línea llevaba mayúsculas forzadas cuando decía «CONECTIVIDAD DEL
          PUESTO». Ahora dice «Lenovo U3302 · S/N 2440634LG», y ahí las
          mayúsculas destruyen información: `iiyama T2454MSC` es como se escribe
          esa marca —lo dice `src/domain/almacen.ts` sobre el almacén— y un
          número de serie con minúsculas deja de coincidir con la pegatina que el
          técnico tiene delante. La mono y el interletrado se quedan: es un
          renglón técnico y se lee como tal.
        */}
        <p className="mt-0.5 font-mono text-[0.6875rem] leading-tight tracking-wide text-muted">
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
                'key flex h-11 w-[3.25rem] flex-col items-center justify-center border',
                'text-[0.625rem] leading-none',
                selected ? SELECTED[opt.value] : 'key-quiet text-muted',
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
