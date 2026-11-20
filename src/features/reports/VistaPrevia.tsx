import { type RefObject, useEffect, useRef, useState } from 'react'

/**
 * La vista previa del informe, a escala.
 *
 * El documento está maquetado como una hoja A4: mide lo que mide, y por debajo
 * de ese ancho no se recoloca —es un papel, no una página web—. En un marco
 * más estrecho que la hoja, que es cualquier teléfono, lo que se veía era la
 * esquina de arriba a la izquierda con una barra para moverse de lado: las
 * cuatro cifras de la cabecera no cabían juntas y el informe recién hecho
 * parecía descuadrado, cuando el PDF salía perfecto.
 *
 * Aquí el marco mide siempre lo que la hoja y se encoge entero, como una
 * miniatura: en el teléfono se ve la página completa, igual que se va a ver en
 * el PDF, y se amplía con los dedos si hace falta leer algo. En una pantalla
 * ancha no se toca.
 *
 * Sin `allow-scripts`: el informe no lleva ni una línea de JavaScript y así se
 * queda.
 */

/** Lo que mide la hoja en pantalla: los 178 mm de la caja más sus márgenes, y el gris de alrededor. */
const ANCHO_DE_LA_HOJA = 840

export function VistaPrevia({
  html,
  titulo,
  marco,
}: {
  html: string
  titulo: string
  /** El iframe, para quien tenga que imprimirlo como último recurso. */
  marco: RefObject<HTMLIFrameElement | null>
}): React.ReactElement {
  const caja = useRef<HTMLDivElement>(null)
  const [ancho, setAncho] = useState(0)

  useEffect(() => {
    const el = caja.current
    if (!el) return
    const medir = (): void => setAncho(el.clientWidth)
    medir()
    // Un iPad que gira, una ventana que se estrecha: la escala va detrás.
    if (typeof ResizeObserver === 'undefined') return
    const ojo = new ResizeObserver(medir)
    ojo.observe(el)
    return () => ojo.disconnect()
  }, [])

  const escala = ancho > 0 && ancho < ANCHO_DE_LA_HOJA ? ancho / ANCHO_DE_LA_HOJA : 1

  return (
    <div
      ref={caja}
      className="mt-4 h-[70vh] w-full overflow-hidden rounded-card border border-line bg-white"
    >
      <iframe
        ref={marco}
        title={titulo}
        srcDoc={html}
        sandbox="allow-same-origin allow-modals"
        className="block border-0 bg-white"
        style={
          escala < 1
            ? {
                width: ANCHO_DE_LA_HOJA,
                // Más alto en la misma proporción en que se encoge, para que
                // después de encoger llene la caja y no deje media en blanco.
                height: `${100 / escala}%`,
                transform: `scale(${escala})`,
                transformOrigin: '0 0',
              }
            : { width: '100%', height: '100%' }
        }
      />
    </div>
  )
}
