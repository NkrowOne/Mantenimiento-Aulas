import type { ReactNode } from 'react'
import { Icono } from '@/components/Icono'

/**
 * Las piezas que comparten todas las secciones de «Datos».
 *
 * Cada sección era una isla: unas abrían con un `eyebrow` en versalitas y
 * otras con un `<h1>` de veinte píxeles; unas decían «Cargando…» y otras
 * «Buscando huérfanas…»; el error de carga tenía cuatro formas distintas y la
 * confirmación de «guardado» tres. Ninguna estaba mal sola, y todas juntas se
 * leían como doce pantallas pegadas, que es exactamente lo que eran.
 *
 * Aquí viven las seis formas que se repiten, y solo esas:
 *
 *  - `Seccion`: el título con su recuento de pendientes, UNA frase de qué es,
 *    el resto de la explicación detrás de «Más información», y un hueco para
 *    las acciones de arriba.
 *  - `MasInformacion`: ese desplegable, para usarlo también dentro de una
 *    sección.
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
      // Con la cifra de clave: al cambiar, el número se vuelve a montar y da su
      // pequeño salto (`.contador`). Es lo que avisa de que ya no es el de antes.
      key={n}
      title={`${n} ${que}`}
      className={`contador inline-flex min-w-6 items-center justify-center rounded-full px-2 py-0.5 text-xs font-semibold tabular ${CONTADOR[tono]}`}
    >
      {n}
    </span>
  )
}

/**
 * La explicación larga, plegada.
 *
 * Cada sección abría con un párrafo de tres o cuatro frases: qué es, por qué
 * existe, qué hace cada botón y qué no se pierde. Todo cierto y todo útil la
 * primera vez; la vigésima, es un muro que hay que saltar para llegar a la
 * lista. Con doce secciones, eran doce muros.
 *
 * Ahora cada una dice en una frase qué es, y lo demás —el porqué, los avisos de
 * «esto no borra nada»— sigue ahí, a un toque. No se ha quitado ninguna
 * advertencia: se ha movido.
 *
 * Es un `<details>` del navegador y no un estado de React: se abre con el
 * teclado, lo anuncia VoiceOver y la búsqueda en la página de Safari lo
 * despliega sola si lo que se busca está dentro.
 */
export function MasInformacion({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}): React.ReactElement {
  return (
    <details className={`mas-informacion ${className}`}>
      <summary>Más información</summary>
      <div className="max-w-prose pb-1 text-sm leading-relaxed text-muted">{children}</div>
    </details>
  )
}

export function Seccion({
  id,
  titulo,
  texto,
  detalle,
  pendientes,
  acciones,
  children,
}: {
  id: string
  titulo: string
  /** Qué es esto, en una frase. */
  texto?: ReactNode
  /** El resto: por qué existe, qué hace cada botón, qué no se pierde. Va plegado. */
  detalle?: ReactNode
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
          <h2 id={id} className="flex flex-wrap items-center gap-2 text-xl font-bold tracking-tight">
            {titulo}
            {pendientes !== undefined && pendientes > 0 && <Contador n={pendientes} />}
          </h2>
          {texto && <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted">{texto}</p>}
          {detalle && <MasInformacion>{detalle}</MasInformacion>}
        </div>
        {/* `max-w-full` y sin `shrink-0`: con él, tres filtros en fila —los de
            Actividad— medían más que un teléfono y el último se salía por la
            derecha sin forma de alcanzarlo. Así, lo que no cabe baja de línea. */}
        {acciones && <div className="flex max-w-full flex-wrap items-center gap-2">{acciones}</div>}
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
    <div className="rounded-card border border-dashed border-line px-4 py-6 text-center">
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
  // La misma caja que `Confirmacion`, y en rojo si es un error: antes era texto
  // de color suelto debajo de una lista, y un «asignadas» verde a media pantalla
  // se confundía con una fila más.
  const caja =
    tono === 'crit' ? 'bg-crit-tint text-crit' : 'bg-ok-tint text-ok'
  return (
    <p
      aria-live="polite"
      role={tono === 'crit' ? 'alert' : undefined}
      className={
        texto
          ? `confirmacion mt-3 flex items-start gap-2.5 rounded-ctl px-3 py-2.5 text-sm font-medium leading-snug ${caja}`
          : 'sr-only'
      }
    >
      {texto && <Icono nombre={tono === 'crit' ? 'cerrar' : 'hecho'} lado={18} className="mt-0.5 shrink-0" />}
      <span className="min-w-0 flex-1">{texto ?? ''}</span>
    </p>
  )
}

/**
 * El mensaje de un error de mutación, para `Nota`.
 *
 * No basta con `instanceof Error`: lo que devuelve `supabase.rpc()` es un
 * `PostgrestError`, que en esta versión es un objeto plano con `message` y no
 * hereda de `Error`. Con esa comprobación sola, cada «Solo se fusionan dos
 * equipos de la misma sala» o «No son el mismo aparato» que el servidor
 * escribe con cuidado llegaba a la pantalla como «No se ha podido aplicar.», y
 * quien lo leía no tenía forma de saber qué hacer distinto.
 */
export function mensajeDe(error: unknown, siNo = 'No se ha podido aplicar.'): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error as { message: unknown }
    if (typeof message === 'string' && message.trim() !== '') return message
  }
  return siNo
}
