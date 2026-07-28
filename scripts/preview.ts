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

/**
 * Catálogo e inventario. La revisión ya no sale de una lista fija: sus filas son
 * los equipos de la sala, así que sin sembrarlos la captura solo mostraría la
 * comprobación de red.
 *
 * `Cañón corto` va sin confirmar a propósito: es el caso que hay que poder
 * mirar, el del tipo creado desde un aula que sale en naranja y se usa igual.
 */
const TYPES = [
  { name: 'Proyector', lamp: true, confirmed: true },
  { name: 'Pantalla', lamp: false, confirmed: true },
  { name: 'Altavoces', lamp: false, confirmed: true },
  { name: 'Micrófono', lamp: false, confirmed: true },
  { name: 'Cámara', lamp: false, confirmed: true },
  { name: 'Botonera', lamp: false, confirmed: true },
  { name: 'Cañón corto', lamp: false, confirmed: false },
]

/** El inventario de la sala que se fotografía. */
const INVENTORY = [
  { type: 'Proyector', label: 'Proyector', model: 'NP-M403HG', serial: '0340985RL' },
  { type: 'Pantalla', label: 'Pantalla', model: null, serial: '04204526NB' },
  { type: 'Pantalla', label: 'Pantalla 2', model: null, serial: null },
  { type: 'Altavoces', label: 'Altavoces', model: null, serial: null },
  { type: 'Micrófono', label: 'Micrófono', model: 'Jabra 710', serial: null },
  { type: 'Cámara', label: 'Cámara', model: '520 PRO', serial: '5310306900024' },
  { type: 'Botonera', label: 'Botonera', model: null, serial: null },
  { type: 'Cañón corto', label: 'Cañón corto', model: null, serial: null },
]

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(PORT, r))
  const browser = await chromium.launch({
    executablePath: process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  })
  const page = await browser.newPage({ viewport: { width: 414, height: 900 }, deviceScaleFactor: 2 })

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' })

  // Las variables de Supabase se compilan dentro del bundle. Si el `dist` se
  // construyó sin ellas, la aplicación muestra el aviso de configuración y aquí
  // solo se vería un tiempo de espera agotado buscando el campo del PIN.
  if (await page.getByText('Configuración incompleta').count()) {
    throw new Error(
      'El dist actual se construyó sin las variables de Supabase.\n' +
        'Para previsualizar basta con valores de relleno:\n' +
        '  VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=demo npm run build',
    )
  }

  const sealed = await seal(PIN, { access_token: 'demo', refresh_token: 'demo' })
  await page.evaluate(
    async ([sealedSession, rooms, types, inventory]) => {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('mantenimiento-aulas')
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction(
            ['meta', 'buildings', 'zones', 'rooms', 'assetTypes', 'assets'],
            'readwrite',
          )
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
          const typeIds = new Map<string, string>()
          ;(types as Array<Record<string, unknown>>).forEach((ty, i) => {
            const id = `t${i}`
            typeIds.set(ty['name'] as string, id)
            tx.objectStore('assetTypes').put({
              id,
              name: ty['name'],
              category: 'av',
              tracks_serial: true,
              tracks_lamp_hours: ty['lamp'],
              confirmed: ty['confirmed'],
              aliases: [],
              merged_into: null,
            })
          })

          // El inventario va en la sala que se fotografía, que es la última.
          const roomId = `r${(rooms as unknown[]).length - 1}`
          ;(inventory as Array<Record<string, unknown>>).forEach((it, i) => {
            tx.objectStore('assets').put({
              id: `e${i}`,
              asset_type_id: typeIds.get(it['type'] as string),
              room_id: roomId,
              label: it['label'],
              model: it['model'],
              serial: it['serial'],
              status: 'instalado',
              created_at: new Date(2026, 0, 1 + i).toISOString(),
            })
          })

          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }
        open.onerror = () => reject(open.error)
      })
    },
    [sealed, ROOMS, TYPES, INVENTORY] as const,
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

  // El inventario de la sala, que nace plegado.
  await page.emulateMedia({ colorScheme: 'light' })
  await page.getByRole('button', { name: /Equipos de la sala/ }).click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: /Equipos de la sala/ }).scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await shot('inventario')

  // Y el alta: al teclear algo que no está, la única salida es crearlo naranja.
  await page.getByPlaceholder('Añadir equipo').fill('atril')
  await page.waitForTimeout(400)
  await shot('inventario-alta')

  /*
   * El colapso del bloque de incidencia, a cámara lenta.
   *
   * A velocidad normal una animación de 200ms no se puede juzgar en una
   * captura: o está abierta o está cerrada. Multiplicada por siete se ve lo que
   * de verdad hay que mirar —si el contenido se recorta limpio, si la opacidad
   * y el alto van sincronizados— que es donde fallan estas cosas.
   */
  await page.emulateMedia({ colorScheme: 'light' })
  await page.addStyleTag({
    content: '.collapse-y, .collapse-y[data-open="true"] { transition-duration: 3s !important }',
  })
  await page.locator('button[role="radio"][aria-checked="false"]').nth(4).click()
  // 150ms de 3s. La curva es `ease-out`, que arranca rapidísimo: a la mitad del
  // tiempo ya está casi abierto, así que hay que mirar mucho antes.
  await page.waitForTimeout(150)
  await shot('animacion-a-media')

  /*
   * La lámpara encendida. Sin esto solo se comprueba el estado apagado, que es
   * justamente el que no dice nada: el que hay que revisar es el otro.
   */
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('mantenimiento-aulas')
      open.onsuccess = () => {
        const tx = open.result.transaction(['outbox'], 'readwrite')
        for (let i = 0; i < 3; i++) {
          tx.objectStore('outbox').put({
            id: `demo-${i}`,
            entity: 'inspection',
            op: 'upsert',
            payload: {},
            createdAt: Date.now(),
            attempts: 0,
            nextAttemptAt: Date.now(),
            status: 'pendiente',
            lastError: null,
          })
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }
      open.onerror = () => reject(open.error)
    })
  })
  // Recarga obligatoria: la escritura va por IndexedDB en crudo, así que Dexie
  // no se entera y `useLiveQuery` no se reevalúa. Es limitación del sembrado,
  // no de la aplicación —ahí las escrituras pasan por Dexie y sí notifican—.
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('input[name="pin"]').fill(PIN)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await page.waitForTimeout(1200)
  await page.locator('header').first().screenshot({ path: 'dist/preview-lampara.png' })
  console.log('  dist/preview-lampara.png')

  await browser.close()
  server.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
