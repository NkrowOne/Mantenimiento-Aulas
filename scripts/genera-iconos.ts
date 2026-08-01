/**
 * Genera los PNG del icono a partir de `public/favicon.svg`.
 *
 *   npx tsx scripts/genera-iconos.ts
 *
 * Renderiza con el Chromium de Playwright —que ya es dependencia del humo—
 * para no sumar ninguna librería de imágenes. Produce:
 *
 *   public/icon-192.png            manifest (Android, escritorio)
 *   public/icon-512.png            manifest
 *   public/icon-maskable-512.png   manifest `purpose: maskable`: el contenido
 *                                  al 78% para sobrevivir al recorte circular
 *   public/apple-touch-icon.png    iOS (180×180); iOS redondea él
 *
 * Se ejecuta a mano cuando cambie el SVG y los PNG se suben al repositorio:
 * el build de la plataforma no trae navegador y no tiene por qué traerlo.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const svg = readFileSync(resolve('public/favicon.svg'), 'utf8')

/**
 * El SVG a pantalla completa. Para el maskable se encoge SOLO el grupo
 * `#contenido` —la placa—, no el fondo: escalar el SVG entero dejaba una
 * costura cuadrada entre el degradado y el color de relleno del hueco.
 */
function pagina(escala = 1): string {
  const desplaza = (512 * (1 - escala)) / 2
  const dibujo =
    escala === 1
      ? svg
      : svg.replace(
          '<g id="contenido">',
          `<g id="contenido" transform="translate(${desplaza} ${desplaza}) scale(${escala})">`,
        )
  return `<!doctype html><html><body style="margin:0">
    <div style="width:100vw;height:100vh">${dibujo}</div>
  </body></html>`
}

const salidas: Array<{ fichero: string; lado: number; escala: number }> = [
  { fichero: 'public/icon-192.png', lado: 192, escala: 1 },
  { fichero: 'public/icon-512.png', lado: 512, escala: 1 },
  { fichero: 'public/icon-maskable-512.png', lado: 512, escala: 0.78 },
  { fichero: 'public/apple-touch-icon.png', lado: 180, escala: 1 },
]

// En el sandbox de desarrollo el Chromium vive fuera del árbol de Playwright;
// `PW_CHROMIUM` permite señalarlo sin tocar el script. Sin la variable, el
// Chromium que Playwright tenga instalado.
const navegador = await chromium.launch(
  process.env['PW_CHROMIUM'] ? { executablePath: process.env['PW_CHROMIUM'] } : {},
)
try {
  for (const { fichero, lado, escala } of salidas) {
    const page = await navegador.newPage({ viewport: { width: lado, height: lado } })
    await page.setContent(pagina(escala))
    await page.screenshot({ path: fichero })
    await page.close()
    console.log(`✓ ${fichero} (${lado}×${lado}${escala !== 1 ? `, contenido al ${escala * 100}%` : ''})`)
  }
} finally {
  await navegador.close()
}
