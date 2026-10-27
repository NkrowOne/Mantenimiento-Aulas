/**
 * El almacén en un Excel: existencias, movimientos y unidades con número de serie.
 *
 * Es para quien necesita el almacén fuera de la aplicación —un pedido a
 * compras, la revisión de fin de curso, un cruce con la bolsa— y no quiere
 * pasar por la sincronización con SharePoint, que es otra cosa: aquella
 * devuelve el trabajo al libro de la gente; esto saca una foto del almacén de
 * hoy en un libro nuevo, que nadie tiene que subir a ninguna parte.
 *
 * Tres hojas, y cada una contesta una pregunta distinta:
 *
 *  - **Existencias**: qué hay. Una fila por artículo, con lo que queda, cuántas
 *    hay de cada estado (nuevas, usadas, reacondicionadas, averiadas, sin
 *    estado), cómo se cuenta (por cantidad o por número de serie), el mínimo y
 *    si está por debajo. Los **retirados salen también**, apagados y con su
 *    motivo: `stock_levels` los deja fuera (filtra por `active`) y por eso el
 *    saldo de un retirado no se lee de ahí sino de sumar sus movimientos, que
 *    es de donde sale el saldo de todos. Por la misma razón **no llevan cifras
 *    por estado**: `stock_levels_por_estado`, que las da, tampoco los trae.
 *  - **Movimientos de Almacén**: qué pasó, con el saldo detrás. Es la hoja de
 *    la sincronización tal cual (`hojaDeMovimientos`), así que los dos libros
 *    dicen lo mismo del mismo movimiento.
 *  - **Unidades con n.º de serie**: cuáles son, por número de serie, de
 *    cualquier artículo —un ordenador, un proyector, un teclado—, cómo está
 *    cada una (nueva, usada, averiada…) y dónde: en el almacén, instalada en un
 *    aula o de baja. El almacén cuenta y esto nombra; no tienen por qué cuadrar,
 *    y no es un error: son las que nadie ha apuntado todavía.
 *
 * **«Estado» es cómo está y «Situación» es dónde está.** Estado es nueva, usada,
 * reacondicionada, averiada: lo dice quien tiene el aparato delante, y se llama
 * igual en las pantallas, en las columnas de existencias y en la hoja de
 * unidades. Lo que en «Existencias» se llamaba «Estado» y valía «Activo» o
 * «Retirado» es la **situación** del artículo —si sigue en el catálogo—, como la
 * de una unidad es si está en el almacén, instalada o de baja. Con la misma
 * palabra para las dos cosas, una columna «Estado» que dijera «Activo», junto a
 * otras que cuentan las nuevas y las averiadas, se leería como una sola
 * pregunta con dos respuestas que no tienen nada que ver.
 *
 * **Un servidor sin la migración del estado por cantidad** no tiene la vista
 * `stock_levels_por_estado`. Eso no puede impedir sacar el almacén: la
 * exportación sale como salía —sin las columnas de estado ni «Cómo se cuenta»— y
 * no se avisa de nada, porque no ha fallado nada. Es lo mismo que se hace con la
 * vista de las unidades.
 *
 * La carga es lo único que toca la red; todo lo demás son funciones puras que
 * reciben las filas tal como las devuelve la base. Es la separación que permite
 * probar los tintes, el «Sí/No» y el cruce de movimientos con partes, aulas y
 * personas sin levantar un servidor.
 *
 * Como en `datosDeLaPasada`, **todo va paginado, y una descarga incompleta
 * detiene la exportación**: un Excel con la mitad de los movimientos sale con
 * saldos que no cuadran con las existencias, y nadie lo nota hasta que alguien
 * suma.
 */

import { supabase } from '@/lib/supabase'
import { diaEnMadrid } from '@/domain/fechas'
import { descargaEntera } from '@/sync/paginada'
import type { Descarga } from '@/sync/paginada'
import { esSilencio, señalConTope } from '@/features/reports/informe/espera'
import { tipoVivo } from '@/domain/equipos'
import type { TipoConocido } from '@/domain/equipos'
import { ESTADO_EN_PLURAL, SEGUIMIENTO_LABEL } from '@/domain/estados'
import type { NivelPorEstado } from '@/domain/estados'
import { hojaDeMovimientos } from '@/domain/hojasNuevas'
import type { MovimientoParaHoja } from '@/domain/hojasNuevas'
import type { Formato, HojaNueva, Tinte } from '@/domain/libro'
import { CONDICION_LABEL, ESTADOS_EN_ORDEN, SITUACION_LABEL, cuantasEnEstado } from '@/domain/unidades'
import type { Condicion, SituacionDeUnidad } from '@/domain/unidades'
import { fechaAExcel } from '@/domain/valores'
import type { ValorCelda } from '@/domain/xlsx'
import type { Exportacion } from '@/domain/vistaPrevia'

// -----------------------------------------------------------------------------
// Las filas, tal como las devuelve la base
// -----------------------------------------------------------------------------

export interface FilaArticulo {
  id: string
  name: string
  unit: string
  min_threshold: number
  asset_type_id: string | null
  active: boolean
  /** Cuándo y por qué lo retiró el administrador. Faltan en un servidor sin la migración del 23/09. */
  retired_at?: string | null
  retired_reason?: string | null
}

/** Una fila de `stock_levels`: lo que la pantalla del almacén enseña. */
export interface FilaNivel {
  stock_item_id: string
  on_hand: number
}

/**
 * Una fila de `stock_levels_por_estado`: un artículo **activo**, con su cantidad
 * partida por estados y cómo se lleva.
 *
 * Solo las columnas que el export lee. `on_hand` y `disponibles` están en la
 * vista y aquí sobran: las existencias salen de `stock_levels`, como siempre, y
 * «disponibles» es una resta que quien abre el Excel hace si la quiere. Pedir
 * menos columnas es arriesgar menos: si a un servidor a medias le faltara una de
 * las que aquí sobran, la exportación perdería los estados enteros por nada.
 */
export type FilaNivelPorEstado = Pick<NivelPorEstado, 'stock_item_id' | 'seguimiento' | Condicion>

export interface FilaMovimiento {
  stock_item_id: string
  qty: number
  kind: string
  occurred_at: string
  incident_id: string | null
  room_id: string | null
  by_user: string | null
  source: string
  note: string | null
}

export interface FilaIncidencia {
  id: string
  external_ref: string | null
  /** `incidencia`, `solicitud` u `observacion`. */
  kind: string
  room_id: string | null
}

export interface FilaSala {
  id: string
  code: string
  zone_id: string
}
export interface FilaZona {
  id: string
  building_id: string
}
export interface FilaEdificio {
  id: string
  name: string
}
export interface FilaPerfil {
  id: string
  full_name: string | null
}

/**
 * Una unidad tal como la devuelve la base. `item_name` y `condicion` solo los
 * trae la vista `stock_unit_list`: faltan en un servidor sin la migración del
 * 27 de octubre, que lee la tabla de siempre.
 */
export interface FilaUnidad {
  /** Lo que decía la hoja o el alta, tal cual: «Ordenador Tiny». */
  articulo: string
  /** El nombre del artículo del almacén al que pertenece, si se pudo casar. */
  item_name?: string | null
  brand: string | null
  model: string | null
  serial: string
  notes: string | null
  status: string
  condicion?: string | null
  room_id: string | null
  installed_at: string | null
  retired_at: string | null
}

/** Todo lo que el export lee, sin cruzar. */
export interface DatosDelAlmacen {
  articulos: FilaArticulo[]
  niveles: FilaNivel[]
  /**
   * Cuántas hay de cada estado, de los artículos activos. `null` es que el
   * servidor no tiene la vista `stock_levels_por_estado` —no ha pasado la
   * migración del estado por cantidad—: la exportación sale entonces sin las
   * columnas de estado, como antes. Una lista vacía es otra cosa: un servidor al
   * día sin ningún artículo activo.
   */
  estados: FilaNivelPorEstado[] | null
  tipos: TipoConocido[]
  movimientos: FilaMovimiento[]
  incidencias: FilaIncidencia[]
  salas: FilaSala[]
  zonas: FilaZona[]
  edificios: FilaEdificio[]
  perfiles: FilaPerfil[]
  unidades: FilaUnidad[]
}

// -----------------------------------------------------------------------------
// Fechas
// -----------------------------------------------------------------------------

/**
 * `2026-10-27` → `2026-10-27T12:00:00Z`.
 *
 * `fechaAExcel` convierte un instante al día **de la zona del aparato**, y una
 * fecha suelta la lee como medianoche UTC: en un iPad con la zona en América
 * eso es la tarde del día anterior, y todas las fechas del Excel saldrían con
 * un día menos. Los días de aquí ya vienen en hora de Madrid (`diaEnMadrid`);
 * a mediodía UTC caen en el mismo día en cualquier zona entre UTC−11 y UTC+11,
 * que es todo el mundo con aparatos de este campus.
 */
function alMediodia(dia: string): string {
  return `${dia}T12:00:00Z`
}

function serieDelDia(dia: string | null): number | null {
  return dia ? fechaAExcel(alMediodia(dia)) : null
}

// -----------------------------------------------------------------------------
// Existencias
// -----------------------------------------------------------------------------

/** Cómo se lleva un artículo y cuántas hay de cada estado: lo que dice su fila de `stock_levels_por_estado`. */
export type EstadosParaHoja = Pick<NivelPorEstado, 'seguimiento' | Condicion>

export interface ArticuloParaHoja {
  nombre: string
  unidad: string
  existencias: number
  /**
   * Cuántas hay de cada estado y cómo se cuenta el artículo. `null` cuando no se
   * sabe: un servidor que no tiene estados, o un artículo retirado, que la vista
   * no trae. No es lo mismo que «ninguna».
   */
  estados: EstadosParaHoja | null
  /** `0` es «sin umbral», igual que en la base. */
  minimo: number
  /** El tipo de equipo al que está enlazado el artículo (un cable de proyector → «Proyector»), si lo está. */
  tipoDeEquipo: string | null
  activo: boolean
  /** Día de Madrid (`2026-09-23`) en que se retiró. */
  retiradoEl: string | null
  motivoDeRetirada: string | null
}

/**
 * Una columna de «Existencias»: cómo se llama, cuánto mide, cómo se formatea y de
 * dónde sale lo que lleva cada artículo.
 *
 * Las cuatro cosas van juntas porque la hoja tiene dos formas —con las columnas
 * de estado y sin ellas— y, repartidas en arrays paralelos, cada columna de más
 * obligaría a recontar a mano los índices de los anchos y de los formatos. Un
 * índice mal contado pone el formato de fecha en la columna de al lado sin que
 * falle nada: la cabecera, el ancho y el formato de una columna no se separan.
 */
interface ColumnaDeExistencias {
  cabecera: string
  /** En caracteres. */
  ancho: number
  formato?: Formato
  valor: (a: ArticuloParaHoja) => ValorCelda
}

/** Lo que mide cada columna de estado: lo que su cabecera y un poco más, por la flecha del filtro. */
const ANCHO_DEL_ESTADO: Record<Condicion, number> = {
  nuevo: 9,
  usado: 9,
  reacondicionado: 18,
  averiado: 11,
  sin_indicar: 12,
}

/**
 * Cuántas hay de un estado, para la celda: **en blanco si no hay ninguna**.
 *
 * Con sesenta artículos, casi todos tienen todo en un solo estado —los ocho
 * teclados, nuevos— y cuatro columnas de ceros esconden las dos o tres cifras
 * que hay que mirar: lo averiado, lo que sigue sin estado. Es lo que ya hacen
 * «Entrada» y «Salida» en los movimientos, donde una celda vacía es «ninguna».
 * Y de paso el filtro de «Averiadas» por «no vacías» es la lista de lo que hay
 * que reparar, y una suma de la columna da lo mismo con ceros que sin ellos.
 *
 * «Existencias» sí lleva su cero: un artículo agotado es justo lo que se busca
 * en esa columna, y es la que pinta la fila.
 *
 * Un blanco vale entonces por «ninguna» y también por «no hay dato» (un
 * retirado): se distinguen por la columna «Situación». Lo que no es cero se
 * enseña tal cual, también si fuera negativo: una cifra que no cuadra tiene que
 * verse, no esconderse.
 */
function cifraDeEstado(n: number | undefined): number | null {
  return !n ? null : n
}

const SEGUIMIENTOS_CONOCIDOS = new Set<string>(Object.keys(SEGUIMIENTO_LABEL))

/**
 * «Por cantidad» o «Por número de serie», con las palabras de las pantallas. En
 * blanco cuando no se sabe —un retirado, un servidor sin estados— o cuando la
 * base dice algo que la aplicación no entiende: la hoja no escribe lo que no
 * entiende.
 */
function comoSeCuenta(a: Pick<ArticuloParaHoja, 'estados'>): string | null {
  const s = a.estados?.seguimiento
  return s && SEGUIMIENTOS_CONOCIDOS.has(s) ? SEGUIMIENTO_LABEL[s] : null
}

/**
 * Las columnas de «Existencias», en el orden en que se leen.
 *
 * **Con estados** (el servidor tiene `stock_levels_por_estado`) detrás de
 * «Existencias» van las cinco cifras —nuevas, usadas, reacondicionadas,
 * averiadas, sin estado—, que suman las existencias, y detrás de «Tipo de
 * equipo», «Cómo se cuenta». **Sin estados** la hoja es la de siempre, salvo el
 * nombre de «Situación», que antes era «Estado».
 */
function columnasDeExistencias(conEstados: boolean): ColumnaDeExistencias[] {
  const porEstado = conEstados
    ? ESTADOS_EN_ORDEN.map(
        (c): ColumnaDeExistencias => ({
          cabecera: ESTADO_EN_PLURAL[c],
          ancho: ANCHO_DEL_ESTADO[c],
          formato: 'entero',
          valor: (a) => cifraDeEstado(a.estados?.[c]),
        }),
      )
    : []

  return [
    { cabecera: 'Artículo', ancho: 40, valor: (a) => a.nombre },
    { cabecera: 'Unidad', ancho: 9, valor: (a) => a.unidad },
    { cabecera: 'Existencias', ancho: 12, formato: 'entero', valor: (a) => a.existencias },
    ...porEstado,
    { cabecera: 'Mínimo', ancho: 9, formato: 'entero', valor: (a) => a.minimo },
    { cabecera: 'Bajo mínimo', ancho: 13, valor: (a) => (estaBajoMinimo(a) ? 'Sí' : 'No') },
    { cabecera: 'Tipo de equipo', ancho: 20, valor: (a) => a.tipoDeEquipo },
    ...(conEstados ? [{ cabecera: 'Cómo se cuenta', ancho: 20, valor: comoSeCuenta }] : []),
    { cabecera: 'Situación', ancho: 11, valor: (a) => (a.activo ? 'Activo' : 'Retirado') },
    { cabecera: 'Retirado el', ancho: 12, formato: 'fecha', valor: (a) => serieDelDia(a.retiradoEl) },
    { cabecera: 'Motivo de la retirada', ancho: 46, formato: 'textoAjustado', valor: (a) => a.motivoDeRetirada },
  ]
}

/**
 * La misma regla que la vista `stock_levels` (`below_threshold`): solo alerta
 * quien tiene un mínimo de verdad, y alcanzarlo ya es estar bajo. Un artículo
 * con mínimo 0 no está «bajo mínimo» aunque no quede ninguno; eso es otro
 * aviso, y tiene su propio tinte.
 */
export function estaBajoMinimo(a: Pick<ArticuloParaHoja, 'activo' | 'minimo' | 'existencias'>): boolean {
  // Un retirado ya no se cuenta: no pide reposición aunque su saldo sea cero.
  return a.activo && a.minimo > 0 && a.existencias <= a.minimo
}

/**
 * Lo que dice el color de cada fila: un retirado se apaga, lo que está bajo
 * mínimo se pinta en rojo, y lo que se ha acabado sin que nadie fijara un
 * mínimo en ámbar —el aviso de que se agotó algo que no vigilaba nadie—.
 */
export function tinteDelArticulo(a: ArticuloParaHoja): Tinte | undefined {
  if (!a.activo) return 'apagado'
  if (estaBajoMinimo(a)) return 'critico'
  if (a.existencias <= 0) return 'aviso'
  return undefined
}

/**
 * La hoja «Existencias». `conEstados` es si **el servidor sabe de estados**, no
 * si algún artículo los tiene: con él la hoja lleva las columnas de estado y
 * «Cómo se cuenta» —en blanco para el retirado que la vista no trae—, y sin él
 * no las lleva, ni vacías. Una hoja con cinco columnas en blanco diría «ninguna»
 * donde en realidad no se sabe.
 */
export function hojaDeExistencias(articulos: ArticuloParaHoja[], conEstados = false): HojaNueva {
  const columnas = columnasDeExistencias(conEstados)
  const filas: ValorCelda[][] = [columnas.map((c) => c.cabecera)]
  const tintes: Array<Tinte | undefined> = []

  // Los vivos primero, por nombre, que es como se recorre el almacén; los
  // retirados al final, juntos, donde no estorban al que busca qué pedir.
  // `numeric` para que «Cable 2 m» vaya antes que «Cable 10 m».
  const ordenados = [...articulos].sort(
    (a, b) =>
      Number(b.activo) - Number(a.activo) || a.nombre.localeCompare(b.nombre, 'es', { numeric: true }),
  )

  for (const a of ordenados) {
    filas.push(columnas.map((c) => c.valor(a)))
    tintes.push(tinteDelArticulo(a))
  }

  return {
    nombre: 'Existencias',
    filas,
    anchos: columnas.map((c) => c.ancho),
    formatos: columnas.map((c) => c.formato),
    tintes,
    caracter: 'app',
  }
}

// -----------------------------------------------------------------------------
// Unidades con número de serie
// -----------------------------------------------------------------------------

export interface UnidadParaHoja {
  /** El artículo del almacén, con su nombre; si no se pudo casar, lo que apuntó quien la dio de alta. */
  articulo: string
  marca: string | null
  modelo: string | null
  serial: string
  /** Cómo está —nueva, usada, averiada…—: lo dice quien la tiene delante. */
  condicion: Condicion
  /** Dónde está —en el almacén, instalada, de baja—: lo decide lo que se hace con ella. */
  situacion: SituacionDeUnidad
  /** Dónde está, si está instalada: `2.1 C (Edificio H)`. */
  aula: string | null
  /** Día de Madrid de la instalación o de la baja, si la hubo. */
  desde: string | null
  observaciones: string | null
}

// «Estado» es la condición y «Situación» es dónde está: son dos cosas, y se leen
// como dos columnas. Los mismos nombres que las pantallas (`unidades.ts`).
const COL_UNIDADES = [
  'Artículo',
  'Marca',
  'Modelo',
  'N.º de serie',
  'Estado',
  'Situación',
  'Aula',
  'Desde',
  'Observaciones',
]

/** En qué orden se leen: primero lo que se puede usar, al final lo que ya no está. */
const ORDEN_DE_SITUACION: Record<SituacionDeUnidad, number> = { disponible: 0, instalado: 1, baja: 2 }

/**
 * Lo que dice el color de cada fila: una unidad de baja se apaga —se queda en
 * la lista porque es un registro, pero ya no cuenta—, y una averiada se pinta en
 * ámbar: es la que no se debe llevar a un aula y conviene ver a la primera.
 * Una de baja que además esté averiada es una de baja.
 */
export function tinteDeLaUnidad(u: Pick<UnidadParaHoja, 'condicion' | 'situacion'>): Tinte | undefined {
  if (u.situacion === 'baja') return 'apagado'
  if (u.condicion === 'averiado') return 'aviso'
  return undefined
}

export function hojaDeUnidadesConSerie(unidades: UnidadParaHoja[]): HojaNueva {
  const filas: ValorCelda[][] = [COL_UNIDADES]
  const tintes: Array<Tinte | undefined> = []

  const ordenadas = [...unidades].sort(
    (a, b) =>
      ORDEN_DE_SITUACION[a.situacion] - ORDEN_DE_SITUACION[b.situacion] ||
      a.articulo.localeCompare(b.articulo, 'es', { numeric: true }) ||
      (a.modelo ?? '').localeCompare(b.modelo ?? '', 'es', { numeric: true }) ||
      a.serial.localeCompare(b.serial, 'es', { numeric: true }),
  )

  for (const u of ordenadas) {
    filas.push([
      u.articulo,
      u.marca,
      u.modelo,
      u.serial,
      CONDICION_LABEL[u.condicion],
      SITUACION_LABEL[u.situacion],
      u.aula,
      serieDelDia(u.desde),
      u.observaciones,
    ])
    tintes.push(tinteDeLaUnidad(u))
  }

  return {
    nombre: 'Unidades con n.º de serie',
    filas,
    anchos: [30, 16, 22, 24, 16, 13, 24, 11, 46],
    formatos: formatos({ 7: 'fecha', 8: 'textoAjustado' }),
    tintes,
    caracter: 'app',
  }
}

// -----------------------------------------------------------------------------
// De las filas de la base a lo que pintan las hojas
// -----------------------------------------------------------------------------

/**
 * Los artículos del almacén, vivos y retirados, con su saldo.
 *
 * El saldo de un artículo vivo es el de `stock_levels`, el mismo que enseña la
 * pantalla. El de uno retirado no está en esa vista y se suma de sus
 * movimientos —que es, por definición, lo que es el saldo—. Un vivo que la
 * vista no trajera (una lectura vieja) cae a lo mismo.
 *
 * Las cifras por estado vienen de `stock_levels_por_estado`, que solo trae los
 * vivos: un retirado no las tiene (`null`), igual que todos con un servidor que
 * no sabe de estados. Se copian solo las seis columnas que la hoja usa, para que
 * el artículo no arrastre una fila entera de la base.
 */
export function articulosParaHoja(
  d: Pick<DatosDelAlmacen, 'articulos' | 'niveles' | 'estados' | 'movimientos' | 'tipos'>,
): ArticuloParaHoja[] {
  const nivel = new Map(d.niveles.map((n) => [n.stock_item_id, n.on_hand]))
  const porEstado = new Map((d.estados ?? []).map((e) => [e.stock_item_id, e]))
  const suma = new Map<string, number>()
  for (const m of d.movimientos) suma.set(m.stock_item_id, (suma.get(m.stock_item_id) ?? 0) + m.qty)
  const tipos = new Map(d.tipos.map((t) => [t.id, t]))

  return d.articulos.map((a) => {
    // Siguiendo las fusiones: un artículo enlazado a un tipo que luego se
    // fundió en otro tiene que salir con el nombre del tipo vivo.
    const tipo = a.asset_type_id ? tipos.get(a.asset_type_id) : undefined
    const e = porEstado.get(a.id)
    return {
      nombre: a.name,
      unidad: a.unit,
      existencias: nivel.get(a.id) ?? suma.get(a.id) ?? 0,
      estados: e
        ? {
            seguimiento: e.seguimiento,
            nuevo: e.nuevo,
            usado: e.usado,
            reacondicionado: e.reacondicionado,
            averiado: e.averiado,
            sin_indicar: e.sin_indicar,
          }
        : null,
      minimo: a.min_threshold,
      tipoDeEquipo: tipo ? tipoVivo(tipo, tipos).name : null,
      activo: a.active,
      retiradoEl: a.retired_at ? diaEnMadrid(new Date(a.retired_at)) : null,
      motivoDeRetirada: a.retired_reason?.trim() || null,
    }
  })
}

/** `incidents.kind` → la columna de la hoja de movimientos en la que va el número del parte. */
function claseDeParte(kind: string): MovimientoParaHoja['claseDeParte'] {
  return kind === 'incidencia' || kind === 'solicitud' ? kind : null
}

/**
 * Los movimientos con el parte, el aula y la persona ya resueltos.
 *
 * Es el cruce que hace la sincronización, con las mismas reglas: el aula del
 * propio movimiento primero —el material que se apunta desde la ficha del aula
 * lleva sala y a veces ningún parte— y, si no, la del parte; y lo que entró por
 * el Excel lo dice la columna «Quién», porque un hueco ahí se lee como un dato
 * perdido. Las fechas son el día **de Madrid**.
 */
export function movimientosParaHoja(
  d: Pick<DatosDelAlmacen, 'articulos' | 'movimientos' | 'incidencias' | 'salas' | 'perfiles'>,
): MovimientoParaHoja[] {
  const articulo = new Map(d.articulos.map((a) => [a.id, a.name]))
  const aula = new Map(d.salas.map((s) => [s.id, s.code]))
  const parte = new Map(d.incidencias.map((i) => [i.id, i]))
  const persona = new Map(d.perfiles.map((p) => [p.id, p.full_name?.trim() ?? '']))

  return d.movimientos.map((m) => {
    const p = m.incident_id ? parte.get(m.incident_id) : undefined
    return {
      cuando: alMediodia(diaEnMadrid(new Date(m.occurred_at))),
      articulo: articulo.get(m.stock_item_id) ?? '—',
      cantidad: m.qty,
      tipo: m.kind,
      incidencia: p?.external_ref || null,
      claseDeParte: p ? claseDeParte(p.kind) : null,
      sala:
        (m.room_id ? aula.get(m.room_id) : undefined) ?? (p?.room_id ? aula.get(p.room_id) : undefined) ?? null,
      quien: m.by_user ? persona.get(m.by_user) || null : m.source === 'sharepoint' ? 'Excel' : null,
      nota: m.note,
    }
  })
}

const CONDICIONES_CONOCIDAS = new Set<string>(Object.keys(CONDICION_LABEL))

export function unidadesParaHoja(d: Pick<DatosDelAlmacen, 'unidades' | 'salas' | 'zonas' | 'edificios'>): UnidadParaHoja[] {
  const sala = new Map(d.salas.map((s) => [s.id, s]))
  const zona = new Map(d.zonas.map((z) => [z.id, z]))
  const edificio = new Map(d.edificios.map((e) => [e.id, e.name]))

  return d.unidades.map((u) => {
    // Una situación que la aplicación no conoce se lee como «en el almacén», que
    // es lo que hace la sincronización: la columna solo admite las tres.
    const situacion: SituacionDeUnidad = u.status === 'instalado' || u.status === 'baja' ? u.status : 'disponible'
    const s = situacion === 'instalado' && u.room_id ? sala.get(u.room_id) : undefined
    const donde = s ? edificio.get(zona.get(s.zone_id)?.building_id ?? '') : undefined
    const cuando = situacion === 'instalado' ? u.installed_at : situacion === 'baja' ? u.retired_at : null
    return {
      // El nombre del artículo del almacén, no lo que apuntó quien la dio de
      // alta: así todas las unidades de un mismo artículo salen juntas. Sin
      // artículo casado —o con un servidor que no lo dice— queda lo apuntado.
      articulo: u.item_name?.trim() || u.articulo,
      marca: u.brand,
      modelo: u.model,
      serial: u.serial,
      // Sin estado —un servidor sin la vista, o una unidad que nadie ha mirado—
      // es «sin indicar», no «nuevo»: nadie lo ha dicho.
      condicion: u.condicion && CONDICIONES_CONOCIDAS.has(u.condicion) ? (u.condicion as Condicion) : 'sin_indicar',
      situacion,
      aula: s ? (donde ? `${s.code} (${donde})` : s.code) : null,
      desde: cuando ? diaEnMadrid(new Date(cuando)) : null,
      observaciones: u.notes,
    }
  })
}

/** Las tres hojas, en el orden en que se abren. */
export function hojasDelAlmacen(d: DatosDelAlmacen): HojaNueva[] {
  return exportacionDelAlmacen(d).hojas.map((h) => h.hoja)
}

// -----------------------------------------------------------------------------
// Leer de la base
// -----------------------------------------------------------------------------

/**
 * Ninguna petición puede quedarse esperando para siempre: una descarga que no
 * contesta en un minuto no va a contestar, y el botón «Preparando…» sin final
 * es peor que un mensaje que diga qué no llegó.
 */
const PLAZO_MS = 60_000
const plazo = (): AbortSignal => señalConTope(PLAZO_MS)

/**
 * ¿Dice este error que a la consulta le falta la vista, o una columna de ella?
 *
 * PostgREST lo cuenta de varias maneras según la versión y según qué falte:
 * «Could not find the table 'public.stock_unit_list' in the schema cache»
 * (`PGRST205`), `relation "…" does not exist` (`42P01`) y `column … does not
 * exist` (`42703`). Se mira lo que **dicen** y no el nombre de la vista: así un
 * permiso denegado o un plazo agotado no pasan por «falta la migración» y paran
 * la exportación con su propio mensaje.
 */
const FALTA_ALGO_DE_LA_VISTA = /does not exist|schema cache|PGRST20[45]|42P01|42703/i

/** Lo leído, o el motivo —dicho con palabras— por el que no se puede exportar. */
function exigir<T>(que: string, d: Descarga<T>): T[] {
  if (d.error) {
    // PostgREST devuelve un objeto pelado `{ message }` y `esSilencio` lee el
    // texto de un `Error`: sin envolverlo, un «TimeoutError: …» pasaba por un
    // fallo cualquiera y se perdía el consejo de buscar cobertura.
    throw new Error(
      esSilencio(new Error(d.error.message))
        ? `No se pudo leer ${que}: el servidor no ha contestado a tiempo. Comprueba la cobertura y vuelve a intentarlo.`
        : `No se pudo leer ${que}: ${d.error.message}`,
    )
  }
  if (!d.completa) {
    throw new Error(
      `La descarga de ${que} vino incompleta. Un Excel con medio almacén sería peor que ninguno: vuelve a intentarlo.`,
    )
  }
  return d.data ?? []
}

/**
 * Quién es quién, para la columna «Quién» de los movimientos.
 *
 * Por `nombres_del_personal()` y no por `profiles`: la política de `profiles` le
 * da a un técnico solo su propia fila, y esta pantalla la abre un técnico. Leída
 * la tabla, el Excel saldría con su nombre en sus movimientos y en blanco en los
 * de los demás, sin error ni aviso. La función da el nombre de cada perfil a
 * todo el personal sin abrirle el correo ni el rol (es lo que usa
 * `pullPersonas`). Un servidor sin la migración no la tiene, y entonces se cae
 * a `profiles`, que al menos le da el suyo a un técnico y todos a un supervisor.
 */
async function cargarPerfiles(): Promise<Descarga<FilaPerfil>> {
  try {
    const rpc = await supabase.rpc('nombres_del_personal').abortSignal(plazo())
    if (!rpc.error && rpc.data) return { data: rpc.data as FilaPerfil[], error: null, completa: true }
  } catch {
    // Sin respuesta: el respaldo lo cuenta con sus palabras si tampoco contesta.
  }
  return descargaEntera<FilaPerfil>((d, h) =>
    supabase.from('profiles').select('id, full_name').order('id').range(d, h).abortSignal(plazo()),
  )
}

/**
 * Las existencias por estado, o `null` si el servidor todavía no sabe de ellas.
 *
 * Un servidor sin la migración del estado por cantidad no tiene la vista
 * `stock_levels_por_estado` —o no tiene alguna de sus columnas—, y eso no puede
 * impedir sacar el almacén: se exporta como siempre, sin las columnas de estado.
 * Es lo que se hace con la vista de las unidades, y con su misma regla: se mira
 * lo que el error **dice**. Un permiso denegado o un plazo agotado no se
 * disfrazan de «falta la migración» —saldría un Excel sin estados, en silencio,
 * justo cuando el servidor sí los tiene y no ha podido darlos— y paran la
 * exportación con su propio mensaje, como cualquier otra lectura.
 */
function estadosSiLosHay(d: Descarga<FilaNivelPorEstado>): FilaNivelPorEstado[] | null {
  if (d.error && FALTA_ALGO_DE_LA_VISTA.test(`${d.error.message} ${d.error.code ?? ''}`)) return null
  return exigir('las existencias por estado', d)
}

export async function cargarDatosDelAlmacen(): Promise<DatosDelAlmacen> {
  const [articulosD, nivelesD, estadosD, tiposD, movimientosD, incidenciasD, salasD, zonasD, edificiosD, perfilesD, unidadesD] =
    await Promise.all([
      descargaEntera<FilaArticulo>((d, h) =>
        supabase
          .from('stock_items')
          .select('id, name, unit, min_threshold, asset_type_id, active, retired_at, retired_reason')
          .order('id')
          .range(d, h)
          .abortSignal(plazo()),
      ).then((r) =>
        // Un servidor sin la migración del 23/09 no tiene las dos columnas de la
        // retirada: se vuelve a pedir sin ellas, que es lo que había siempre.
        r.error && /retired_/.test(r.error.message)
          ? descargaEntera<FilaArticulo>((d, h) =>
              supabase
                .from('stock_items')
                .select('id, name, unit, min_threshold, asset_type_id, active')
                .order('id')
                .range(d, h)
                .abortSignal(plazo()),
            )
          : r,
      ),
      descargaEntera<FilaNivel>((d, h) =>
        supabase.from('stock_levels').select('stock_item_id, on_hand').order('stock_item_id').range(d, h).abortSignal(plazo()),
      ),
      // Cuántas hay de cada estado, de la vista `stock_levels_por_estado`: una
      // fila por artículo activo. Solo se piden las columnas que la hoja usa.
      descargaEntera<FilaNivelPorEstado>((d, h) =>
        supabase
          .from('stock_levels_por_estado')
          .select('stock_item_id, seguimiento, nuevo, usado, reacondicionado, averiado, sin_indicar')
          .order('stock_item_id')
          .range(d, h)
          .abortSignal(plazo()),
      ),
      descargaEntera<TipoConocido>((d, h) =>
        supabase.from('asset_types').select('id, name, merged_into, aliases').order('id').range(d, h).abortSignal(plazo()),
      ),
      descargaEntera<FilaMovimiento>((d, h) =>
        supabase
          .from('stock_movements')
          .select('stock_item_id, qty, kind, occurred_at, incident_id, room_id, by_user, source, note')
          .order('id')
          .range(d, h)
          .abortSignal(plazo()),
      ),
      descargaEntera<FilaIncidencia>((d, h) =>
        supabase.from('incidents').select('id, external_ref, kind, room_id').order('id').range(d, h).abortSignal(plazo()),
      ),
      descargaEntera<FilaSala>((d, h) =>
        supabase.from('rooms').select('id, code, zone_id').order('id').range(d, h).abortSignal(plazo()),
      ),
      descargaEntera<FilaZona>((d, h) =>
        supabase.from('zones').select('id, building_id').order('id').range(d, h).abortSignal(plazo()),
      ),
      descargaEntera<FilaEdificio>((d, h) =>
        supabase.from('buildings').select('id, name').order('id').range(d, h).abortSignal(plazo()),
      ),
      cargarPerfiles(),
      // Las unidades salen de la vista `stock_unit_list`, que trae el nombre de
      // su artículo y su estado. Un servidor sin la migración del 27 de octubre
      // no la tiene, o no tiene alguna de sus columnas: se vuelve a pedir la
      // tabla de siempre, sin estado, y todas salen «sin indicar». Y uno sin la
      // de septiembre no tiene ni `stock_units`, y eso no puede impedir sacar el
      // resto: la hoja sale con solo la cabecera.
      descargaEntera<FilaUnidad>((d, h) =>
        supabase
          .from('stock_unit_list')
          .select('articulo, item_name, brand, model, serial, notes, status, condicion, room_id, installed_at, retired_at')
          .order('id')
          .range(d, h)
          .abortSignal(plazo()),
      )
        .then((r) =>
          r.error && FALTA_ALGO_DE_LA_VISTA.test(`${r.error.message} ${r.error.code ?? ''}`)
            ? descargaEntera<FilaUnidad>((d, h) =>
                supabase
                  .from('stock_units')
                  .select('articulo, brand, model, serial, notes, status, room_id, installed_at, retired_at')
                  .order('id')
                  .range(d, h)
                  .abortSignal(plazo()),
              )
            : r,
        )
        .then((r): Descarga<FilaUnidad> =>
          r.error && /stock_units/.test(r.error.message) ? { data: [], error: null, completa: true } : r,
        ),
    ])

  return {
    articulos: exigir('el catálogo del almacén', articulosD),
    niveles: exigir('las existencias', nivelesD),
    estados: estadosSiLosHay(estadosD),
    tipos: exigir('el catálogo de equipos', tiposD),
    movimientos: exigir('los movimientos de almacén', movimientosD),
    incidencias: exigir('los partes', incidenciasD),
    salas: exigir('las aulas', salasD),
    zonas: exigir('las plantas', zonasD),
    edificios: exigir('los edificios', edificiosD),
    perfiles: exigir('los usuarios', perfilesD),
    unidades: exigir('las unidades del almacén', unidadesD),
  }
}

/**
 * Lee el almacén y devuelve lo que se exporta: las tres hojas, el título y las
 * cifras de la cabecera. Es lo que se le da a `<ExportarConVistaPrevia>`, que
 * enseña las hojas antes de descargar y saca de ellas el Excel y el PDF.
 *
 * El PDF es **el inventario del almacén**: lo que hay hoy —existencias, con
 * cuántas hay de cada estado, y unidades con número de serie—. Los movimientos
 * van en el Excel siempre y en el PDF solo si se marcan, porque el historial de
 * un año son decenas de páginas que no se piden cuando se pide un inventario.
 */
export async function prepararExportacionDelAlmacen(): Promise<Exportacion> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('Sin conexión: el inventario se hace con los datos del servidor. Busca cobertura y vuelve a intentarlo.')
  }
  const datos = await cargarDatosDelAlmacen()
  return exportacionDelAlmacen(datos)
}

/**
 * Las columnas de «Existencias» que van al papel: las que sirven para decidir
 * qué pedir —cuántas hay, de qué estado, si están por debajo del mínimo— y si el
 * artículo sigue en el catálogo. La unidad y el tipo de equipo se quedan en el
 * Excel, que lleva todas las columnas: son lo que menos pesa a la hora de
 * decidir, y con las cinco de estado no cabría todo en un A4.
 *
 * Por el nombre de la cabecera, como pide `pdf.columnas`, y sin estados las
 * mismas menos las cinco: una cabecera que no esté en la hoja se ignora, y el
 * papel sale sin ella en vez de no salir.
 */
function columnasDelPdfDeExistencias(conEstados: boolean): string[] {
  return [
    'Artículo',
    'Existencias',
    ...(conEstados ? ESTADOS_EN_ORDEN.map((c) => ESTADO_EN_PLURAL[c]) : []),
    'Mínimo',
    'Bajo mínimo',
    'Situación',
  ]
}

/** La exportación a partir de lo leído. Aparte para poder probarla sin red. */
export function exportacionDelAlmacen(d: DatosDelAlmacen): Exportacion {
  const articulos = articulosParaHoja(d)
  const unidades = unidadesParaHoja(d)
  // El servidor sabe de estados si ha dado la lista, aunque venga vacía.
  const conEstados = d.estados != null
  const activos = articulos.filter((a) => a.activo)
  const bajoMinimo = activos.filter(estaBajoMinimo).length
  // Las averiadas de todo lo que se cuenta, por cantidad o por número de serie:
  // las que no se pueden llevar a un aula. Solo las de los artículos vivos, que
  // son los que cuentan; un retirado no tiene cifras, y un servidor sin estados
  // no tiene ninguna que sumar.
  const averiadas = activos.reduce((suma, a) => suma + (a.estados?.averiado ?? 0), 0)
  // Las que están en el almacén: las instaladas ya no se cuentan ahí y las de
  // baja tampoco, aunque sigan en la hoja.
  const enElAlmacen = unidades.filter((u) => u.situacion === 'disponible').length
  const resumen = [
    `${activos.length} ${activos.length === 1 ? 'artículo' : 'artículos'}`,
    bajoMinimo > 0 ? `${bajoMinimo} bajo mínimo` : null,
    averiadas > 0 ? cuantasEnEstado('averiado', averiadas) : null,
    `${enElAlmacen} ${enElAlmacen === 1 ? 'unidad' : 'unidades'} con n.º de serie en el almacén`,
  ]
    .filter(Boolean)
    .join(' · ')
  return {
    titulo: 'Inventario del almacén',
    resumen,
    nombreBase: 'Almacén',
    hojas: [
      { hoja: hojaDeExistencias(articulos, conEstados), pdf: { columnas: columnasDelPdfDeExistencias(conEstados) } },
      { hoja: hojaDeMovimientos(movimientosParaHoja(d)), pdf: { incluir: false } },
      { hoja: hojaDeUnidadesConSerie(unidades) },
    ],
  }
}

// -----------------------------------------------------------------------------

/** `{ 4: 'fecha' }` → el array de formatos que espera `HojaNueva`. */
function formatos(porIndice: Record<number, Formato>): Array<Formato | undefined> {
  const maximo = Math.max(...Object.keys(porIndice).map(Number))
  const out = new Array<Formato | undefined>(maximo + 1).fill(undefined)
  for (const [i, f] of Object.entries(porIndice)) out[Number(i)] = f
  return out
}
