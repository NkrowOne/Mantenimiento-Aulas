import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * `dist/salud.json`, para que la plataforma tenga algo a lo que apuntar.
 *
 * Comprobar que Caddy responde es la mitad del trabajo, y la menos útil: un
 * servidor de ficheros estáticos casi nunca es lo que se rompe. Lo que sí se
 * rompe —ya pasó— es desplegar sin `VITE_SUPABASE_ANON_KEY`: el build sale
 * bien, la plataforma da el despliegue por bueno y la aplicación abre diciendo
 * que le falta configuración. Como esa clave se hornea dentro del bundle, aquí
 * es el único sitio donde se sabe si estaba: en el contenedor esa variable ya
 * no existe.
 *
 * Y esto es solo la MITAD del informe. La otra —`SUPABASE_UPSTREAM`, `PORT`,
 * la clave de servicio— no se conoce hasta que arranca el contenedor, y es
 * `scripts/salud.sh` quien la junta con esta y reescribe `/srv/dist/salud.json`.
 * En el despliegue con `docker-compose.yml` no hay quien lo reescriba y se
 * sirve esto tal cual: por eso lo de aquí dice `revisado: 'compilacion'`, para
 * que nadie lea la mitad creyendo que es el todo.
 *
 * Devuelve 200 siempre a propósito. Marcar el despliegue como enfermo por una
 * variable ausente dejaría el servicio caído en vez de meramente desconfigurado,
 * y eso es peor. `estado` lo dice sin ambigüedad para quien mire.
 *
 * Aquí nunca entra el VALOR de nada: `/salud.json` es público.
 */
interface Construccion {
  /** ¿Estaba la clave anónima al compilar? Su valor no se publica jamás. */
  clave_anonima: boolean
  /**
   * `origen` (por defecto: la API va por el mismo nombre que la PWA) o `fijada`
   * (alguien pasó `VITE_SUPABASE_URL`). Cuál es, no se publica; lo que hace
   * falta desde fuera es distinguir los dos casos, porque una URL fijada a otro
   * nombre es lo que hace aparecer CORS, y `kong.yml` no lleva plugin de CORS
   * a propósito.
   */
  url_api: 'origen' | 'fijada'
  /**
   * Minutos hasta que la sesión se bloquea sola; 0 es «nunca». Se publica
   * porque es la única forma de saberlo: acaba plegado como constante dentro
   * del bundle y allí no queda ni el nombre de la variable.
   */
  bloqueo_min: number
}

function saludJson(construccion: Construccion): Plugin {
  const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }
  return {
    name: 'salud-json',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'salud.json',
        source: JSON.stringify({
          ok: true,
          estado: construccion.clave_anonima ? 'ok' : 'desconfigurado',
          version,
          // Qué commit se compiló. `version` no distingue dos despliegues —nada
          // la sube—, así que sin esto averiguar si el arreglo está en el aire
          // obliga a descargar el bundle y buscar cadenas dentro.
          commit: process.env['VITE_COMMIT'] || 'desconocido',
          // `configurada` conserva el significado que tuvo siempre —la clave
          // anónima estaba al compilar— porque el campo ya existía.
          configurada: construccion.clave_anonima,
          revisado: 'compilacion',
          construccion,
          faltan: construccion.clave_anonima ? [] : ['VITE_SUPABASE_ANON_KEY'],
          avisos: [],
        }),
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // `process.env` no basta: si las variables vienen de un `.env`, quien las lee
  // es Vite, no el proceso.
  const env = loadEnv(mode, process.cwd(), 'VITE_')

  // Un valor que no sea número deja el bloqueo en NaN y la sesión no se cierra
  // nunca sin decirlo (ver `src/auth/session.ts`). Se normaliza aquí para que
  // el informe publique lo que de verdad va a pasar.
  const bloqueo = Number(env['VITE_LOCK_AFTER_MINUTES'] ?? 0)
  const construccion: Construccion = {
    clave_anonima: Boolean(env['VITE_SUPABASE_ANON_KEY']),
    url_api: env['VITE_SUPABASE_URL'] ? 'fijada' : 'origen',
    bloqueo_min: Number.isFinite(bloqueo) ? bloqueo : 0,
  }

  return {
    /*
     * Qué versión es esta, dentro del bundle.
     *
     * `salud.json` ya lo publica, pero eso responde «qué hay en el servidor», y
     * la pregunta que hace falta cuando algo no cuadra es otra: **qué está
     * ejecutando ESTE iPad**. Con `registerType: 'prompt'` las dos pueden no
     * coincidir un rato —la versión nueva se instala sola, pero espera al
     * siguiente momento seguro (ver `src/sw.ts`), y un dispositivo con el
     * código de antes de esa política sigue esperando un toque—, así que un
     * aparato puede estar enseñando un fallo que se arregló hace horas.
     *
     * Sin esto no hay forma de distinguirlo desde el aparato, que es donde
     * ocurre: se diagnostica a ciegas un código que ni siquiera es el que está
     * corriendo. Pasó, y costó varias vueltas.
     */
    define: {
      /*
       * Las migraciones que esta versión de la aplicación da por aplicadas: los
       * nombres de fichero de `supabase/migrations`. La pantalla de diagnóstico
       * las compara con las que la base tiene anotadas, y así «al servidor le
       * falta una migración» deja de ser una sospecha y pasa a ser una lista.
       */
      __MIGRACIONES__: JSON.stringify(
        readdirSync('./supabase/migrations')
          .filter((f) => f.endsWith('.sql'))
          .sort(),
      ),
      __BUILD__: JSON.stringify(
        (() => {
          // La hora de compilación va SIEMPRE: es la que contesta «¿este iPad
          // ya lleva el despliegue de esta mañana?» sin cotejar hashes.
          const cuando = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`
          const commit = process.env['VITE_COMMIT']
          // «desconocido» era el relleno del Dockerfile: tratado como commit
          // real, el chip enseñaba «versión descono» — recortado a 7 y sin
          // decir nada. Un relleno no es una versión.
          return commit && commit !== 'desconocido'
            ? `${commit.slice(0, 7)} · ${cuando}`
            : cuando
        })(),
      ),
    },
    plugins: [
      react(),
      saludJson(construccion),
      VitePWA({
        registerType: 'prompt',
        includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
        manifest: {
          name: 'Mantenimiento de Aulas',
          short_name: 'Aulas',
          description: 'Revisión de salas, inventario y stock',
          lang: 'es',
          // El petróleo de la marca (--accent), no un azul que no sale en
          // ninguna pantalla de la aplicación.
          theme_color: '#046A78',
          background_color: '#F6F7F9',
          display: 'standalone',
          start_url: '/',
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
            // Con su fichero propio: el recorte circular de Android necesita el
            // contenido encogido, y servirle el normal cortaba la placa.
            { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          /*
           * Y de esa red se quedan fuera las tres pantallas pesadas.
           *
           * El precache se baja ENTERO en cuanto el worker se instala, o sea en
           * cuanto alguien abre la aplicación después de un despliegue. Eran
           * 2,7 MB, y 1,4 de ellos —más de la mitad— son cosas que un técnico
           * no abre en todo el día:
           *
           *   echarts       1019 kB   los gráficos del panel y del informe
           *   CleanupPage    229 kB   el motor del Excel entero
           *   ReportsPage    139 kB   el informe
           *
           * Con 5G en un edificio, ese megabyte y medio va por el mismo tubo
           * que las consultas de la pantalla que se está mirando, así que la
           * aplicación compite consigo misma justo al arrancar. Es la respuesta
           * a «todo carga muy lento», y se notaba más cuanto más se desplegaba.
           *
           * Se siguen pudiendo abrir: se bajan al entrar y `runtimeCaching` las
           * guarda para la próxima. Lo que se pierde es abrirlas **sin red la
           * primera vez**, y las tres necesitan servidor para hacer su trabajo
           * —el panel consulta, el informe lo compone el servidor y el Excel va
           * contra la base—, así que sin red no servían de nada de todos modos.
           *
           * Lo que NO sale del precache: el escáner QR (`jsQR`), que se usa en
           * el aula y justo donde no hay cobertura, y todo lo que entra en el
           * arranque.
           */
          /*
           * El rescate de dispositivos atascados en una versión vieja, dentro
           * del propio service worker: es el único código nuevo que ejecuta un
           * dispositivo cuyo código de página nunca va a activar el worker en
           * espera (ver public/rescate-sw.js). Fuera del precache: se carga
           * por `importScripts`, que no pasa por el manejador de fetch, y
           * precachearlo solo duplicaría la copia.
           */
          importScripts: ['rescate-sw.js'],
          globIgnores: [
            '**/rescate-sw.js',
            '**/echarts-*.js',
            '**/CleanupPage-*.js',
            '**/ReportsPage-*.js',
            '**/DashboardPage-*.js',
            /*
             * Los subconjuntos de la monoespaciada que ningún texto de la
             * aplicación usa. El CSS los declara con `unicode-range`, así que el
             * navegador no los pediría nunca; precachearlos era bajar seis
             * ficheros en cada instalación para no leerlos jamás.
             */
            '**/ibm-plex-mono-cyrillic*',
            '**/ibm-plex-mono-vietnamese*',
            /*
             * Los iconos grandes del manifiesto los pide el sistema al instalar
             * la aplicación en la pantalla de inicio, no la página: 130 kB que
             * el worker guardaba y nadie volvía a leer. El de 192 se queda: es
             * el que enseña la pantalla de bloqueo.
             */
            '**/icon-512.png',
            '**/icon-maskable-512.png',
          ],
          /*
           * Lo que no se precachea se guarda la primera vez que se pide.
           *
           * El nombre lleva el hash del contenido, así que una respuesta
           * guardada no puede quedarse vieja: un despliegue cambia el nombre y
           * el fichero de antes deja de pedirse. Por eso `CacheFirst` y no
           * `StaleWhileRevalidate`: no hay nada que revalidar.
           */
          runtimeCaching: [
            {
              urlPattern: /\/assets\/.*\.(?:js|css)$/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'trozos-bajo-demanda',
                expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
          // El API nunca se cachea: los datos vienen de Dexie, no del service worker.
          // Cachear PostgREST daría lecturas rancias indistinguibles de las frescas.
          //
          // `salud.json` está en la lista por otra razón: no se precachea
          // —`globPatterns` no incluye json—, pero sin excluirlo, abrirlo en la
          // barra de direcciones de un iPad ya controlado por el service worker
          // devuelve la aplicación en vez del informe. Diagnosticar a mano se
          // vuelve confuso justo cuando hace falta que no lo sea.
          navigateFallbackDenylist: [/^\/rest\//, /^\/auth\//, /^\/storage\//, /^\/salud\.json$/],
          cleanupOutdatedCaches: true,
        },
      }),
    ],
    build: {
      rollupOptions: {
        output: {
          /*
           * `echarts` en su propio trozo, y con nombre.
           *
           * Salía en un `index-<hash>.js` anónimo de 1 MB —el fichero más
           * grande del despliegue, más que la aplicación entera— porque lo
           * comparten el panel y el informe. Sin nombre no se puede dejar fuera
           * del precache sin dejar fuera también el arranque, que se llama
           * igual.
           */
          manualChunks(id: string) {
            if (/node_modules[/\\](echarts|zrender)[/\\]/.test(id)) return 'echarts'
            return undefined
          },
        },
      },
    },
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
    },
    test: {
      environment: 'node',
      setupFiles: ['./src/test/setup.ts'],
    },
  }
})
