/**
 * Previsualización de las pantallas reales con datos de ejemplo.
 *
 *   npm run preview
 *
 * Siembra IndexedDB con una sesión sellada y unas salas, entra con el PIN y
 * captura las pantallas que de verdad usa el técnico. La prueba de humo solo
 * alcanza el bloqueo; esto llega a la revisión, que es donde se decide si el
 * diseño funciona.
 *
 * Las capturas van a `dist/preview-*.png` y no se versionan.
 */

import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import { extname, join, normalize } from 'node:path'

const PORT = 4179
const ROOT = 'dist'
const PIN = '4829'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
}

const server = createServer((req, res) => {
  void (async () => {
    const raw = (req.url ?? '/').split('?')[0] ?? '/'
    const rel = normalize(raw === '/' ? '/index.html' : raw).replace(/^(\.\.[/\\])+/, '')
    try {
      const body = await readFile(join(ROOT, rel))
      res.writeHead(200, { 'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(200, { 'Content-Type': MIME['.html']! }).end(await readFile(join(ROOT, 'index.html')))
    }
  })()
})

/** Mismo sellado que `src/auth/pin.ts`, para que el PIN abra de verdad. */
async function seal(pin: string, session: unknown) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16))
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const material = await webcrypto.subtle.importKey(
    'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey'],
  )
  const key = await webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310_000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  )
  const ct = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(session)),
  )
  const b64 = (b: ArrayBuffer | Uint8Array): string =>
    Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64')

  return {
    salt: b64(salt), iv: b64(iv), ciphertext: b64(ct),
    hint: { email: 'ana@ejemplo.es', fullName: 'Ana Ruiz' },
  }
}

const ROOMS = [
  { code: '1.7', name: '1.7', caps: { proyector: true, altavoces: true, camara: false, microfono: false, botonera: true, tv: false }, days: 214 },
  { code: '1.8', name: '1.8', caps: { proyector: true, altavoces: true, camara: true, microfono: true, botonera: true, tv: true }, days: 189 },
  { code: '2.1', name: '2.1', caps: { proyector: true, altavoces: false, camara: false, microfono: false, botonera: false, tv: false }, days: 45 },
  { code: '-2.1', name: 'Lab Criminología', caps: { proyector: true, altavoces: true, camara: true, microfono: true, botonera: true, tv: true }, days: 302 },
]

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(PORT, r))
  const browser = await chromium.launch({
    executablePath: process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  })
  const page = await browser.newPage({ viewport: { width: 414, height: 900 }, deviceScaleFactor: 2 })

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' })

  const sealed = await seal(PIN, { access_token: 'demo', refresh_token: 'demo' })
  await page.evaluate(
    async ([sealedSession, rooms]) => {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('mantenimiento-aulas')
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction(['meta', 'buildings', 'zones', 'rooms'], 'readwrite')
          tx.objectStore('meta').put({ key: 'sealed-session', value: sealedSession })
          tx.objectStore('buildings').put({
            id: 'b1', code: 'H', name: 'EDIFICIO H', sort_order: 1, needs_review: false,
          })
          tx.objectStore('zones').put({ id: 'z1', building_id: 'b1', name: 'PLANTA −2', sort_order: 1 })
          ;(rooms as Array<Record<string, unknown>>).forEach((r, i) => {
            tx.objectStore('rooms').put({
              id: `r${i}`, zone_id: 'z1', code: r['code'], name: r['name'],
              kind: 'aula', capabilities: r['caps'],
              projector_hours: 3400, lamp_pct: 0.14,
              last_inspection_at: new Date(Date.now() - (r['days'] as number) * 86400000).toISOString(),
              active: true,
            })
          })
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }
        open.onerror = () => reject(open.error)
      })
    },
    [sealed, ROOMS] as const,
  )

  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('input[name="pin"]').fill(PIN)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await page.waitForTimeout(1200)

  const shot = async (name: string): Promise<void> => {
    await page.screenshot({ path: `dist/preview-${name}.png` })
    console.log(`  dist/preview-${name}.png`)
  }

  await shot('edificios')
  await page.getByText('EDIFICIO H').click()
  await page.waitForTimeout(500)
  await shot('salas')

  await page.getByText('Lab Criminología').click()
  await page.waitForTimeout(800)
  await shot('revision')

  // Y cómo queda tras marcar una incidencia y usar la vía rápida.
  await page.locator('button[role="radio"][aria-checked="false"]').nth(1).click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Marcar OK/ }).click()
  await page.waitForTimeout(600)
  await shot('revision-incidencia')

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(400)
  await shot('revision-oscuro')

  await browser.close()
  server.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
