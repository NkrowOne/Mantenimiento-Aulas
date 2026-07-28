/**
 * Alta y gestión de usuarios.
 *
 *   npm run admin:user -- crear  --email ana@x.es --nombre "Ana Ruiz" --rol tecnico
 *   npm run admin:user -- crear  --email jefe@x.es --nombre "Jefe" --primer-admin
 *   npm run admin:user -- codigo --email ana@x.es          # nuevo código de alta
 *   npm run admin:user -- rol    --email ana@x.es --rol supervisor
 *   npm run admin:user -- listar
 *
 * Usa la clave de servicio, así que **solo se ejecuta en el servidor**, nunca
 * desde el navegador.
 *
 * Cómo encaja con el login: el código de alta ES la contraseña temporal del
 * usuario en GoTrue. Cuando el técnico lo introduce, `enrollDevice()` de
 * `src/auth/session.ts` entra con él, lo rota inmediatamente a una contraseña
 * aleatoria fuerte que no se guarda en ningún sitio, y llama a
 * `consume_enrollment_code()`. A partir de ahí la única llave del dispositivo
 * es el refresh token cifrado con el PIN.
 */

import { createClient } from '@supabase/supabase-js'
import { createHash, randomInt } from 'node:crypto'

const SUPABASE_URL = process.env['SUPABASE_URL']
const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY']

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    'Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.\n' +
      'Este script gestiona usuarios, así que necesita la clave de servicio.\n' +
      'Ejecútalo en el servidor, con el .env cargado.',
  )
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** Horas que dura un código antes de caducar. */
const CODE_TTL_HOURS = 24

/**
 * Alfabeto sin caracteres confundibles: nada de O/0, I/1/l, S/5.
 * El código se dicta en voz alta o se apunta en un papel, y un carácter ambiguo
 * se traduce en una llamada al admin.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ2346789'

function generateCode(): string {
  const pick = (): string => ALPHABET[randomInt(ALPHABET.length)]!
  const group = (): string => Array.from({ length: 4 }, pick).join('')
  return `${group()}-${group()}-${group()}`
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

type Role = 'tecnico' | 'supervisor' | 'admin'

function parseRole(value: string | undefined, fallback: Role = 'tecnico'): Role {
  if (!value) return fallback
  if (value === 'tecnico' || value === 'supervisor' || value === 'admin') return value
  console.error(`Rol no válido: "${value}". Usa tecnico, supervisor o admin.`)
  process.exit(1)
}

async function findUserByEmail(email: string): Promise<{ id: string } | null> {
  // La API de administración pagina; con un equipo de este tamaño una página
  // amplia basta y evita complicar el script con un bucle.
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) throw error
  const user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
  return user ? { id: user.id } : null
}

/** Registra el código y caduca los anteriores del mismo usuario. */
async function storeCode(profileId: string, code: string): Promise<void> {
  await admin
    .from('enrollment_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('profile_id', profileId)
    .is('consumed_at', null)

  const expires = new Date(Date.now() + CODE_TTL_HOURS * 3600_000)
  const { error } = await admin.from('enrollment_codes').insert({
    profile_id: profileId,
    code_hash: hashCode(code),
    expires_at: expires.toISOString(),
  })
  if (error) throw error
}

function announce(email: string, code: string, role: Role): void {
  console.log(`
  Usuario:  ${email}
  Rol:      ${role}
  Código:   ${code}

  Caduca en ${CODE_TTL_HOURS} horas y solo sirve una vez.
  El técnico lo introduce junto a su email la primera vez que abre la
  aplicación, y a continuación elige su PIN.

  No vuelve a mostrarse. Si se pierde, genera otro con:
    npm run admin:user -- codigo --email ${email}
`)
}

async function crear(): Promise<void> {
  const email = arg('email')
  const nombre = arg('nombre')
  if (!email || !nombre) {
    console.error('Uso: crear --email <email> --nombre "<nombre>" [--rol tecnico|supervisor|admin]')
    process.exit(1)
  }

  const role: Role = has('primer-admin') ? 'admin' : parseRole(arg('rol'))

  if (await findUserByEmail(email)) {
    console.error(`Ya existe un usuario con ${email}. Para darle un código nuevo:`)
    console.error(`  npm run admin:user -- codigo --email ${email}`)
    process.exit(1)
  }

  const code = generateCode()

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: code,
    // Sin SMTP no hay forma de confirmar por correo, y el alta la hace un
    // administrador en persona: la confirmación ya la aporta él.
    email_confirm: true,
    user_metadata: { full_name: nombre, role },
  })
  if (error || !data.user) {
    console.error('No se pudo crear el usuario:', error?.message)
    process.exit(1)
  }

  // `handle_new_user()` crea el perfil con el rol de user_metadata. Se relee
  // para confirmarlo en vez de suponer que el trigger hizo lo esperado.
  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', data.user.id)
    .single()

  if (profile?.role !== role) {
    await admin.from('profiles').update({ role, full_name: nombre }).eq('id', data.user.id)
  }

  await storeCode(data.user.id, code)
  announce(email, code, role)
}

async function codigo(): Promise<void> {
  const email = arg('email')
  if (!email) {
    console.error('Uso: codigo --email <email>')
    process.exit(1)
  }

  const user = await findUserByEmail(email)
  if (!user) {
    console.error(`No hay ningún usuario con ${email}.`)
    process.exit(1)
  }

  const code = generateCode()

  // Reponer la contraseña temporal invalida el dispositivo anterior sólo si
  // este vuelve a necesitar autenticarse: los refresh tokens vivos siguen
  // funcionando, que es lo que queremos cuando alguien añade un segundo iPad.
  const { error } = await admin.auth.admin.updateUserById(user.id, { password: code })
  if (error) {
    console.error('No se pudo generar el código:', error.message)
    process.exit(1)
  }

  await storeCode(user.id, code)

  const { data: profile } = await admin.from('profiles').select('role').eq('id', user.id).single()
  announce(email, code, (profile?.role as Role) ?? 'tecnico')
}

async function rol(): Promise<void> {
  const email = arg('email')
  const nuevo = parseRole(arg('rol'))
  if (!email) {
    console.error('Uso: rol --email <email> --rol tecnico|supervisor|admin')
    process.exit(1)
  }

  const user = await findUserByEmail(email)
  if (!user) {
    console.error(`No hay ningún usuario con ${email}.`)
    process.exit(1)
  }

  const { error } = await admin.from('profiles').update({ role: nuevo }).eq('id', user.id)
  if (error) {
    console.error('No se pudo cambiar el rol:', error.message)
    process.exit(1)
  }

  console.log(`
  ${email} pasa a ser ${nuevo}.

  El rol viaja dentro del token, así que el cambio se aplica cuando se
  renueve: puede tardar hasta una hora, o de inmediato si cierra y vuelve
  a entrar con su PIN.
`)
}

async function listar(): Promise<void> {
  const { data, error } = await admin
    .from('profiles')
    .select('email, full_name, role, active')
    .order('role')
  if (error) {
    console.error(error.message)
    process.exit(1)
  }

  console.log('')
  for (const p of data ?? []) {
    const estado = p.active ? '' : '  (desactivado)'
    console.log(`  ${String(p.role).padEnd(11)} ${String(p.email).padEnd(32)} ${p.full_name}${estado}`)
  }
  console.log(`\n  ${data?.length ?? 0} usuarios\n`)
}

const command = process.argv[2]
const commands: Record<string, () => Promise<void>> = { crear, codigo, rol, listar }

const run = command ? commands[command] : undefined
if (!run) {
  console.error(`
Uso: npm run admin:user -- <comando> [opciones]

  crear   --email <e> --nombre "<n>" [--rol <r>] [--primer-admin]
  codigo  --email <e>
  rol     --email <e> --rol tecnico|supervisor|admin
  listar
`)
  process.exit(1)
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
