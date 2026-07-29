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
 * es el único sitio donde se sabe si estaba.
 *
 * La URL no se comprueba: por defecto es el propio origen (ver `lib/supabase.ts`).
 *
 * Devuelve 200 siempre a propósito. Marcar el despliegue como enfermo por una
 * variable ausente dejaría el servicio caído en vez de meramente desconfigurado,
 * y eso es peor. `configurada` lo dice sin ambigüedad para quien mire.
 */
function saludJson(configurada: boolean): Plugin {
  const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }
  return {
    name: 'salud-json',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'salud.json',
        source: JSON.stringify({ ok: true, version, configurada }),
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // `process.env` no basta: si las variables vienen de un `.env`, quien las lee
  // es Vite, no el proceso.
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const configurada = Boolean(env['VITE_SUPABASE_ANON_KEY'])

  return {
    plugins: [
      react(),
      saludJson(configurada),
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
          navigateFallbackDenylist: [/^\/rest\//, /^\/auth\//, /^\/storage\//],
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
