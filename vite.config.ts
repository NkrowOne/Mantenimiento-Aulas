import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'
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
     * coincidir durante días —el service worker nuevo espera a que alguien pulse
     * «Actualizar»—, así que un dispositivo puede estar enseñando un fallo que
     * se arregló hace horas.
     *
     * Sin esto no hay forma de distinguirlo desde el aparato, que es donde
     * ocurre: se diagnostica a ciegas un código que ni siquiera es el que está
     * corriendo. Pasó, y costó varias vueltas.
     */
    define: {
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
        includeAssets: ['favicon.svg'],
        manifest: {
          name: 'Mantenimiento de Aulas',
          short_name: 'Aulas',
          description: 'Revisión de salas, inventario y stock',
          lang: 'es',
          theme_color: '#2B4C8C',
          background_color: '#F6F7F9',
          display: 'standalone',
          start_url: '/',
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
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
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
    },
    test: {
      environment: 'node',
      setupFiles: ['./src/test/setup.ts'],
    },
  }
})
