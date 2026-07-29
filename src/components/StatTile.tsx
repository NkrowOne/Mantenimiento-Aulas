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
  /**
   * Qué se hace con este número.
   *
   * Si se pasa, el mosaico deja de ser un cartel y pasa a ser el camino: la
   * etiqueta se acompaña de la acción y la baldosa responde al toque.
   */
  onClick?: () => void
  /** Lo que se va a hacer al pulsar, en dos palabras. «Ver las 11», «Revisar». */
  accion?: string
}

/**
 * El resumen antes que el detalle. El estado se codifica en el raíl lateral
 * *además* de en el color del número, para que se lea igual sin distinguir
 * bien los colores.
 *
 * Y si tiene destino, se nota. Antes el componente ya aceptaba `onClick` y el
 * panel no se lo pasaba a ninguno: cuatro cifras grandes que informaban de un
 * problema y no llevaban a ninguna parte. Un cuadro de mando que solo se mira es
 * un cuadro de mando que se deja de mirar.
 */
export function StatTile({
  label,
  value,
  detail,
  tone = 'neutro',
  onClick,
  accion,
}: Props): React.ReactElement {
  const styles = TONE[tone]

  const cuerpo = (
    <>
      <span aria-hidden className={`w-1 shrink-0 ${styles.rail}`} />
      <span className="flex flex-1 flex-col px-3.5 py-3">
        <span className="eyebrow block">{label}</span>
        <span className={`mt-1.5 block font-mono text-[2rem] font-semibold leading-none tabular ${styles.value}`}>
          {value}
        </span>
        {detail && <span className="mt-1.5 block text-xs leading-snug text-muted">{detail}</span>}

        {/*
          La acción, abajo y en el color de la marca.
          Va dentro de la baldosa y no como un botón aparte porque la baldosa
          ENTERA es el objetivo: en un móvil, un enlace de 60 px dentro de una
          tarjeta de 160 es un objetivo peor que la tarjeta.
        */}
        {accion && (
          <span className="mt-auto flex items-center gap-1 pt-2.5 text-xs font-medium text-accent">
            {accion}
            <span aria-hidden>→</span>
          </span>
        )}
      </span>
    </>
  )

  if (!onClick) {
    return <div className="card flex items-stretch overflow-hidden p-0 text-left">{cuerpo}</div>
  }

  return (
    <button
      type="button"
      onClick={onClick}
      /* `.key` le da el hundido al pulsar que ya tienen todos los controles de
         la aplicación: sin él, la baldosa es pulsable y no lo parece. */
      className="key card flex items-stretch overflow-hidden p-0 text-left"
    >
      {cuerpo}
    </button>
  )
}
