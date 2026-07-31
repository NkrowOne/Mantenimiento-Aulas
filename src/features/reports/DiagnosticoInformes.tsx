import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { diagnostico, type EstadoInformes } from './diagnostico'

/**
 * «¿Por qué no sale el informe?» — la pregunta, con botón.
 *
 * Existe porque el fallo más grave de esta pantalla fue invisible durante
 * semanas: la tubería entera parecía funcionar —«Generar» sin errores, el cron
 * corriendo— y ningún informe se emitía jamás. La única forma de verlo era
 * entrar con psql a mirar la cola de pg_net. Eso no puede volver a ser el
 * procedimiento: la pantalla que promete el informe es la que tiene que saber
 * decir por qué no llega.
 *
 * Nace plegado —el caso normal es que todo funcione— y se abre solo cuando la
 * espera de un informe pasa de lo razonable, que es exactamente el momento en
 * que quien mira necesita la respuesta.
 */

const ESTILO: Record<'crit' | 'warn' | 'ok', string> = {
  crit: 'border-crit/40 bg-crit-tint text-crit',
  warn: 'border-warn/40 bg-warn-tint text-warn',
  ok: 'border-ok/40 bg-ok-tint text-ok',
}

export function DiagnosticoInformes({ sugerido }: { sugerido: boolean }): React.ReactElement {
  const [abierto, setAbierto] = useState(false)

  // La espera larga lo abre sola una vez; cerrarlo después queda en manos de
  // quien mira, sin que el temporizador se lo vuelva a abrir en las narices.
  useEffect(() => {
    if (sugerido) setAbierto(true)
  }, [sugerido])

  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: ['estado-informes'],
    queryFn: async (): Promise<EstadoInformes> => {
      const { data: estado, error } = await supabase.rpc('estado_de_informes')
      if (error) throw error
      return estado as EstadoInformes
    },
    enabled: abierto,
    refetchInterval: abierto ? 15_000 : false,
  })

  const avisos = data ? diagnostico(data) : []

  return (
    <section className="card p-4">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-expanded={abierto}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="font-semibold">¿No sale el informe?</span>
        <span className="text-sm text-muted">{abierto ? 'cerrar' : 'diagnosticar la tubería'}</span>
      </button>

      {abierto && (
        <div className="mt-3 space-y-3">
          {isError && (
            <p className="text-sm text-crit">
              No se ha podido leer el estado. Hace falta conexión y ser supervisor.
            </p>
          )}
          {!data && !isError && <p className="text-sm text-muted">Preguntando a la base…</p>}

          {avisos.map((a) => (
            <p
              key={a.texto}
              className={`rounded-ctl border p-3 text-sm leading-relaxed ${ESTILO[a.nivel]}`}
            >
              {a.texto}
            </p>
          ))}

          {/* Los hechos debajo del veredicto: las últimas respuestas del worker
              y las últimas corridas del cron, para poder discutir el veredicto
              con los datos delante. */}
          {data && data.respuestas.length > 0 && (
            <div>
              <span className="eyebrow">Últimas respuestas del worker</span>
              <ul className="mt-1 space-y-1">
                {data.respuestas.map((r, i) => (
                  <li key={i} className="font-mono text-xs text-muted">
                    {new Date(r.cuando).toLocaleString('es-ES')} ·{' '}
                    {r.codigo !== null ? `HTTP ${r.codigo}` : r.caduco ? 'sin respuesta a tiempo' : 'sin conexión'}
                    {r.error ? ` · ${r.error}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data && data.corridas.length > 0 && (
            <div>
              <span className="eyebrow">Últimas corridas del cron</span>
              <ul className="mt-1 space-y-1">
                {data.corridas.map((c, i) => (
                  <li key={i} className="font-mono text-xs text-muted">
                    {new Date(c.cuando).toLocaleString('es-ES')} · {c.nombre} · {c.estado}
                    {c.detalle ? ` · ${c.detalle}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="key key-quiet min-h-11 px-3 text-sm"
          >
            {isFetching ? 'Preguntando…' : 'Volver a mirar'}
          </button>
        </div>
      )}
    </section>
  )
}
