/**
 * La ficha de una revisión: una pantalla propia con todo lo de aquella visita.
 *
 * Existe porque las dos cosas que se quieren hacer con una revisión pasada no
 * caben en el mismo sitio: **recorrer** la lista pide filas limpias que se
 * lean de un golpe, y **leer** una visita pide espacio — las fotos grandes, la
 * observación entera, cada comprobación con su medida y su nota, quién firmó y
 * cuándo. Metido todo en la tarjeta de la lista, la lista dejaba de ser una
 * lista; aquí cada cosa tiene su sitio.
 *
 * Es una capa a pantalla completa y no una vista más de la navegación, por lo
 * mismo que el visor de fotos: leer una revisión es un paréntesis dentro de la
 * ficha de la sala, y quien vuelve tiene que aterrizar exactamente donde
 * estaba en la lista, no al principio de la sala. `Escape` cierra y el foco
 * vuelve a la fila que la abrió.
 *
 * El detalle no se pide hasta que se abre la pantalla — la lista trae solo los
 * contadores— y la corrección se prepara desde aquí: es la acción de la ficha,
 * pero va al final, porque nueve de cada diez veces se entra a leer.
 */

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { fechaCorta } from '@/domain/fechas'
import { fechaLegible } from '@/domain/historial'
import {
  GRAVEDAD_LEGIBLE,
  RESULTADO_ESTILO,
  detalleDeComprobacion,
  etiquetaDeComprobacion,
  ordenarComprobaciones,
  resultadoLegible,
  type ComprobacionDetalle,
  type Visita,
} from '@/domain/revisiones'
import { FichaDeObservacion } from './FichaDeObservacion'

/** Las filas de aquella revisión. Lo comparte la pantalla con `preparar` en la
    lista: la misma clave de caché, así que corregir reutiliza lo ya leído. */
export async function comprobacionesDe(inspectionId: string): Promise<ComprobacionDetalle[]> {
  const { data, error } = await supabase
    .from('inspection_check_detail')
    .select('*')
    .eq('inspection_id', inspectionId)
  if (error) throw error
  return ordenarComprobaciones((data ?? []) as ComprobacionDetalle[])
}

export function FichaDeRevision({
  visita,
  enCurso,
  conFotoLocal,
  preparando,
  fallo,
  onCorregir,
  onCerrar,
}: {
  visita: Visita
  /** Ya hay una corrección de esta visita empezada en el dispositivo. */
  enCurso: boolean
  /** Hay fotos de esta visita todavía en la cola del dispositivo. */
  conFotoLocal: boolean
  preparando: boolean
  fallo: string | null
  onCorregir: () => void
  onCerrar: () => void
}): React.ReactElement {
  const { vigente, versiones } = visita
  const original = versiones[0]!
  const corregida = versiones.length > 1

  /** Qué versión se está leyendo. Solo cambia si hay más de una. */
  const [viendo, setViendo] = useState(vigente.id)
  const versionVista = versiones.find((r) => r.id === viendo) ?? vigente

  const volver = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    /*
     * El foco entra en la pantalla y al cerrar vuelve a la fila que la abrió:
     * sin esto, el usuario de teclado reempezaba desde la cabecera en mitad de
     * un histórico largo. `Escape` cierra — el visor de fotos, que se abre por
     * encima, captura su propio Escape antes de que llegue aquí.
     */
    const origen = document.activeElement instanceof HTMLElement ? document.activeElement : null
    volver.current?.focus()
    const alPulsar = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCerrar()
    }
    window.addEventListener('keydown', alPulsar)
    return () => {
      window.removeEventListener('keydown', alPulsar)
      origen?.focus()
    }
  }, [onCerrar])

  /*
   * Que hubo foto local se recuerda, no solo se observa: al terminar de subir,
   * la foto sale de la cola antes de que el recuento del servidor se refresque,
   * y sin el enclave la ficha de observación desaparecía un instante.
   */
  const huboFotoLocal = useRef(false)
  if (conFotoLocal) huboFotoLocal.current = true
  const fotoLocal = conFotoLocal || huboFotoLocal.current

  const fotos = versiones.reduce((n, r) => n + r.fotos, 0)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Revisión del ${fechaLegible(vigente.occurred_at)}`}
      className="fixed inset-0 z-20 overflow-y-auto bg-ground"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* El hueco del notch lo pone la cabecera, no el contenedor: pegada
          arriba, es ella la que pasa por debajo al desplazar, y con el relleno
          dentro su contenido nunca queda tapado. */}
      <header
        className="sticky top-0 z-10 border-b border-line bg-ground"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2">
          <button
            ref={volver}
            type="button"
            onClick={onCerrar}
            className="key key-quiet min-h-11 shrink-0 px-3 text-sm"
          >
            ← Volver
          </button>
          <div className="min-w-0 flex-1">
            <p className="eyebrow">Revisión</p>
            {/* Con la hora: es la pregunta que la lista no contesta. */}
            <p className="truncate text-sm font-medium">{fechaLegible(vigente.occurred_at)}</p>
          </div>
          <span
            className={`shrink-0 rounded-tag px-2 py-0.5 text-xs font-semibold ${
              vigente.fallos > 0 || vigente.overall === 'con_incidencias'
                ? 'bg-crit-tint text-crit'
                : 'bg-ok-tint text-ok'
            }`}
          >
            {resultadoLegible(vigente)}
          </span>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 pb-16 pt-4">
        {/* Quién y cuándo, con palabras: es la mitad de «todo detalle». */}
        <p className="text-sm">
          {original.who ? `Revisó ${original.who}` : 'Sin firma'}
          {corregida && vigente.corrected_at && (
            <span className="text-accent">
              {' · '}corregida el {fechaCorta(vigente.corrected_at)}
              {vigente.who ? ` por ${vigente.who}` : ''}
            </span>
          )}
        </p>

        {/* La letra pequeña de la visita: de qué está hecho el resultado. */}
        <p className="mt-1 font-mono text-xs text-muted">
          {[
            vigente.comprobaciones > 0
              ? `${vigente.comprobaciones} comprobacion${vigente.comprobaciones === 1 ? '' : 'es'}`
              : null,
            vigente.no_aplica > 0 ? `${vigente.no_aplica} n/a` : null,
            fotos > 0 ? `${fotos} foto${fotos === 1 ? '' : 's'}` : null,
            vigente.incidencias > 0
              ? `${vigente.incidencias} incidencia${vigente.incidencias === 1 ? '' : 's'} abiertas`
              : null,
            corregida ? `${versiones.length} versiones` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>

        <FichaDeObservacion
          ids={versiones.map((r) => r.id)}
          nota={vigente.notes}
          anunciadas={fotos}
          conFotoLocal={fotoLocal}
        />

        <section aria-labelledby="ficha-comprobaciones" className="mt-6">
          <div className="section-head">
            <h2 id="ficha-comprobaciones" className="eyebrow">
              Lo que se comprobó
            </h2>
          </div>

          {/* El selector de versiones solo aparece si hay más de una. Es la
              forma de mirar lo que decía la revisión ANTES de corregirse, que
              es justamente lo que hace que corregir no sea perder nada. */}
          {corregida && (
            <div className="scroll-x -mx-1 mb-3 flex gap-2 px-1 pb-1">
              {versiones.map((r, i) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setViendo(r.id)}
                  aria-pressed={viendo === r.id}
                  className={`key min-h-11 shrink-0 px-3 text-xs ${
                    viendo === r.id ? 'key-accent' : 'key-quiet text-muted'
                  }`}
                >
                  {i === 0 ? 'Original' : `Corrección ${i}`}
                  {r.id === vigente.id ? ' · actual' : ''}
                </button>
              ))}
            </div>
          )}

          <div className="card px-4 py-2">
            <Comprobaciones inspectionId={viendo} />
          </div>

          {/* Quién firmó la versión que se está mirando, cuando no es la
              vigente: sin esto, «Original» y «Corrección 1» se leen como dos
              listas sin autor. */}
          {corregida && viendo !== vigente.id && (
            <p className="mt-3 font-mono text-xs text-muted">
              {[
                versionVista.corrected_at
                  ? `corregida el ${fechaCorta(versionVista.corrected_at)}`
                  : `revisada el ${fechaCorta(versionVista.occurred_at)}`,
                versionVista.who,
                resultadoLegible(versionVista),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </section>

        {/*
          Corregir, al final: es la acción de la ficha, pero nueve de cada diez
          veces se entra a leer. Con una corrección a medias sube de tono, que
          es lo que hace encontrable el trabajo empezado.
        */}
        <button
          type="button"
          onClick={onCorregir}
          disabled={preparando}
          className={`key mt-6 min-h-touch w-full px-4 text-sm ${enCurso ? 'key-accent' : 'key-quiet'}`}
        >
          {preparando
            ? 'Recuperando…'
            : enCurso
              ? 'Continuar la corrección'
              : 'Corregir esta revisión'}
        </button>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          La corrección se guarda como una versión nueva de esta misma visita, con su
          fecha. La original no se borra: se sigue leyendo aquí.
        </p>

        {fallo && <p className="mt-2 text-sm text-crit">{fallo}</p>}
      </div>
    </div>
  )
}

/** Lo que aquella revisión contestó, fila a fila: el aparato, su medida —las
    horas de lámpara— y la nota de quien lo comprobó. */
function Comprobaciones({ inspectionId }: { inspectionId: string }): React.ReactElement {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['inspection-checks', inspectionId],
    queryFn: () => comprobacionesDe(inspectionId),
  })

  if (isPending) return <p className="py-2 text-sm text-muted">Cargando el detalle…</p>

  if (isError) {
    return (
      <div className="py-2">
        <p className="text-sm text-crit">No se ha podido leer el detalle.</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="key key-quiet mt-2 min-h-11 px-3 text-sm"
        >
          Reintentar
        </button>
      </div>
    )
  }

  if ((data ?? []).length === 0) {
    return (
      <p className="py-2 text-sm text-muted">
        Esta revisión no guardó el resultado fila a fila: viene de la importación del
        Excel, que solo traía la fecha y cómo salió.
      </p>
    )
  }

  return (
    <ul className="divide-y divide-line-soft">
      {(data ?? []).map((c) => {
        const estilo = RESULTADO_ESTILO[c.result]
        const detalle = detalleDeComprobacion(c)

        return (
          <li key={c.id} className="flex items-start gap-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{etiquetaDeComprobacion(c)}</span>
              {detalle && <span className="block font-mono text-xs text-muted">{detalle}</span>}

              {/* La medida, donde la hay: horas de lámpara, Mbps. Es la mitad del
                  valor de leer una revisión vieja —«iba por 1.900 horas»—. */}
              {c.measure !== null && (
                <span className="mt-0.5 block font-mono text-xs text-ink-2">
                  {c.measure} {c.measure_unit ?? ''}
                </span>
              )}

              {c.note && (
                <span className="mt-0.5 block whitespace-pre-line break-words text-xs leading-relaxed text-muted">
                  {c.note}
                </span>
              )}
            </span>

            <span
              className={`shrink-0 rounded-tag px-2 py-0.5 text-xs font-semibold ${estilo.clase}`}
            >
              {estilo.etiqueta}
              {c.result === 'incidencia' && c.severity && (
                <span className="font-normal"> · {GRAVEDAD_LEGIBLE[c.severity]}</span>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
