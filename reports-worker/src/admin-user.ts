/**
 * Alta y gestión de usuarios.
 *
 *   npm run admin:user -- crear  ana@x.es "Ana Ruiz" --rol tecnico
 *   npm run admin:user -- crear  jefe@x.es "Jefe" --primer-admin
 *   npm run admin:user -- crear  ana@x.es          # ya existe: código nuevo
 *   npm run admin:user -- codigo ana@x.es          # lo mismo, dicho aparte
 *   npm run admin:user -- rol    ana@x.es supervisor
 *   npm run admin:user -- borrar ana@x.es
 *   npm run admin:user -- listar
 *
 * El email va suelto, sin `--email`, porque esto se teclea entero en la
 * terminal de un panel, sin historial ni autocompletado. Las opciones con
 * nombre siguen valiendo y ganan si se ponen las dos.
 *
 * Una sola implementación para los tres sitios desde los que se administra:
 *
 *   - el repositorio, con `npm run admin:user` (`scripts/admin-user.ts`);
 *   - el worker de informes, con `npm run admin`, que ya es Node;
 *   - el contenedor de la PWA, con `alta`, donde el `Dockerfile` de la raíz la
 *     empaqueta con esbuild porque allí no hay ni repositorio ni node_modules.
 *
 * El tercero es el que importa en un despliegue sobre plataforma: la imagen de
 * servicio es `caddy:2-alpine` con `dist` dentro, y sin esto dar de alta a
 * alguien exigía otra máquina con el repositorio clonado.
 *
 * Copiar el fichero en vez de compartirlo saldría caro: si el alfabeto de los
 * códigos, su hash o su caducidad se separan entre copias, el síntoma es un
 * código que la aplicación no reconoce.
 *
 * Usa la clave de servicio, así que **solo se ejecuta en el servidor**, nunca
 * desde el navegador.
 *
 * Cómo encaja con el login: el código de alta ES la contraseña temporal del
 * usuario en GoTrue. Cuando el técnico lo introduce, `enrollDevice()` de
 * `src/auth/session.ts` (en la PWA) entra con él, lo rota inmediatamente a una
 * contraseña aleatoria fuerte que no se guarda en ningún sitio, y llama a
 * `consume_enrollment_code()`. A partir de ahí la única llave del dispositivo
 * es el refresh token cifrado con el PIN.
 */

import { createClient } from '@supabase/supabase-js'
import { createHash, randomInt } from 'node:crypto'

/**
 * En el contenedor de la PWA no hay `SUPABASE_URL`, pero sí `SUPABASE_UPSTREAM`
 * —el host:puerto de Kong en la red interna—, que es lo que Caddy usa ya para
 * hacer de proxy de la API. Reutilizarlo ahorra una variable de entorno y, de
 * paso, el alta no sale a Internet para hablar con la API de al lado.
 */
function urlDeLaApi(): string | undefined {
  const explicita = process.env['SUPABASE_URL']
  if (explicita) return explicita
  const upstream = process.env['SUPABASE_UPSTREAM']
  if (!upstream) return undefined
  return /^https?:\/\//.test(upstream) ? upstream : `http://${upstream}`
}

/**
 * Cómo se invoca esta orden allí donde se esté ejecutando. Un mensaje de ayuda
 * que sugiere un comando inexistente en ese contenedor no ayuda a nadie: la
 * imagen de la PWA la expone como `alta`, y el repositorio y el worker como
 * script de npm.
 */
const CLI = process.env['ADMIN_CLI'] ?? 'npm run admin:user --'

/** De qué variable ha salido la URL, para poder señalarla si es la equivocada. */
const VARIABLE_DE_LA_URL = process.env['SUPABASE_URL'] ? 'SUPABASE_URL' : 'SUPABASE_UPSTREAM'

const SUPABASE_URL = urlDeLaApi()
const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY']

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    'Falta SUPABASE_SERVICE_ROLE_KEY o la URL de la API.\n' +
      'Este script gestiona usuarios, así que necesita la clave de servicio.\n' +
      'La URL sale de SUPABASE_URL o, en el contenedor de la PWA, de\n' +
      'SUPABASE_UPSTREAM. Desde el repositorio, ejecútalo con el .env cargado.',
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

/** Opciones que no llevan valor detrás; el resto consume el argumento siguiente. */
const BANDERAS = new Set(['primer-admin'])

/**
 * Argumentos sueltos, los que no son ni una opción ni el valor de una.
 *
 * Están porque `alta borrar --email ana@x.es` es más de lo que hace falta
 * escribir en la terminal de un panel, donde no hay historial ni autocompletado
 * y el comando se teclea entero cada vez. El orden es siempre el mismo que en
 * la ayuda: primero el email, luego lo que pida el comando.
 *
 * Las opciones con nombre siguen valiendo, y ganan si aparecen las dos: hay
 * documentación y guiones escritos con ellas, y romperlos por escribir menos
 * sería un mal cambio.
 */
function sueltos(): string[] {
  const resto = process.argv.slice(3)
  const libres: string[] = []
  for (let i = 0; i < resto.length; i++) {
    const token = resto[i]!
    if (!token.startsWith('--')) {
      libres.push(token)
      continue
    }
    // Una opción con valor se lleva por delante el argumento siguiente, que no
    // es suelto por mucho que no empiece por guiones.
    if (!BANDERAS.has(token.slice(2))) i++
  }
  return libres
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

function announce(email: string, code: string, role: Role, renovado = false): void {
  console.log(`
  Usuario:  ${email}
  Rol:      ${role}
  Código:   ${code}
${renovado ? '\n  Ya existía: este código sustituye al anterior, que queda anulado.\n' : ''}
  Caduca en ${CODE_TTL_HOURS} horas y solo sirve una vez.
  El técnico lo introduce junto a su email la primera vez que abre la
  aplicación, y a continuación elige su PIN.

  No vuelve a mostrarse. Si se pierde, genera otro con:
    ${CLI} codigo ${email}
`)
}

/**
 * Da un código nuevo y anula el anterior, que es lo que de verdad hace falta
 * casi siempre. Lo comparten `crear` y `codigo` para que el usuario que ya
 * existe acabe exactamente igual por los dos caminos.
 *
 * Reponer la contraseña temporal invalida el dispositivo anterior sólo si este
 * vuelve a necesitar autenticarse: los refresh tokens vivos siguen
 * funcionando, que es lo que queremos cuando alguien añade un segundo iPad.
 */
async function nuevoCodigo(id: string, email: string, renovado: boolean): Promise<void> {
  const code = generateCode()

  const { error } = await admin.auth.admin.updateUserById(id, { password: code })
  if (error) {
    console.error('No se pudo generar el código:', error.message)
    process.exit(1)
  }

  await storeCode(id, code)

  const { data: profile } = await admin.from('profiles').select('role').eq('id', id).single()
  announce(email, code, (profile?.role as Role) ?? 'tecnico', renovado)
}

/**
 * Alta de un usuario, y **repetible**: si el email ya existe no es un error,
 * es una renovación —código nuevo, el anterior anulado—.
 *
 * Antes fallaba pidiendo que se usara `codigo`, y eso convertía el caso más
 * común —«dicté mal el código», «se lo pasé a quien no era»— en dos comandos y
 * un mensaje de error por el que no hay nada roto. La alternativa que tenía a
 * mano quien no leyera el mensaje era borrar al usuario y volver a crearlo, que
 * es mucho más destructivo de lo que el problema pedía.
 *
 * El rol solo cambia si se pide explícitamente. Sin esa cautela, renovarle el
 * código a un administrador escribiendo `crear` a secas lo degradaría a técnico
 * en silencio, porque `--rol` vale `tecnico` por defecto.
 */
async function crear(): Promise<void> {
  const email = arg('email') ?? sueltos()[0]
  const nombre = arg('nombre') ?? sueltos()[1]
  if (!email) {
    console.error(`Uso: ${CLI} crear <email> "<nombre>" [--rol tecnico|supervisor|admin] [--primer-admin]`)
    process.exit(1)
  }

  const rolPedido: Role | undefined = has('primer-admin') ? 'admin' : arg('rol') ? parseRole(arg('rol')) : undefined

  const existente = await findUserByEmail(email)
  if (existente) {
    // Lo que se haya escrito se aplica; lo que no, se deja como estaba. Un
    // `crear` sin `--rol` no es una petición de degradar a nadie.
    const cambios: { full_name?: string; role?: Role } = {}
    if (nombre) cambios.full_name = nombre
    if (rolPedido) cambios.role = rolPedido
    if (Object.keys(cambios).length > 0) {
      const { error } = await admin.from('profiles').update(cambios).eq('id', existente.id)
      if (error) {
        console.error('No se pudo actualizar el perfil:', error.message)
        process.exit(1)
      }
    }
    await nuevoCodigo(existente.id, email, true)
    return
  }

  // Para un alta de verdad el nombre no es opcional: es lo que se ve en el
  // historial de cada revisión.
  if (!nombre) {
    console.error(`Uso: ${CLI} crear <email> "<nombre>" [--rol tecnico|supervisor|admin] [--primer-admin]`)
    process.exit(1)
  }

  const role: Role = rolPedido ?? 'tecnico'
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
  const email = arg('email') ?? sueltos()[0]
  if (!email) {
    console.error(`Uso: ${CLI} codigo <email>`)
    process.exit(1)
  }

  const user = await findUserByEmail(email)
  if (!user) {
    console.error(`No hay ningún usuario con ${email}.`)
    process.exit(1)
  }

  await nuevoCodigo(user.id, email, true)
}

async function rol(): Promise<void> {
  const email = arg('email') ?? sueltos()[0]
  const nuevo = parseRole(arg('rol') ?? sueltos()[1])
  if (!email) {
    console.error(`Uso: ${CLI} rol <email> tecnico|supervisor|admin`)
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

/**
 * Borra un usuario de verdad: desaparece de GoTrue y, en cascada, su perfil,
 * sus códigos de alta y sus dispositivos.
 *
 * No pregunta «¿seguro?» y no es un descuido: en la terminal del panel el
 * comando corre sin entrada estándar, así que una confirmación interactiva no
 * esperaría a nadie —se quedaría colgada hasta agotar el tiempo—. Lo que sí
 * hace es decir a quién ha borrado, para que un email mal escrito se vea al
 * instante.
 *
 * La base de datos pone el límite y está bien puesto: `by_user`, `opened_by`,
 * `resolved_by` y compañía apuntan a `profiles` sin `on delete`, o sea
 * `no action`. Quien tenga una sola revisión o incidencia a su nombre NO se
 * puede borrar, y el motivo es el de siempre: el historial dice quién hizo
 * qué, y eso es lo que le da valor. Para esos casos la baja es desactivar.
 */
async function borrar(): Promise<void> {
  const email = arg('email') ?? sueltos()[0]
  if (!email) {
    console.error(`Uso: ${CLI} borrar <email>`)
    process.exit(1)
  }

  const user = await findUserByEmail(email)
  if (!user) {
    console.error(`No hay ningún usuario con ${email}.`)
    process.exit(1)
  }

  const { error } = await admin.auth.admin.deleteUser(user.id)
  if (error) {
    console.error(`No se pudo borrar a ${email}: ${error.message}`)
    console.error(`
  Si tiene historial, la base de datos lo impide a propósito: sus revisiones
  e incidencias guardan quién las hizo. La baja de alguien con historial es
  desactivarlo, que le quita el rol y RLS no le deja ver nada:

    update profiles set active = false where email = '${email}';
`)
    process.exit(1)
  }

  console.log(`
  Borrado ${email}.

  Con él se han ido su perfil, sus códigos de alta sin usar y sus
  dispositivos. Si vuelve, es un alta nueva:

    ${CLI} crear ${email} "<nombre>" --rol tecnico
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
const commands: Record<string, () => Promise<void>> = { crear, codigo, rol, borrar, listar }

const run = command ? commands[command] : undefined
if (!run) {
  console.error(`
Uso: ${CLI} <comando> [opciones]

  crear   <email> "<nombre>" [--rol tecnico|supervisor|admin] [--primer-admin]
          Si el email ya existe, le da un código nuevo y anula el anterior.
  codigo  <email>
  rol     <email> tecnico|supervisor|admin
  borrar  <email>
  listar

Las opciones con nombre (--email, --nombre, --rol) siguen valiendo.
`)
  process.exit(1)
}

/**
 * ¿El fallo es de leer como JSON algo que no lo era?
 *
 * Es el síntoma de que la URL configurada no lleva a la puerta de entrada de
 * Supabase, y el mensaje que sale de supabase-js no lo dice por ningún lado:
 * `404 page not found` —el cuerpo con el que responde un proxy escrito en Go
 * cuando ni el host ni la ruta le suenan— llega hasta aquí como «Unexpected
 * non-whitespace character after JSON at position 4», porque `404` es JSON
 * válido hasta que aparece la `p` de `page`. Cierto, y sin una sola pista de
 * dónde mirar.
 */
function esRespuestaNoJson(err: unknown): boolean {
  const mensaje = err instanceof Error ? err.message : String(err)
  return /JSON|Unexpected token|Unexpected end of/i.test(mensaje)
}

/**
 * Quién contesta de verdad en la URL configurada. Cuesta una petición, pero
 * solo se paga cuando algo ya ha fallado: el estado, el tipo de contenido y la
 * primera línea del cuerpo bastan para distinguir «esto es Kong» de «esto es el
 * frontal de la plataforma». La clave viaja al mismo sitio al que ya iba la
 * petición que ha fallado, así que esto no la enseña a nadie nuevo.
 */
async function quienResponde(url: string, clave: string): Promise<string> {
  const sonda = `${url.replace(/\/+$/, '')}/auth/v1/health`
  try {
    const res = await fetch(sonda, { headers: { apikey: clave, Authorization: `Bearer ${clave}` } })
    const cuerpo = (await res.text()).trim().replace(/\s+/g, ' ').slice(0, 160)
    const tipo = res.headers.get('content-type') ?? 'sin content-type'
    return `  ${sonda}\n  responde HTTP ${res.status} (${tipo}): ${cuerpo || '(cuerpo vacío)'}`
  } catch (err) {
    return `  ${sonda}\n  no responde: ${err instanceof Error ? err.message : String(err)}`
  }
}

run().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err)
  if (esRespuestaNoJson(err)) {
    console.error(`
  La API ha contestado algo que no es JSON, así que ${VARIABLE_DE_LA_URL} no
  apunta a la puerta de entrada de Supabase (Kong), o esta no enruta /auth/v1:

${await quienResponde(SUPABASE_URL, SERVICE_KEY)}

  Ahí tiene que ir el host:puerto de Kong en la red privada del despliegue
  (p. ej. kong:8000), NO un dominio público: al salir por el frontal, su
  «404 page not found» vuelve convertido en este error de JSON.
`)
  }
  process.exit(1)
})
