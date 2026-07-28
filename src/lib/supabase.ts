import { createClient } from '@supabase/supabase-js'

const url = import.meta.env['VITE_SUPABASE_URL'] as string | undefined
const anonKey = import.meta.env['VITE_SUPABASE_ANON_KEY'] as string | undefined

if (!url || !anonKey) {
  throw new Error(
    'Faltan VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY. Copia .env.example a .env y rellénalos.',
  )
}

export const supabase = createClient(url, anonKey, {
  auth: {
    // La sesión la custodiamos nosotros, cifrada con el PIN del usuario. Si la
    // dejáramos en localStorage en claro, un iPad perdido daría acceso directo.
    persistSession: false,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
})
