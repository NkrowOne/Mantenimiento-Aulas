/**
 * Código QR, y de verdad.
 *
 * El prototipo llevaba una marca decorativa —un patrón pseudoaleatorio con tres
 * esquinas dibujadas a mano y un comentario que decía «no pretende ser un QR
 * legible»—. Como maqueta estaba bien: enseñaba dónde va y qué tamaño ocupa.
 * Impreso y atornillado a una puerta, sería una pegatina que no escanea nadie.
 *
 * Aquí se codifica de verdad, y lo que se codifica es el **identificador interno
 * de la sala**, no su nombre ni su matrícula. Es lo que hace que la placa
 * sobreviva a un renombrado: cambiar «1.7 H» por «Aula 1.7» no invalida las
 * etiquetas ya impresas ni rompe el histórico.
 *
 * Sale como SVG y no como `<canvas>` por dos razones que aquí importan: se
 * imprime nítido a cualquier tamaño —que es el punto entero de una placa— y no
 * necesita que el navegador haya pintado nada para existir.
 */

import { matrizQR } from '@/lib/qr'

interface Props {
  /** Lo que se codifica. Para una placa, el UUID de la sala. */
  value: string
  /** Lado en píxeles CSS. El SVG escala solo; esto es solo la caja. */
  size?: number
  /**
   * Módulos de silencio alrededor. La norma pide 4 y no es decorativo: sin
   * margen, un lector no distingue dónde acaba el código y muchos fallan.
   */
  quiet?: number
  /** Texto para lectores de pantalla. Un QR sin esto es una imagen muda. */
  label: string
}

export function QR({ value, size = 96, quiet = 4, label }: Props): React.ReactElement {
  // La matriz vive en `@/lib/qr`, con sus pruebas: es lo que separa un QR de un
  // dibujo que se le parece, y el prototipo llevaba justamente el dibujo.
  const { lado, path } = matrizQR(value, quiet)

  return (
    <svg
      viewBox={`0 0 ${lado} ${lado}`}
      width={size}
      height={size}
      role="img"
      aria-label={label}
      /* `crispEdges` evita que el antialiasing difumine el borde de cada módulo:
         en pantallas pequeñas un QR suavizado pierde lecturas. */
      shapeRendering="crispEdges"
    >
      {/* El fondo va explícito y blanco, no transparente: el contraste entre
          módulo oscuro y claro es lo que lee el escáner, y sobre una superficie
          oscura —o sobre el modo oscuro de la app— un QR transparente se
          invierte y deja de leerse. */}
      <rect width={lado} height={lado} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}
