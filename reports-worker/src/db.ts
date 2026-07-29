/**
 * La conexión a Postgres del worker.
 *
 * Existe para un solo detalle, y es el que rompe el despliegue contra un
 * Supabase gestionado: **el pooler en modo transacción no admite sentencias
 * preparadas**. El cliente `postgres` las usa por defecto, así que la primera
 * consulta muere con «prepared statement "..." already exists» o «does not
 * exist» — un error que no menciona el pooler por ningún lado y que aparece de
 * forma intermitente, porque depende de qué conexión del pool te toque.
 *
 * La cadena que el panel de Supabase ofrece por defecto es justamente la del
 * pooler (puerto 6543). Detectarlo aquí evita que el worker arranque bien,
 * supere el healthcheck y solo falle cuando `pg_cron` le pida el primer
 * informe, de madrugada y sin nadie mirando.
 */

import postgres from 'postgres'

/**
 * ¿La cadena apunta a un pooler en modo transacción?
 *
 * Tres señales, porque los proveedores no coinciden en ninguna: el puerto 6543
 * de Supabase, el host del pooler, y el `?pgbouncer=true` que documentan varias
 * plataformas. Con que aparezca una, se desactivan las preparadas.
 */
export function esPooler(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.port === '6543') return true
    if (u.hostname.includes('pooler.')) return true
    if (u.searchParams.get('pgbouncer') === 'true') return true
    return false
  } catch {
    // Una cadena que no se puede analizar no es motivo para no intentar
    // conectar: que falle el conector, que sabe decir por qué.
    return false
  }
}

/**
 * Conexión con el número de conexiones que pida quien llame.
 *
 * `max` es distinto en el servidor (2, atiende peticiones seguidas) y en la
 * línea de órdenes (1, un informe y se acaba).
 *
 * `onnotice` es para quien ejecute DDL: por defecto postgres.js vuelca el
 * objeto entero del aviso, y las migraciones sueltan unos cuantos («pg_cron no
 * disponible», «ya existe, se omite») que en un arranque conviene leer de un
 * vistazo, no en veinte líneas de JSON.
 */
export function conectar(url: string, max: number, onnotice?: (aviso: postgres.Notice) => void): postgres.Sql {
  return postgres(url, {
    max,
    ...(onnotice ? { onnotice } : {}),
    // Sin esto, contra el pooler de Supabase no funciona ninguna consulta.
    prepare: !esPooler(url),
    // Con las consultas ya explícitas esto no cambia ningún número, pero deja la
    // sesión en hora local para lo que se escriba aquí mañana y para los registros.
    connection: { timezone: 'Europe/Madrid' },
  })
}
