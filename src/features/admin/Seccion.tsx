import type { ReactNode } from 'react'

/**
 * Las piezas que comparten todas las secciones de «Datos».
 *
 * Cada sección era una isla: unas abrían con un `eyebrow` en versalitas y
 * otras con un `<h1>` de veinte píxeles; unas decían «Cargando…» y otras
 * «Buscando huérfanas…»; el error de carga tenía cuatro formas distintas y la
 * confirmación de «guardado» tres. Ninguna estaba mal sola, y todas juntas se
 * leían como doce pantallas pegadas, que es exactamente lo que eran.
 *
 * Aquí viven las cinco formas que se repiten, y solo esas:
 *
 *  - `Seccion`: el título con su recuento de pendientes, la frase de qué es y
 *    dónde va lo que se hace aquí, y un hueco para las acciones de arriba.
 *  - `EstadoVacio`: «no hay nada que hacer», dicho como una buena noticia y no
 *    como una lista vacía. Es el estado normal de la mayoría de bandejas.
 *  - `Cargando` y `FalloDeCarga`: una sola forma de esperar y una sola de
 *    fallar, con el botón de reintentar siempre en el mismo sitio.
 *  - `Nota`: la confirmación o el error de una acción, en región viva para
 *    quien no ve la pantalla.
 *
 * No hay más: una biblioteca de componentes de administración con veinte
 * piezas sería la tercera forma de tener doce pantallas distintas.
 */

type Tono = 'aviso' | 'neutro' | 'ok' | 'crit'

const CONTADOR: Record<Tono, string> = {
  aviso: 'bg-warn-tint text-warn',
  neutro: 'bg-raised text-muted',
  ok: 'bg-ok-tint text-ok',
  crit: 'bg-crit-tint text-crit',
}

/** Cuántas cosas esperan, al lado del título. Con palabra en el `title`: el color solo acompaña. */
export function Contador({ n, tono = 'aviso', que = 'pendientes' }: { n: number; tono?: Tono; que?: string }): React.ReactElement {
  return (
    <span
      title={`${n} ${que}`}
      className={`inline-flex min-w-6 items-center justify-center rounded-tag px-2 py-0.5 font-mono text-xs font-semibold tabular ${CONTADOR[tono]}`}
    >
      {n}
    </span>
  )
}

export function Seccion({
  id,
  titulo,
  texto,
  pendientes,
  acciones,
  children,
}: {
  id: string
  titulo: string
  /** Qué es esto y qué pasa con lo que se decide aquí. Una o dos frases. */
  texto?: ReactNode
  /** Cuántas cosas esperan decisión. Cero no se pinta: el vacío ya lo dice el cuerpo. */
  pendientes?: number
  /** Lo que se hace sobre la sección entera: «Validar los 12», un filtro. */
  acciones?: ReactNode
  children: ReactNode
}): React.ReactElement {
  return (
    <section aria-labelledby={id} className="section-tail">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <h2 id={id} className="flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight">
            {titulo}
            {pendientes !== undefined && pendientes > 0 && <Contador n={pendientes} />}
          </h2>
          {texto && <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted">{texto}</p>}
        </div>
        {acciones && <div className="flex shrink-0 flex-wrap items-center gap-2">{acciones}</div>}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  )
}

/**
 * Nada pendiente. Es una buena noticia y se ve como tal: con marca, no como
 * una lista que se quedó sin filas.
 */
export function EstadoVacio({ titulo, texto }: { titulo: string; texto?: string }): React.ReactElement {
  return (
    <div className="rounded-ctl border border-dashed border-line px-4 py-5 text-center">
      <p className="text-sm font-medium text-ok">
        <span aria-hidden>✓ </span>
        {titulo}
      </p>
      {texto && <p className="mt-1 text-xs text-muted">{texto}</p>}
    </div>
  )
}

export function Cargando({ texto = 'Cargando…' }: { texto?: string }): React.ReactElement {
  return (
    <p role="status" className="py-2 text-sm text-muted">
      {texto}
    </p>
  )
}

export function FalloDeCarga({
  que,
  error,
  onReintentar,
}: {
  /** Qué no se pudo leer: «los usuarios», «las retiradas». */
  que: string
  error: unknown
  onReintentar?: () => void
}): React.ReactElement {
  return (
    <div className="card border-crit p-4">
      <p className="text-sm text-crit">
        No se han podido leer {que}
        {error instanceof Error && error.message ? `: ${error.message}` : '.'}
      </p>
      <p className="mt-1 text-xs text-muted">Esta sección necesita conexión y el rol que le corresponde.</p>
      {onReintentar && (
        <button type="button" onClick={onReintentar} className="key key-quiet mt-3 min-h-11 px-3 text-sm">
          Reintentar
        </button>
      )}
    </div>
  )
}

/**
 * La respuesta a una acción: «guardado», «no se ha podido».
 *
 * Siempre montada y en región viva: montarla a la vez que su texto hacía que
 * VoiceOver se saltara el anuncio con frecuencia. Vacía no ocupa.
 */
export function Nota({ texto, tono = 'ok' }: { texto: string | null; tono?: 'ok' | 'crit' }): React.ReactElement {
  const color = tono === 'crit' ? 'text-crit' : 'text-ok'
  return (
    <p aria-live="polite" role={tono === 'crit' ? 'alert' : undefined} className={texto ? `mt-3 text-sm ${color}` : 'sr-only'}>
      {texto ?? ''}
    </p>
  )
}

/** El mensaje de un error de mutación, para `Nota`. */
export function mensajeDe(error: unknown, siNo = 'No se ha podido aplicar.'): string {
  return error instanceof Error && error.message ? error.message : siNo
}
