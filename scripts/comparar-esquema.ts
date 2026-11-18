/**
 * El esquema recién migrado, comparado con el repositorio.
 *
 *   psql ... -At -F '|' -c "select nombre, md5 ..." | tsx scripts/comparar-esquema.ts
 *
 * Es la misma comparación que hace `migrar` en producción
 * (`reports-worker/src/esquema.ts`): el md5 del cuerpo de cada función del
 * repositorio contra `pg_proc.prosrc`. Aquí se hace sobre una base que acaba de
 * recibir TODAS las migraciones, así que no puede haber ni un desajuste: si lo
 * hay, el que se equivoca es el comprobador —o una migración que cambia una
 * función sin escribirla—, y en producción saldría en rojo «la base no tiene
 * las migraciones que dice tener» sobre una base al día. Pasó con
 * `20261116000100`. Lo llama `scripts/db-verify.sh`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { desajustes, funcionesDe, versionVigente } from '../reports-worker/src/esquema'

const DIR = 'supabase/migrations'

const porFichero = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((fichero) => ({ fichero, ...funcionesDe(fichero, readFileSync(`${DIR}/${fichero}`, 'utf8')) }))

const enLaBase = new Map<string, Set<string>>()
for (const linea of readFileSync(0, 'utf8').split('\n')) {
  const [nombre, md5] = linea.trim().split('|')
  if (!nombre || !md5) continue
  if (!enLaBase.has(nombre)) enLaBase.set(nombre, new Set())
  enLaBase.get(nombre)!.add(md5)
}
if (enLaBase.size === 0) {
  console.log('   ✗ no ha llegado ni una función de la base: no hay nada que comparar')
  process.exit(1)
}

const vigente = versionVigente(porFichero)
const mal = desajustes(vigente, enLaBase)
for (const d of mal) console.log(`   ✗ ${d.nombre}: ${d.que} — el repositorio espera la de ${d.fichero}`)
if (mal.length > 0) {
  console.log(`   ${mal.length} función(es) de una base recién migrada no son las del repositorio.`)
  console.log('   Una función se cambia escribiéndola entera en su migración.')
  process.exit(1)
}
console.log(`   ${vigente.size} funciones, y las ${vigente.size} son las del repositorio`)
