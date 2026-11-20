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
/*
 * Las variables de compilación, o nada.
 *
 * `import.meta.env` lo pone Vite. Fuera de Vite no existe: el servidor de
 * informes carga este mismo fichero —genera el informe con el código de la
 * aplicación, para que no haya dos informes distintos— y allí leer una
 * propiedad de `undefined` tumbaba el proceso al arrancar. Allí tampoco se usa
 * este cliente: ver `usarCliente`, más abajo.
 */
const entorno = ((import.meta as { env?: Record<string, string | undefined> }).env ?? {}) as Record<
  string,
  string | undefined
>

const enNavegador = typeof window !== 'undefined'

const url = entorno['VITE_SUPABASE_URL'] || (enNavegador ? window.location.origin : undefined)

const anonKey = entorno['VITE_SUPABASE_ANON_KEY']

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

// `let` y no `const` por una sola razón, que está en `usarCliente`.
export let supabase = createClient(
  url ?? 'https://configuracion-ausente.invalid',
  anonKey ?? 'sin-clave',
  {
    auth: {
      // La sesión la custodiamos nosotros, cifrada con el PIN del usuario. Si la
      // dejáramos en localStorage en claro, un iPad perdido daría acceso directo.
      persistSession: false,
      // Fuera del navegador no hay sesión que renovar, y el temporizador de
      // renovación solo serviría para llamar cada medio minuto a un dominio
      // que no existe.
      autoRefreshToken: enNavegador,
      detectSessionInUrl: false,
    },
  },
)

/**
 * Pone otro cliente en el sitio de este. **Solo lo llama el servidor.**
 *
 * El informe se puede generar sin la aplicación abierta: lo hace el servidor
 * de informes con este mismo código —`src/servidor/informe.ts`—. Allí no hay
 * una sesión, hay una por cada informe que se está haciendo, y cada una tiene
 * que leer los datos con los permisos de quien lo pidió. Así que el servidor
 * deja aquí un cliente que reparte: cada lectura va con la sesión del informe
 * desde el que se hace.
 *
 * Es una costura y no un parámetro porque el cliente lo usan unas cuarenta
 * consultas repartidas por media docena de ficheros, y pasárselo a todas para
 * un caso que la aplicación no tiene era cambiar cuarenta firmas por una.
 *
 * En el navegador no se llama nunca: el cliente es el de arriba y no cambia.
 */
export function usarCliente(otro: typeof supabase): void {
  supabase = otro
}
