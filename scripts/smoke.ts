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
  await check('no falta configuración en el build', async () =>
    (await page.getByText('Configuración incompleta').count()) === 0,
  )
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

  console.log('\n▸ Informe de configuración')
  // Nadie más comprueba que `salud.json` exista. Ni este servidor ni Caddy
  // devuelven 404 cuando falta un fichero: los dos caen al index.html de la SPA
  // con un 200, así que el código de estado no prueba nada y la sonda del
  // contenedor seguiría en verde sirviendo HTML. Si el plugin dejara de
  // emitirlo, esto es lo único que se daría cuenta.
  await check('/salud.json es el informe y no el index.html', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/salud.json`)
    if (!r.ok) return false
    const informe = (await r.json()) as { ok?: boolean; version?: string; construccion?: unknown }
    return informe.ok === true && typeof informe.version === 'string' && informe.construccion !== undefined
  })

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
  /*
   * Ningún campo por debajo de 16px.
   *
   * No es una preferencia de estilo: Safari de iOS amplía la página al enfocar
   * un campo con la letra más pequeña, y con la página ampliada la barra de
   * pestañas —que es `fixed`— se queda varada en mitad de la pantalla, porque
   * WebKit ancla los elementos fijos al viewport de maquetación y no al que se
   * ve. Es el fallo de «el menú tiene que estar fijado», y se arregla aquí: sin
   * zoom no hay divergencia y la barra no se mueve.
   *
   * Se comprueba sobre lo RENDERIZADO y no sobre las clases: lo que importa es
   * el tamaño con el que iOS decide, y ese sale del CSS ya compilado.
   */
  await check('ningún campo baja de 16px, que es lo que hace que iOS amplíe', async () => {
    const chicos = await page.evaluate(() =>
      [...document.querySelectorAll('input, textarea, select')]
        .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
        .map((el) => `${el.tagName.toLowerCase()}[name=${el.getAttribute('name') ?? '?'}]`),
    )
    if (chicos.length) problems.push(`campos por debajo de 16px: ${chicos.join(', ')}`)
    return chicos.length === 0
  })

  console.log('\n▸ Guardado de contraseña en el alta')
  await check('el PIN es un campo de contraseña', async () =>
    (await page.locator('input[type="password"][name="pin"]').count()) > 0,
  )
  await check('el navegador puede ofrecer guardarlo (new-password)', async () =>
    (await page.locator('input[autocomplete="new-password"]').count()) > 0,
  )
  await check('hay campo de usuario para asociar la credencial', async () =>
    (await page.locator('input[autocomplete="username"]').count()) > 0,
  )

  console.log('\n▸ Pantalla de desbloqueo diario')
  // Se inyecta una sesión sellada falsa para que la aplicación pinte la
  // pantalla de PIN en vez de la de alta. Solo se comprueba el marcado: el
  // descifrado real ya lo cubren las pruebas de `pin.test.ts`.
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('mantenimiento-aulas')
      open.onsuccess = () => {
        const dbh = open.result
        const tx = dbh.transaction('meta', 'readwrite')
        tx.objectStore('meta').put({
          key: 'sealed-session',
          value: {
            salt: 'AAAA',
            iv: 'BBBB',
            ciphertext: 'CCCC',
            hint: { email: 'ana@ejemplo.es', fullName: 'Ana Ruiz' },
          },
        })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }
      open.onerror = () => reject(open.error)
    })
  })
  await page.reload({ waitUntil: 'networkidle' })

  await check('saluda por el nombre en vez de pedir el alta', async () =>
    (await page.getByText('Hola, Ana Ruiz').count()) > 0,
  )
  await check('muestra la cuenta, que es lo que asocia la credencial', async () =>
    (await page.locator('input[name="username"][autocomplete="username"]').inputValue()) ===
    'ana@ejemplo.es',
  )
  await check('el PIN pide autorrelleno (current-password)', async () =>
    (await page.locator('input[name="pin"][autocomplete="current-password"]').count()) > 0,
  )
  await check('el campo de cuenta es de solo lectura', async () =>
    await page.locator('input[name="username"]').evaluate((el) => (el as HTMLInputElement).readOnly),
  )

  await page.screenshot({ path: 'dist/smoke-pin.png' })

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
