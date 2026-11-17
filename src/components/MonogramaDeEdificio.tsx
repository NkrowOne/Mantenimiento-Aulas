import { useMemo } from 'react'
import {
  monogramaDeEdificio,
  type ComposicionDeMonograma,
  type LetraDeMonograma,
} from '@/domain/monograma'

/**
 * La chapa de un edificio, dibujada.
 *
 * Qué lleva cada edificio lo decide `domain/monograma.ts`, a partir de su sigla
 * y su nombre; aquí solo se pinta. Es un SVG y no texto con clases porque lo que
 * varía —la inclinación, el contorno, una letra a sangre que se sale por abajo,
 * un rótulo en vertical— son cosas de dibujo: en HTML cada una sería un apaño
 * distinto, y en un lienzo de 48×48 son cuatro atributos.
 *
 * Los colores no están aquí: salen de `--m-*`, que `index.css` define para cada
 * tinta con los colores de la aplicación. Así la chapa cambia con el tema claro
 * y el oscuro sin que este fichero lo sepa.
 *
 * Sin fuentes nuevas. La inclinada es la recta sesgada catorce grados —un
 * sesgo de rótulo, no una cursiva—; la estrecha, la recta comprimida; la
 * pesada, la negrita con un trazo de su mismo color. Con las dos tipografías que
 * la aplicación ya baja salen las siete letras, y no hay nada más que cargar ni
 * que tener en caché para verlas sin cobertura.
 */

const SANS = '"Instrument Sans Variable", system-ui, -apple-system, sans-serif'
const MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace'

interface Trazo {
  familia: string
  peso: number
  /** Lo que mide de ancho una letra, en cuerpos: para saber si el código cabe. */
  ancho: number
  /** Separación entre letras, en cuerpos. */
  tracking: number
  /** La transformación propia de la letra, alrededor de su centro. */
  forma?: string
  contorno?: boolean
  refuerzo?: number
}

const TRAZOS: Record<LetraDeMonograma, Trazo> = {
  recta: { familia: SANS, peso: 700, ancho: 0.66, tracking: -0.01 },
  inclinada: { familia: SANS, peso: 700, ancho: 0.74, tracking: -0.01, forma: 'skewX(-14)' },
  mono: { familia: MONO, peso: 600, ancho: 0.6, tracking: 0 },
  contorno: { familia: SANS, peso: 700, ancho: 0.7, tracking: 0.02, contorno: true },
  fina: { familia: SANS, peso: 400, ancho: 0.7, tracking: 0.07 },
  pesada: { familia: SANS, peso: 700, ancho: 0.78, tracking: 0.05, refuerzo: 1.1 },
  estrecha: { familia: SANS, peso: 700, ancho: 0.5, tracking: 0, forma: 'scale(0.74 1.22)' },
}

/** El cuerpo de la letra para cada composición, según cuántas letras hay. */
function cuerpo(composicion: ComposicionDeMonograma, largo: number): number {
  const porLargo = (tabla: number[]): number => tabla[Math.min(largo, tabla.length) - 1] ?? 10
  switch (composicion) {
    case 'sangre':
      return porLargo([40, 30])
    case 'esquina':
      return porLargo([27, 21, 15.5])
    case 'apilada':
      // `largo` es el del renglón más largo.
      return porLargo([20, 19, 14, 11])
    case 'vertical':
      return porLargo([26, 22, 17, 13.5, 11])
    default:
      return porLargo([27, 22, 17, 13.5, 11])
  }
}

export function MonogramaDeEdificio({
  code,
  name,
  lado = 44,
  className = '',
}: {
  code: string
  name?: string | null
  /** El lado de la chapa, en píxeles. */
  lado?: number
  className?: string
}): React.ReactElement {
  const m = useMemo(() => monogramaDeEdificio(code, name), [code, name])
  const trazo = TRAZOS[m.letra]
  const largo = Math.max(...m.lineas.map((l) => l.length))
  const px = cuerpo(m.composicion, largo)

  // La franja ocupa los seis primeros puntos: lo demás se corre para no pisarla.
  const margen = m.fondo === 'franja' ? 4 : 0
  const cx = 24 + margen / 2

  /*
   * Si el código no cabe a su cuerpo, se encaja a la fuerza en el ancho que hay
   * (`textLength`). Es la red de seguridad para una sigla más larga de lo
   * previsto: se estrecha, pero no se sale de la chapa ni se corta.
   */
  const hueco = (m.composicion === 'sangre' ? 46 : m.composicion === 'esquina' ? 37 : 39) - margen
  const encajar = (texto: string): { textLength?: number; lengthAdjust?: 'spacingAndGlyphs' } => {
    const mide = texto.length * px * (trazo.ancho + trazo.tracking)
    return mide > hueco && m.letra !== 'estrecha'
      ? { textLength: hueco, lengthAdjust: 'spacingAndGlyphs' }
      : {}
  }

  const estilo: React.CSSProperties = {
    fontFamily: trazo.familia,
    fontWeight: trazo.peso,
    fontSize: px,
    letterSpacing: `${trazo.tracking}em`,
    fill: trazo.contorno ? 'none' : 'var(--m-fg)',
    stroke: trazo.contorno || trazo.refuerzo ? 'var(--m-fg)' : 'none',
    strokeWidth: trazo.contorno ? Math.max(1.1, px / 16) : (trazo.refuerzo ?? 0) * (px / 22),
    strokeLinejoin: 'round',
    paintOrder: 'stroke',
  }

  /** Un renglón, colocado con su ancla y su línea de base. */
  const renglon = (
    texto: string,
    x: number,
    y: number,
    ancla: 'start' | 'middle',
    clave: number,
  ): React.ReactElement => {
    // La forma propia de la letra se aplica alrededor del punto donde se apoya,
    // para que inclinarla o estrecharla no la mueva de sitio.
    const centroX = ancla === 'middle' ? x : x + (texto.length * px * trazo.ancho) / 2
    const forma = trazo.forma
      ? `translate(${centroX} ${y}) ${trazo.forma} translate(${-centroX} ${-y})`
      : undefined
    return (
      <text key={clave} x={x} y={y} textAnchor={ancla} transform={forma} style={estilo} {...encajar(texto)}>
        {texto}
      </text>
    )
  }

  // Dónde cae la línea de base para que una mayúscula quede centrada en `y`.
  const centrada = (y: number): number => y + px * 0.355

  let letras: React.ReactNode
  if (m.composicion === 'apilada') {
    const [arriba = '', abajo = ''] = m.lineas
    const salto = px * 1.02
    const primera = 24 - salto / 2
    letras = (
      <>
        {renglon(arriba, cx, centrada(primera), 'middle', 0)}
        {renglon(abajo, cx, centrada(primera + salto), 'middle', 1)}
      </>
    )
  } else if (m.composicion === 'vertical') {
    letras = <g transform={`rotate(-90 ${cx} 24)`}>{renglon(m.lineas[0] ?? '', cx, centrada(24), 'middle', 0)}</g>
  } else if (m.composicion === 'esquina') {
    letras = renglon(m.lineas[0] ?? '', 6 + margen, 41, 'start', 0)
  } else if (m.composicion === 'sangre') {
    // Grande y apoyada por debajo del borde: la chapa la recorta un poco.
    letras = renglon(m.lineas[0] ?? '', cx, 24 + px * 0.47, 'middle', 0)
  } else {
    letras = renglon(m.lineas[0] ?? '', cx, centrada(m.fondo === 'base' ? 22 : 24), 'middle', 0)
  }

  return (
    // El envoltorio es el que redondea y pone el canto. Redondear el propio
    // `<svg>` no recorta igual en todos los navegadores, y un `span` sí.
    <span
      data-tinta={m.tinta}
      className={`monograma ${className}`}
      style={{ width: lado, height: lado }}
    >
    <svg width={lado} height={lado} viewBox="0 0 48 48" role="img" aria-label={code}>
      <rect width="48" height="48" fill="var(--m-bg)" />

      {/* El fondo. Lo que queda detrás de la letra va en la tinta suave; lo que
          no la toca —la franja, la base—, en la fuerte. */}
      {m.fondo === 'diagonal' && <path d="M48 8V48H8Z" fill="var(--m-suave)" />}
      {m.fondo === 'arco' && <circle cx="48" cy="48" r="30" fill="var(--m-suave)" />}
      {m.fondo === 'disco' && <circle cx="17" cy="17" r="15" fill="var(--m-suave)" />}
      {m.fondo === 'franja' && <rect width="6" height="48" fill="var(--m-fuerte)" />}
      {m.fondo === 'base' && <rect y="41" width="48" height="7" fill="var(--m-fuerte)" />}
      {m.fondo === 'rayas' && (
        <g stroke="var(--m-suave)" strokeWidth="3">
          {[-36, -24, -12, 0, 12, 24, 36].map((d) => (
            <line key={d} x1={d} y1="48" x2={d + 48} y2="0" />
          ))}
        </g>
      )}
      {/* La esquina lleva su punto, arriba a la derecha: equilibra la letra, que
          está abajo a la izquierda. */}
      {m.composicion === 'esquina' && <circle cx="39" cy="9" r="3" fill="var(--m-fuerte)" />}

      {letras}
    </svg>
    </span>
  )
}
