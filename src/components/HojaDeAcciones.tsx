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

import { Icono, type NombreDeIcono } from '@/components/Icono'
import { entrar } from '@/lib/historial'
import { congelarFondo } from '@/lib/viewport'

export interface AccionDeHoja {
  id: string
  etiqueta: string
  /** Segunda línea, más pequeña: la consecuencia de elegirla. */
  descripcion?: string
  tono?: 'normal' | 'critico'
  /** El dibujo que va delante. Opcional: las hojas de siempre no lo llevan. */
  icono?: NombreDeIcono
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
    // Sin desplazar: la hoja es `fixed` y ya está a la vista. Un `focus()` a
    // secas le pide a iOS que la enseñe, y con el teclado a medio bajar eso
    // mueve la página por debajo y deja la barra de pestañas flotando — lo
    // cuenta entero `lib/viewport.ts`.
    if (primera && acciones.length > 0) primera.focus({ preventScroll: true })
    else panel.current?.focus({ preventScroll: true })

    // Y el documento de detrás se congela: `overscroll-contain` corta el
    // encadenado en los límites del scroll propio, pero cuando la hoja es corta
    // no hay scroll propio que consumir e iOS pasa el gesto a la lista de
    // debajo — que entonces se desplaza detrás de la hoja abierta. Al cerrar,
    // la página vuelve a donde estaba al píxel y el foco a la fila, sin mover
    // nada.
    return congelarFondo(origen)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al montar, a propósito
  }, [])

  // Y entra en el historial: el botón atrás del móvil la cierra igual que
  // «Cancelar». Al desmontarse sale, la haya cerrado quien la haya cerrado.
  useEffect(() => entrar(() => cerrar.current()), [])

  /*
   * Tirar de la hoja hacia abajo la cierra.
   *
   * La hoja lleva arriba un asa —la rayita gris—, y un asa se agarra: es el
   * gesto que cualquiera hace en un teléfono para quitar de en medio algo que ha
   * subido desde abajo. Estuvo pintada sin que detrás hubiera nada, y eso es
   * peor que no ponerla: se tiraba, la hoja no se movía, y había que bajar a
   * buscar «Cerrar» al final de una hoja que no cabe en la pantalla.
   *
   * CUÁNDO es arrastrar y cuándo es desplazar. La hoja desplaza su propio
   * contenido cuando no cabe, y el mismo dedo hace las dos cosas. Se arrastra
   * solo si el gesto empieza con la hoja ARRIBA DEL TODO y va hacia abajo: con
   * el contenido desplazado, tirar hacia abajo es volver a subirlo, como en
   * cualquier lista. Tampoco si empieza en un campo —ahí se está colocando el
   * cursor—, ni si va más de lado que hacia abajo, que es deslizar un carril.
   *
   * CUÁNDO se cierra al soltar. Si se ha bajado un trozo de verdad —un tercio
   * de la hoja, o 140 px— o si ha sido un tirón rápido. Si no, vuelve a su
   * sitio: un roce al desplazar no puede cerrarla.
   *
   * Y cuando la hoja NO se deja cerrar tocando fuera (`cierrePorFondo` a falso:
   * hay algo tecleado dentro), tampoco se cierra tirando. Se mueve un poco,
   * con resistencia, y vuelve: dice «te he entendido, pero aquí hay algo sin
   * guardar», que es mejor que no responder y mucho mejor que tirar lo escrito.
   *
   * Con oyentes nativos y no con los de React: `touchmove` tiene que poder
   * llamar a `preventDefault()` para que el navegador no desplace a la vez, y
   * React los registra pasivos. El `transform` se escribe directo en el nodo,
   * sin estado: son sesenta escrituras por segundo siguiendo un dedo.
   *
   * Solo en estrecho, que es donde la hoja está anclada abajo. Centrada en una
   * pantalla ancha es un cuadro, y un cuadro no se arrastra.
   */
  const velo = useRef<HTMLDivElement>(null)
  const seDejaCerrar = useRef(cierrePorFondo)
  seDejaCerrar.current = cierrePorFondo

  useEffect(() => {
    const hoja = panel.current
    if (!hoja) return

    let x0 = 0
    let y0 = 0
    let dy = 0
    /* Por dónde iba el dedo en el último décimo de segundo. La velocidad que
       cuenta es la del FINAL del gesto: quien apoya el dedo, se lo piensa y da
       el tirón ha ido despacio de media y rápido al soltar, y es un tirón. */
    let rastro: Array<{ y: number; t: number }> = []
    let pendiente = false
    let arrastrando = false
    let cierre: number | undefined

    const alTocar = (e: TouchEvent): void => {
      pendiente = false
      if (e.touches.length !== 1 || window.matchMedia('(min-width: 640px)').matches) return
      const en = e.target instanceof Element ? e.target : null
      if (!en || en.closest('input, textarea, select')) return
      // Ni la hoja ni nada de lo que lleve dentro puede estar desplazado.
      for (let n: Element | null = en; n && hoja.contains(n); n = n.parentElement) {
        if (n.scrollTop > 0) return
      }
      const dedo = e.touches[0]!
      x0 = dedo.clientX
      y0 = dedo.clientY
      rastro = [{ y: y0, t: e.timeStamp }]
      dy = 0
      pendiente = true
      arrastrando = false
    }

    const alMover = (e: TouchEvent): void => {
      if (!pendiente) return
      const dedo = e.touches[0]!
      dy = dedo.clientY - y0
      rastro.push({ y: dedo.clientY, t: e.timeStamp })
      while (rastro.length > 2 && e.timeStamp - rastro[0]!.t > 100) rastro.shift()
      if (!arrastrando) {
        const dx = Math.abs(dedo.clientX - x0)
        // Hacia arriba o de lado: no es esto.
        if (dy < -6 || dx > Math.max(8, dy)) {
          pendiente = false
          return
        }
        /*
         * Desde el primer milímetro hacia abajo se le quita el gesto al
         * navegador, aunque la hoja no empiece a moverse hasta los 8 px.
         *
         * Es por Safari de iOS: si en los primeros `touchmove` no se dice que
         * no, él empieza SU desplazamiento —con la hoja arriba del todo, el
         * rebote elástico—, y una vez empezado ya no se puede cancelar: los
         * `touchmove` siguientes llegan con `cancelable` a falso y el contenido
         * rebota por dentro a la vez que la hoja baja.
         */
        if (dy > 0 && e.cancelable) e.preventDefault()
        if (dy < 8) return
        arrastrando = true
        // La animación de entrada escribe `transform`: mientras siga puesta, el
        // nuestro no se vería.
        hoja.style.animation = 'none'
        hoja.style.transition = 'none'
      }
      if (e.cancelable) e.preventDefault()
      const baja = Math.max(0, dy)
      hoja.style.transform = `translateY(${seDejaCerrar.current ? baja : baja * 0.2}px)`
      if (velo.current && seDejaCerrar.current) {
        velo.current.style.opacity = String(Math.max(0.25, 1 - baja / (hoja.offsetHeight || 1)))
      }
    }

    const alSoltar = (e: TouchEvent): void => {
      if (!pendiente) return
      pendiente = false
      if (!arrastrando) return
      arrastrando = false

      const primero = rastro[0]!
      const ultimo = rastro[rastro.length - 1]!
      const velocidad = (ultimo.y - primero.y) / Math.max(1, ultimo.t - primero.t)
      const seCierra =
        e.type === 'touchend' &&
        seDejaCerrar.current &&
        (dy > Math.min(140, hoja.offsetHeight / 3) || (velocidad > 0.5 && dy > 40))

      hoja.style.transition = 'transform 220ms var(--ease-drawer)'
      if (seCierra) {
        hoja.style.transform = 'translateY(100%)'
        if (velo.current) {
          velo.current.style.transition = 'opacity 220ms var(--ease-out)'
          velo.current.style.opacity = '0'
        }
        // Se desmonta cuando ha terminado de bajar, no antes: quitarla a
        // media caída se ve como un corte.
        cierre = window.setTimeout(() => cerrar.current(), 200)
      } else {
        hoja.style.transform = ''
        if (velo.current) velo.current.style.opacity = ''
      }
    }

    hoja.addEventListener('touchstart', alTocar, { passive: true })
    hoja.addEventListener('touchmove', alMover, { passive: false })
    hoja.addEventListener('touchend', alSoltar)
    hoja.addEventListener('touchcancel', alSoltar)
    return () => {
      window.clearTimeout(cierre)
      hoja.removeEventListener('touchstart', alTocar)
      hoja.removeEventListener('touchmove', alMover)
      hoja.removeEventListener('touchend', alSoltar)
      hoja.removeEventListener('touchcancel', alSoltar)
    }
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
      /*
       * «Intro» en un campo de la hoja pulsa su botón principal.
       *
       * Los formularios que viven en una hoja —añadir una sala, renombrar— no
       * son `<form>`: son campos sueltos y un botón, así que «Intro» no hacía
       * nada y con un teclado delante había que soltarlo para ir a por el botón.
       * El botón se señala con `data-principal`, a mano y uno por formulario:
       * adivinarlo por el color acabaría pulsando lo que no es el día que una
       * hoja tenga dos teclas de acento.
       *
       * Solo en campos de una línea y fuera de un `<form>` de verdad, que ya
       * sabe enviarse solo. Si el botón está deshabilitado —falta un dato—, no
       * pasa nada, que es lo mismo que pasa al pulsarlo.
       */
      if (e.key === 'Enter' && !e.defaultPrevented && !e.isComposing) {
        const campo = e.target
        const raiz = panel.current
        if (
          raiz &&
          campo instanceof HTMLInputElement &&
          raiz.contains(campo) &&
          !campo.form &&
          !['checkbox', 'radio', 'file', 'button', 'submit'].includes(campo.type)
        ) {
          const principal = raiz.querySelector<HTMLButtonElement>(
            'button[data-principal]:not([disabled])',
          )
          if (principal) {
            e.preventDefault()
            principal.click()
          }
        }
        return
      }

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
      /* En un teléfono la hoja sube desde abajo, que es donde está el pulgar.
         En una pantalla ancha —un iPad apaisado, un portátil— una tira pegada
         al borde inferior de lado a lado obliga a cruzar la pantalla entera para
         leer una línea: ahí se centra y se queda en el ancho de un formulario. */
      className="fixed inset-0 z-40 flex flex-col justify-end sm:items-center sm:justify-center sm:p-6"
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
        ref={velo}
        aria-hidden
        className={`absolute inset-0 bg-black/45 ${cierrePorFondo ? 'cursor-pointer' : ''}`}
        style={{ animation: 'funde 200ms var(--ease-out)' }}
        onClick={cierrePorFondo ? onCerrar : undefined}
      />

      <div
        ref={panel}
        tabIndex={-1}
        className="hueco-del-teclado relative max-h-[88vh] w-full overflow-y-auto overscroll-contain rounded-t-[1.5rem] bg-surface px-4 pt-2 shadow-float sm:max-h-[90vh] sm:max-w-lg sm:rounded-[1.5rem] sm:pt-4"
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
        {/* El asa. Es la señal que todo el mundo lee como «esto es una hoja que
            ha subido, y se puede bajar» —y se puede: tirar de la hoja hacia
            abajo la cierra, lo cuenta el efecto de arriba—. No hace falta
            acertar en la rayita: vale tirar de cualquier parte de la hoja que no
            sea un campo. Solo en estrecho: centrada en una pantalla ancha ya no
            es una hoja, es un cuadro. */}
        <div aria-hidden className="mx-auto mb-3 h-1 w-9 rounded-full bg-line sm:hidden" />

        <div className="pb-1">
          <p className="truncate text-lg font-semibold tracking-tight">{titulo}</p>
          {subtitulo && <p className="truncate text-sm text-muted">{subtitulo}</p>}
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
                    className={`key flex min-h-touch w-full items-center gap-3 px-4 py-2.5 text-left text-[0.9375rem] ${
                      critica ? 'key-crit' : 'key-quiet'
                    }`}
                  >
                    {a.icono && (
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${
                          critica ? 'bg-black/15' : 'bg-accent-tint text-accent'
                        }`}
                      >
                        <Icono nombre={a.icono} lado={20} />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block">{a.etiqueta}</span>
                      {a.descripcion && (
                        <span
                          className={`mt-0.5 block text-xs font-normal leading-snug ${
                            critica ? 'text-crit-ink opacity-80' : 'text-muted'
                          }`}
                        >
                          {a.descripcion}
                        </span>
                      )}
                    </span>
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
