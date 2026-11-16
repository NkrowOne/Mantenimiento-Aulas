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
  children: React.ReactNode
}

export function Marco({
  lateral,
  cabecera,
  pie,
  capas,
  claveDePantalla,
  avisos,
  children,
}: Props): React.ReactElement {
  const [ranura, setRanura] = useState<HTMLDivElement | null>(null)

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
       */}
      <main id={ID_CONTENIDO} className="marco-contenido min-h-0 flex-1 overflow-y-auto overscroll-y-none">
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
