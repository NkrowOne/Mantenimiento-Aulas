import { useMemo } from 'react'
import { monogramaDeEdificio, type LetraDeMonograma } from '@/domain/monograma'

/**
 * La chapa de un edificio, dibujada.
 *
 * Qué lleva cada edificio lo decide `domain/monograma.ts`, a partir de su sigla
 * y su nombre; aquí solo se pinta. Es un SVG y no texto con clases porque lo que
 * varía —la inclinación, el refuerzo del trazo, un arco que asoma por la
 * esquina— son cosas de dibujo, y en un lienzo de 48×48 son cuatro atributos.
 *
 * Los colores no están aquí: salen de `--m-*`, que `index.css` define para cada
 * tinta con los colores de la aplicación. Así la chapa cambia con el tema claro
 * y el oscuro sin que este fichero lo sepa.
 *
 * Sin fuentes nuevas. La inclinada es la recta sesgada catorce grados —un sesgo
 * de rótulo, no una cursiva— y la pesada, la negrita con un trazo de su mismo
 * color. Con la tipografía que la aplicación ya baja salen las tres, y no hay
 * nada más que cargar ni que tener en caché para verlas sin cobertura.
 */

const SANS = '"Instrument Sans Variable", system-ui, -apple-system, sans-serif'

interface Trazo {
  /** Lo que mide de ancho una letra, en cuerpos: para saber si el código cabe. */
  ancho: number
  /** Separación entre letras, en cuerpos. */
  tracking: number
  /** Grados de sesgo. */
  sesgo: number
  /** Trazo añadido del color de la letra, para engordarla. */
  refuerzo: number
}

const TRAZOS: Record<LetraDeMonograma, Trazo> = {
  recta: { ancho: 0.66, tracking: -0.01, sesgo: 0, refuerzo: 0 },
  inclinada: { ancho: 0.74, tracking: -0.01, sesgo: -14, refuerzo: 0 },
  pesada: { ancho: 0.78, tracking: 0.05, sesgo: 0, refuerzo: 1.1 },
}

/** El cuerpo de la letra según cuántas hay: la chapa mide siempre lo mismo. */
const CUERPOS = [27, 22, 17, 13.5, 11]

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
  const px = CUERPOS[Math.min(m.texto.length, CUERPOS.length) - 1] ?? 11

  // La franja ocupa los seis primeros puntos y la base los siete últimos: la
  // letra se centra en lo que queda libre, no en la chapa entera.
  const cx = m.detalle === 'franja' ? 27 : 24
  const cy = m.detalle === 'base' ? 21 : 24

  /*
   * Si el código no cabe a su cuerpo, se encaja a la fuerza en el ancho que hay
   * (`textLength`). Es la red de seguridad para una sigla más larga de lo
   * previsto: se estrecha, pero no se sale de la chapa ni se corta.
   */
  const hueco = m.detalle === 'franja' ? 35 : 39
  const mide = m.texto.length * px * (trazo.ancho + trazo.tracking)
  const encaje = mide > hueco ? { textLength: hueco, lengthAdjust: 'spacingAndGlyphs' as const } : {}

  // La línea de base para que una mayúscula quede centrada en `cy`.
  const y = cy + px * 0.355

  return (
    // El envoltorio es el que redondea y pone el canto. Redondear el propio
    // `<svg>` no recorta igual en todos los navegadores, y un `span` sí.
    <span data-tinta={m.tinta} className={`monograma ${className}`} style={{ width: lado, height: lado }}>
      <svg width={lado} height={lado} viewBox="0 0 48 48" role="img" aria-label={code}>
        <rect width="48" height="48" fill="var(--m-bg)" />

        {/* El detalle: uno solo. El arco queda detrás de la letra y va en la
            tinta suave; la franja y la base no la tocan y van en la fuerte. */}
        {m.detalle === 'arco' && <circle cx="48" cy="48" r="29" fill="var(--m-suave)" />}
        {m.detalle === 'franja' && <rect width="6" height="48" fill="var(--m-fuerte)" />}
        {m.detalle === 'base' && <rect y="41" width="48" height="7" fill="var(--m-fuerte)" />}

        <text
          x={cx}
          y={y}
          textAnchor="middle"
          // El sesgo se aplica alrededor del centro de la letra, para que
          // inclinarla no la mueva de sitio.
          transform={trazo.sesgo ? `translate(${cx} ${cy}) skewX(${trazo.sesgo}) translate(${-cx} ${-cy})` : undefined}
          style={{
            fontFamily: SANS,
            fontWeight: 700,
            fontSize: px,
            letterSpacing: `${trazo.tracking}em`,
            fill: 'var(--m-fg)',
            stroke: trazo.refuerzo ? 'var(--m-fg)' : 'none',
            strokeWidth: trazo.refuerzo * (px / 22),
            strokeLinejoin: 'round',
            paintOrder: 'stroke',
          }}
          {...encaje}
        >
          {m.texto}
        </text>
      </svg>
    </span>
  )
}
