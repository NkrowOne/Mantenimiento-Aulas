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

// -----------------------------------------------------------------------------
// El vocabulario que ya existe, para no volver a teclearlo
// -----------------------------------------------------------------------------

/**
 * Un valor que ya se usa en el parque, con cuántas veces aparece.
 *
 * El recuento no es adorno: es el orden. Si de 41 proyectores 30 son un
 * «NEC NP44», ese tiene que salir primero — es el que va a teclear la siguiente
 * persona, y ponerlo detrás de una rareza que aparece una vez convierte la ayuda
 * en una lista que hay que leer.
 */
export interface Sugerencia {
  valor: string
  veces: number
}

/** Qué campo del equipo se está autocompletando. */
export type CampoDeEquipo = 'model' | 'label'

/**
 * Lo que ya se ha escrito para este tipo de equipo, en todo el parque.
 *
 * Corregir un equipo pedía teclear el modelo entero a mano, y son cadenas como
 * `Epson EB-1485Fi` escritas de pie con una mano: se teclean mal, se teclean con
 * mayúsculas distintas, y a partir de ahí el mismo proyector cuenta como dos
 * modelos en cualquier informe que agrupe. Lo que arregla eso no es validar más:
 * es ofrecer lo que ya está escrito.
 *
 * Sale del espejo local —el dispositivo tiene los equipos de las 276 salas—, así
 * que funciona sin cobertura, igual que el resto de la revisión.
 *
 * Va aparte del filtrado por lo tecleado a propósito: esto recorre el parque
 * entero y solo cambia cuando cambia el inventario; lo otro corre en cada tecla.
 *
 * `label` mira también fuera de la sala, y ahí está su valor: «Pantalla del
 * atril» se inventa en un aula y a partir de ese momento se ofrece en las demás,
 * que es como una plantilla que nadie ha tenido que mantener.
 */
export function vocabularioDeTipo(
  assets: Asset[],
  assetTypeId: string,
  campo: CampoDeEquipo,
): Sugerencia[] {
  const veces = new Map<string, { valor: string; n: number }>()

  for (const asset of assets) {
    if (asset.asset_type_id !== assetTypeId) continue
    // Un equipo retirado sigue aportando vocabulario: el modelo que se instaló
    // durante seis años no deja de ser el modelo que se escribe.
    const valor = (asset[campo] ?? '').trim()
    if (!valor) continue

    const clave = norm(valor)
    const previo = veces.get(clave)
    // Se conserva la primera grafía vista y se cuentan todas: `NEC np44` y
    // `NEC NP44` son el mismo modelo mal escrito dos veces, y ofrecer las dos
    // sería ofrecer el problema.
    if (previo) previo.n += 1
    else veces.set(clave, { valor, n: 1 })
  }

  return [...veces.values()]
    .map((v) => ({ valor: v.valor, veces: v.n }))
    .sort((a, b) => b.veces - a.veces || a.valor.localeCompare(b.valor, 'es', { numeric: true }))
}

/**
 * Qué se ofrece con lo que hay tecleado.
 *
 * Con el campo vacío se ofrece lo más frecuente, y eso es deliberado: el caso
 * que ahorra trabajo de verdad es el técnico delante de un proyector cuyo modelo
 * no ha tecleado todavía. Esperar a que escriba tres letras para ayudarle es
 * ayudarle cuando ya ha hecho el trabajo.
 */
export function sugerenciasDe(
  vocabulario: Sugerencia[],
  query: string,
  opciones?: { excluir?: string[]; limit?: number },
): Sugerencia[] {
  const q = norm(query)
  const fuera = new Set((opciones?.excluir ?? []).map(norm).filter(Boolean))
  const limit = opciones?.limit ?? 5

  const candidatos = vocabulario.filter((s) => {
    const v = norm(s.valor)
    // Lo que ya está escrito en el campo no se ofrece: sería una fila que al
    // pulsarla no hace nada.
    if (fuera.has(v)) return false
    return q === '' || v.includes(q)
  })

  // Con el campo vacío manda la frecuencia, que es el orden con el que llega.
  if (q === '') return candidatos.slice(0, limit)

  // Y con algo tecleado, lo que empieza por ello antes de lo que solo lo
  // contiene. `sort` es estable, así que dentro de cada grupo sigue mandando la
  // frecuencia.
  return candidatos
    .sort((a, b) => {
      const score = (s: Sugerencia): number => (norm(s.valor).startsWith(q) ? 0 : 1)
      return score(a) - score(b)
    })
    .slice(0, limit)
}

/**
 * Orden de lectura de la sala, no alfabético.
 *
 * El técnico entra por la puerta y mira primero lo que se ve desde el fondo del
 * aula. Alfabéticamente la botonera iría primero y el proyector el sexto, que
 * no es el orden en que nadie revisa nada.
 *
 * Vive aquí y no dentro de la pantalla de revisión porque lo usan tres sitios: el
 * formulario, el bloque de inventario que tiene debajo y la lectura de una
 * revisión pasada desde la ficha de la sala. Tenerlo en cada uno producía el
 * mismo equipamiento listado en tres órdenes distintos.
 */
export const TYPE_ORDER = [
  'PROYECTOR',
  'PANTALLA',
  'ALTAVOCES',
  'MICROFONO',
  'CAMARA',
  'BOTONERA',
  'ORDENADOR',
  'ATRIL',
]

/**
 * Dónde cae un tipo en ese recorrido, por su nombre.
 *
 * Por nombre y no por identificador a propósito: una revisión de hace un año
 * habla de un aparato que hoy puede estar retirado, y de él solo llega el nombre
 * del tipo que resolvió el servidor. Lo que no está en la lista va al final, en
 * el orden en que llegue.
 */
export function rangoDeTipo(typeName: string | null | undefined): number {
  const i = TYPE_ORDER.indexOf(norm(typeName ?? ''))
  return i === -1 ? TYPE_ORDER.length : i
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
