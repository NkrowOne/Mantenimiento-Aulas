/**
 * Placa de puerta.
 *
 * El técnico está de pie delante de una placa atornillada con el código de la
 * sala. La cabecera de la revisión imita ese objeto: mismo orden de lectura
 * —ubicación arriba, nombre grande, matrícula a un lado— y los mismos dos
 * tornillos. Cuando levanta la vista de la pantalla, encuentra lo mismo.
 *
 * Es lo que evita que la pantalla parezca una ficha genérica: el elemento nace
 * del oficio, no de un catálogo de componentes.
 *
 * Y resuelve una confusión real: un código como `-2.1` leído solo se toma por
 * un sótano cualquiera. Con «Edificio H · Planta −2» delante, no hay duda.
 */

interface Props {
  building: string
  zone: string
  /** Nombre de la sala, o su código si no tiene nombre propio. */
  title: string
  /** Código de sala. Se muestra aparte, como la matrícula grabada en la placa. */
  code: string
  onBack: () => void
}

export function RoomPlate({ building, zone, title, code, onBack }: Props): React.ReactElement {
  return (
    <header className="border-b border-line bg-ground px-3 pb-3 pt-2">
      <button
        type="button"
        onClick={onBack}
        className="mb-2 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-accent"
      >
        ← Volver
      </button>

      <div className="relative flex items-stretch overflow-hidden rounded-card border border-line bg-surface shadow-lift">
        {/* Los dos tornillos. Detalle pequeño, pero es lo que convierte un
            rectángulo en una placa. */}
        <span
          aria-hidden
          className="absolute left-[7px] top-1/2 h-[5px] w-[5px] -translate-y-1/2 rounded-full bg-sunken shadow-[inset_0_1px_1px_rgba(0,0,0,.35)]"
        />
        <span
          aria-hidden
          className="absolute right-[7px] top-1/2 h-[5px] w-[5px] -translate-y-1/2 rounded-full bg-sunken shadow-[inset_0_1px_1px_rgba(0,0,0,.35)]"
        />

        <div className="min-w-0 flex-1 border-r border-line px-5 py-3">
          <p className="font-mono text-[0.625rem] font-bold uppercase tracking-[0.17em] text-muted">
            {building} · {zone}
          </p>
          {/*
            `leading-none` recortaba las letras con trazo descendente: la caja de
            línea mide exactamente 1em, `truncate` esconde lo que se salga, y la
            «g» de Criminología caía justo por debajo. Con 1.2 hay sitio para el
            descendente sin que el título deje de ser compacto.
          */}
          <h1 className="mt-1 truncate text-[1.6rem] font-bold leading-[1.2] tracking-tight">
            {title}
          </h1>
        </div>

        <div className="flex shrink-0 flex-col items-center justify-center px-5 py-3">
          <span className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-muted">
            Sala
          </span>
          <span className="mt-0.5 font-mono text-base font-semibold tabular text-ink">{code}</span>
        </div>
      </div>
    </header>
  )
}
