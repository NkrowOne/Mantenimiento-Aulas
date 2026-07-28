/**
 * Genera el secreto JWT y las dos claves de API de Supabase.
 *
 *   npx tsx scripts/gen-keys.ts
 *
 * Las claves `anon` y `service_role` no son valores mágicos: son JWT firmados
 * con el `JWT_SECRET` del despliegue. Copiarlas de un tutorial —cosa habitual
 * en self-hosted— significa desplegar con un secreto que conoce todo internet.
 *
 * Se firma HS256 a mano con `crypto` para no añadir una dependencia a un
 * script que se ejecuta una vez en la vida del servidor.
 */

import { createHmac, randomBytes } from 'node:crypto'

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const signature = base64url(createHmac('sha256', secret).update(`${header}.${body}`).digest())
  return `${header}.${body}.${signature}`
}

/**
 * 40 caracteres alfanuméricos, que es lo que espera GoTrue y usa el compose
 * oficial. Se genera con rechazo en lugar de filtrando un base64: al quitar los
 * caracteres no alfanuméricos de un base64 el resultado se queda corto de forma
 * impredecible —salían 38 caracteres— y el secreto acaba con menos entropía de
 * la que aparenta.
 */
function randomAlphanumeric(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      // 62 no divide a 256: descartar el resto evita sesgar hacia los primeros
      // caracteres del alfabeto.
      if (byte < 248) out += alphabet[byte % 62]
      if (out.length === length) break
    }
  }
  return out
}

const jwtSecret = randomAlphanumeric(40)
const postgresPassword = randomBytes(24).toString('base64url')
const workerToken = randomBytes(24).toString('base64url')

const issuedAt = Math.floor(Date.now() / 1000)
// Diez años: son claves de infraestructura, no sesiones de usuario. Rotarlas
// obliga a reconstruir el front, así que una caducidad corta solo garantiza
// una caída futura en un momento inoportuno.
const expiresAt = issuedAt + 10 * 365 * 24 * 3600

const anonKey = signJwt({ role: 'anon', iss: 'supabase', iat: issuedAt, exp: expiresAt }, jwtSecret)
const serviceKey = signJwt(
  { role: 'service_role', iss: 'supabase', iat: issuedAt, exp: expiresAt },
  jwtSecret,
)

console.log(`
# ─────────────────────────────────────────────────────────────────────
# Generado por scripts/gen-keys.ts — pégalo en tu .env
#
# SUPABASE_SERVICE_ROLE_KEY se salta RLS por completo: trátala como la
# contraseña de root. Nunca en el front, nunca en un commit.
# ─────────────────────────────────────────────────────────────────────

POSTGRES_PASSWORD=${postgresPassword}
JWT_SECRET=${jwtSecret}
ANON_KEY=${anonKey}
SERVICE_ROLE_KEY=${serviceKey}
REPORTS_WORKER_TOKEN=${workerToken}

# El front solo necesita estas dos, y ambas son públicas por diseño:
VITE_SUPABASE_URL=https://\${DOMAIN}
VITE_SUPABASE_ANON_KEY=${anonKey}
`)
