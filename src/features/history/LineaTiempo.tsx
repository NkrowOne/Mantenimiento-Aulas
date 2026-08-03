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
  onSala,
}: {
  eventos: EventoSala[]
  /** Cómo se llama la sala de un evento. Solo en la pestaña general, donde la
      lista mezcla salas; en la revisión no se pinta porque ya se sabe cuál es. */
  salaDe?: (roomId: string) => string | null
  /**
   * Ir al aula de un evento, si desde esta pantalla tiene sentido.
   *
   * El histórico era una lista de cosas que pasaron y de la que no se salía:
   * leías «Proyector: no da imagen · H 1.7» y a partir de ahí te las apañabas
   * —memorizar el código, cambiar de pestaña, elegir edificio, buscar el aula
   * entre treinta y nueve—. Con esto, cada línea es la puerta de su aula.
   *
   * Sin la prop, las filas no son pulsables y no lo aparentan: dentro de la
   * propia ficha de la sala, un enlace a la sala en la que ya estás es una
   * promesa que no lleva a ninguna parte.
   */
  onSala?: (roomId: string) => void
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
          </>
        )

        return (
          <li key={`${e.kind}-${e.subkind}-${e.ref_id}`} className="relative flex gap-3 py-2.5 pl-0">
            <span
              aria-hidden="true"
              className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-ground ${estilo.punto}`}
            />

            {onSala ? (
              /* El anillo de foco hacia dentro y con un poco de aire alrededor:
                 la fila llega al borde del contenedor y el anillo por fuera se
                 recortaba, igual que en las tarjetas con `overflow-hidden`. */
              <button
                type="button"
                onClick={() => onSala(e.room_id)}
                aria-label={`Abrir la ficha del aula ${sala ?? ''}`.trim()}
                className="-my-1 min-w-0 flex-1 rounded-ctl px-1 py-1 text-left transition-colors duration-100 focus-visible:outline-offset-[-2px] active:bg-raised"
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
