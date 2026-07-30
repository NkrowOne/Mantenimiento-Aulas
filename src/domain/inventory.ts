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
import type { Asset, AssetModel, AssetType } from './types'

/**
 * Espacio de nombres del proyecto. Es un valor arbitrario pero **fijo para
 * siempre**: cambiarlo haría que los mismos nombres generaran ids distintos y
 * el catálogo se duplicaría entero.
 */
const TYPE_NAMESPACE = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

/**
 * El de los modelos. Distinto del de los tipos y por el mismo motivo de siempre:
 * fijo para siempre. Su gemelo en SQL está en `public.asset_model_id()`, y los
 * dos tienen que dar el MISMO uuid o el catálogo se duplicaría entre lo que
 * deduce el servidor y lo que crea un iPad sin cobertura.
 */
const MODEL_NAMESPACE = 'f1c0f1d2-6a52-5a3b-9c2e-2f6f0b7d4a11'

/** El id que le corresponde a un tipo por su nombre. Misma entrada, mismo id. */
export function assetTypeId(name: string): string {
  return uuidv5(norm(name), TYPE_NAMESPACE)
}

/**
 * El id que le corresponde a un modelo. Misma marca y mismo modelo, mismo id.
 *
 * Gemela de `public.asset_model_id(uuid, text, text)`. Que las dos coincidan es
 * lo que permite que el relleno del servidor y un alta hecha en un aula sin
 * línea acaben en la misma fila en vez de chocar contra el índice único.
 */
export function assetModelId(typeId: string, brand: string, model: string): string {
  return uuidv5(`${typeId}|${norm(brand)}|${norm(model)}`, MODEL_NAMESPACE)
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

/** Lo mismo para los modelos: la lápida de una fusión lleva al modelo vivo. */
export function resolveModel(
  models: Map<string, AssetModel>,
  id: string | null,
): AssetModel | null {
  if (!id) return null
  const seen = new Set<string>()
  let current = models.get(id) ?? null

  while (current?.merged_into && !seen.has(current.id)) {
    seen.add(current.id)
    current = models.get(current.merged_into) ?? null
  }
  return current
}

// -----------------------------------------------------------------------------
// Marcas y modelos
// -----------------------------------------------------------------------------

/**
 * Marcas que se ofrecen aunque el catálogo esté vacío.
 *
 * No es una lista cerrada ni pretende serlo: en cuanto haya modelos de verdad,
 * las marcas que se sugieren salen de ellos. Está para el primer día, cuando
 * escribir la marca desde cero en un teclado de iPad, de pie y en un aula, es
 * justo lo que hace que no se escriba.
 */
export const MARCAS_HABITUALES = [
  // Proyección
  'Epson', 'NEC', 'Panasonic', 'Optoma', 'BenQ', 'Hitachi', 'Vivitek', 'Casio',
  'InFocus', 'Maxell', 'Barco', 'Christie', 'Ricoh',
  // Informática
  'Lenovo', 'HP', 'Dell', 'Acer', 'Asus', 'Fujitsu', 'Apple', 'MSI', 'Toshiba',
  'Gigabyte', 'Microsoft', 'Intel', 'AMD', 'Aspen',
  // Pantallas
  'Samsung', 'LG', 'Sony', 'Philips', 'ViewSonic', 'Iiyama', 'AOC', 'Sharp', 'Xiaomi',
  // Audio y vídeo
  'Logitech', 'Jabra', 'Shure', 'Sennheiser', 'Bose', 'JBL', 'Yamaha', 'Poly',
  'Polycom', 'Behringer', 'Bosch', 'TOA', 'Aver', 'AVerMedia', 'Vaddio', 'Canon',
  // Control y red
  'Crestron', 'Extron', 'Kramer', 'Atlona', 'Cisco', 'Ubiquiti', 'Aruba',
  'Netgear', 'TP-Link', 'D-Link', 'Zyxel',
]

/** Cómo se escribe una marca vacía. Nunca en blanco: un hueco no dice nada. */
export const SIN_MARCA = 'Sin marca'

/** «Lenovo U3302», o «U3302» si no consta la marca. */
export function modelLabel(model: AssetModel | null): string {
  if (!model) return ''
  return [model.brand.trim(), model.model.trim()].filter(Boolean).join(' ')
}

/**
 * Todo lo que identifica a un aparato, resuelto de una vez.
 *
 * Existe porque el mismo join de tres tablas se hacía en cinco pantallas y en
 * cinco formatos distintos, y porque la pregunta que el encargo plantea —«no es
 * lo mismo un Ordenador que un Ordenador ASPEN 223»— se contesta en todas ellas
 * o no se contesta.
 *
 * Los tres niveles, siempre en el mismo orden y con el mismo separador:
 *
 *     Ordenador 2      ← cómo se llama EN ESTA SALA
 *     Ordenador Lenovo U3302   ← qué es exactamente
 *     S/N ABC123       ← cuál de todos ellos
 */
export interface AssetIdentity {
  /** El nombre en la sala: «Pantalla 2». Es lo que se señala con el dedo. */
  etiqueta: string
  /** El tipo vivo: «Pantalla». */
  tipo: string
  /** La marca, o cadena vacía si no consta. */
  marca: string
  /** El modelo, del catálogo o del texto libre de antes. Vacío si no hay. */
  modelo: string
  serie: string
  /** `Lenovo U3302`, o «Sin modelo» si no hay nada que decir. */
  modeloLargo: string
  /** `Ordenador Lenovo U3302`. Lo que se enseña cuando la etiqueta no basta. */
  completo: string
  /** `Lenovo U3302 · S/N ABC123`, para la segunda línea de una lista. */
  ficha: string
  /** El modelo está en el catálogo pero nadie lo ha validado todavía. */
  modeloSinValidar: boolean
}

/**
 * Resuelve la identidad de un aparato siguiendo fusiones de tipo y de modelo.
 *
 * Cae con elegancia hacia atrás: si no hay modelo de catálogo usa el texto libre
 * que se escribió antes de que existiera, y si tampoco lo hay lo dice. Un
 * inventario que se queda mudo cuando falta un dato es peor que uno que admite
 * que le falta.
 */
export function identifyAsset(
  asset: Asset,
  types: Map<string, AssetType>,
  models: Map<string, AssetModel>,
): AssetIdentity {
  const type = resolveType(types, asset.asset_type_id)
  const model = resolveModel(models, asset.asset_model_id)

  const tipo = type?.name ?? 'Equipo'
  const marca = model?.brand.trim() ?? ''
  const modelo = model ? model.model.trim() : (asset.model?.trim() ?? '')
  const serie = asset.serial?.trim() ?? ''

  const modeloLargo = [marca, modelo].filter(Boolean).join(' ')
  const completo = [tipo, modeloLargo].filter(Boolean).join(' ')
  const ficha = [modeloLargo, serie && `S/N ${serie}`].filter(Boolean).join(' · ')

  return {
    etiqueta: asset.label ?? tipo,
    tipo,
    marca,
    modelo,
    serie,
    modeloLargo: modeloLargo || 'Sin modelo',
    completo,
    ficha,
    modeloSinValidar: model ? !model.confirmed : false,
  }
}

export interface ModelHit {
  model: AssetModel
  /** Por qué ha salido: vacío si coincide marca o modelo, «alias “x”» si no. */
  why: string
}

/**
 * Busca modelos de un tipo por marca, por modelo y por alias.
 *
 * Se busca sobre «marca modelo» junta además de por separado, porque es como se
 * teclea: nadie escribe el modelo a secas cuando sabe la marca. Y por eso
 * `lenovo u33` encuentra el U3302 sin que haya que acertar dónde empieza cada
 * mitad.
 */
export function searchModels(
  models: AssetModel[],
  typeId: string | null,
  query: string,
  limit = 6,
): ModelHit[] {
  const q = norm(query)
  const vivos = models.filter(
    (m) => !m.merged_into && m.active && (typeId === null || m.asset_type_id === typeId),
  )
  if (!q) {
    // Sin nada tecleado se ofrecen los validados primero: es el catálogo bueno,
    // y en un desplegable de seis huecos es lo que ahorra teclear.
    return [...vivos]
      .sort(
        (a, b) =>
          Number(b.confirmed) - Number(a.confirmed) ||
          modelLabel(a).localeCompare(modelLabel(b), 'es', { numeric: true }),
      )
      .slice(0, limit)
      .map((model) => ({ model, why: '' }))
  }

  const hits: ModelHit[] = []
  for (const model of vivos) {
    const junto = norm(modelLabel(model))
    if (junto.includes(q) || norm(model.model).includes(q) || norm(model.brand).includes(q)) {
      hits.push({ model, why: '' })
      continue
    }
    const alias = model.aliases.find((a) => norm(a).includes(q))
    if (alias) hits.push({ model, why: `alias «${alias}»` })
  }

  return hits
    .sort((a, b) => {
      const score = (h: ModelHit): number =>
        (norm(modelLabel(h.model)).startsWith(q) ? 0 : 2) + (h.why ? 1 : 0)
      return (
        score(a) - score(b) ||
        Number(b.model.confirmed) - Number(a.model.confirmed) ||
        modelLabel(a.model).localeCompare(modelLabel(b.model), 'es', { numeric: true })
      )
    })
    .slice(0, limit)
}

/** ¿Ese par marca+modelo ya existe en el catálogo de ese tipo? */
export function exactModel(
  models: AssetModel[],
  typeId: string,
  brand: string,
  model: string,
): AssetModel | null {
  const b = norm(brand)
  const m = norm(model)
  return (
    models.find(
      (x) =>
        !x.merged_into &&
        x.asset_type_id === typeId &&
        norm(x.brand) === b &&
        norm(x.model) === m,
    ) ?? null
  )
}

/**
 * Parte «Lenovo U3302» en marca y modelo. Gemela de `partir_marca_modelo()`.
 *
 * Se usa al escribir: quien teclea el modelo entero de corrido no tiene por qué
 * saber que hay dos campos. Si no reconoce marca, devuelve el texto entero como
 * modelo — inventar una marca es peor que no ponerla.
 */
export function splitBrandModel(texto: string, marcasConocidas: string[] = MARCAS_HABITUALES):
  { brand: string; model: string } {
  const limpio = texto.trim()
  if (!limpio) return { brand: '', model: '' }

  const n = norm(limpio)
  const marca = [...marcasConocidas]
    .sort((a, b) => b.length - a.length)
    .find((m) => n.startsWith(`${norm(m)} `) || n.startsWith(`${norm(m)}-`))

  if (!marca) return { brand: '', model: limpio }

  const resto = limpio.slice(marca.length).replace(/^[\s-]+/, '').trim()
  return resto ? { brand: marca, model: resto } : { brand: '', model: limpio }
}

/**
 * Modelos del mismo tipo que se parecen tanto que casi seguro son el mismo.
 *
 * Es la herramienta que el catálogo real necesita el primer día. Los datos que
 * hay traen «ME403U», «ME-403U» y «ME403U *» como tres modelos distintos, y
 * encontrarlos a ojo en una lista de cincuenta es exactamente el trabajo que
 * nadie hace.
 *
 * La comparación es sobre el nombre normalizado **sin nada que no sea letra o
 * número**, que es donde está la diferencia en los tres casos de arriba. No
 * intenta ser lista con distancias de edición: un parecido difuso produce
 * sugerencias falsas, y una sugerencia falsa en una operación que no se deshace
 * hace que se dejen de mirar todas.
 */
export function duplicadosProbables(models: AssetModel[]): Array<AssetModel[]> {
  const clave = (m: AssetModel): string =>
    `${m.asset_type_id}|${norm(modelLabel(m)).replace(/[^A-Z0-9]/g, '')}`

  const grupos = new Map<string, AssetModel[]>()
  for (const m of models) {
    if (m.merged_into) continue
    const k = clave(m)
    if (!k.endsWith('|')) grupos.set(k, [...(grupos.get(k) ?? []), m])
  }

  return [...grupos.values()]
    .filter((g) => g.length > 1)
    .sort((a, b) => b.length - a.length)
}
