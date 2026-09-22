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
 *   claim_app_role = null  → el hook de GoTrue no está activo. **No es un fallo
 *                            por sí solo**: `auth_role()` mira el perfil cuando
 *                            el claim no viene, y eso existe justo para esto.
 *                            Solo importa si además `puede_leer` es false.
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
  /**
   * Las migraciones que la base tiene anotadas. `null` es una base sin
   * registro; ausente, un servidor cuya función de diagnóstico es anterior a
   * que se contara esto. Se compara con `__MIGRACIONES__`, la lista con la que
   * se compiló esta versión, porque «al servidor le falta una migración» tiene
   * que ser una lista y no una sospecha: el 21 de septiembre los cierres de
   * avería se quedaban en la cola por una columna que la base no tenía y desde
   * el móvil no había forma de saber cuál ni por qué.
   */
  migraciones?: string[] | null
}

/** Las que esta versión de la aplicación necesita y la base no anota. */
function migracionesQueFaltan(parte: Parte): string[] {
  if (!parte.migraciones) return []
  const anotadas = new Set(parte.migraciones)
  return __MIGRACIONES__.filter((m) => !anotadas.has(m))
}

/**
 * Lo que el propio servidor de la PWA dice de sí mismo (`/salud.json`).
 *
 * Es la única fuente que sigue contestando cuando la base está vieja: lo
 * escribe el arranque del contenedor con lo que hay en su entorno, sin tocar
 * Postgres. Ahí se ve el caso que costó dos semanas de avería —el servicio sin
 * `DATABASE_URL`, que por tanto nunca migra la base y lo venía diciendo como
 * «al dia»—, y que `mi_diagnostico()` no puede contar porque vive justo en la
 * migración que falta.
 */
interface Salud {
  estado?: string
  commit?: string | null
  ejecucion?: { migraciones?: string }
  faltan?: string[]
}

const MIGRACIONES_LEGIBLE: Record<string, string> = {
  'al dia': 'aplicadas y comprobadas contra el esquema',
  fallidas: 'fallaron al aplicarse',
  'sin comprobar': 'este servidor NO migra la base',
  'esquema no cuadra': 'anotadas, pero la base no las tiene',
}

export function Diagnostico(): React.ReactElement {
  const [parte, setParte] = useState<Parte | null>(null)
  const [salud, setSalud] = useState<Salud | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cargando, setCargando] = useState(false)

  const consultar = (): void => {
    setCargando(true)
    setError(null)
    void (async () => {
      /*
       * El informe del propio servidor, antes que la base: si el servicio no
       * migra, todo lo que conteste la base es de una versión anterior y hay
       * que decirlo ANTES de leer nada más. No puede tumbar el diagnóstico —en
       * desarrollo `salud.json` ni existe—, así que su fallo se traga.
       */
      try {
        const res = await fetch('/salud.json', { cache: 'no-store' })
        setSalud(res.ok ? ((await res.json()) as Salud) : null)
      } catch {
        setSalud(null)
      }

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

      {/* Lo primero, y en rojo: un servidor que no migra la base hace que todo
          lo demás de esta pantalla hable de una versión que no es la que la
          aplicación necesita. */}
      {salud?.ejecucion?.migraciones === 'sin comprobar' && (
        <div className="card mt-3 border-crit p-4 text-sm">
          <p className="font-semibold text-crit">Este servidor no migra la base.</p>
          <p className="mt-1 text-muted">
            Al servicio de la aplicación le falta la variable{' '}
            <span className="font-mono">DATABASE_URL</span>, así que al arrancar no toca la base: se
            queda en la versión que tuviera, y seguirá igual en cada despliegue. Es lo que hace que
            la aplicación pida columnas y funciones que el servidor no tiene.
          </p>
          <p className="mt-2 text-muted">
            Añade <span className="font-mono">DATABASE_URL</span> (el Postgres de la pila) a las
            variables de <em>este</em> servicio y vuelve a desplegar. O lánzalo a mano desde su
            terminal: <span className="font-mono">DATABASE_URL=postgres://… migrar</span>
          </p>
        </div>
      )}
      {salud?.ejecucion?.migraciones === 'esquema no cuadra' && (
        <div className="card mt-3 border-crit p-4 text-sm">
          <p className="font-semibold text-crit">La base no tiene las migraciones que dice tener.</p>
          <p className="mt-1 text-muted">
            El registro las da por aplicadas y las funciones de la base son otras: pasa cuando
            alguien las anota para salir de un atasco sin llegar a ejecutarlas. Es lo que hace que
            el Excel rechace plantas, que el almacén no entienda «Stock Disponible» o que un cierre
            de avería se quede en la cola.
          </p>
          <p className="mt-2 text-muted">
            En la terminal del servicio, <span className="font-mono">migrar</span> dice qué
            funciones y con qué orden se arregla cada fichero:{' '}
            <span className="font-mono">migrar --reaplicar &lt;fichero&gt;.sql</span>
          </p>
        </div>
      )}
      {salud?.ejecucion?.migraciones === 'fallidas' && (
        <div className="card mt-3 border-crit p-4 text-sm">
          <p className="font-semibold text-crit">Las migraciones fallaron al arrancar.</p>
          <p className="mt-1 text-muted">
            La base puede no tener las tablas ni las funciones que la aplicación va a pedir.
            Relánzalas desde la terminal del servicio con <span className="font-mono">migrar</span>{' '}
            y lee lo que conteste: lo dice en una línea.
          </p>
        </div>
      )}

      {parte && (
        <>
          <ul className="mt-3 divide-y divide-line text-xs">
            {/*
              El claim ausente NO se pinta en rojo si el rol se resolvió igual.
              `auth_role()` mira el perfil cuando el claim no viene —existe justo
              para eso—, así que un despliegue que funciona perfectamente enseñaba
              una línea en rojo y, debajo, un párrafo mandando tocar variables de
              entorno del servicio de auth. Se busca una avería que no está
              mientras la de verdad, si la hay, queda tapada.
            */}
            {fila(
              'claim app_role',
              parte.claim_app_role ?? '(ausente, se usa el perfil)',
              !parte.claim_app_role && !parte.puede_leer,
            )}
            {fila('rol efectivo', parte.rol_efectivo, parte.rol_efectivo === 'none')}
            {fila('perfil', parte.perfil_existe ? 'existe' : 'NO existe', !parte.perfil_existe)}
            {fila('rol del perfil', parte.perfil_rol ?? '—', !parte.perfil_rol)}
            {fila('perfil activo', parte.perfil_activo === false ? 'no' : 'sí', parte.perfil_activo === false)}
            {fila('puede leer', parte.puede_leer ? 'sí' : 'no', !parte.puede_leer)}
            {salud?.ejecucion?.migraciones &&
              fila(
                'migraciones al arrancar',
                MIGRACIONES_LEGIBLE[salud.ejecucion.migraciones] ?? salud.ejecucion.migraciones,
                salud.ejecucion.migraciones !== 'al dia',
              )}
            {parte.migraciones !== undefined &&
              fila(
                'migraciones en la base',
                parte.migraciones === null ? 'sin registro' : `${parte.migraciones.length} anotadas`,
                parte.migraciones === null,
              )}
            {migracionesQueFaltan(parte).length > 0 &&
              fila('migraciones que faltan', String(migracionesQueFaltan(parte).length), true)}
          </ul>

          {migracionesQueFaltan(parte).length > 0 && (
            <div className="mt-3 text-sm">
              <p className="text-crit">
                A esta base le faltan {migracionesQueFaltan(parte).length} migraciones que esta versión
                de la aplicación necesita. Mientras tanto, lo que la aplicación mande con columnas
                nuevas se queda en la cola, con el motivo a la vista en la lámpara.
              </p>
              <ul className="mt-1 font-mono text-xs text-muted">
                {migracionesQueFaltan(parte).map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
              <p className="mt-1 text-muted">
                En el servidor: <span className="font-mono">./scripts/deploy.sh</span> (o{' '}
                <span className="font-mono">npm run init:plataforma</span> sobre una plataforma). Si
                el registro anota como aplicada una que no corrió, ejecútala a mano con psql,
                anótala y reinicia la API.
              </p>
            </div>
          )}
          {parte.migraciones === undefined && (
            <p className="mt-2 text-xs text-muted">
              Este servidor no dice qué migraciones tiene: su función de diagnóstico es anterior.
              Le falta, al menos, la migración 20260921000400.
            </p>
          )}

          {/*
            La conclusión, escrita. Una tabla de valores obliga a saber ya cuál
            de los seis importa; esto dice qué hacer.

            Y el orden de las ramas ES el diagnóstico. La del claim iba primera,
            así que se llevaba por delante a todas las demás: con el hook sin
            activar —que es lo normal sobre una plataforma— la pantalla decía
            «añade estas dos variables» aunque el rol estuviera bien, se pudiera
            leer y no pasara absolutamente nada. Ahora lo que manda es si se
            puede leer o no, que es la pregunta que trae aquí a la gente.
          */}
          <p className="mt-3 text-sm text-muted">
            {!parte.perfil_existe
              ? 'Tu cuenta no tiene perfil. Créalo con: alta crear <tu-email> "<tu nombre>" admin'
              : parte.perfil_activo === false
                ? 'Tu perfil está desactivado, así que RLS no te deja ver nada.'
                : !parte.puede_leer
                  ? !parte.claim_app_role
                    ? 'RLS no te deja leer y el token llega sin el claim app_role. En el servicio de auth, añade GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true y GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI=pg-functions://postgres/public/custom_access_token_hook, reinícialo y vuelve a entrar con el PIN.'
                    : 'Tienes sesión pero RLS no te deja leer. Revisa el rol de tu perfil.'
                  : `Todo correcto: puedes leer y tu rol es ${parte.rol_efectivo}. Si aún no ves datos, es que el servidor no tiene ninguno cargado.`}
          </p>

          {/* El apunte del hook, cuando no hay nada roto: es una optimización
              pendiente, no una avería, y decirlo con ese peso evita que alguien
              se pase la mañana tocando el servicio de auth sin motivo. */}
          {parte.puede_leer && !parte.claim_app_role && (
            <p className="mt-2 text-xs text-muted">
              El token no trae el claim <span className="font-mono">app_role</span>, así que el rol
              se resuelve leyendo tu perfil. Funciona —lo estás viendo— y activar el hook de GoTrue
              solo ahorra esa consulta.
            </p>
          )}
        </>
      )}
    </div>
  )
}
