import { Icono } from '@/components/Icono'

/**
 * «Volver», igual en todas las pantallas.
 *
 * Había cinco: tres en monoespaciada, versalitas y con la flecha tecleada
 * («← VOLVER»), una como tecla gris y otra como enlace de texto. Hacían lo
 * mismo y no se parecían, así que en cada pantalla había que buscar la salida
 * otra vez. Ahora es una sola pieza: la flecha dibujada, la palabra en la letra
 * de la interfaz, el color de la marca y 44 px de alto para el dedo.
 *
 * El margen negativo alinea la FLECHA con el borde del contenido, no el área de
 * toque: la caja pulsable sobresale diez píxeles hacia la izquierda, que es
 * espacio que nadie ve y que el pulgar agradece.
 *
 * `texto` es a dónde se vuelve cuando decirlo ayuda («Edificios», «Acciones»).
 * Es también el nombre accesible del botón: la flecha es decorativa.
 */
export function BotonVolver({
  onClick,
  texto = 'Volver',
  className = '',
  ref,
}: {
  onClick: () => void
  texto?: string
  className?: string
  ref?: React.Ref<HTMLButtonElement>
}): React.ReactElement {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={`key-ghost -ml-2.5 inline-flex min-h-11 items-center gap-1.5 px-2.5 text-sm ${className}`}
    >
      <Icono nombre="atras" lado={18} />
      {texto}
    </button>
  )
}
