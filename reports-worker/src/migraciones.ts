/**
 * Aplica a la base las migraciones que le falten.
 *
 *   migrar                      # en el contenedor de la PWA, y al arrancar
 *   migrar ./supabase/migrations
 *
 * Hermano de `scripts/init-plataforma.sh`, para el escenario en el que ese
 * script no existe: sobre una plataforma no hay repositorio, ni psql, ni bash
 * —la imagen de servicio es `caddy:2-alpine` con Node dentro para el alta—, y
 * el campo de comando del panel no admite pegar 1.900 líneas de SQL. Sin esto,
 * estrenar la base de un despliegue exige otra máquina con el repositorio
 * clonado y acceso a la red privada.
 *
 * Se ejecuta en cada arranque del contenedor, así que lo importante es que
 * repetirlo no haga nada: el registro en `public.schema_migrations` es el mismo
 * que lleva `init-plataforma.sh`, con los mismos nombres de fichero, de modo
 * que da igual quién de los dos aplicara cada una.
 *
 * NO decide si la aplicación se sirve o no: eso lo decide quien lo llama (ver
 * el `Dockerfile` de la raíz). Aquí solo se informa con el código de salida.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Sql } from 'postgres'
import { conectar } from './db.js'

const DIRECTORIO = process.argv[2] ?? process.env['MIGRACIONES_DIR'] ?? '/opt/migraciones'
const DATABASE_URL = process.env['DATABASE_URL'] ?? ''

/**
 * Cerrojo de asesor sobre la propia base. Un despliegue con dos réplicas las
 * arranca a la vez: sin esto, las dos leerían el registro vacío y aplicarían la
 * misma migración dos veces, y la segunda muere con «already exists» dejando un
 * contenedor caído. El número no significa nada; solo tiene que ser siempre el
 * mismo.
 */
const CERROJO = 20260728

/** Segundos que se espera a que la base acepte conexiones. */
const ESPERA_MAX_S = 30

const say = (m: string): void => console.log(`\n▸ ${m}`)
const ok = (m: string): void => console.log(`  ✓ ${m}`)
const avisa = (m: string): void => console.log(`  ! ${m}`)
const mensaje = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Conecta reintentando: en un despliegue, la base y la aplicación arrancan a la
 * vez y perder la carrera por unos segundos es lo normal, no un fallo.
 */
async function conectarConEspera(): Promise<Sql | null> {
  const hasta = Date.now() + ESPERA_MAX_S * 1000
  let ultimo = ''
  for (;;) {
    const sql = conectar(DATABASE_URL, 1, (aviso) => {
      // Los avisos dicen cosas que importan («pg_cron no disponible: los
      // informes no se programarán»), así que se enseñan; el objeto entero no.
      if (aviso.message) console.log(`    · ${aviso.message}`)
    })
    try {
      await sql`select 1`
      return sql
    } catch (err) {
      ultimo = mensaje(err)
      await sql.end({ timeout: 1 }).catch(() => undefined)
      if (Date.now() >= hasta) {
        avisa(`la base no responde tras ${ESPERA_MAX_S} s: ${ultimo}`)
        return null
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

/**
 * Que la base sea la del despliegue y no otra cualquiera.
 *
 * `profiles` referencia `auth.users` y las políticas de fotos referencian
 * `storage.objects`; los dos esquemas los crean GoTrue y Storage con SUS
 * migraciones al arrancar. Si no están, o van por detrás o DATABASE_URL apunta
 * a otra base — y ese segundo caso es el que hay que cazar aquí: aplicar el
 * esquema entero sobre la base equivocada «funciona», y el destrozo no se ve
 * hasta mucho después.
 */
async function esLaBaseDelDespliegue(sql: Sql): Promise<boolean> {
  const [fila] = await sql<{ auth: boolean; storage: boolean }[]>`
    select to_regclass('auth.users') is not null as auth,
           to_regclass('storage.buckets') is not null as storage`
  if (fila?.auth && fila.storage) return true
  avisa('no existe auth.users o storage.buckets: esta base no es la de la aplicación.')
  avisa('Los crean GoTrue y Storage al arrancar. Si ya lo han hecho, es que')
  avisa('DATABASE_URL apunta a otra base: tiene que ser el Postgres de la pila.')
  return false
}

async function main(): Promise<number> {
  if (!DATABASE_URL) {
    avisa('sin DATABASE_URL: no se aplican migraciones')
    return 0
  }

  let ficheros: string[]
  try {
    ficheros = readdirSync(DIRECTORIO)
      .filter((f) => f.endsWith('.sql'))
      // Alfabético es cronológico: por eso el bootstrap lleva ceros delante.
      .sort()
  } catch (err) {
    avisa(`no se puede leer ${DIRECTORIO}: ${mensaje(err)}`)
    return 0
  }
  if (ficheros.length === 0) {
    avisa(`no hay migraciones en ${DIRECTORIO}`)
    return 0
  }

  say('Migraciones')
  const sql = await conectarConEspera()
  if (!sql) return 1

  try {
    if (!(await esLaBaseDelDespliegue(sql))) return 1

    // El cerrojo va antes de mirar el registro: leerlo y decidir es justo lo
    // que no pueden hacer dos réplicas a la vez.
    await sql`select pg_advisory_lock(${CERROJO})`

    await sql.unsafe(`create table if not exists public.schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now())`)
    const previas = await sql<{ filename: string }[]>`select filename from public.schema_migrations`
    const yaEstaban = new Set(previas.map((r) => r.filename))

    let nuevas = 0
    for (const f of ficheros) {
      if (yaEstaban.has(f)) continue
      console.log(`    ${f}`)
      try {
        // Protocolo simple: todas las sentencias del fichero en un solo envío
        // y, con ello, en una sola transacción implícita. Una migración que
        // falla a la mitad se deshace entera en vez de dejar medio esquema.
        await sql.unsafe(readFileSync(join(DIRECTORIO, f), 'utf8')).simple()
      } catch (err) {
        console.error(`  ✗ ${f}: ${mensaje(err)}`)
        console.error('    «already exists» aquí casi siempre significa que esa migración ya')
        console.error('    estaba aplicada y el registro no lo sabía. Anótala sin ejecutarla:')
        console.error(`    insert into public.schema_migrations (filename) values ('${f}')`)
        return 1
      }
      await sql`insert into public.schema_migrations (filename) values (${f}) on conflict do nothing`
      nuevas++
    }

    await sql`select pg_advisory_unlock(${CERROJO})`
    ok(nuevas === 0 ? 'la base ya estaba al día' : `${nuevas} migraciones nuevas, ${ficheros.length} en total`)

    /*
     * PostgREST lee el esquema al arrancar y lo guarda en memoria: un `create
     * table` posterior no lo cambia, y responde «Could not find the table
     * 'public.profiles' in the schema cache» a todo, con la tabla delante.
     * Esta notificación es la que le dice que vuelva a mirar, y aquí es donde
     * toca, porque acabar de migrar es justo cuando su caché queda vieja.
     *
     * Se manda SIEMPRE, también cuando no se ha aplicado nada, porque el caso
     * que deja a alguien atascado es ese: migrar, tropezar con el error
     * después, y volver a ejecutar esto para que conteste «ya estaba al día»
     * sin arreglar nada.
     *
     * Es un aviso, no una orden: si PostgREST no escucha ese canal
     * (`PGRST_DB_CHANNEL_ENABLED` en false) esto no falla y el remedio es
     * reiniciar su servicio. Por eso se dice lo que se ha hecho en vez de dar
     * por hecho que ha surtido efecto.
     */
    try {
      await sql.notify('pgrst', 'reload schema')
      ok('avisado a PostgREST de que recargue el esquema')
    } catch (err) {
      avisa(`no se ha podido avisar a PostgREST (${mensaje(err)}): reinicia su servicio si la API no ve las tablas`)
    }

    return 0
  } catch (err) {
    console.error(`  ✗ ${mensaje(err)}`)
    return 1
  } finally {
    // Cerrar la conexión suelta el cerrojo aunque algo haya reventado antes.
    await sql.end({ timeout: 5 }).catch(() => undefined)
  }
}

// Sin `await` de primer nivel a propósito: la imagen de la PWA empaqueta esto
// con esbuild en formato CJS, que no lo admite.
void main().then((codigo) => {
  process.exitCode = codigo
})
