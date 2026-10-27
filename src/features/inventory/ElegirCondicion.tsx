import { useId } from 'react'
import { CONDICIONES, CONDICION_AYUDA, CONDICION_LABEL, type Condicion } from '@/domain/unidades'

/**
 * El estado de una unidad, en cuatro botones.
 *
 * Cuatro y no un desplegable porque es una pregunta de un toque que se contesta
 * con el aparato en la mano: se ven las cuatro respuestas a la vez, se toca una,
 * y debajo dice qué significa la elegida. En el teléfono van de dos en dos para
 * que «Reacondicionado» quepa entero.
 */
export function ElegirCondicion({
  valor,
  onCambio,
  deshabilitado = false,
  etiqueta = 'Estado',
}: {
  valor: Condicion
  onCambio: (c: Exclude<Condicion, 'sin_indicar'>) => void
  deshabilitado?: boolean
  etiqueta?: string
}): React.ReactElement {
  const id = useId()
  return (
    <fieldset role="radiogroup" aria-labelledby={id} className="mt-3">
      <legend id={id} className="text-xs text-muted">
        {etiqueta}
      </legend>
      <div className="mt-1 grid grid-cols-2 gap-1 rounded-ctl border border-line bg-surface p-1 sm:grid-cols-4">
        {CONDICIONES.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={valor === c}
            disabled={deshabilitado}
            onClick={() => onCambio(c)}
            className={`min-h-11 rounded-ctl px-2 text-sm font-semibold ${
              valor === c ? 'key key-accent' : 'text-muted'
            }`}
          >
            {CONDICION_LABEL[c]}
          </button>
        ))}
      </div>
      <p className="mt-1 text-xs text-muted">
        {valor === 'sin_indicar' ? 'Nadie ha dicho todavía cómo está.' : CONDICION_AYUDA[valor]}
      </p>
    </fieldset>
  )
}

/** «← Volver»: la salida de cada vista de la hoja hacia la anterior. */
export function Volver({ onVolver, texto = 'Volver' }: { onVolver: () => void; texto?: string }): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onVolver}
      className="-ml-2 inline-flex min-h-11 items-center px-2 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-accent"
    >
      ← {texto}
    </button>
  )
}
