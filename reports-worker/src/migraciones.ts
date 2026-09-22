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
import { desajustes, esRepetible, funcionesDe, versionVigente } from './esquema.js'

/**
 * `migrar --reaplicar <fichero>`: vuelve a ejecutar una migración que el
 * registro da por aplicada y el esquema desmiente.
 *
 * Existe porque el atajo que había —anotarla en `schema_migrations` sin
 * ejecutarla— es justo lo que ha causado la avería dos veces. Éste hace lo
 * contrario: ejecuta de verdad, y solo si el fichero se puede repetir sin
 * romper ni borrar nada.
 */
const REAPLICAR = process.argv.includes('--reaplicar')
  ? (process.argv[process.argv.indexOf('--reaplicar') + 1] ?? '')
  : null

const DIRECTORIO =
  (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined) ??
  process.env['MIGRACIONES_DIR'] ??
  '/opt/migraciones'
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
  // Se pregunta al catálogo y no con `to_regclass`, que para resolver el nombre
  // exige `usage` sobre el esquema: `auth` y `storage` son de sus propios
  // administradores, así que la forma cómoda se contestaba a sí misma con
  // «permission denied for schema auth» —un mensaje sobre permisos para una
  // pregunta sobre si la tabla existe— y ahí se acababa el arranque.
  const [fila] = await sql<{ auth: boolean; storage: boolean }[]>`
    select
      exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'auth' and c.relname = 'users') as auth,
      exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'storage' and c.relname = 'buckets') as storage`
  if (fila?.auth && fila.storage) return true
  avisa('no existe auth.users o storage.buckets: esta base no es la de la aplicación.')
  avisa('Los crean GoTrue y Storage al arrancar. Si ya lo han hecho, es que')
  avisa('DATABASE_URL apunta a otra base: tiene que ser el Postgres de la pila.')
  return false
}

/**
 * Las funciones que la base tiene, con el md5 de su cuerpo.
 *
 * Solo las del esquema `public` y solo las normales: los agregados y las de
 * ventana no salen de ninguna migración de este proyecto.
 */
async function funcionesDeLaBase(sql: Sql): Promise<Map<string, Set<string>>> {
  const filas = await sql<{ nombre: string; md5: string }[]>`
    select n.nspname || '.' || p.proname as nombre, md5(p.prosrc) as md5
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'`
  const out = new Map<string, Set<string>>()
  for (const f of filas) {
    const ya = out.get(f.nombre) ?? new Set<string>()
    ya.add(f.md5)
    out.set(f.nombre, ya)
  }
  return out
}

/** @returns cuántas funciones de la base no son las del repositorio. */
async function comprobarElEsquema(sql: Sql, ficheros: string[]): Promise<number> {
  const analizados = ficheros.map((f) => ({
    fichero: f,
    ...funcionesDe(f, readFileSync(join(DIRECTORIO, f), 'utf8')),
  }))
  const sinLeer = analizados.flatMap((a) => a.sinLeer)
  const vigente = versionVigente(analizados)
  const fuera = desajustes(vigente, await funcionesDeLaBase(sql))

  if (sinLeer.length > 0) {
    // Decirlo, siempre. Una comprobación que se calla lo que no ha mirado es
    // otra forma de mentir, que es de lo que veníamos.
    avisa(`${sinLeer.length} definiciones no se han podido leer y NO se han comprobado:`)
    for (const s of sinLeer.slice(0, 5)) avisa(`    ${s.fichero} · ${s.nombre}: ${s.porQue}`)
  }

  if (fuera.length === 0) {
    ok(`esquema comprobado: las ${vigente.size} funciones de la base son las del repositorio`)
    return 0
  }

  // Por fichero, que es la unidad con la que se arregla.
  const porFichero = new Map<string, string[]>()
  for (const d of fuera)
    porFichero.set(d.fichero, [...(porFichero.get(d.fichero) ?? []), `${d.nombre} (${d.que})`])

  console.error(
    `  ✗ el esquema NO cuadra: ${fuera.length} de ${vigente.size} funciones no son las del repositorio.`,
  )
  console.error(
    '    El registro dice que esas migraciones están aplicadas y la base dice que no.',
  )
  console.error(
    '    Casi siempre es porque alguien las anotó sin ejecutarlas para salir de un atasco.',
  )
  for (const [fichero, nombres] of porFichero) {
    console.error(`    ${fichero}`)
    for (const n of nombres.slice(0, 6)) console.error(`        ${n}`)
    if (nombres.length > 6) console.error(`        … y ${nombres.length - 6} más`)
  }

  /*
   * Y el remedio, en orden y desde el principio del estropicio.
   *
   * No basta con reaplicar los ficheros que poseen una función descuadrada: un
   * registro que mintió sobre uno mintió sobre la tanda, y lo que una migración
   * hace con los DATOS —un `update` que reclasifica movimientos— no deja rastro
   * en `pg_proc`, así que aquí no se ve. El caso real: la rama de
   * `articulo.disponible` vive hoy en la migración del día 200, pero la del 100
   * es la que reclasifica el saldo inicial como compra, y la del 200 busca
   * justo la nota que la del 100 deja. Reaplicar solo la del 200 deja el
   * almacén a medias y en silencio.
   */
  const primero = [...porFichero.keys()].sort()[0]!
  const desdeAhi = ficheros.filter((f) => f >= primero)
  console.error('')
  console.error(
    '    Hay que reaplicar en orden, desde la primera que falla. Lo que una migración',
  )
  console.error(
    '    cambia en los DATOS no se ve en esta comprobación, así que no basta con las',
  )
  console.error('    que salen arriba:')
  for (const f of desdeAhi) {
    const { si, porQue } = esRepetible(readFileSync(join(DIRECTORIO, f), 'utf8'))
    console.error(si ? `        migrar --reaplicar ${f}` : `        ${f}  ← a mano: ${porQue}`)
  }
  return fuera.length
}

/**
 * Vuelve a ejecutar una migración que el registro da por aplicada.
 *
 * Es la salida del atasco que sustituye al atajo viejo —anotarla sin
 * ejecutarla—, y por eso comprueba antes que el fichero se pueda repetir sin
 * romper ni borrar nada. Si no se puede, no lo hace: lo dice y se queda quieto.
 */
async function reaplicar(sql: Sql, fichero: string, ficheros: string[]): Promise<number> {
  if (!ficheros.includes(fichero)) {
    console.error(`  ✗ «${fichero}» no está en ${DIRECTORIO}. Escribe el nombre tal cual, con su .sql.`)
    return 1
  }
  const contenido = readFileSync(join(DIRECTORIO, fichero), 'utf8')
  const { si, porQue } = esRepetible(contenido)
  if (!si) {
    console.error(`  ✗ «${fichero}» no se puede volver a aplicar entero: ${porQue}.`)
    console.error(
      '    Hay que mirarlo y aplicar a mano lo que falte. Repetirlo podría borrar trabajo.',
    )
    return 1
  }
  console.log(`    reaplicando ${fichero} (${porQue})`)
  try {
    await sql.unsafe(contenido).simple()
  } catch (err) {
    console.error(`  ✗ ${fichero}: ${mensaje(err)}`)
    return 1
  }
  await sql`insert into public.schema_migrations (filename) values (${fichero}) on conflict do nothing`
  ok(`${fichero} aplicada de verdad`)
  const quedan = await comprobarElEsquema(sql, ficheros)
  try {
    await sql.notify('pgrst', 'reload schema')
    ok('avisado a PostgREST de que recargue el esquema')
  } catch {
    avisa('no se ha podido avisar a PostgREST: reinicia su servicio si la API no ve los cambios')
  }
  return quedan > 0 ? 3 : 0
}

async function main(): Promise<number> {
  if (!DATABASE_URL) {
    /*
     * Sin cadena de conexión no se aplica nada, y eso NO es un éxito.
     *
     * Devolvía 0. El arranque lo leía como «al día», `salud.json` publicaba
     * «migraciones: al dia» y nadie volvía a mirar: un despliegue en el que
     * este servicio no lleva `DATABASE_URL` no migra la base NUNCA, deploy
     * tras deploy, diciendo que todo va bien. Se descubrió el 22/09/2026, con
     * la base corriendo funciones de agosto: los cierres de avería atascados
     * por una columna que no existía y 54 filas en cuarentena porque el
     * almacén y las plantas seguían con las reglas viejas.
     *
     * El 2 lo distingue de un fallo de verdad (1): no se ha podido comprobar.
     */
    avisa(
      'sin DATABASE_URL: este servicio NO aplica migraciones, ni ahora ni en los despliegues siguientes.',
    )
    avisa(
      'La base se queda como esté, y la aplicación pedirá columnas y funciones que quizá no tenga.',
    )
    avisa(
      'Solución: añade DATABASE_URL (el Postgres de la pila) a las variables de ESTE servicio y vuelve a desplegar.',
    )
    return 2
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

    if (REAPLICAR !== null) return await reaplicar(sql, REAPLICAR, ficheros)

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
    ok(
      nuevas === 0
        ? 'el registro no pedía ninguna'
        : `${nuevas} migraciones nuevas, ${ficheros.length} en total`,
    )

    /*
     * Y ahora lo que de verdad contesta «¿está la base al día?»: el esquema.
     *
     * El registro no puede contestarlo. Guarda un nombre de fichero, así que
     * «aplicada» significa «alguien escribió esta cadena en una tabla», y eso
     * ha sido falso dos veces en una semana con el coste de siete días de
     * trabajo atascados y 54 filas en cuarentena. El cuerpo de cada función
     * está en `pg_proc.prosrc` byte a byte: comparar su md5 con el del fichero
     * no se puede engañar anotando una fila.
     */
    const noCuadra = await comprobarElEsquema(sql, ficheros)
    if (noCuadra > 0) return 3

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
