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

import { createContext, useContext, useLayoutEffect, useState } from 'react'
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
  cabecera: React.ReactNode
  /** La barra de pestañas, o nada cuando la pantalla trae la suya. */
  pie: React.ReactNode
  /** Capas `fixed` que van por encima de todo: el escáner, el aviso de versión. */
  capas?: React.ReactNode
  children: React.ReactNode
}

export function Marco({ cabecera, pie, capas, children }: Props): React.ReactElement {
  const [ranura, setRanura] = useState<HTMLDivElement | null>(null)

  // Antes de pintar: con un fotograma de documento desplazable debajo de una
  // columna de alto fijo, la barra saldría un instante donde no es.
  useLayoutEffect(() => {
    document.documentElement.classList.add(CLASE_MARCO)
    return () => document.documentElement.classList.remove(CLASE_MARCO)
  }, [])

  return (
    <div className="marco-columna flex h-full flex-col">
      {cabecera}
      {/*
       * `min-h-0`: un hijo de flex no encoge por debajo de su contenido sin
       * esto, y el `<main>` crecería hasta empujar la barra fuera de la
       * pantalla en vez de desplazar.
       *
       * `overscroll-y-none`: ni rebote ni arrastre del documento de detrás, lo
       * mismo que ya pedía `html` cuando el que desplazaba era él.
       */}
      <main id={ID_CONTENIDO} className="marco-contenido min-h-0 flex-1 overflow-y-auto overscroll-y-none">
        <RanuraDelPie.Provider value={ranura}>{children}</RanuraDelPie.Provider>
      </main>
      <div ref={setRanura} className="flex-none empty:hidden" />
      {pie}
      {capas}
    </div>
  )
}
