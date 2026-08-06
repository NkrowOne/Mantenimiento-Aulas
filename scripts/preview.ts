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

// Dos plantas, para que el orden «Por planta» tenga algo que agrupar.
const ROOMS = [
  { code: '1.7', name: '1.7', zone: 'z2', caps: { proyector: true, altavoces: true, camara: false, microfono: false, botonera: true, tv: false }, days: 214 },
  { code: '1.8', name: '1.8', zone: 'z2', caps: { proyector: true, altavoces: true, camara: true, microfono: true, botonera: true, tv: true }, days: 189 },
  { code: '2.1', name: '2.1', zone: 'z2', caps: { proyector: true, altavoces: false, camara: false, microfono: false, botonera: false, tv: false }, days: 45 },
  { code: '-2.1', name: 'Lab Criminología', zone: 'z1', caps: { proyector: true, altavoces: true, camara: true, microfono: true, botonera: true, tv: true }, days: 302 },
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

  /*
   * Un token con FORMA de token, no la cadena «demo».
   *
   * `supabase.auth.setSession()` decodifica el acceso para saber cuándo caduca.
   * Con una cadena cualquiera falla al analizarlo, y desde que `unlockWithPin()`
   * mira ese error —antes lo descartaba— la previsualización se quedaba clavada
   * en la pantalla del PIN diciendo que el servidor no acepta la sesión. Tenía
   * razón: lo que estaba mal era lo que se sembraba aquí.
   *
   * Sin firmar y sin caducar en un año: no vale contra ningún servidor, y no
   * hace falta, porque estas capturas se toman contra `dist` servido en local y
   * ninguna pantalla de esta previsualización llega a pedir datos remotos.
   */
  const jwtDeMentira = (): string => {
    const b64 = (o: unknown): string =>
      Buffer.from(JSON.stringify(o))
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    const exp = Math.floor(Date.now() / 1000) + 365 * 24 * 3600
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
      sub: '00000000-0000-4000-8000-000000000001',
      role: 'authenticated',
      app_role: 'admin',
      exp,
    })}.previsualizacion`
  }

  const sealed = await seal(PIN, {
    access_token: jwtDeMentira(),
    refresh_token: 'previsualizacion',
  })
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
          tx.objectStore('zones').put({ id: 'z2', building_id: 'b1', name: '1ª PLANTA', sort_order: 2 })
          ;(rooms as Array<Record<string, unknown>>).forEach((r, i) => {
            tx.objectStore('rooms').put({
              id: `r${i}`, zone_id: r['zone'], code: r['code'], name: r['name'],
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
  await page.getByRole('button', { name: /EDIFICIO H/ }).click()
  await page.waitForTimeout(500)
  await shot('salas')

  /*
   * El otro orden, el de la cola de trabajo.
   *
   * La captura `salas` de arriba ya sale por planta —es el orden con el que se
   * abre un edificio—, así que volver a pulsar «Por planta» aquí fotografiaba
   * dos veces la misma pantalla. Lo que falta ver es el cambio: sin cabeceras de
   * planta y con lo más atrasado arriba.
   */
  await page.getByRole('button', { name: 'Más antiguas' }).click()
  await page.waitForTimeout(400)
  await shot('salas-mas-antiguas')

  // Y el buscador filtrando.
  await page.getByPlaceholder('Buscar sala').fill('crimin')
  await page.waitForTimeout(400)
  await shot('salas-buscando')
  await page.getByPlaceholder('Buscar sala').fill('')
  await page.waitForTimeout(300)

  // La fila de la sala, no el título de la placa: ahora hay buscador y cabecera
  // con el mismo texto.
  await page.getByRole('button', { name: /Lab Criminología/ }).first().click()
  await page.waitForTimeout(800)
  await shot('ficha')

  /*
   * Y de la ficha a la revisión, con su botón.
   *
   * Esto faltaba y por eso el recorrido se paraba en seco: la lista dejó de
   * abrir el formulario y pasó a abrir la FICHA de la sala, pero aquí se seguía
   * dando por hecho lo primero. La captura llamada «revision» era en realidad la
   * ficha, y el clic siguiente esperaba unos tri-estados que en esa pantalla no
   * existen. Un `nth(1)` sobre cero elementos: treinta segundos de espera y un
   * tiempo agotado que no menciona la causa.
   */
  await page.getByRole('button', { name: 'Revisar esta sala' }).click()
  await page.waitForTimeout(800)
  await shot('revision')

  // Y cómo queda tras marcar una incidencia y usar la vía rápida.
  await page.locator('button[role="radio"][aria-checked="false"]').nth(1).click()
  await page.waitForTimeout(400)
  // El acelerador vive ahora en la barra de acción, junto al recuento.
  await page.getByRole('button', { name: /marcar OK/ }).click()
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
  /*
   * El bucle de la ronda, comprobado de verdad y no solo fotografiado.
   *
   * Es el arreglo con más palanca de toda la auditoría y el más fácil de
   * romper sin enterarse: si `complete()` dejara de marcar la sala en local,
   * «siguiente sala» devolvería a la misma aula y la captura seguiría saliendo
   * bien. Por eso se afirma, no se mira.
   */
  await page.emulateMedia({ colorScheme: 'light' })
  // A estas alturas del recorrido puede quedar algo sin marcar o no, según lo
  // que hayan tocado los pasos anteriores.
  const acelerador = page.getByRole('button', { name: /marcar OK/ })
  if (await acelerador.count()) {
    await acelerador.click()
    await page.waitForTimeout(400)
  }

  const salaAntes = await page.locator('h1').first().innerText()
  await page.getByRole('button', { name: 'Guardar y siguiente sala' }).click()
  await page.waitForTimeout(900)

  const salaDespues = await page.locator('h1').first().innerText()
  if (salaAntes === salaDespues) {
    throw new Error(
      `«Guardar y siguiente sala» no ha cambiado de aula: sigue en «${salaAntes}».`,
    )
  }
  console.log(`  ✓ encadena salas: ${salaAntes} → ${salaDespues}`)
  await shot('siguiente-sala')

  // Y la sala terminada tiene que haber bajado en la lista.
  await page.getByRole('button', { name: '← Volver' }).click()
  await page.waitForTimeout(600)
  const primera = await page.locator('ul li button').first().innerText()
  if (primera.includes('Criminología')) {
    throw new Error('La sala recién revisada sigue encabezando la lista.')
  }
  console.log('  ✓ la sala revisada baja en la lista')
  await shot('lista-tras-revisar')

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

  /*
   * El PANEL, que hasta ahora no se podía previsualizar.
   *
   * Es la única pantalla de la aplicación que lee SOLO del servidor: sin
   * Supabase delante no pasa del mensaje de «no se ha podido leer». Así que aquí
   * se le contesta a la API con datos de ejemplo —los del despliegue real, para
   * que las cifras y las proporciones sean las que se van a ver— y se fotografía
   * en claro y en oscuro.
   *
   * Merece la pena tenerlo: es la pantalla donde más fácil es que un cambio de
   * diseño quede bien en el editor y mal en un móvil a oscuras.
   */
  const conBorradores = true

  await page.route('**/rest/v1/**', async (route) => {
    const url = route.request().url()
    const json = (data: unknown): Promise<void> =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })

    /*
     * Los cuatro recuentos de arriba salen a CERO en esta previsualización, y no
     * es un fallo de la aplicación.
     *
     * `useSummary()` los pide con `{ count: 'exact', head: true }`, o sea que la
     * cifra no viaja en el cuerpo sino en la cabecera `Content-Range`. Falsearla
     * desde aquí no ha salido bien, así que queda dicho en vez de disimulado:
     * las baldosas se ven con su forma, su acción y su altura —que es lo que se
     * viene a comprobar— pero con el número a cero.
     *
     * Los gráficos y las listas sí traen datos de ejemplo: esos llegan en el
     * cuerpo y se pueden contestar.
     */

    if (url.includes('alerts_lamp_low')) {
      return json(
        Array.from({ length: 6 }, (_, i) => ({
          room_id: `r${i}`,
          building_code: 'H',
          room_code: `1.${i}`,
          room_name: `1.${i}`,
          lamp_pct: 0.02 + i * 0.025,
          projector_hours: 3400 + i * 120,
        })),
      )
    }
    if (url.includes('alerts_stale_incidents')) return json([])

    if (url.includes('incidents_by_building')) {
      return json(
        [118, 41, 32, 22, 21, 19, 18, 9, 3].map((total, i) => ({
          code: ['P', 'H', 'E', 'M', 'C', 'O', 'CD', 'COM', 'PRY'][i],
          total,
        })),
      )
    }
    if (url.includes('incidents_by_month')) {
      return json(
        ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02'].map((month, i) => ({
          month,
          total: [8, 14, 11, 6, 19, 12][i],
        })),
      )
    }
    /*
     * Incidencias, con y sin borradores.
     *
     * Los borradores ya no tienen pestaña propia: salen dentro de esta pantalla
     * y solo si los hay. Las dos capturas son justamente para comprobar las dos
     * caras — que cuando no hay ninguno no queda ni un hueco.
     */
    /*
     * El patrón lleva la interrogación a propósito.
     *
     * Con `url.includes('/incidents')` esta rama se tragaba también
     * `/incidents_by_building` y `/incidents_by_month`, y los gráficos salían
     * vacíos con un «undefined» debajo. Se vio en la captura, no razonándolo.
     */
    if (/\/incidents\?/.test(url)) {
      if (url.includes('state=eq.borrador')) {
        return json(
          conBorradores
            ? [
                {
                  id: 'd1',
                  room_id: null,
                  kind: 'observacion',
                  title: null,
                  external_ref: null,
                  opened_at: '2026-06-02T09:00:00Z',
                },
                {
                  id: 'd2',
                  room_id: null,
                  kind: 'incidencia',
                  title: 'Soporte del altavoz izquierdo flojo',
                  external_ref: null,
                  opened_at: '2026-07-11T09:00:00Z',
                },
              ]
            : [],
        )
      }
      return json([
        {
          id: 'i1',
          title: 'No duplica la imagen en el monitor principal',
          description: null,
          severity: 'media',
          state: 'abierta',
          kind: 'incidencia',
          opened_at: '2026-07-20T09:00:00Z',
          resolved_at: null,
          external_ref: 'I260720_0031',
          room_id: null,
          opened_from_inspection_id: null,
        },
        /*
         * Y una nacida de una revisión, que es el caso normal desde que marcar
         * «Falla» en un equipo abre incidencia. Está aquí para que la captura
         * enseñe las tres cosas que antes no se veían: la gravedad en palabras,
         * la marca de que alguien lo vio en el aula, y la nota que escribió.
         */
        {
          id: 'i2',
          title: 'Proyector: no enciende, el led parpadea en rojo',
          description: 'No enciende, el led parpadea en rojo. Probado con otro cable.',
          severity: 'alta',
          state: 'abierta',
          kind: 'incidencia',
          opened_at: '2026-07-28T08:20:00Z',
          resolved_at: null,
          external_ref: null,
          room_id: null,
          opened_from_inspection_id: 'rev-1',
        },
      ])
    }

    return json([])
  })

  await page.locator('nav').getByRole('button', { name: 'Panel' }).click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'dist/preview-panel.png', fullPage: true })
  console.log('  dist/preview-panel.png')

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'dist/preview-panel-oscuro.png', fullPage: true })
  console.log('  dist/preview-panel-oscuro.png')

  /*
   * Incidencias, en sus dos estados.
   *
   * Con borradores y sin ellos: lo que hay que ver en la segunda es que NO se
   * ve nada — ni cabecera, ni «ninguno pendiente», ni un hueco donde estaba.
   */
  await page.emulateMedia({ colorScheme: 'light' })
  await page.locator('nav').getByRole('button', { name: 'Incidencias' }).click()
  await page.waitForTimeout(1200)
  await shot('incidencias-con-borradores')

  /*
   * El caso contrario —sin ningún borrador, donde no debe dibujarse nada— no se
   * fotografía aquí: exigiría recargar para saltarse la caché de React Query, y
   * al recargar la aplicación devuelve al técnico dentro de la revisión donde
   * estaba, que esconde la barra inferior. Enredar el guion para eso no compensa.
   *
   * Esa regla la cubre `Borradores.test.ts`, que además es más duradero que una
   * captura: comprueba que no se enseña nada ni vacío, ni cargando, ni al fallar.
   */

  await browser.close()
  server.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
