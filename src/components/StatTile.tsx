type Tone = 'neutro' | 'ok' | 'aviso' | 'critico'

const TONE: Record<Tone, { value: string; rail: string }> = {
  neutro: { value: 'text-ink', rail: 'bg-line' },
  ok: { value: 'text-ok', rail: 'bg-ok' },
  aviso: { value: 'text-warn', rail: 'bg-warn' },
  critico: { value: 'text-crit', rail: 'bg-crit' },
}

interface Props {
  label: string
  value: number | string
  /** Contexto que convierte un número suelto en una lectura. */
  detail?: string
  tone?: Tone
  onClick?: () => void
}

/**
 * El resumen antes que el detalle. El estado se codifica en el raíl lateral
 * *además* de en el color del número, para que se lea igual sin distinguir
 * bien los colores.
 */
export function StatTile({ label, value, detail, tone = 'neutro', onClick }: Props): React.ReactElement {
  const styles = TONE[tone]
  const Element = onClick ? 'button' : 'div'

  return (
    <Element
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className="card flex items-stretch gap-3 overflow-hidden p-0 text-left"
    >
      <span aria-hidden className={`w-1 shrink-0 ${styles.rail}`} />
      <span className="flex-1 px-3 py-3">
        <span className="eyebrow block">{label}</span>
        <span className={`mt-1 block font-mono text-3xl font-semibold tabular ${styles.value}`}>
          {value}
        </span>
        {detail && <span className="mt-0.5 block text-xs text-muted">{detail}</span>}
      </span>
    </Element>
  )
}
