/**
 * Comprobación de contraste del sistema de color.
 *
 *   npm run check:contrast
 *
 * Lee los tokens directamente de `src/design/tokens.css` —no una copia, el
 * fichero de verdad— y calcula el contraste WCAG de cada pareja que lleva texto,
 * en los dos temas.
 *
 * Existe porque el color es lo único del sistema de diseño que se puede
 * degradar en silencio: nadie escribe una prueba para un tono, y «se ve bien en
 * mi pantalla» es exactamente el criterio que produjo la paleta anterior. Aquí
 * el criterio es un número, y falla la construcción si baja.
 *
 * El umbral es AA (4,5:1), que es el requisito real. Se sube a AAA (7:1) solo
 * para el texto corrido sobre el fondo, donde sale gratis: ahí la paleta va por
 * encima de 13:1 en los dos temas, y bajar de 7 sería señal de que algo se ha
 * roto de verdad.
 */

import { readFile } from 'node:fs/promises'

type Rgb = [number, number, number]

const AA = 4.5
const AAA = 7

/** Luminancia relativa según WCAG 2.1. */
function luminance([r, g, b]: Rgb): number {
  const channel = (v: number): number => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Claridad perceptual CIE L*, de 0 (negro) a 100 (blanco).
 *
 * Para separar superficies hace falta esta y no la razón de contraste. La razón
 * se comprime en los extremos: dos grises casi blancos claramente distintos a
 * la vista dan 1,05:1, y dos negros claramente distintos también. Con L* la
 * misma diferencia perceptual da el mismo número arriba y abajo, que es justo
 * lo que se quiere comprobar en dos temas opuestos.
 */
function lightness(rgb: Rgb): number {
  const y = luminance(rgb)
  return y > 0.008856 ? 116 * y ** (1 / 3) - 16 : 903.3 * y
}

/**
 * Extrae los tokens de un bloque del CSS.
 *
 * El tema claro es el bloque `:root {`; el oscuro, `:root[data-theme='dark'] {`.
 * Se lee el fichero real para que esto no pueda quedarse desincronizado: si
 * alguien cambia un tono y no toca este script, la comprobación se entera.
 */
function parseBlock(css: string, selector: string): Map<string, Rgb> {
  const start = css.indexOf(selector)
  if (start === -1) throw new Error(`No se encontró el bloque "${selector}" en tokens.css`)

  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  const body = css.slice(open + 1, close)

  const tokens = new Map<string, Rgb>()
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*--([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+);/)
    if (m) tokens.set(m[1]!, [Number(m[2]), Number(m[3]), Number(m[4])])
  }
  return tokens
}

/** Las parejas que de verdad se pintan una sobre otra en la interfaz. */
const PAIRS: Array<{ fg: string; bg: string; min: number; what: string }> = [
  { fg: 'ink', bg: 'ground', min: AAA, what: 'texto principal' },
  { fg: 'ink', bg: 'surface', min: AAA, what: 'texto sobre tarjeta' },
  { fg: 'ink-2', bg: 'surface', min: AA, what: 'texto secundario' },
  { fg: 'muted', bg: 'ground', min: AA, what: 'texto atenuado' },
  { fg: 'muted', bg: 'surface', min: AA, what: 'pistas de las comprobaciones' },

  // Las marcas: color sobre el fondo, como texto o como raíl.
  { fg: 'accent', bg: 'ground', min: AA, what: 'marca de acento' },
  { fg: 'accent', bg: 'surface', min: AA, what: 'marca de acento en tarjeta' },
  { fg: 'ok', bg: 'ground', min: AA, what: 'marca correcto' },
  { fg: 'warn', bg: 'ground', min: AA, what: 'marca aviso' },
  { fg: 'crit', bg: 'ground', min: AA, what: 'marca crítico' },

  // Las marcas sobre su propio tinte: es lo que hace una fila teñida.
  { fg: 'accent', bg: 'accent-tint', min: AA, what: 'acento sobre su tinte' },
  { fg: 'ok', bg: 'ok-tint', min: AA, what: 'correcto sobre su tinte' },
  { fg: 'warn', bg: 'warn-tint', min: AA, what: 'aviso sobre su tinte' },
  { fg: 'crit', bg: 'crit-tint', min: AA, what: 'crítico sobre su tinte' },
  { fg: 'na', bg: 'na-tint', min: AA, what: 'no aplica sobre su tinte' },

  // Las teclas: tinta dentro del relleno. Aquí van las etiquetas de 10px de
  // «OK / Falla / N/A», que es el texto más pequeño de la aplicación.
  { fg: 'accent-ink', bg: 'accent-fill', min: AA, what: 'tecla de acento' },
  { fg: 'ok-ink', bg: 'ok-fill', min: AA, what: 'tecla correcto' },
  { fg: 'warn-ink', bg: 'warn-fill', min: AA, what: 'tecla aviso' },
  { fg: 'crit-ink', bg: 'crit-fill', min: AA, what: 'tecla crítico' },
]

/**
 * Las superficies tienen que **separarse** unas de otras. No es contraste de
 * texto: es la comprobación que faltaba cuando el fondo oscuro era casi negro y
 * la tarjeta quedaba a diez puntos RGB, con la jerarquía aplastada.
 *
 * Se mide en L*, no en razón de contraste, por lo explicado en `lightness()`.
 * Tres puntos de L* es un escalón que se ve sin buscarlo pero no llama la
 * atención — que es exactamente lo que tiene que hacer una superficie.
 */
const SEPARATION: Array<[string, string]> = [
  ['surface', 'ground'],
  ['raised', 'surface'],
  ['line', 'surface'],
]
const MIN_SEPARATION = 3

/**
 * La paleta categórica de los gráficos, leída de `src/design/charts.ts`.
 *
 * Se comprueba aquí porque no vive en los tokens y se le puede escapar a
 * cualquiera: el fondo oscuro subió de casi negro a grafito, y subir el fondo
 * **baja** el contraste de unas series que ya eran claras. Una barra que se
 * confunde con el fondo es un dato perdido.
 */
function parsePalette(ts: string, name: string): string[] {
  const m = ts.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`))
  if (!m?.[1]) throw new Error(`No se encontró la paleta ${name} en charts.ts`)
  return [...m[1].matchAll(/#([0-9A-Fa-f]{6})/g)].map((x) => x[1]!)
}

function hexToRgb(hex: string): Rgb {
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ]
}

async function main(): Promise<void> {
  const css = await readFile('src/design/tokens.css', 'utf8')
  const chartsTs = await readFile('src/design/charts.ts', 'utf8')
  const themes: Array<[string, Map<string, Rgb>, string]> = [
    ['claro', parseBlock(css, ':root {'), 'CATEGORICAL_LIGHT'],
    ['oscuro', parseBlock(css, ":root[data-theme='dark'] {"), 'CATEGORICAL_DARK'],
  ]

  let failures = 0

  for (const [name, tokens, palette] of themes) {
    console.log(`\n  Tema ${name}`)

    for (const { fg, bg, min, what } of PAIRS) {
      const a = tokens.get(fg)
      const b = tokens.get(bg)
      if (!a || !b) {
        console.log(`  ✗ falta el token --${a ? bg : fg}`)
        failures++
        continue
      }

      const ratio = contrast(a, b)
      const ok = ratio >= min
      if (!ok) failures++
      console.log(
        `  ${ok ? '·' : '✗'} ${ratio.toFixed(2).padStart(5)}:1  (mín ${min})  ${what}` +
          `  ${fg} / ${bg}`,
      )
    }

    for (const [top, under] of SEPARATION) {
      const a = tokens.get(top)
      const b = tokens.get(under)
      if (!a || !b) continue
      const delta = Math.abs(lightness(a) - lightness(b))
      const ok = delta >= MIN_SEPARATION
      if (!ok) failures++
      console.log(
        `  ${ok ? '·' : '✗'} ${delta.toFixed(2).padStart(5)} L*  (mín ${MIN_SEPARATION})` +
          `  separación  ${top} / ${under}`,
      )
    }

    // Las series de un gráfico son formas grandes, no texto: el mínimo es el de
    // los componentes no textuales, 3:1.
    const surface = tokens.get('surface')!
    parsePalette(chartsTs, palette).forEach((hex, i) => {
      const ratio = contrast(hexToRgb(hex), surface)
      const ok = ratio >= 3
      if (!ok) failures++
      console.log(
        `  ${ok ? '·' : '✗'} ${ratio.toFixed(2).padStart(5)}:1  (mín 3)` +
          `      serie ${i + 1} del gráfico  #${hex} / surface`,
      )
    })
  }

  if (failures > 0) {
    console.error(`\n  ${failures} comprobaciones de contraste por debajo del mínimo.\n`)
    process.exit(1)
  }
  console.log('\n  Contraste correcto en los dos temas.\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
