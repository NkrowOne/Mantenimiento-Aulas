/**
 * Diagnostica, completa y verifica las variables del despliegue.
 *
 *   npm run variables                 # lee el entorno y el .env si existe
 *   DATABASE_URL=... npm run variables
 *
 * Hermano de `gen-keys.ts`, pero para el caso contrario. `gen-keys` parte de
 * cero y crea un despliegue nuevo. Esto parte de uno que **ya existe** —una
 * plataforma que levantó Supabase por ti— y donde regenerar el `JWT_SECRET`
 * sería destructivo: invalidaría de golpe las claves que ya usan GoTrue,
 * PostgREST y Storage, y el sistema dejaría de aceptar ni un solo token.
 *
 * De ahí la regla que gobierna todo el fichero: **generar solo lo que no puede
 * romper nada**. Un secreto que ya existe se verifica; nunca se sustituye.
 *
 * Lo que sí puede deducir, que es donde está la gracia: dado el `JWT_SECRET`,
 * las claves `anon` y `service_role` no son valores que haya que buscar en
 * ningún panel, son JWT firmados con él. Se calculan.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

// ── Utilidades de JWT ──────────────────────────────────────────────────────

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const signature = base64url(createHmac('sha256', secret).update(`${header}.${body}`).digest())
  return `${header}.${body}.${signature}`
}

interface Claims {
  role?: string
  exp?: number
  iss?: string
}

/** Las partes de un JWT, sin comprobar la firma. */
function decodeJwt(token: string): Claims | null {
  const partes = token.split('.')
  if (partes.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(partes[1]!, 'base64url').toString('utf8')) as Claims
  } catch {
    return null
  }
}

/** ¿La firma corresponde a este secreto? Comparación en tiempo constante. */
function firmaValida(token: string, secret: string): boolean {
  const partes = token.split('.')
  if (partes.length !== 3) return false
  const esperada = Buffer.from(
    base64url(createHmac('sha256', secret).update(`${partes[0]}.${partes[1]}`).digest()),
  )
  const recibida = Buffer.from(partes[2]!)
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida)
}

// ── Recolección ────────────────────────────────────────────────────────────

const env: Record<string, string> = { ...(process.env as Record<string, string>) }
const origen: Record<string, string> = {}
for (const k of Object.keys(env)) origen[k] = 'entorno'

// El `.env` no pisa al entorno: si has exportado algo a mano, mandas tú.
if (existsSync('.env')) {
  for (const linea of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(linea)
    if (!m) continue
    const [, k, bruto] = m
    const v = bruto!.trim().replace(/^["']|["']$/g, '')
    if (v && !env[k!]) {
      env[k!] = v
      origen[k!] = '.env'
    }
  }
}

const notas: string[] = []
const problemas: string[] = []

// ── Detección desde la base de datos ───────────────────────────────────────
//
// `supabase/postgres` deja el secreto en un parámetro de la base. No siempre
// está —depende de cómo lo haya montado la plataforma— así que es un intento,
// no un requisito.
function psql(sql: string): string | null {
  if (!env['DATABASE_URL']) return null
  try {
    return execFileSync('psql', [env['DATABASE_URL'], '-tAc', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Sin límite, un host inalcanzable —un nombre mal escrito, un cortafuegos,
      // la base aún arrancando— deja esto colgado minutos sin decir nada. Un
      // diagnóstico que se queda pensando es peor que uno que falla rápido.
      // El cinturón y los tirantes: libpq deja de esperar a los 5 segundos, y
      // si aun así no vuelve, el proceso muere a los 15.
      env: { ...process.env, PGCONNECT_TIMEOUT: '5' },
      timeout: 15_000,
    }).trim()
  } catch {
    return null
  }
}

if (env['DATABASE_URL']) {
  const vivo = psql('select 1')
  if (vivo !== '1') {
    problemas.push('DATABASE_URL no conecta; se omite todo lo que se detecta desde la base')
  } else {
    notas.push(`base de datos accesible (${psql("select split_part(version(), ' ', 2)")})`)

    if (!env['JWT_SECRET']) {
      const s = psql("select current_setting('app.settings.jwt_secret', true)")
      if (s) {
        env['JWT_SECRET'] = s
        origen['JWT_SECRET'] = 'base de datos'
      }
    }

    // El token del worker ya acordado. Reutilizarlo evita el clásico de
    // cambiarlo en un sitio y no en el otro, que da 401 sin explicar nada.
    const tokenBD = psql("select value from app_config where key = 'reports_worker_token'")
    if (tokenBD && tokenBD !== 'cambiame-en-produccion') {
      if (!env['REPORTS_WORKER_TOKEN']) {
        env['REPORTS_WORKER_TOKEN'] = tokenBD
        origen['REPORTS_WORKER_TOKEN'] = 'base de datos (app_config)'
      } else if (env['REPORTS_WORKER_TOKEN'] !== tokenBD) {
        problemas.push(
          'REPORTS_WORKER_TOKEN no coincide con app_config.reports_worker_token: los informes programados darán 401',
        )
      }
    }

    const urlBD = psql("select value from app_config where key = 'reports_worker_url'")
    if (urlBD?.includes('reports-worker:8080')) {
      problemas.push(
        `app_config.reports_worker_url sigue en «${urlBD}», que es el nombre interno del compose y no existe en tu plataforma`,
      )
    }
  }
}

// ── JWT_SECRET: se verifica, no se inventa ─────────────────────────────────

const jwtSecret = env['JWT_SECRET']
if (!jwtSecret) {
  problemas.push(
    'Falta JWT_SECRET. Es el único que NO se puede generar aquí: tu Supabase ya tiene uno y ' +
      'cambiarlo invalidaría las claves de GoTrue, PostgREST y Storage a la vez. Cópialo del panel ' +
      'de la plataforma (o del servicio de auth, GOTRUE_JWT_SECRET) y vuelve a ejecutar esto.',
  )
} else if (jwtSecret.length < 32) {
  problemas.push(`JWT_SECRET tiene ${jwtSecret.length} caracteres; GoTrue espera al menos 32`)
}

// ── anon y service_role: deducibles del secreto ────────────────────────────

function claveApi(nombre: string, rolEsperado: string): string | undefined {
  const actual = env[nombre]

  if (actual) {
    const claims = decodeJwt(actual)
    if (!claims) {
      problemas.push(`${nombre} no es un JWT válido`)
      return actual
    }
    if (claims.role !== rolEsperado) {
      problemas.push(`${nombre} lleva role='${claims.role}' y debería ser '${rolEsperado}'`)
    }
    if (claims.exp && claims.exp * 1000 < Date.now()) {
      problemas.push(`${nombre} está caducada (exp ${new Date(claims.exp * 1000).toISOString().slice(0, 10)})`)
    }
    if (jwtSecret) {
      if (firmaValida(actual, jwtSecret)) {
        notas.push(`${nombre} verificada contra JWT_SECRET`)
      } else {
        problemas.push(
          `${nombre} NO está firmada con este JWT_SECRET. O la clave es de otro despliegue —copiarlas ` +
            `de un tutorial es el error clásico en self-hosted— o el secreto no es el que usa tu Supabase.`,
        )
      }
    } else {
      notas.push(`${nombre} presente, sin verificar (falta JWT_SECRET)`)
    }
    return actual
  }

  if (!jwtSecret) return undefined

  // Diez años: son claves de infraestructura, no sesiones. Rotarlas obliga a
  // reconstruir el front, así que una caducidad corta solo asegura una caída
  // futura en mal momento.
  const iat = Math.floor(Date.now() / 1000)
  const generada = signJwt(
    { role: rolEsperado, iss: 'supabase', iat, exp: iat + 10 * 365 * 24 * 3600 },
    jwtSecret,
  )
  origen[nombre] = 'deducida del JWT_SECRET'
  notas.push(`${nombre} calculada a partir del secreto (no hacía falta buscarla)`)
  return generada
}

const anonKey = claveApi('ANON_KEY', 'anon')
const serviceKey = claveApi('SERVICE_ROLE_KEY', 'service_role')

// La que se compila en el bundle tiene que ser la misma. Es un fallo fácil:
// se cambia una y no la otra, y el front queda hablando con credenciales viejas.
if (env['VITE_SUPABASE_ANON_KEY'] && anonKey && env['VITE_SUPABASE_ANON_KEY'] !== anonKey) {
  problemas.push('VITE_SUPABASE_ANON_KEY y ANON_KEY no coinciden')
}

// ── Token del worker: este sí se genera sin riesgo ─────────────────────────

let workerToken = env['REPORTS_WORKER_TOKEN']
if (!workerToken) {
  workerToken = randomBytes(24).toString('base64url')
  origen['REPORTS_WORKER_TOKEN'] = 'generado'
  notas.push('REPORTS_WORKER_TOKEN generado (no existía en ningún sitio)')
} else if (workerToken.length < 16) {
  problemas.push(`REPORTS_WORKER_TOKEN tiene ${workerToken.length} caracteres; el worker exige 16 o más`)
}

// ── Avisos sobre la conexión ───────────────────────────────────────────────

if (env['DATABASE_URL']) {
  try {
    const u = new URL(env['DATABASE_URL'])
    if (u.port === '6543' || u.hostname.includes('pooler.')) {
      notas.push('DATABASE_URL apunta al pooler; el worker desactiva las preparadas solo (ver reports-worker/src/db.ts)')
    }
  } catch {
    // `new URL` rechaza formas que libpq acepta de sobra —la de socket local,
    // sin ir más lejos—. Esto solo sirve para avisar del pooler, así que no
    // poder analizarla no es un problema: quien decide si la cadena vale es la
    // conexión, y esa ya se ha probado más arriba.
  }
}

if (!env['SUPABASE_UPSTREAM']) {
  problemas.push(
    'Falta SUPABASE_UPSTREAM (host:puerto de Kong en la red privada, p. ej. kong.interno:8000). ' +
      'Sin él Caddy no sabe a dónde mandar /rest, /auth y /storage.',
  )
}

// ── Salida ─────────────────────────────────────────────────────────────────

const V = '\x1b[32m✓\x1b[0m'
const X = '\x1b[31m✗\x1b[0m'
const B = (s: string): string => `\x1b[1m${s}\x1b[0m`

console.log(`\n${B('▸ Lo que he encontrado')}`)
for (const k of ['JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'REPORTS_WORKER_TOKEN', 'DATABASE_URL', 'SUPABASE_UPSTREAM']) {
  const tiene = k === 'ANON_KEY' ? anonKey : k === 'SERVICE_ROLE_KEY' ? serviceKey : k === 'REPORTS_WORKER_TOKEN' ? workerToken : env[k]
  console.log(`  ${tiene ? V : X} ${k.padEnd(22)} ${tiene ? `\x1b[2m${origen[k] ?? 'entorno'}\x1b[0m` : '\x1b[31mfalta\x1b[0m'}`)
}

if (notas.length) {
  console.log(`\n${B('▸ Comprobado')}`)
  for (const n of notas) console.log(`  ${V} ${n}`)
}

if (problemas.length) {
  console.log(`\n${B('▸ Hay que resolver esto')}`)
  for (const p of problemas) console.log(`  ${X} ${p}`)
}

if (anonKey && serviceKey) {
  console.log(`
${B('▸ Servicio del front')}   \x1b[2m(la clave es argumento de CONSTRUCCIÓN, no de ejecución)\x1b[0m

VITE_SUPABASE_ANON_KEY=${anonKey}
SUPABASE_UPSTREAM=${env['SUPABASE_UPSTREAM'] ?? '<host:puerto de Kong en la red privada>'}
SUPABASE_SERVICE_ROLE_KEY=${serviceKey}   \x1b[2m(solo para \`alta\`; la PWA no la usa)\x1b[0m

${B('▸ Servicio del worker de informes')}

DATABASE_URL=${env['DATABASE_URL'] ?? '<cadena de conexión>'}
SUPABASE_URL=${env['SUPABASE_URL'] ?? '<la URL pública del FRONT, que hace de proxy>'}
SUPABASE_SERVICE_ROLE_KEY=${serviceKey}
WORKER_TOKEN=${workerToken}
PORT=8080

${B('▸ Y en la base de datos')}

update app_config set value = '${workerToken}' where key = 'reports_worker_token';
update app_config set value = 'http://<worker>.interno:8080/generate' where key = 'reports_worker_url';

\x1b[2mO, más corto, dejando que lo haga el inicializador:\x1b[0m
  REPORTS_WORKER_TOKEN=${workerToken} npm run init:plataforma
`)
}

// Salir con error si algo bloquea: así esto encaja en un script mayor sin que
// un fallo pase por bueno.
process.exit(problemas.length ? 1 : 0)
