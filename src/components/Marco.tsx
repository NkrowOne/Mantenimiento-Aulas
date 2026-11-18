/**
 * El marco de la aplicación: cabecera arriba, barra abajo, y en medio lo único
 * que se desplaza.
 *
 * La barra de pestañas era `fixed bottom-0` sobre un documento que desplazaba
 * entero, y en el iPhone eso no es de fiar. En WebKit lo `fixed` se coloca
 * contra el viewport de maquetación, no contra lo que se ve, y el teclado los
 * separa: al bajar tienen que volver a juntarse y en iOS 26 a veces no lo hacen
 * —WebKit 297779, «un fallo de un componente del sistema» según Apple—. Todo lo
 * `fixed` y lo `sticky` se queda varado hasta reiniciar la aplicación: la barra
 * a media pantalla con contenido por debajo.
 *
 * Aquí la cabecera y la barra no son ni `fixed` ni `sticky`: son el primer y el
 * último hijo de una columna del alto de la pantalla, y lo que desplaza es el
 * `<main>` de en medio. Su sitio lo decide la maquetación normal, que ese fallo
 * no toca. Es como lo hace Ionic, justo por esto.
 *
 * Mientras el marco está montado, el documento no desplaza (`html.marco`, en
 * index.css). Antes —en el candado, en la carga— sí, que ahí hay formularios
 * que en un teléfono pequeño con el teclado arriba necesitan bajar.
 *
 * La RANURA DEL PIE es para la barra de acción de la revisión, que tiene el
 * mismo problema que la de pestañas y ocupa su mismo sitio: se pinta ahí con un
 * portal en vez de ser `fixed`.
 */

import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { CLASE_MARCO, ID_CONTENIDO } from '@/lib/viewport'

/** El hueco de debajo del contenido, para quien necesite una barra ahí. */
export const RanuraDelPie = createContext<HTMLElement | null>(null)

/**
 * Pinta lo de dentro en la ranura del pie: debajo del contenido, donde va la
 * barra de pestañas, y sin ser `fixed`.
 *
 * Fuera de un marco —no pasa en la aplicación— se queda donde está, al final
 * del contenido: mejor ahí que flotando.
 */
export function AlPie({ children }: { children: React.ReactNode }): React.ReactElement {
  const ranura = useContext(RanuraDelPie)
  return ranura ? createPortal(children, ranura) : <>{children}</>
}

/** Lleva el contenido arriba del todo, como una pantalla nueva. */
export function subirArriba(): void {
  document.getElementById(ID_CONTENIDO)?.scrollTo({ top: 0 })
}

interface Props {
  /**
   * El menú lateral de las pantallas anchas. Se pinta a la izquierda de todo lo
   * demás, a la altura entera de la pantalla; en estrecho se esconde él solo
   * (`hidden lg:flex`) y la navegación es la barra del `pie`.
   */
  lateral?: React.ReactNode
  cabecera: React.ReactNode
  /** La barra de pestañas, o nada cuando la pantalla trae la suya. */
  pie: React.ReactNode
  /** Capas `fixed` que van por encima de todo: el escáner, el aviso de versión. */
  capas?: React.ReactNode
  /**
   * Qué pantalla es la que se está viendo. Cuando cambia, el contenido se
   * vuelve a montar dentro de un envoltorio nuevo y entra con la animación de
   * `.pantalla`. Quien la pasa decide qué cuenta como «otra pantalla».
   */
  claveDePantalla?: string
  /**
   * Avisos de la aplicación que van encima de la pantalla y NO son parte de
   * ella: el de un escaneo que no sirvió, el del rol que no se pudo leer. Van
   * fuera del envoltorio con clave, así que no se desmontan ni vuelven a
   * entrar animados cada vez que se cambia de pantalla —y el diagnóstico que
   * alguien haya desplegado dentro de uno sigue desplegado—.
   */
  avisos?: React.ReactNode
  /**
   * En qué sitio se está, para recordar por dónde iba el desplazamiento de
   * cada uno: `salas-<edificio>`, `ficha-<sala>`, `incidencias`… Más fino que
   * `claveDePantalla`: dos aulas distintas son la misma pantalla y dos sitios.
   * Lo explica `useMemoriaDeDesplazamiento`, más abajo.
   */
  sitio?: string
  children: React.ReactNode
}

/** Cuántos sitios se recuerdan. De sobra: el camino más largo de la aplicación
    —inicio, edificio, ficha, revisión, ficha, hoja— son seis. */
const SITIOS_RECORDADOS = 16

/**
 * Cada sitio recuerda por dónde iba, y al volver a él se vuelve AHÍ.
 *
 * Lo que desplaza es el `<main>` del marco, que no se desmonta nunca: solo
 * cambia lo que lleva dentro. Así que el desplazamiento no era de ninguna
 * pantalla, era del marco, y pasaban dos cosas igual de molestas:
 *
 *  - HACIA DENTRO. Se bajaba por la lista hasta el aula veinticinco, se tocaba,
 *    y la ficha se abría ya desplazada ochocientos píxeles: se entraba por la
 *    mitad, con la placa y «Revisar esta sala» fuera de la pantalla. Lo mismo
 *    al encadenar aulas con «Guardar y siguiente sala»: la siguiente empezaba
 *    por donde se había dejado la anterior, o sea por el final.
 *  - HACIA FUERA. Al volver de la ficha, la lista estaba donde la hubiera
 *    dejado la FICHA, no donde se dejó la lista: había que volver a buscar el
 *    aula veinticinco para seguir con la veintiséis. En un edificio de treinta
 *    y nueve salas eso es un barrido de pulgar por aula.
 *
 * La regla es la de cualquier navegador y la de cualquier aplicación de
 * teléfono: un sitio NUEVO empieza por arriba; uno al que se VUELVE, donde se
 * dejó. Para saber cuál es cuál se lleva una pila de por dónde se ha pasado: si
 * el sitio ya está en la pila, es una vuelta —se restaura y se olvida lo que
 * había por encima—; si no, es nuevo y se apila.
 *
 * Vale también entre pestañas, que es como se comporta la barra de un teléfono:
 * mirar el Almacén a media lista de Incidencias y volver no pierde el sitio.
 *
 * LA ESPERA. Al volver, la pantalla se monta vacía y se llena un instante
 * después —lo que tarda Dexie, o una consulta en caché—, así que en el primer
 * fotograma todavía no hay ochocientos píxeles a los que bajar. Se insiste
 * unos fotogramas hasta que el contenido da de sí, y se deja de insistir en
 * cuanto la persona toca la pantalla: a partir de ahí manda ella.
 */
function useMemoriaDeDesplazamiento(
  sitio: string | undefined,
): (nodo: HTMLElement | null) => void {
  const main = useRef<HTMLElement | null>(null)
  const pila = useRef<Array<{ sitio: string; top: number }>>([])

  useLayoutEffect(() => {
    const el = main.current
    if (!el || sitio === undefined) return

    const visto = pila.current.findIndex((e) => e.sitio === sitio)
    // El mismo sitio que ya estaba arriba: un repintado, no un viaje.
    if (visto !== -1 && visto === pila.current.length - 1) return

    let destino = 0
    if (visto !== -1) {
      destino = pila.current[visto]!.top
      pila.current.length = visto + 1
    } else {
      pila.current.push({ sitio, top: 0 })
      if (pila.current.length > SITIOS_RECORDADOS) pila.current.shift()
    }

    el.scrollTop = destino
    if (destino === 0) return

    // Hasta medio segundo, o hasta que llegue, o hasta que alguien toque.
    let intentos = 0
    const insistir = window.setInterval(() => {
      if (Math.abs(el.scrollTop - destino) <= 1 || ++intentos > 16) soltar()
      else el.scrollTop = destino
    }, 30)
    const soltar = (): void => {
      window.clearInterval(insistir)
      el.removeEventListener('touchstart', soltar)
      el.removeEventListener('wheel', soltar)
      el.removeEventListener('keydown', soltar)
    }
    el.addEventListener('touchstart', soltar, { passive: true })
    el.addEventListener('wheel', soltar, { passive: true })
    el.addEventListener('keydown', soltar)
    return soltar
  }, [sitio])

  /*
   * El oyente de desplazamiento, colgado UNA vez.
   *
   * Va en un `ref` de función porque el `<main>` existe desde el primer render
   * y no cambia nunca. Y la función va en `useCallback` por algo que no se ve
   * leyéndola: si fuera una función nueva en cada render, React llamaría a la
   * vieja con `null` y a la nueva con el nodo CADA VEZ que el marco se repinta,
   * y cada una de esas veces colgaría otro oyente sin quitar el anterior. En un
   * teléfono que se pasa la mañana abierto eso son cientos de oyentes
   * respondiendo a cada píxel de desplazamiento. Estable, se llama al montar y
   * al desmontar, y el oyente se quita al irse.
   */
  const alDesplazar = useRef<(() => void) | null>(null)
  return useCallback((nodo: HTMLElement | null) => {
    if (main.current && alDesplazar.current) {
      main.current.removeEventListener('scroll', alDesplazar.current)
    }
    main.current = nodo
    alDesplazar.current = null
    if (!nodo) return
    alDesplazar.current = () => {
      const arriba = pila.current.at(-1)
      if (arriba) arriba.top = nodo.scrollTop
    }
    nodo.addEventListener('scroll', alDesplazar.current, { passive: true })
  }, [])
}

export function Marco({
  lateral,
  cabecera,
  pie,
  capas,
  claveDePantalla,
  avisos,
  sitio,
  children,
}: Props): React.ReactElement {
  const [ranura, setRanura] = useState<HTMLDivElement | null>(null)
  const recordar = useMemoriaDeDesplazamiento(sitio)

  // Antes de pintar: con un fotograma de documento desplazable debajo de una
  // columna de alto fijo, la barra saldría un instante donde no es.
  useLayoutEffect(() => {
    document.documentElement.classList.add(CLASE_MARCO)
    return () => document.documentElement.classList.remove(CLASE_MARCO)
  }, [])

  return (
    /*
     * Una fila con dos piezas: el menú lateral —que en estrecho no existe— y la
     * columna de siempre. La columna lleva `min-w-0` por lo mismo que el
     * `<main>` lleva `min-h-0`: un hijo de flex no encoge por debajo de su
     * contenido, y una tabla ancha dentro empujaría la columna fuera de la
     * pantalla en vez de desplazar dentro de su carril.
     */
    <div className="marco-fila flex h-full">
      {lateral}
    <div className="marco-columna flex h-full min-w-0 flex-1 flex-col">
      {cabecera}
      {/*
       * `min-h-0`: un hijo de flex no encoge por debajo de su contenido sin
       * esto, y el `<main>` crecería hasta empujar la barra fuera de la
       * pantalla en vez de desplazar.
       *
       * `overscroll-y-none`: ni rebote ni arrastre del documento de detrás, lo
       * mismo que ya pedía `html` cuando el que desplazaba era él.
       *
       * `relative`: para que lo `absolute` de dentro sea SUYO. Sin esto, un
       * `sr-only` —que es `position: absolute`— al final de una pantalla larga
       * no se recortaba aquí ni se desplazaba con el contenido: colgaba del
       * documento, a tres mil píxeles de arriba, y lo hacía tres mil píxeles
       * de alto por detrás del marco. `overflow: hidden` impide desplazarlo
       * con el dedo, pero no a iOS ni a un `focus()`: el documento se iba
       * hacia arriba y la barra de pestañas quedaba a media pantalla con un
       * vacío debajo. Se vio en el Almacén, con el aviso oculto de «Ver y
       * exportar». Lo vigila `src/marco.test.ts`.
       */}
      <main
        ref={recordar}
        id={ID_CONTENIDO}
        className="marco-contenido hueco-del-teclado relative min-h-0 flex-1 overflow-y-auto overscroll-y-none"
      >
        <RanuraDelPie.Provider value={ranura}>
          {/*
           * El ancho máximo es para las pantallas grandes: en un monitor, una
           * lista estirada a 1.600 px deja el nombre a la izquierda y su dato a
           * medio metro. Centrado a 72rem se lee como en un iPad apaisado, que
           * es para lo que están pensadas las pantallas. En un teléfono no
           * hace nada.
           *
           * La animación de entrada mueve el envoltorio con `transform`, y un
           * `transform` convierte a su elemento en el bloque contenedor de lo
           * `fixed` que tenga dentro —las hojas se anclarían a él y no a la
           * pantalla—. No pasa nada porque dura 160ms y no deja nada puesto al
           * terminar: ninguna hoja se abre en el primer sexto de segundo de
           * una pantalla.
           */}
          {avisos && <div className="marco-ancho mx-auto w-full max-w-6xl">{avisos}</div>}
          <div key={claveDePantalla} className="marco-ancho pantalla mx-auto w-full max-w-6xl">
            {children}
          </div>
        </RanuraDelPie.Provider>
      </main>
      <div ref={setRanura} className="flex-none empty:hidden" />
      {pie}
    </div>
      {capas}
    </div>
  )
}
