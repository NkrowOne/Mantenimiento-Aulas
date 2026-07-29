import { useState } from 'react'
import { supabase } from '@/lib/supabase'

/**
 * Qué dice el servidor de mí.
 *
 * Todo esto se sufre en un iPad o en un móvil: ni consola, ni `psql`, ni forma
 * de mirar el token. Y el fallo más caro de este despliegue —el JWT emitido sin
 * el claim `app_role`, que hace que RLS conteste `200 []` a todas las lecturas—
 * se ve exactamente igual que un servidor vacío. Sin una pantalla como esta, la
 * única vía era sospecharlo desde fuera y comprobarlo por otro camino.
 *
 * Son cinco líneas y una llamada, y contestan la pregunta entera:
 *
 *   claim_app_role = null  → el hook de GoTrue no está activo en el servicio de
 *                            auth (GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED).
 *   perfil_existe  = false → la cuenta no tiene fila en `profiles`.
 *   perfil_rol     ≠ el que toca → el alta se hizo sin rol: entra como técnico.
 *   puede_leer     = false → RLS bloquea; es la causa de que no se vea nada.
 */
interface Parte {
  uid: string | null
  claim_app_role: string | null
  rol_efectivo: string
  perfil_existe: boolean
  perfil_rol: string | null
  perfil_activo: boolean | null
  puede_leer: boolean
}

export function Diagnostico(): React.ReactElement {
  const [parte, setParte] = useState<Parte | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cargando, setCargando] = useState(false)

  const consultar = (): void => {
    setCargando(true)
    setError(null)
    void (async () => {
      const { data, error: err } = await supabase.rpc('mi_diagnostico')
      if (err) {
        // Que la propia función no exista ES un diagnóstico: significa que la
        // base no tiene aplicada la migración que la trae.
        setError(
          /function|schema cache|PGRST202/i.test(err.message)
            ? `La API no encuentra mi_diagnostico(): a esta base le faltan migraciones. Ejecuta «migrar» en el servicio. (${err.message})`
            : err.message,
        )
      } else {
        setParte(data as Parte)
      }
      setCargando(false)
    })()
  }

  const fila = (etiqueta: string, valor: string, mal: boolean): React.ReactElement => (
    <li className="flex justify-between gap-3 py-1">
      <span className="text-muted">{etiqueta}</span>
      <span className={`font-mono ${mal ? 'text-crit' : 'text-ink-2'}`}>{valor}</span>
    </li>
  )

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={consultar}
        disabled={cargando}
        className="key key-quiet min-h-11 px-3 text-sm"
      >
        {cargando ? 'Consultando…' : 'Ver diagnóstico del servidor'}
      </button>

      {error && <p className="mt-2 text-sm text-crit">{error}</p>}

      {parte && (
        <>
          <ul className="mt-3 divide-y divide-line text-xs">
            {fila('claim app_role', parte.claim_app_role ?? '(ausente)', !parte.claim_app_role)}
            {fila('rol efectivo', parte.rol_efectivo, parte.rol_efectivo === 'none')}
            {fila('perfil', parte.perfil_existe ? 'existe' : 'NO existe', !parte.perfil_existe)}
            {fila('rol del perfil', parte.perfil_rol ?? '—', !parte.perfil_rol)}
            {fila('perfil activo', parte.perfil_activo === false ? 'no' : 'sí', parte.perfil_activo === false)}
            {fila('puede leer', parte.puede_leer ? 'sí' : 'no', !parte.puede_leer)}
          </ul>

          {/* La conclusión, escrita. Una tabla de valores obliga a saber ya cuál
              de los seis importa; esto dice qué hacer. */}
          <p className="mt-3 text-sm text-muted">
            {!parte.claim_app_role
              ? 'El token llega sin el claim app_role: el hook de GoTrue no está activo. En el servicio de auth, añade GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true y GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI=pg-functions://postgres/public/custom_access_token_hook, reinícialo y vuelve a entrar con el PIN.'
              : !parte.perfil_existe
                ? 'Tu cuenta no tiene perfil. Créalo con: alta crear <tu-email> "<tu nombre>" admin'
                : parte.perfil_activo === false
                  ? 'Tu perfil está desactivado, así que RLS no te deja ver nada.'
                  : !parte.puede_leer
                    ? 'Tienes sesión pero RLS no te deja leer. Revisa el rol de tu perfil.'
                    : `Todo correcto: puedes leer y tu rol es ${parte.rol_efectivo}. Si aún no ves datos, es que el servidor no tiene ninguno cargado.`}
          </p>
        </>
      )}
    </div>
  )
}
