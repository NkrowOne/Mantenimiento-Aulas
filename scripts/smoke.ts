/**
 * Prueba de humo de la interfaz en un navegador real.
 *
 *   npm run smoke
 *
 * Compilar no es arrancar. El typecheck y el build pasan con una aplicación que
 * revienta en el primer render —un hook mal usado, un import circular, un
 * `undefined` al pintar—, y eso solo se ve ejecutándola.
 *
 * No sustituye a probar en un iPad: comprueba que la aplicación levanta, pinta
 * y no escupe errores en consola, que es el suelo mínimo antes de tocar un
 * dispositivo real.
 */

import { chromium, type ConsoleMessage } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const PORT = 4178
const ROOT = 'dist'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
}

const server = createServer((req, res) => {
  void (async () => {
    const raw = (req.url ?? '/').split('?')[0] ?? '/'
    // `normalize` evita que un `..` en la URL salga del directorio servido.
    const rel = normalize(raw === '/' ? '/index.html' : raw).replace(/^(\.\.[/\\])+/, '')
    try {
      const body = await readFile(join(ROOT, rel))
      res.writeHead(200, { 'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      // SPA: cualquier ruta desconocida devuelve el index, como haría Caddy.
      const body = await readFile(join(ROOT, 'index.html'))
      res.writeHead(200, { 'Content-Type': MIME['.html']! })
      res.end(body)
    }
  })()
})

const problems: string[] = []

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(PORT, r))

  const browser = await chromium.launch({ executablePath:
      process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') problems.push(`consola: ${msg.text()}`)
  })
  page.on('pageerror', (err) => problems.push(`excepción: ${err.message}`))

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' })

  // La pantalla de bloqueo es lo primero que ve cualquiera y no necesita red:
  // si esto no aparece, la aplicación no arranca.
  const check = async (label: string, fn: () => Promise<boolean>): Promise<void> => {
    const ok = await fn().catch(() => false)
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
    if (!ok) problems.push(`no se cumplió: ${label}`)
  }

  console.log('\n▸ Arranque')
  await check('la pantalla de alta aparece', async () =>
    (await page.getByText('Dar de alta este dispositivo').count()) > 0,
  )
  await check('pide email y código', async () =>
    (await page.locator('input[type="email"]').count()) > 0 &&
    (await page.getByText('Código de alta').count()) > 0,
  )
  await check('el campo de PIN es numérico', async () =>
    (await page.locator('input[inputmode="numeric"]').count()) > 0,
  )

  console.log('\n▸ Validación del PIN, sin red')
  await page.locator('input[type="email"]').fill('tecnico@test.local')
  await page.locator('input[autocomplete="one-time-code"]').fill('AAAA-BBBB-CCCC')
  await page.locator('input[inputmode="numeric"]').fill('1234')
  await page.getByRole('button', { name: 'Dar de alta' }).click()

  await check('rechaza el PIN 1234 antes de llamar al servidor', async () => {
    await page.waitForTimeout(300)
    return (await page.getByText(/secuencias como 1234/i).count()) > 0
  })

  console.log('\n▸ Accesibilidad y maquetación')
  await check('el botón de envío es pulsable con el pulgar (≥44px)', async () => {
    const box = await page.getByRole('button', { name: 'Dar de alta' }).boundingBox()
    return (box?.height ?? 0) >= 44
  })
  await check('la página no se desborda en horizontal', async () =>
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  )

  console.log('\n▸ Tema oscuro')
  await page.emulateMedia({ colorScheme: 'dark' })
  await check('el fondo cambia con el tema del sistema', async () =>
    await page.evaluate(() => {
      const bg = getComputedStyle(document.body).backgroundColor
      const m = bg.match(/\d+/g)
      // El fondo oscuro es #0E1216: los tres canales por debajo de 60.
      return !!m && m.slice(0, 3).every((v) => Number(v) < 60)
    }),
  )

  await page.screenshot({ path: 'dist/smoke-lockscreen.png' })

  await browser.close()
  server.close()

  if (problems.length > 0) {
    console.error('\n✗ Problemas encontrados:')
    for (const p of problems) console.error(`   ${p}`)
    process.exit(1)
  }
  console.log('\n✓ La aplicación arranca y responde sin errores de consola\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
