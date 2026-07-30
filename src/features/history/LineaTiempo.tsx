import {
  FAMILIA_ESTILO,
  cantidadLegible,
  familiaDe,
  fechaLegible,
  subtipoLegible,
  type EventoSala,
} from '@/domain/historial'

/**
 * La lista de eventos.
 *
 * Es la misma en las dos pantallas que la usan —el panel plegado de la revisión
 * y la pestaña de Historial— y eso es deliberado: quien ve el histórico de un
 * aula y luego lo busca en la pestaña general tiene que reconocer las mismas
 * filas, no traducir entre dos diseños.
 *
 * La forma es una línea de tiempo con un raíl a la izquierda, y no una tabla,
 * por dos motivos. Uno, se lee en un iPhone sujeto con una mano: una tabla de
 * cinco columnas obliga a desplazar en horizontal. Y dos, un raíl continuo dice
 * «esto es una secuencia» sin necesidad de ninguna etiqueta; una tabla dice
 * «esto son registros», que es verdad pero no es lo que hay que entender aquí.
 *
 * El punto de color lleva la familia. El resto —quién, cuánto, qué estado— va
 * en texto, porque son cosas que se leen, no que se reconocen.
 */
export function LineaTiempo({
  eventos,
  salaDe,
  onRevision,
}: {
  eventos: EventoSala[]
  /** Cómo se llama la sala de un evento. Solo en la pestaña general, donde la
      lista mezcla salas; en la revisión no se pinta porque ya se sabe cuál es. */
  salaDe?: (roomId: string) => string | null
  /**
   * Abrir la ficha de una revisión.
   *
   * Solo las revisiones se pueden abrir, y esa asimetría es la propia naturaleza
   * de la lista: una revisión tiene detrás nueve comprobaciones, sus notas y sus
   * fotos —«Revisión con incidencias» es un titular, no el dato—, mientras que un
   * consumo de dos metros de cable ya está dicho entero en su fila.
   *
   * Cuando no se pasa, las filas no son pulsables. Es lo que evita fingir un
   * destino en las pantallas que todavía no lo tienen.
   */
  onRevision?: (inspectionId: string) => void
}): React.ReactElement {
  return (
    <ol className="relative">
      {/* El raíl. Va detrás de los puntos y se corta arriba y abajo con el
          degradado del propio contenedor para que no parezca que la historia
          empieza y termina exactamente aquí. */}
      <span
        aria-hidden="true"
        className="absolute bottom-2 left-[0.3125rem] top-2 w-px bg-line"
      />

      {eventos.map((e) => {
        const estilo = FAMILIA_ESTILO[familiaDe(e.kind)]
        const sub = subtipoLegible(e)
        const cantidad = cantidadLegible(e.qty)
        const sala = salaDe?.(e.room_id) ?? null
        const esRevision = e.kind === 'revision_ok' || e.kind === 'revision_ko'
        const abrible = esRevision && onRevision !== undefined

        const cuerpo = (
          <>
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 text-sm font-medium leading-snug">{e.title}</span>
              {cantidad && (
                <span
                  className={`shrink-0 font-mono text-sm font-semibold tabular ${
                    (e.qty ?? 0) > 0 ? 'text-ok' : estilo.tinte
                  }`}
                >
                  {cantidad}
                </span>
              )}
              {/* El galón dice que esta fila lleva a algún sitio. Sin él, que una
                  de cada seis filas sea pulsable es un secreto. */}
              {abrible && (
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  className="shrink-0 self-center text-muted"
                >
                  <path
                    d="M9 6l6 6-6 6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </div>

            <p className="mt-0.5 text-xs text-muted">
              <span className={estilo.tinte}>{estilo.etiqueta}</span>
              {sub && <> · {sub}</>}
              {sala && <> · <span className="font-mono text-ink-2">{sala}</span></>}
              {' · '}
              {fechaLegible(e.at)}
            </p>

            {e.detail && (
              <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted">{e.detail}</p>
            )}

            {/* Se dice lo que hay dentro, y no «ver detalle»: lo que trae a
                alguien aquí es saber QUÉ falló, y la ficha es donde está. */}
            {abrible && (
              <p className="mt-1 text-xs text-accent">Ver la ficha: qué se comprobó y qué falló</p>
            )}
          </>
        )

        return (
          <li key={`${e.kind}-${e.subkind}-${e.ref_id}`} className="relative flex gap-3 py-2.5 pl-0">
            <span
              aria-hidden="true"
              className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-ground ${estilo.punto}`}
            />

            {abrible ? (
              <button
                type="button"
                onClick={() => onRevision?.(e.ref_id)}
                className="-my-1 min-w-0 flex-1 rounded-ctl px-1 py-1 text-left transition-colors duration-100 active:bg-raised"
              >
                {cuerpo}
              </button>
            ) : (
              <div className="min-w-0 flex-1">{cuerpo}</div>
            )}
          </li>
        )
      })}
    </ol>
  )
}
