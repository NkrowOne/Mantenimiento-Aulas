import { createClient } from '@supabase/supabase-js'

/**
 * Dónde está la API.
 *
 * Por defecto, **el mismo origen que la aplicación**. Caddy sirve la PWA y
 * hace de proxy de `/rest`, `/auth` y `/storage` hacia Kong, así que la API
 * vive bajo el mismo nombre y no hay peticiones entre orígenes —por eso
 * `kong.yml` no lleva plugin de CORS—. Como el valor correcto es siempre
 * «donde estoy», deducirlo evita una variable de compilación que no aporta
 * nada y que, olvidada, deja la aplicación muerta.
 *
 * `VITE_SUPABASE_URL` sigue mandando cuando está: en `npm run dev` el servidor
 * de Vite no hace de proxy de nada, y quien despliegue con la API en otro
 * nombre la necesita (y entonces tendrá que añadir CORS en Kong).
 */
const url =
  (import.meta.env['VITE_SUPABASE_URL'] as string | undefined) ||
  (typeof window !== 'undefined' ? window.location.origin : undefined)

const anonKey = import.meta.env['VITE_SUPABASE_ANON_KEY'] as string | undefined

/**
 * Configuración que falta, si falta alguna.
 *
 * Antes esto lanzaba al cargar el módulo, y el resultado era **una página en
 * blanco**: la aplicación compilaba sin problema, se desplegaba, y el técnico
 * abría la URL y no veía nada. El error solo aparecía en la consola del
 * navegador, que es donde nadie mira.
 *
 * Ahora se recoge y la interfaz lo muestra. Sigue siendo fácil de provocar
 * porque la clave **se compila dentro del bundle**: cambiarla obliga a
 * reconstruir, no basta con reiniciar.
 */
export const configError: string | null =
  !url || !anonKey
    ? `Faltan ${[!url && 'VITE_SUPABASE_URL', !anonKey && 'VITE_SUPABASE_ANON_KEY']
        .filter(Boolean)
        .join(' y ')}`
    : null

export const supabase = createClient(
  url ?? 'https://configuracion-ausente.invalid',
  anonKey ?? 'sin-clave',
  {
    auth: {
      // La sesión la custodiamos nosotros, cifrada con el PIN del usuario. Si la
      // dejáramos en localStorage en claro, un iPad perdido daría acceso directo.
      persistSession: false,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  },
)
