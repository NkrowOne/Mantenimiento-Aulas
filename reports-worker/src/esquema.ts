/**
 * Comprobar el esquema de verdad, y no lo que diga el registro.
 *
 * `public.schema_migrations` guarda una sola cosa: el nombre del fichero. Así
 * que «aplicada» significa literalmente «alguien escribió esta cadena en una
 * tabla», y hay demasiados caminos por los que una migración acaba anotada sin
 * haberse ejecutado —el principal, el `insert` con las 67 de golpe que los
 * propios scripts imprimen como remedio cuando algo se atasca—.
 *
 * Ha pasado dos veces en una semana, y las dos igual de caro:
 *
 *  - 16/09: `easyvista_ref` anotada y no creada. Siete días de trabajo de un
 *    técnico atascados en la cola de su móvil, con el error delante y sin que
 *    nadie supiera leerlo.
 *  - 21/09: cuatro migraciones anotadas y no aplicadas. La base siguió con las
 *    funciones de agosto, el Excel se sincronizó contra ellas y dejó 54 filas
 *    en cuarentena. Mientras tanto el arranque decía «la base ya estaba al día»
 *    y la pantalla del coordinador, «Todo correcto».
 *
 * La cura no es un registro mejor: es dejar de creerle. El cuerpo de una
 * función PL/pgSQL está en `pg_proc.prosrc` **byte a byte** como se escribió
 * entre las comillas de dólar, así que comparar su md5 con el del fichero
 * contesta la única pregunta que importa —«¿tiene la base esta versión?»— sin
 * pasar por ninguna tabla de anotaciones. Son 95 funciones y una consulta.
 *
 * Y detecta de paso lo que ningún registro detecta: una función editada a mano
 * en producción, que es la avería que no deja rastro en ningún sitio.
 *
 * Aquí vive solo la parte que no habla con nadie —leer ficheros y comparar—,
 * para poder probarla contra las migraciones de verdad.
 */

import { createHash } from 'node:crypto'

/** Una función que el repositorio define, con el md5 de su cuerpo. */
export interface FuncionDelRepo {
  /** `public.sync_mover_sala`, en minúsculas y siempre con esquema. */
  nombre: string
  /** md5 del cuerpo, que es lo que Postgres guarda en `pg_proc.prosrc`. */
  md5: string
  /** De qué fichero salió. Es lo que hay que reaplicar si no cuadra. */
  fichero: string
}

/** Lo que no se ha podido leer. Se cuenta y se dice: callarlo sería otra mentira. */
export interface SinLeer {
  fichero: string
  nombre: string
  porQue: string
}

const CREA = /create\s+or\s+replace\s+function\s+([a-zA-Z_][\w.]*)\s*\(/gi
const ABRE = /\bas\s+(\$[A-Za-z_]*\$)/i
/**
 * Lo que puede venir justo detrás del cierre de un cuerpo.
 *
 * Es la guarda contra el cierre prematuro: un cuerpo que contuviera `$$` por su
 * cuenta cerraría antes de tiempo y daría un md5 que no coincide con nada. Si
 * lo que sigue no parece el final de un `create function`, se declara ilegible
 * en vez de darlo por bueno.
 */
const TRAS_EL_CIERRE =
  /^\s*(;|language\b|immutable\b|stable\b|volatile\b|strict\b|security\b|set\b|parallel\b|cost\b|rows\b|as\b)/i

/** Las funciones que define un fichero de migración, con el md5 de cada cuerpo. */
export function funcionesDe(
  fichero: string,
  sql: string,
): { funciones: FuncionDelRepo[]; sinLeer: SinLeer[] } {
  const funciones: FuncionDelRepo[] = []
  const sinLeer: SinLeer[] = []
  CREA.lastIndex = 0

  for (let m = CREA.exec(sql); m !== null; m = CREA.exec(sql)) {
    const crudo = (m[1] ?? '').toLowerCase()
    const nombre = crudo.includes('.') ? crudo : `public.${crudo}`

    const resto = sql.slice(m.index + m[0].length)
    const abre = ABRE.exec(resto)
    if (!abre) {
      sinLeer.push({
        fichero,
        nombre,
        porQue: 'no encuentro el «as $$» que abre el cuerpo',
      })
      continue
    }
    const etiqueta = abre[1]!
    const desde = m.index + m[0].length + abre.index + abre[0].length
    const hasta = sql.indexOf(etiqueta, desde)
    if (hasta === -1) {
      sinLeer.push({
        fichero,
        nombre,
        porQue: `no encuentro el «${etiqueta}» que lo cierra`,
      })
      continue
    }
    if (!TRAS_EL_CIERRE.test(sql.slice(hasta + etiqueta.length, hasta + etiqueta.length + 40))) {
      sinLeer.push({
        fichero,
        nombre,
        porQue: 'el cuerpo parece cerrarse antes de tiempo',
      })
      continue
    }
    funciones.push({
      nombre,
      fichero,
      md5: createHash('md5').update(sql.slice(desde, hasta)).digest('hex'),
    })
  }

  return { funciones, sinLeer }
}

/**
 * La versión vigente de cada función: la del ÚLTIMO fichero que la define.
 *
 * Un mismo fichero puede definir dos veces el mismo nombre —una sobrecarga—, y
 * entonces valen las dos: se guardan todas las del fichero que manda.
 */
export function versionVigente(
  porFichero: Array<{ fichero: string; funciones: FuncionDelRepo[] }>,
): Map<string, { md5s: Set<string>; fichero: string }> {
  const out = new Map<string, { md5s: Set<string>; fichero: string }>()
  // En orden de fichero: el último que la define es el que manda.
  for (const { fichero, funciones } of porFichero) {
    for (const f of funciones) {
      const ya = out.get(f.nombre)
      if (ya && ya.fichero === fichero) ya.md5s.add(f.md5)
      else out.set(f.nombre, { md5s: new Set([f.md5]), fichero })
    }
  }
  return out
}

export interface Desajuste {
  nombre: string
  fichero: string
  /** `falta` = la base no tiene ninguna función con ese nombre. */
  que: 'falta' | 'distinta'
}

/**
 * Qué funciones de la base no son las del repositorio.
 *
 * `enLaBase` es `nombre → md5 de cada versión que hay`, tal y como sale de
 * `pg_proc`. Una función con varias sobrecargas trae varios md5; basta con que
 * esté el que el repositorio espera.
 */
export function desajustes(
  vigente: Map<string, { md5s: Set<string>; fichero: string }>,
  enLaBase: Map<string, Set<string>>,
): Desajuste[] {
  const out: Desajuste[] = []
  for (const [nombre, { md5s, fichero }] of vigente) {
    const suyos = enLaBase.get(nombre)
    if (!suyos || suyos.size === 0) {
      out.push({ nombre, fichero, que: 'falta' })
      continue
    }
    if (![...md5s].some((h) => suyos.has(h))) out.push({ nombre, fichero, que: 'distinta' })
  }
  // Por fichero, que es la unidad con la que se arregla.
  return out.sort((a, b) => a.fichero.localeCompare(b.fichero) || a.nombre.localeCompare(b.nombre))
}

/**
 * Sentencias de nivel raíz que se pueden repetir sin romper ni borrar nada.
 *
 * Es lo que decide si un fichero se puede volver a aplicar. No se declara a
 * mano en cada migración —serían 67 ficheros que tocar y 67 ocasiones de
 * equivocarse—: se deduce de lo que hay escrito, y ante la duda se dice que NO.
 *
 * Lo peligroso no es un `create table` repetido, que falla y se ve: son los
 * `update` incondicionales, que al repetirse no dan error y pisan en silencio
 * lo que alguien corrigió a mano.
 */
const REPETIBLE: RegExp[] = [
  /^create\s+or\s+replace\s+(function|view|procedure|trigger)\b/i,
  /^create\s+(table|index|unique\s+index|schema|extension|type)\s+if\s+not\s+exists\b/i,
  /^alter\s+table\s+[\w.]+\s+add\s+column\s+if\s+not\s+exists\b/i,
  /^alter\s+table\s+[\w.]+\s+(enable|disable)\s+trigger\b/i,
  /^alter\s+table\s+[\w.]+\s+(drop\s+constraint\s+if\s+exists|add\s+constraint)\b/i,
  /^drop\s+(function|trigger|policy|view|index|table|type)\s+if\s+exists\b/i,
  /^create\s+(policy|trigger)\b/i,
  /^comment\s+on\b/i,
  /^(grant|revoke)\b/i,
  /^notify\b/i,
  /^insert\s+into\b[\s\S]*on\s+conflict\b/i,
]

/** La marca de escape para lo que la lista de arriba no sabe juzgar. */
const MARCA = /^--\s*reejecutable:\s*(si|sí|no)\b/im

/**
 * ¿Se puede volver a aplicar este fichero entero sin hacer daño?
 *
 * Devuelve también por qué no, que es lo que hay que enseñar: «no la reaplico
 * porque lleva un update de datos» es una respuesta; «no» no lo es.
 */
export function esRepetible(sql: string): { si: boolean; porQue: string } {
  const marca = MARCA.exec(sql)
  if (marca) {
    const dice = (marca[1] ?? '').toLowerCase()
    return dice === 'no'
      ? { si: false, porQue: 'el propio fichero dice que no se puede repetir' }
      : { si: true, porQue: 'el propio fichero dice que se puede repetir' }
  }

  for (const sentencia of sentenciasDeNivelRaiz(sql)) {
    if (!REPETIBLE.some((r) => r.test(sentencia))) {
      return {
        si: false,
        porQue: `lleva una sentencia que no se puede repetir: «${sentencia.slice(0, 60)}…»`,
      }
    }
  }
  return { si: true, porQue: 'todas sus sentencias se pueden repetir' }
}

/**
 * Parte el fichero en sentencias de nivel raíz, respetando las comillas de
 * dólar y los comentarios. Un `;` dentro de un cuerpo PL/pgSQL no separa nada.
 */
export function sentenciasDeNivelRaiz(sql: string): string[] {
  const out: string[] = []
  let actual = ''
  let i = 0
  while (i < sql.length) {
    // Comentario de línea.
    if (sql.startsWith('--', i)) {
      const fin = sql.indexOf('\n', i)
      i = fin === -1 ? sql.length : fin + 1
      continue
    }
    // Comentario de bloque.
    if (sql.startsWith('/*', i)) {
      const fin = sql.indexOf('*/', i + 2)
      i = fin === -1 ? sql.length : fin + 2
      continue
    }
    // Cadena entre comillas simples, con '' como escape.
    if (sql[i] === "'") {
      const ini = i
      i++
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2
        else if (sql[i] === "'") {
          i++
          break
        } else i++
      }
      actual += sql.slice(ini, i)
      continue
    }
    // Comillas de dólar: todo lo de dentro es literal, punto y coma incluido.
    const dolar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))
    if (dolar) {
      const etiqueta = dolar[0]
      const fin = sql.indexOf(etiqueta, i + etiqueta.length)
      const hasta = fin === -1 ? sql.length : fin + etiqueta.length
      actual += sql.slice(i, hasta)
      i = hasta
      continue
    }
    if (sql[i] === ';') {
      const limpia = actual.trim()
      if (limpia) out.push(limpia.replace(/\s+/g, ' '))
      actual = ''
      i++
      continue
    }
    actual += sql[i]
    i++
  }
  const limpia = actual.trim()
  if (limpia) out.push(limpia.replace(/\s+/g, ' '))
  return out
}
