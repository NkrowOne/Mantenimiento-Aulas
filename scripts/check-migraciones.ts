/**
 * El orden de las migraciones, comprobado.
 *
 *   npm run check:migraciones
 *
 * Las tres formas de desplegar —`deploy.sh`, `init-plataforma.sh` y
 * `db-verify.sh`— aplican `supabase/migrations/*.sql` recorriendo el glob, y el
 * glob va en orden alfabético. Eso funciona porque el nombre empieza por una
 * marca de tiempo: alfabético y cronológico son el mismo orden.
 *
 * Salvo que dos ficheros lleven la MISMA marca. Entonces el desempate lo hace el
 * resto del nombre, y el resto del nombre no sabe nada de cuándo se escribió cada
 * uno: pasó de verdad —`20260730000300_etiqueta_sin_choque` se aplicaba antes que
 * `20260730000300_incidencias_de_revision` porque la «e» va antes que la «i»,
 * cuando se habían escrito en el orden contrario—.
 *
 * Y es un fallo que no se nota. Dos migraciones independientes aguantan
 * cualquier orden, así que la base queda bien y nadie se entera; el día que una
 * dependa de la otra, revienta el despliegue de alguien que no ha tocado nada.
 * Por eso se comprueba aquí y no se confía en revisarlo a ojo: pasa cuando dos
 * ramas crecen en paralelo, que es justo cuando nadie está mirando.
 *
 * Esta comprobación no necesita base de datos: solo lee los ficheros.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'supabase/migrations'

let fallos = 0

function comprueba(ok: boolean, texto: string): void {
  if (!ok) fallos++
  console.log(`  ${ok ? '✓' : '✗'} ${texto}`)
}

const ficheros = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  // El mismo orden que verá el glob del shell.
  .sort()

comprueba(ficheros.length > 0, `${ficheros.length} migraciones en ${DIR}`)

// -----------------------------------------------------------------------------
// 1 — Todas empiezan por una marca de tiempo
// -----------------------------------------------------------------------------
const sinPrefijo = ficheros.filter((f) => !/^\d{14}_/.test(f))
comprueba(
  sinPrefijo.length === 0,
  sinPrefijo.length === 0
    ? 'todas llevan sus 14 dígitos delante'
    : `sin marca de tiempo: ${sinPrefijo.join(', ')}`,
)

// -----------------------------------------------------------------------------
// 2 — Y ninguna la comparte
//
// Es el fallo de verdad. Con el prefijo repetido, el orden entre las dos lo
// decide el alfabeto y no la historia.
// -----------------------------------------------------------------------------
const porPrefijo = new Map<string, string[]>()
for (const f of ficheros) {
  const prefijo = f.slice(0, 14)
  porPrefijo.set(prefijo, [...(porPrefijo.get(prefijo) ?? []), f])
}

const repetidos = [...porPrefijo.entries()].filter(([, fs]) => fs.length > 1)
comprueba(
  repetidos.length === 0,
  repetidos.length === 0
    ? 'ninguna marca de tiempo repetida'
    : `marca compartida — renumera la más reciente:\n` +
        repetidos.map(([p, fs]) => `      ${p}: ${fs.join(' · ')}`).join('\n'),
)

// -----------------------------------------------------------------------------
// 3 — Y el fichero se puede leer
//
// Un nombre con espacios o con mayúsculas no rompe el glob, pero sí rompe el
// `insert into schema_migrations` de `init-plataforma.sh`, que lo interpola en
// una cadena SQL sin escapar.
// -----------------------------------------------------------------------------
const raros = ficheros.filter((f) => !/^[0-9a-z_]+\.sql$/.test(f))
comprueba(
  raros.length === 0,
  raros.length === 0
    ? 'todos los nombres son minúsculas, dígitos y guion bajo'
    : `nombres que el registro no sabe citar: ${raros.join(', ')}`,
)

// -----------------------------------------------------------------------------
// 4 — El bootstrap va primero
//
// Crea los roles y los esquemas de los que cuelga todo lo demás. Sus ceros
// delante son el mecanismo, no un adorno.
// -----------------------------------------------------------------------------
comprueba(
  ficheros[0] === '00000000000000_bootstrap_roles.sql',
  `la primera es ${ficheros[0]}`,
)

// -----------------------------------------------------------------------------
// 5 — Cada `create policy` se puede reejecutar
//
// `create policy` no admite `if not exists`, así que una migración que cree
// políticas y se vuelva a ejecutar muere con «already exists». Y se vuelve a
// ejecutar más de lo que parece: basta con que una pasada anterior se cortara
// después de crear la política y antes de anotarse en el registro, y a partir de
// ahí TODOS los despliegues de esa base mueren en el mismo punto, sin manera de
// avanzar salvo tocar el registro a mano.
//
// Pasó, y dejó un despliegue bloqueado con la aplicación de campo esperando el
// arreglo que venía dentro. El remedio es de una línea y va delante de cada
// `create policy`: `drop policy if exists "…" on …;`. Idéntico resultado, y
// repetible.
// -----------------------------------------------------------------------------
const sinDrop: string[] = []
for (const f of ficheros) {
  const sql = readFileSync(join(DIR, f), 'utf8')
  for (const m of sql.matchAll(/^create policy\s+"([^"]+)"\s*\n?\s*on\s+([\w.]+)/gm)) {
    const antes = sql.slice(Math.max(0, m.index - 200), m.index)
    if (!antes.includes(`drop policy if exists "${m[1]}"`)) sinDrop.push(`${f} → "${m[1]}"`)
  }
}
comprueba(
  sinDrop.length === 0,
  sinDrop.length === 0
    ? 'todas las políticas se pueden reejecutar'
    : `políticas sin «drop policy if exists» delante:\n      ${sinDrop.join('\n      ')}`,
)

if (fallos === 0) {
  console.log(`\n✓ Las migraciones se aplican en el orden en que se escribieron`)
} else {
  console.log(`\n✗ ${fallos} problema(s) en el orden de las migraciones`)
}
console.log(
  `  ${ficheros.at(0)} … ${ficheros.at(-1)}`,
)
process.exit(fallos === 0 ? 0 : 1)
