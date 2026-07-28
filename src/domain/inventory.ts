/**
 * Catálogo de tipos de equipo e inventario de sala.
 *
 * El problema que resuelve: el técnico está en un aula, sin cobertura, y se
 * encuentra un aparato que no está en el catálogo. Si tiene que esperar a que
 * alguien lo dé de alta, no lo apunta; y lo que no se apunta no existe. Así que
 * puede crearlo en el momento —y sale en naranja hasta que el coordinador lo
 * valida—.
 *
 * A cambio hay que impedir que el catálogo se llene de duplicados, que es como
 * el Excel acabó con ocho grafías de SÍ/NO. Tres defensas, de más fuerte a más
 * débil:
 *
 *  1. **El id sale del nombre**, no del azar (uuid v5 sobre el nombre
 *     normalizado). Dos técnicos sin cobertura que creen «Pantalla nueva»
 *     generan literalmente la misma fila, y al sincronizar convergen. Sin esto
 *     el modo offline fabricaría duplicados por diseño.
 *  2. **Índice único** sobre el nombre normalizado en la base.
 *  3. **Buscar antes de crear**: el autocompletado mira nombres y alias, así que
 *     `jab` encuentra *Micrófono Jabra* y nadie llega a la pantalla de crear.
 *
 * Lo que ninguna de las tres detecta es el duplicado de vocabulario —«Cañón» y
 * «Proyector» son el mismo aparato con dos palabras—. Para eso está la fusión,
 * que es trabajo del coordinador.
 */

import { v5 as uuidv5 } from 'uuid'
import { norm } from './normalize'
import type { Asset, AssetType } from './types'

/**
 * Espacio de nombres del proyecto. Es un valor arbitrario pero **fijo para
 * siempre**: cambiarlo haría que los mismos nombres generaran ids distintos y
 * el catálogo se duplicaría entero.
 */
const TYPE_NAMESPACE = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

/** El id que le corresponde a un tipo por su nombre. Misma entrada, mismo id. */
export function assetTypeId(name: string): string {
  return uuidv5(norm(name), TYPE_NAMESPACE)
}

export interface CatalogHit {
  type: AssetType
  /** Por qué ha salido: vacío si coincide el nombre, «alias “jab”» si no. */
  why: string
}

/**
 * Busca en el catálogo por nombre y por alias.
 *
 * Los alias son la mitad del valor: el técnico escribe lo que dice en voz alta
 * —«jab», «cañón»— no el nombre de catálogo. Sin ellos la búsqueda falla y se
 * crea un duplicado, que es justo lo que se quiere evitar.
 */
export function searchCatalog(types: AssetType[], query: string, limit = 5): CatalogHit[] {
  const q = norm(query)
  if (!q) return []

  const hits: CatalogHit[] = []
  for (const type of types) {
    if (type.merged_into) continue

    if (norm(type.name).includes(q)) {
      hits.push({ type, why: '' })
      continue
    }
    const alias = type.aliases.find((a) => norm(a).includes(q))
    if (alias) hits.push({ type, why: `alias «${alias}»` })
  }

  // El que empieza por lo tecleado va antes que el que solo lo contiene, y la
  // coincidencia de nombre antes que la de alias.
  return hits
    .sort((a, b) => {
      const score = (h: CatalogHit): number =>
        (norm(h.type.name).startsWith(q) ? 0 : 2) + (h.why ? 1 : 0)
      return score(a) - score(b) || a.type.name.localeCompare(b.type.name)
    })
    .slice(0, limit)
}

/** ¿El texto tecleado ya es exactamente un tipo del catálogo? */
export function exactType(types: AssetType[], query: string): AssetType | null {
  const q = norm(query)
  return types.find((t) => !t.merged_into && norm(t.name) === q) ?? null
}

/**
 * La etiqueta que le toca a un elemento nuevo dentro de su sala.
 *
 * El primero se llama como su tipo, el segundo lleva un 2. Nadie teclea el
 * número: obligar a hacerlo produce «Pantalla2», «pantalla 2» y «Pantalla II»
 * en tres salas distintas, y a partir de ahí los informes ya no agrupan.
 *
 * Se cuenta sobre las etiquetas ya usadas y no sobre cuántos hay, porque si
 * alguien retiró la «Pantalla 2» y quedan dos elementos, el siguiente no puede
 * volver a llamarse «Pantalla 2».
 */
export function nextLabel(assetsInRoom: Asset[], typeName: string): string {
  const used = new Set(
    assetsInRoom.filter((a) => a.status !== 'retirado').map((a) => norm(a.label ?? '')),
  )

  if (!used.has(norm(typeName))) return typeName

  for (let n = 2; n < 100; n++) {
    const candidate = `${typeName} ${n}`
    if (!used.has(norm(candidate))) return candidate
  }
  return `${typeName} ${assetsInRoom.length + 1}`
}

/**
 * ¿Se puede usar esta etiqueta en esta sala?
 *
 * Espeja el índice único de la base. Comprobarlo aquí no es redundante: sin
 * esto el rechazo llegaría al sincronizar, horas después y lejos del aula,
 * cuando ya no hay forma de saber cuál de las dos pantallas era.
 */
export function labelAvailable(assetsInRoom: Asset[], label: string, exceptId?: string): boolean {
  const l = norm(label)
  if (!l) return false
  return !assetsInRoom.some(
    (a) => a.id !== exceptId && a.status !== 'retirado' && norm(a.label ?? '') === l,
  )
}

/** El nombre del tipo tal y como debe verse, siguiendo las fusiones. */
export function resolveType(types: Map<string, AssetType>, id: string): AssetType | null {
  const seen = new Set<string>()
  let current = types.get(id) ?? null

  while (current?.merged_into && !seen.has(current.id)) {
    seen.add(current.id)
    current = types.get(current.merged_into) ?? null
  }
  return current
}
