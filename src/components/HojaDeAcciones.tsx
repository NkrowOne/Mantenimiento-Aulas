/**
 * La hoja de acciones: un menú que sube del borde inferior.
 *
 * Es la capa genérica y no sabe nada del maestro — recibe una lista de acciones
 * o un formulario y se ocupa de lo demás: que suba desde donde estaba el dedo,
 * que el fondo no se mueva por debajo, que el teclado y VoiceOver no se salgan
 * de ella y que al cerrar el foco vuelva exactamente a la fila que la abrió.
 *
 * Del borde inferior y no del centro por dónde se usa esto: un iPad sujeto con
 * una mano, de pie en un pasillo. Lo que hay arriba de la pantalla está lejos
 * del pulgar, y una hoja centrada obliga a recolocar el aparato para tocar lo
 * que uno mismo acaba de pedir.
 *
 * La mecánica está calcada de `FichaDeRevision`, que es el patrón canónico de
 * capa modal del repo: mismo `role="dialog"`, misma trampa de tabulador con el
 * mismo selector, misma congelación del documento de detrás y mismo cuidado con
 * el `Escape` ya consumido por algo de dentro.
 */

import { useEffect, useId, useRef } from 'react'

export interface AccionDeHoja {
  id: string
  etiqueta: string
  /** Segunda línea, más pequeña: la consecuencia de elegirla. */
  descripcion?: string
  tono?: 'normal' | 'critico'
  deshabilitada?: boolean
  /** Por qué no se puede. Se pinta debajo y va en `aria-describedby`. */
  motivo?: string
  alElegir: () => void
}

interface Props {
  titulo: string
  /** El código, la planta: lo que confirma sobre QUÉ se va a actuar. */
  subtitulo?: string
  acciones: AccionDeHoja[]
  /** Contenido a medida —los formularios de renombrar— debajo de las acciones. */
  children?: React.ReactNode
  /**
   * ¿Se puede cerrar tocando el velo? Por defecto sí, y con un formulario
   * relleno **no**.
   *
   * Tocar fuera es una comodidad que vale mientras lo único que hay dentro sea un
   * menú: se abre por error, se toca al lado, se acabó. En cuanto la hoja aloja
   * un formulario, esa misma comodidad es la que se lleva por delante lo que se
   * acaba de teclear —aquí no hay borrador que sobreviva al desmontaje: el código
   * y el nombre son estado del componente y no pasan por Dexie—, y el velo mide
   * medio iPad justo donde apoya el pulgar que sujeta el aparato. Quien lo decide
   * es quien pinta el formulario, que es el único que sabe si hay algo escrito.
   */
  cierrePorFondo?: boolean
  /**
   * El botón de salida del pie, o `null` cuando los `children` ya traen el suyo.
   *
   * Se apaga en un solo sitio —la confirmación de «hecho», que sale con su
   * «Entendido» a ancho completo— y solo porque ahí «Cancelar» sería mentira:
   * ya no hay nada que cancelar, y dos botones que hacen lo mismo con dos
   * verbos distintos obligan a decidir cuál es cuál. La salida sigue estando en
   * el orden de tabulación y sigue respondiendo al Escape; lo que cambia es
   * quién la pinta.
   */
  etiquetaDeCierre?: string | null
  onCerrar: () => void
}

export function HojaDeAcciones({
  titulo,
  subtitulo,
  acciones,
  children,
  cierrePorFondo = true,
  etiquetaDeCierre = 'Cancelar',
  onCerrar,
}: Props): React.ReactElement {
  const panel = useRef<HTMLDivElement>(null)
  const idBase = useId()

  /*
   * `onCerrar` se lee por `ref` para que los efectos de abajo se monten UNA
   * vez. Con la prop como dependencia —y el padre pasándola como flecha nueva
   * en cada render— cada emisión de un `useLiveQuery` del padre reejecutaba el
   * efecto de foco, y en una lista que se repinta sola eso significa perder el
   * cursor a mitad de escribir un nombre.
   */
  const cerrar = useRef(onCerrar)
  cerrar.current = onCerrar

  useEffect(() => {
    /*
     * Solo al montar. El foco entra en la hoja y al cerrar vuelve a la fila que
     * la abrió: sin esto, quien navega con teclado o con VoiceOver reaparecía
     * al principio de una lista de cuarenta aulas cada vez que cancelaba.
     *
     * Entra en el panel y no en el primer campo cuando hay formulario: enfocar
     * un `<input>` levanta el teclado del iPad al instante y se come media
     * hoja antes de que nadie haya decidido escribir nada.
     */
    const origen = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const primera = panel.current?.querySelector<HTMLElement>('button:not([disabled])')
    if (primera && acciones.length > 0) primera.focus()
    else panel.current?.focus()

    // Y el documento de detrás se congela: `overscroll-contain` corta el
    // encadenado en los límites del scroll propio, pero cuando la hoja es corta
    // no hay scroll propio que consumir e iOS pasa el gesto a la lista de
    // debajo — que entonces se desplaza detrás de la hoja abierta.
    const previo = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden'

    return () => {
      document.documentElement.style.overflow = previo
      origen?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al montar, a propósito
  }, [])

  useEffect(() => {
    const alPulsar = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Consumido es consumido: un desplegable abierto dentro del formulario
        // cierra con `preventDefault` y ese Escape no es para la hoja.
        if (e.defaultPrevented) return
        cerrar.current()
        return
      }

      /*
       * El tabulador da la vuelta DENTRO de la hoja. `aria-modal` promete un
       * fondo imperceptible, pero el fondo sigue en el árbol: sin esto, Tab
       * desde el último botón seguía hacia la lista tapada y hasta el nav
       * inferior, donde activar una pestaña invisible desmonta la pantalla
       * entera con la hoja todavía abierta encima.
       */
      if (e.key === 'Tab') {
        const raiz = panel.current
        if (!raiz) return
        const enfocables = [
          ...raiz.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ]
        if (enfocables.length === 0) return
        const primero = enfocables[0]!
        const ultimo = enfocables[enfocables.length - 1]!
        const activo = document.activeElement

        if (!raiz.contains(activo)) {
          e.preventDefault()
          primero.focus()
          return
        }
        if (!e.shiftKey && activo === ultimo) {
          e.preventDefault()
          primero.focus()
        } else if (e.shiftKey && activo === primero) {
          e.preventDefault()
          ultimo.focus()
        }
      }
    }
    window.addEventListener('keydown', alPulsar)
    return () => window.removeEventListener('keydown', alPulsar)
  }, [])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={titulo}
      /*
       * z-40: por encima del nav inferior (z-10), del globo de estado de la
       * sincronización (z-20) y del aviso de versión nueva (z-30), que si no
       * caerían justo sobre el pie de la hoja —donde está «Cancelar»—; la
       * cámara y el visor de fotos (z-50) siguen quedando por encima, que es lo
       * correcto: son pantallas completas y no un menú.
       */
      className="fixed inset-0 z-40 flex flex-col justify-end"
    >
      {/*
       * Sin `backdrop-blur` a propósito: obliga a WebKit a recapturar y
       * desenfocar el fondo en cada fotograma, y en un iPad con una lista
       * `sticky` detrás eso se ve como tirones mientras la hoja sube. El velo
       * plano cumple lo mismo — apartar lo de detrás — y no cuesta nada.
       *
       * Cerrar tocando fuera es una comodidad, no la salida accesible: la
       * salida es el botón «Cancelar» del final, que sí sale en el orden de
       * tabulación y sí lo anuncia VoiceOver.
       *
       * Y cierra con un TOQUE COMPLETO, no con el contacto. Estaba en
       * `onPointerDown` —el único `onPointerDown` del repo que dispara una
       * acción, frente a los `onClick` de todo lo demás— y eso significa que
       * bastaban los milisegundos del roce: el pulgar que sujeta el iPad apoya
       * en el borde, la hoja se desmonta y con ella los dos campos recién
       * tecleados, sin aviso y sin poder abortar retirando el dedo. Con `click`
       * hay que bajar y levantar sobre el velo, que es lo que separa un gesto de
       * un tropiezo.
       *
       * `cursor-pointer` no es decoración: Safari de iOS no despacha el `click`
       * de un elemento que no parezca interactivo hacia los manejadores
       * delegados —y React los delega todos en la raíz—, así que sin esa línea
       * el velo dejaría de cerrar precisamente en el único navegador que se usa
       * aquí.
       */}
      <div
        aria-hidden
        className={`absolute inset-0 bg-black/40 ${cierrePorFondo ? 'cursor-pointer' : ''}`}
        onClick={cierrePorFondo ? onCerrar : undefined}
      />

      <div
        ref={panel}
        tabIndex={-1}
        className="card relative max-h-[85vh] overflow-y-auto overscroll-contain rounded-b-none px-4 pt-4"
        style={{
          // La curva de los cajones de iOS, la misma que usa el aviso de versión
          // nueva. Con `prefers-reduced-motion` la base la recorta a 1ms y la
          // hoja aparece de golpe, que es exactamente lo que se pide ahí.
          animation: 'slide-up 260ms var(--ease-drawer)',
          // La barra de gestos del iPhone se come píxeles reales, y debajo de
          // ella está «Cancelar».
          paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))',
        }}
      >
        <div className="pb-1">
          <p className="truncate text-base font-medium">{titulo}</p>
          {subtitulo && <p className="truncate font-mono text-xs text-muted">{subtitulo}</p>}
        </div>

        {acciones.length > 0 && (
          <ul className="mt-3 space-y-2">
            {acciones.map((a) => {
              const critica = a.tono === 'critico'
              const idMotivo = `${idBase}-${a.id}`
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    disabled={a.deshabilitada}
                    onClick={a.alElegir}
                    aria-describedby={a.motivo ? idMotivo : undefined}
                    className={`key min-h-touch w-full px-4 py-2 text-left text-sm ${
                      critica ? 'key-crit' : 'key-quiet'
                    }`}
                  >
                    <span className="block">{a.etiqueta}</span>
                    {a.descripcion && (
                      <span
                        className={`mt-0.5 block text-xs font-normal ${
                          critica ? 'text-crit-ink opacity-80' : 'text-muted'
                        }`}
                      >
                        {a.descripcion}
                      </span>
                    )}
                  </button>
                  {/* El motivo va fuera del botón y visible, no en un `title`:
                      un `title` no existe para el dedo, que es el único puntero
                      que hay aquí. */}
                  {a.motivo && (
                    <p id={idMotivo} className="mt-1 px-1 text-xs text-muted">
                      {a.motivo}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {children}

        {etiquetaDeCierre !== null && (
          <button
            type="button"
            onClick={onCerrar}
            className="key key-quiet mt-3 min-h-touch w-full px-4 text-sm text-muted"
          >
            {etiquetaDeCierre}
          </button>
        )}
      </div>
    </div>
  )
}
