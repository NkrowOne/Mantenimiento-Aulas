import { createClient } from '@supabase/supabase-js'

const url = import.meta.env['VITE_SUPABASE_URL'] as string | undefined
const anonKey = import.meta.env['VITE_SUPABASE_ANON_KEY'] as string | undefined

/**
 * Configuración que falta, si falta alguna.
 *
 * Antes esto lanzaba al cargar el módulo, y el resultado era **una página en
 * blanco**: la aplicación compilaba sin problema, se desplegaba, y el técnico
 * abría la URL y no veía nada. El error solo aparecía en la consola del
 * navegador, que es donde nadie mira.
 *
 * Ahora se recoge y la interfaz lo muestra. Es un fallo fácil de cometer porque
 * estas dos variables **se compilan dentro del bundle**: cambiar el dominio y
 * no reconstruir deja la aplicación hablando con el host anterior, y olvidarlas
 * del todo la deja muerta.
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
