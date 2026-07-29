import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import {
  FAMILIAS,
  FAMILIA_ESTILO,
  familiaDe,
  type EventoSala,
  type Familia,
} from '@/domain/historial'
import { LineaTiempo } from './LineaTiempo'

/**
 * Lo que le ha pasado a esta sala.
 *
 * Vive en dos sitios y es el mismo componente: en la ficha de la sala —donde se
 * viene a preguntar antes de hacer nada— y al final de la revisión, para el
 * momento en que lo que tienes delante no cuadra. Uno solo, porque quien lo mira
 * en las dos pantallas tiene que reconocer las mismas filas y no traducir entre
 * dos diseños.
 *
 * El caso que lo justifica: el técnico llega al aula y el proyector no da
 * imagen. Sin esto, lo único que sabe es lo que ve. Con esto sabe que hace tres
 * semanas se cambió el cable de fibra, que en enero hubo una incidencia por lo
 * mismo y que la lámpara se sustituyó en marzo — y eso cambia lo que hace: no
 * es una avería nueva, es la tercera vez.
 *
 * Nace **plegado**, como el inventario y por el mismo motivo: lo normal es
 * revisar y salir. Y la consulta no se lanza hasta que se abre, así que una
 * ronda de treinta aulas no arrastra treinta consultas que nadie miró.
 *
 * Necesita conexión, y se dice. Es una decisión consciente: el histórico
 * completo de 276 salas no cabe en el espejo local, y descargarlo entero para
 * el caso en que alguien lo abra sería pagar el arranque de todos por el uso de
 * unos pocos. Lo que sí funciona sin cobertura es todo lo demás de la revisión.
 */

const LIMITE = 60

export function HistorialSala({ roomId }: { roomId: string }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [familia, setFamilia] = useState<Familia | null>(null)

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['room-timeline', roomId],
    // Sin esto la consulta sale al montar, y este panel se monta en cada aula
    // de la ronda aunque nadie lo abra.
    enabled: open,
    queryFn: async (): Promise<EventoSala[]> => {
      const { data: filas, error } = await supabase
        .from('room_timeline')
        .select('*')
        .eq('room_id', roomId)
        .order('at', { ascending: false })
        .limit(LIMITE)
      if (error) throw error
      return (filas ?? []) as EventoSala[]
    },
  })

  const eventos = data ?? []
  const visibles = familia ? eventos.filter((e) => familiaDe(e.kind) === familia) : eventos

  // Cuántos hay de cada familia. Se cuenta sobre lo descargado, que es lo que
  // el filtro puede enseñar: prometer «12 incidencias» y luego enseñar 4 porque
  // el resto se quedó fuera del límite sería mentir con precisión.
  const cuenta = (f: Familia): number => eventos.filter((e) => familiaDe(e.kind) === f).length

  return (
    /*
     * Tarjeta con aire alrededor, y no otra banda a lo ancho como el panel de
     * equipos que tiene encima. La diferencia no es decorativa: el inventario es
     * parte de lo que se hace en la revisión —se corrige mientras se revisa— y
     * el histórico es material de consulta. Dos cosas distintas leídas seguidas
     * necesitan verse distintas, o la pantalla se convierte en una sucesión de
     * franjas indistinguibles en la que nadie encuentra nada.
     */
    <section className="card mx-4 my-4 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="min-w-0">
          <span className="eyebrow block">Histórico de la sala</span>
          <span className="mt-0.5 block truncate text-xs text-muted">
            Revisiones, incidencias y material
          </span>
        </span>
        {/* El galón dice «esto se abre» sin gastar una palabra, y girándolo dice
            si está abierto. En una pantalla que ya tiene tres paneles plegables,
            la señal tiene que ser reconocible de un vistazo. */}
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          className={`shrink-0 text-muted transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        >
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div className="collapse-y" data-open={open} inert={!open}>
        <div>
          <div className="border-t border-line px-4 py-3">
            {/* Los filtros solo aparecen cuando hay algo que filtrar y más de una
                familia: con seis eventos de un solo tipo son cuatro botones que
                no hacen nada. */}
            {eventos.length > 0 && FAMILIAS.filter((f) => cuenta(f) > 0).length > 1 && (
              <div className="scroll-x -mx-1 mb-2 flex gap-2 px-1 pb-1">
                <button
                  type="button"
                  onClick={() => setFamilia(null)}
                  aria-pressed={familia === null}
                  className={`key min-h-11 shrink-0 px-3 text-xs ${
                    familia === null ? 'key-accent' : 'key-quiet text-muted'
                  }`}
                >
                  Todo {eventos.length}
                </button>
                {FAMILIAS.filter((f) => cuenta(f) > 0).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFamilia(familia === f ? null : f)}
                    aria-pressed={familia === f}
                    className={`key min-h-11 shrink-0 px-3 text-xs ${
                      familia === f ? 'key-accent' : 'key-quiet text-muted'
                    }`}
                  >
                    {FAMILIA_ESTILO[f].etiqueta} {cuenta(f)}
                  </button>
                ))}
              </div>
            )}

            {isPending && open && <p className="py-3 text-sm text-muted">Cargando el histórico…</p>}

            {isError && (
              <div className="py-3">
                <p className="text-sm text-crit">No se ha podido leer el histórico.</p>
                <p className="mt-1 text-sm text-muted">
                  Esta parte necesita conexión. La revisión sí se guarda sin ella.
                </p>
                <button
                  type="button"
                  onClick={() => void refetch()}
                  className="key key-quiet mt-3 min-h-11 px-3 text-sm"
                >
                  Reintentar
                </button>
              </div>
            )}

            {!isPending && !isError && visibles.length === 0 && (
              <p className="py-3 text-sm text-muted">
                {eventos.length === 0
                  ? 'Esta sala no tiene histórico todavía.'
                  : 'Nada de ese tipo en el histórico de esta sala.'}
              </p>
            )}

            {visibles.length > 0 && <LineaTiempo eventos={visibles} />}

            {eventos.length === LIMITE && (
              <p className="pt-2 text-xs text-muted">
                Mostrando lo más reciente. El histórico completo está en la pestaña Historial.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
