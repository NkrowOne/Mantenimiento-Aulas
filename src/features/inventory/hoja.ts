/**
 * La hoja de inventario, en datos.
 *
 * Lo que se imprime —una sala o un edificio entero, con marca, modelo, número de
 * serie y las fechas de alta, cambio y baja— se decide aquí y se pinta en otro
 * sitio. El fichero no toca React, ni Dexie, ni supabase: recibe datos y
 * devuelve datos. Esa frontera es la que permite comprobar con pruebas la hoja
 * ENTERA, que es donde se gana la única confianza que importa: **que el papel no
 * mienta**. Una hoja impresa se lleva al aula, se firma y se archiva; cuando se
 * descubre que dice otra cosa que la pantalla ya no hay a quién preguntar.
 *
 * Tres decisiones que se toman aquí y no en cada pantalla:
 *
 *  1. **El orden dentro de la sala es el de lectura del aula**, no el
 *     alfabético: proyector, pantalla, altavoces… (`rangoDeTipo`/`TYPE_ORDER`).
 *     Es el orden en que se recorre un aula y el que ya usan el formulario de
 *     revisión y el bloque de inventario. Ordenar la hoja alfabéticamente
 *     pondría la botonera primero y el proyector el sexto, y comparar el papel
 *     con la pantalla obligaría a buscar cada fila dos veces.
 *
 *  2. **Una sola fecha por equipo**, la de `ultimoMovimiento`, con una prioridad
 *     explícita. Cada sitio que eligiera la suya diría una fecha distinta del
 *     mismo aparato, y las tres columnas —alta, cambio, baja— no se pueden mirar
 *     de un vistazo cuando la pregunta real es «¿qué le pasó a esto y cuándo?».
 *
 *  3. **Lo que no se sabe se deja en blanco.** `filasDelEspejo` construye la
 *     hoja con lo que hay en el dispositivo, para cuando no hay cobertura, y el
 *     espejo local no tiene `asset_events` ni el `updated_at` del servidor
 *     (`src/sync/pull.ts`). Así que las bajas y la fecha de último cambio salen
 *     nulas. Rellenarlas con `created_at` daría una hoja con todas las casillas
 *     llenas y una fecha inventada en cada línea, que es peor que un hueco: el
 *     hueco se ve y se pregunta.
 *
 * Y `created_at` es nullable de verdad —los 1.094 equipos importados del Excel y
 * el relleno de `backfill_room_assets` pueden no traerla—, así que nada de aquí
 * puede reventar ni imprimir «Invalid Date» por una fecha que falta.
 */

import { fechaCorta } from '@/domain/fechas'
import { rangoDeTipo, resolveType } from '@/domain/inventory'
import { norm } from '@/domain/normalize'
import { EMPTY_CAPABILITIES } from '@/domain/types'
import type { Asset, AssetRemoval, AssetType, Building, Room, Zone } from '@/domain/types'
import { sortRooms } from '@/features/rooms/orden'

/**
 * Una línea de la hoja, con todo lo que hay que imprimir de un equipo.
 *
 * Los nombres van en snake_case y no en la nomenclatura del resto del dominio a
 * propósito: son **exactamente** las columnas de la vista `inventory_sheet`, así
 * que la pantalla hace `select('*')` y castea sin mapear nada. Un mapeo por
 * medio es un sitio más donde una columna nueva se olvida y sale en blanco sin
 * que nadie se entere.
 */
export interface FilaDeInventario {
  asset_id: string
  building_id: string
  building_code: string
  building_name: string
  building_sort: number
  zone_id: string
  zone_name: string
  zone_sort: number
  room_id: string
  room_code: string
  room_name: string
  room_short_ref: string | null
  room_last_inventory_at: string | null
  /** El nombre del tipo YA resuelto siguiendo las fusiones (`merged_into`). */
  type_name: string | null
  label: string | null
  brand: string | null
  model: string | null
  serial: string | null
  status: 'instalado' | 'averiado' | 'retirado'
  confirmed: boolean
  /** `assets.created_at`. */
  alta_at: string | null
  /**
   * `assets.updated_at`, pero **solo cuando va por delante del alta**: la vista
   * publica NULL mientras no conste que nadie tocó el equipo, porque la columna
   * del servidor es `not null` y nace igualada a `created_at`. Nulo también en
   * la hoja del espejo, que no tiene esa fecha.
   */
  cambio_at: string | null
  /** Del último `asset_events` de tipo `baja`. Nulo sin conexión. */
  baja_at: string | null
  /** `meta->>'destino'`: `baja` o `almacen`. */
  baja_destino: string | null
  /** `meta->>'nota'`: lo que escribió quien pidió la retirada. */
  baja_motivo: string | null
  /** Hay un `asset_removals` en estado `pendiente`: el equipo todavía está ahí. */
  retirada_pedida: boolean
}

/** De qué se imprime la hoja. Son los dos alcances que pide el trabajo real:
    la sala que se tiene delante, y el edificio entero para la ronda. */
export type AlcanceDeHoja =
  | { tipo: 'sala'; roomId: string }
  | { tipo: 'edificio'; buildingId: string }

/**
 * Construye las filas con lo que hay en el espejo local, para cuando no hay red.
 *
 * Es la hoja de segunda opción y no se disimula: el espejo no guarda equipos
 * retirados —la descarga pide `.neq('status','retirado')`—, ni `asset_events`,
 * ni el `updated_at` del servidor. Lo que sale de aquí son los equipos
 * INSTALADOS de este dispositivo, con su alta y sin sus bajas. Quien la enseña
 * tiene que decirlo con una frase honesta; lo que esta función no hace es
 * disimularlo rellenando columnas.
 *
 * Un equipo que ya no tiene sala tampoco puede salir: al aprobar una retirada
 * con destino almacén, `decide_asset_removal` deja `assets.room_id` a NULL y la
 * sala solo queda dentro del `asset_events` de la baja, que el dispositivo no
 * tiene. Sin conexión, ese equipo es invisible — y decir «no lo sé» es lo único
 * cierto que se puede decir de él.
 */
export function filasDelEspejo(
  datos: {
    assets: Asset[]
    types: Map<string, AssetType>
    rooms: Room[]
    zones: Zone[]
    buildings: Building[]
    retiradas: AssetRemoval[]
  },
  alcance: AlcanceDeHoja,
): FilaDeInventario[] {
  const zonaPorId = new Map(datos.zones.map((z) => [z.id, z]))
  const edificioPorId = new Map(datos.buildings.map((b) => [b.id, b]))

  const salasEnAlcance = new Map<string, Room>()
  for (const sala of datos.rooms) {
    if (alcance.tipo === 'sala') {
      if (sala.id === alcance.roomId) salasEnAlcance.set(sala.id, sala)
      continue
    }
    if (zonaPorId.get(sala.zone_id)?.building_id === alcance.buildingId) {
      salasEnAlcance.set(sala.id, sala)
    }
  }

  // Una consulta por equipo sobre la lista de retiradas convertiría una hoja de
  // edificio —39 salas, cientos de equipos— en un recorrido cuadrático. El
  // espejo solo guarda las pendientes, así que este conjunto es pequeño.
  const conRetiradaPedida = new Set(
    datos.retiradas.filter((r) => r.state === 'pendiente').map((r) => r.asset_id),
  )

  const filas: FilaDeInventario[] = []
  for (const asset of datos.assets) {
    if (asset.room_id === null) continue
    const sala = salasEnAlcance.get(asset.room_id)
    if (!sala) continue

    const zona = zonaPorId.get(sala.zone_id)
    const edificio = zona ? edificioPorId.get(zona.building_id) : undefined
    // Sin planta o sin edificio no hay fila que imprimir: faltarían la mitad de
    // las columnas. Solo pasa mientras una descarga va por la mitad —la poda de
    // `pull.ts` se lleva las salas que quedan colgando de una planta huérfana—,
    // y una hoja con la sala en blanco no ayudaría a nadie.
    if (!zona || !edificio) continue

    filas.push({
      asset_id: asset.id,
      building_id: edificio.id,
      building_code: edificio.code,
      building_name: edificio.name,
      building_sort: edificio.sort_order,
      zone_id: zona.id,
      zone_name: zona.name,
      zone_sort: zona.sort_order,
      room_id: sala.id,
      room_code: sala.code,
      room_name: sala.name,
      room_short_ref: sala.short_ref,
      room_last_inventory_at: sala.last_inventory_at,
      type_name: resolveType(datos.types, asset.asset_type_id)?.name ?? null,
      label: asset.label,
      brand: asset.brand,
      model: asset.model,
      serial: asset.serial,
      status: asset.status,
      confirmed: asset.confirmed,
      alta_at: asset.created_at,
      // Las cuatro que el dispositivo no puede saber. Ver la cabecera: null es
      // la respuesta honesta, no un hueco que haya que rellenar más adelante.
      cambio_at: null,
      baja_at: null,
      baja_destino: null,
      baja_motivo: null,
      retirada_pedida: conRetiradaPedida.has(asset.id),
    })
  }

  return filas
}

/**
 * ¿Esta línea es la de un equipo que ya salió de la sala?
 *
 * Vive aquí y no en cada sitio que lo pregunta porque son tres —el filtro de la
 * hoja viva, la frase de «qué le pasó por última vez» y la marca de la columna
 * de estado— y las tres tienen que contestar lo mismo. Escrita tres veces, la
 * hoja podía imprimir un equipo tachado como baja y contarlo a la vez entre los
 * instalados del recuento de la cabecera: dos números del mismo papel que no
 * cuadran, que es cuando se deja de creer el documento entero.
 *
 * Y son las DOS condiciones, no una: `reject_asset` deja el equipo en
 * `retirado` sin evento de baja —y ahí `baja_at` puede llegar nulo desde el
 * espejo local—, mientras que un equipo con su evento de baja registrado puede
 * traer todavía el estado viejo en un espejo a medio sincronizar.
 */
export function esBaja(fila: FilaDeInventario): boolean {
  return fila.status === 'retirado' || fila.baja_at !== null
}

/**
 * La fecha tal y como se imprime, o nada.
 *
 * `fechaCorta` ya devuelve cadena vacía ante una fecha ilegible —y las hay: el
 * Excel del que salió todo esto traía cosas como `29-01-026`—, pero una cadena
 * vacía en una plantilla se imprime como una celda que parece rellena. Null es
 * lo que deja poner un guion y que se vea que falta.
 *
 * Es la ÚNICA forma de escribir una fecha de esta hoja: la pantalla la usa para
 * las columnas y la cabecera, y `ultimoMovimiento` para la suya. Con un
 * formateador por cada lado, el día que el proyecto cambie `fechaCorta` la
 * columna «Alta» y la línea de «Último cambio» del mismo papel empezarían a
 * escribir la misma fecha de dos maneras.
 */
export function fechaDeLaHoja(iso: string | null): string | null {
  if (!iso) return null
  return fechaCorta(iso) || null
}

/**
 * Cómo se encabeza la línea de un equipo: el nombre, y si el tipo baja debajo.
 *
 * La primera unidad de cada tipo de cada sala **se llama como su tipo**, por dos
 * caminos que no se hablan entre sí: `nextLabel` devuelve el nombre a secas al
 * dar de alta desde el aula —el 2 llega con el segundo aparato— y el relleno del
 * servidor hace exactamente lo mismo con los 1.094 importados. Y lo normal en un
 * aula es un proyector, una pantalla, unos altavoces, así que la inmensa mayoría
 * de las líneas imprimían «Proyector» y justo debajo «Proyector» otra vez. Sobre
 * el papel un campo repetido no se lee como redundancia: se lee como un dato
 * roto, y alguien lo pregunta.
 *
 * Se compara contra lo que de verdad se pinta arriba y no contra `label`: con la
 * etiqueta vacía el título ya cae en el tipo, así que comparar con `label`
 * volvería a imprimir las dos líneas justo en los equipos que aún no han pasado
 * por el relleno. Y con `norm`, el mismo criterio con el que `nextLabel` decide
 * si una etiqueta está usada: «proyector» escrito a mano no es un dato nuevo.
 *
 * El tipo que NO consta sí baja —lo pinta como hueco quien la usa—, porque ahí
 * la segunda línea dice algo: que falta por resolver. Es lo mismo que la
 * cabecera cuenta como «Sin tipo».
 */
export function nombreDeLaFila(fila: FilaDeInventario): { titulo: string; tipoAparte: boolean } {
  const titulo = fila.label ?? fila.type_name ?? 'Equipo'
  const repetido = fila.type_name !== null && norm(fila.type_name) === norm(titulo)
  return { titulo, tipoAparte: !repetido }
}

export interface GrupoDeSala {
  room_id: string
  room_code: string
  room_name: string
  room_short_ref: string | null
  zone_name: string
  room_last_inventory_at: string | null
  filas: FilaDeInventario[]
}

/**
 * La etiqueta con la que se desempata dentro de un mismo tipo.
 *
 * `Pantalla` y `Pantalla 2` tienen el mismo rango, y sin desempate quedarían en
 * el orden en que los devolviera IndexedDB — que cambia entre dispositivos.
 */
function etiquetaDeFila(fila: FilaDeInventario): string {
  return fila.label ?? fila.type_name ?? ''
}

/**
 * El orden de lectura del aula, el mismo que el formulario de revisión.
 *
 * Se copia el criterio de `ordenarComprobaciones` y de las filas de revisión a
 * propósito —rango de tipo, después etiqueta con `numeric`—: son las dos listas
 * con las que se compara esta hoja, y cualquier diferencia entre ellas se lee
 * como que falta o sobra un equipo.
 *
 * Las bajas NO van en un bloque aparte al final. Un proyector retirado sale
 * justo al lado del que lo sustituyó, que es donde cuenta la historia de ese
 * sitio del aula; sacarlas a una lista propia obliga a cruzar dos tablas para
 * responder «¿y el de antes?».
 */
function porOrdenDeLectura(a: FilaDeInventario, b: FilaDeInventario): number {
  return (
    rangoDeTipo(a.type_name) - rangoDeTipo(b.type_name) ||
    etiquetaDeFila(a).localeCompare(etiquetaDeFila(b), 'es', { numeric: true }) ||
    // Dos equipos pueden compartir etiqueta: el índice único de la base solo
    // cubre los vivos, así que una baja y su recambio se llaman igual.
    a.asset_id.localeCompare(b.asset_id)
  )
}

/**
 * Agrupa por sala y ordena: planta, después sala, y dentro el orden de lectura.
 *
 * El orden de las salas NO se escribe aquí: lo pone `sortRooms(..., 'planta')`,
 * el mismo que la lista de salas y el mismo que la hoja de placas. Es lo que
 * hace que `−2.1` no se cuele en medio de la primera planta y que `0.2` vaya
 * antes que `0.10`, y sobre todo lo que garantiza que el papel salga en el orden
 * en el que el técnico va a recorrer el edificio. Un comparador propio aquí
 * sería una cuarta opinión sobre el mismo problema.
 */
export function agruparPorSala(filas: FilaDeInventario[]): GrupoDeSala[] {
  const porSala = new Map<string, { muestra: FilaDeInventario; filas: FilaDeInventario[] }>()
  const zonas = new Map<string, Zone>()

  for (const fila of filas) {
    const grupo = porSala.get(fila.room_id)
    if (grupo) grupo.filas.push(fila)
    else porSala.set(fila.room_id, { muestra: fila, filas: [fila] })

    if (!zonas.has(fila.zone_id)) {
      zonas.set(fila.zone_id, {
        id: fila.zone_id,
        building_id: fila.building_id,
        name: fila.zone_name,
        sort_order: fila.zone_sort,
      })
    }
  }

  const grupos = [...porSala.values()]

  // `sortRooms` pide salas, y de la hoja solo llegan filas. Se rehacen con los
  // campos que el orden mira —zona y código— y relleno en el resto: son objetos
  // que no salen de esta función, y es más barato que duplicar el comparador y
  // que las dos copias se separen con el tiempo.
  const salas: Room[] = grupos.map(({ muestra }) => ({
    id: muestra.room_id,
    zone_id: muestra.zone_id,
    code: muestra.room_code,
    name: muestra.room_name,
    kind: 'otro',
    capabilities: EMPTY_CAPABILITIES,
    projector_hours: null,
    lamp_pct: null,
    last_inspection_at: null,
    last_inventory_at: muestra.room_last_inventory_at,
    active: true,
    short_ref: muestra.room_short_ref,
  }))

  const ordenadas = sortRooms(salas, zonas, 'planta')

  /*
   * Y el edificio por encima de la planta.
   *
   * `sortRooms` ordena dentro de un edificio, que es todo lo que necesita la
   * lista de salas; una hoja de varios edificios mezclaría sus plantas primeras
   * porque las dos llevan el mismo `sort_order`. Se reordena después y no en el
   * mismo comparador porque `Array.prototype.sort` es estable desde ES2019: lo
   * que ya ordenó `sortRooms` se conserva dentro de cada edificio.
   */
  const edificioDeSala = new Map(grupos.map(({ muestra }) => [muestra.room_id, muestra.building_sort]))
  ordenadas.sort((a, b) => (edificioDeSala.get(a.id) ?? 0) - (edificioDeSala.get(b.id) ?? 0))

  const resultado: GrupoDeSala[] = []
  for (const sala of ordenadas) {
    // `porSala` ya está indexado por `room_id`, que es el `id` con el que se
    // rehicieron las salas de arriba: rehacer un segundo índice idéntico solo
    // añadía un sitio donde las dos claves se pudieran separar.
    const grupo = porSala.get(sala.id)
    if (!grupo) continue
    resultado.push({
      room_id: grupo.muestra.room_id,
      room_code: grupo.muestra.room_code,
      room_name: grupo.muestra.room_name,
      room_short_ref: grupo.muestra.room_short_ref,
      zone_name: grupo.muestra.zone_name,
      room_last_inventory_at: grupo.muestra.room_last_inventory_at,
      filas: [...grupo.filas].sort(porOrdenDeLectura),
    })
  }
  return resultado
}

export interface ResumenDeHoja {
  total: number
  instalados: number
  averiados: number
  retirados: number
  /** Equipos sin número de serie apuntado: el hueco que hace que un parte de
      garantía no se pueda cursar. */
  sinSerie: number
  /** Equipos que apuntó alguien en un aula y nadie ha validado todavía. */
  sinValidar: number
  porTipo: Array<{ tipo: string; n: number }>
}

/** Lo que se lee cuando un tipo no llegó resuelto. Sale en el recuento igual,
    porque el equipo existe: esconderlo haría que las sumas no cuadraran. */
const SIN_TIPO = 'Sin tipo'

/**
 * El recuento de la cabecera de la hoja.
 *
 * Cuenta EXACTAMENTE las filas que se le pasan, y esa es toda la regla. Si la
 * hoja oculta las bajas, el resumen tampoco las cuenta: una cabecera que diga
 * «14 equipos» encima de una tabla con doce líneas es la clase de contradicción
 * que hace desconfiar del documento entero, y ahí ya da igual cuál de los dos
 * números fuera el bueno.
 *
 * Y reparte por estado con `esBaja`, no con `status` a secas, por lo mismo: es
 * el predicado con el que la tabla decide tachar una línea, y contar con otro
 * distinto producía justo la contradicción que `esBaja` existe para impedir.
 */
export function resumen(filas: FilaDeInventario[]): ResumenDeHoja {
  let instalados = 0
  let averiados = 0
  let retirados = 0
  let sinSerie = 0
  let sinValidar = 0

  // El recuento por tipo se guarda con una fila de muestra para poder ordenarlo
  // después con el mismo `rangoDeTipo` que la tabla de abajo.
  const porTipo = new Map<string, { tipo: string; n: number; nombre: string | null }>()

  for (const fila of filas) {
    /*
     * El mismo predicado que pinta la tabla, y en el mismo orden de ramas que
     * `FilaDeLaHoja`: primero la baja, después la avería.
     *
     * Repartir por `status` contaba distinto que la tabla en cuanto llegaba una
     * fila con su fecha de baja y el estado viejo, que no es un caso de
     * laboratorio: la cola de salida sube el equipo con un `upsert` plano, así
     * que un iPad que se descargó la sala antes de que un coordinador aprobara
     * la retirada reescribe `status = 'instalado'` sobre un equipo que ya tiene
     * su evento de baja, y la vista devuelve la fecha de baja con el estado de
     * antes. Con «Incluir equipos dados de baja» marcado —la hoja que se archiva
     * justamente para justificar dónde acabó un equipo— la cabecera imprimía
     * «1 instalado · 0 de baja» encima de una tabla con esa única línea tachada
     * como «× Retirado».
     */
    if (esBaja(fila)) retirados += 1
    else if (fila.status === 'averiado') averiados += 1
    else instalados += 1

    if ((fila.serial ?? '').trim() === '') sinSerie += 1
    if (!fila.confirmed) sinValidar += 1

    const nombre = fila.type_name
    const clave = nombre ?? SIN_TIPO
    const previo = porTipo.get(clave)
    if (previo) previo.n += 1
    else porTipo.set(clave, { tipo: clave, n: 1, nombre })
  }

  return {
    total: filas.length,
    instalados,
    averiados,
    retirados,
    sinSerie,
    sinValidar,
    porTipo: [...porTipo.values()]
      .sort(
        (a, b) =>
          rangoDeTipo(a.nombre) - rangoDeTipo(b.nombre) ||
          a.tipo.localeCompare(b.tipo, 'es', { numeric: true }),
      )
      .map(({ tipo, n }) => ({ tipo, n })),
  }
}

/**
 * Qué le pasó por última vez a este equipo y cuándo, en una sola frase legible.
 *
 * La prioridad es baja > cambio > alta, y no es arbitraria: son las tres cosas
 * que le pueden pasar a un aparato en ese orden temporal, así que la última que
 * conste es la última que ocurrió. Un equipo que se dio de baja ayer y se editó
 * hace un mes tiene que leerse «Baja», no «Modificado».
 *
 * Un equipo retirado del que no consta la fecha de baja SIGUE siendo una baja:
 * es exactamente lo que pasa con la hoja hecha desde el espejo local, y decir
 * «Baja» sin fecha es más cierto que decir «Alta» con la fecha de cuando se
 * instaló. La fecha nula se pinta como el hueco que es.
 *
 * Y el destino se lee con palabras porque los dos casos no son lo mismo: el
 * aparato que se muere desaparece, y el que vuelve a la estantería suma una
 * unidad al almacén. Imprimir «Baja» en los dos borraría la única distinción
 * que hace que el almacén cuadre.
 */
export function ultimoMovimiento(fila: FilaDeInventario): { fecha: string | null; que: string } {
  if (esBaja(fila)) {
    const que = fila.baja_destino === 'almacen' ? 'Devuelto al almacén' : 'Baja'
    return { fecha: fechaDeLaHoja(fila.baja_at), que }
  }
  if (fila.cambio_at !== null) return { fecha: fechaDeLaHoja(fila.cambio_at), que: 'Modificado' }
  return { fecha: fechaDeLaHoja(fila.alta_at), que: 'Alta' }
}

/**
 * Quita las bajas cuando la hoja es la del inventario vivo.
 *
 * Son dos documentos con el mismo formato y usos distintos: el inventario que se
 * lleva al aula para contrastar lo que hay, y el histórico con lo que salió de
 * ella. Mezclarlos hace que el primero tenga líneas de aparatos que ya no están,
 * y en una hoja impresa —sin colores fiables ni columnas que se puedan filtrar—
 * eso se traduce en buscar un proyector que se dio de baja hace dos años.
 *
 * Un equipo con la retirada solo PEDIDA no es una baja: sigue en la sala, se
 * imprime siempre y se marca. La solicitud puede rechazarse.
 */
export function filtrar(
  filas: FilaDeInventario[],
  opciones: { incluirBajas: boolean },
): FilaDeInventario[] {
  if (opciones.incluirBajas) return [...filas]
  return filas.filter((f) => !esBaja(f))
}
