/**
 * El Excel que acompaña al informe: el almacén del periodo y el de hoy.
 *
 * El informe cuenta el almacén en media página —lo que se ha servido, lo que
 * queda, lo que hay que reponer—, que es lo que cabe en un papel. Lo que no
 * cabe es justo lo que alguien va a querer filtrar y sumar: cada movimiento de
 * esos días con su saldo, cuánto había de cada cosa al empezar y al terminar,
 * a qué aula fue cada pieza y lo que hay hoy en la estantería. Eso es este
 * libro, y sale junto al informe: dos ficheros, el PDF y el Excel.
 *
 * Seis hojas, y cada una contesta una pregunta:
 *
 *  - **Resumen**: de qué periodo es el libro, las cifras que lo resumen y qué
 *    hay en cada hoja. Es el contexto: quien abre el fichero dentro de seis
 *    meses no tiene delante el informe del que salió.
 *  - **Stock del periodo**: qué había y qué queda. Una fila por artículo con el
 *    stock al abrir el periodo, lo que entró, lo que salió, los ajustes y el
 *    stock al cerrarlo. Las cuatro columnas cuadran: abrir + entradas − salidas
 *    + ajustes = cerrar.
 *  - **Movimientos del periodo**: qué pasó, apunte a apunte, con el saldo que
 *    quedaba de ese artículo después de cada uno.
 *  - **Consumo por aula**: adónde fue el material.
 *  - **Stock actual**: lo que hay HOY en el almacén. Es la hoja de existencias
 *    de la pestaña Almacén, tal cual, con sus estados y sus mínimos.
 *  - **Unidades con n.º de serie**: los aparatos con número de serie —los
 *    ordenadores de repuesto, entre ellos— y dónde está cada uno.
 *
 * **El saldo sale de los asientos.** El stock de un día pasado no está guardado
 * en ninguna parte: es la suma de todos los movimientos hasta ese día, que es
 * lo que es un saldo. Como los movimientos no se editan ni se borran —son
 * solo-alta—, el libro de un periodo cerrado dice siempre lo mismo se pida
 * cuando se pida, y por eso no hace falta archivarlo junto al informe: se
 * vuelve a hacer desde el archivo y sale igual. Lo único que cambia de un día
 * para otro es «Stock actual», que por definición es el de hoy, y lleva escrito
 * de cuándo es.
 *
 * Como en `exportarAlmacen`, la carga es lo único que toca la red; todo lo
 * demás son funciones puras que reciben las filas tal como las devuelve la
 * base, y se prueban sin servidor.
 */

import { diaEnMadrid, horaCorta, inicioDelDia } from '@/domain/fechas'
import { TIPO_XLSX, libroNuevo } from '@/domain/exportar'
import type { ClaveDeEstilo, Formato, HojaNueva, Tinte } from '@/domain/libro'
import { fechaAExcel } from '@/domain/valores'
import type { ValorCelda } from '@/domain/xlsx'
import {
  type DatosDelAlmacen,
  type FilaMovimiento,
  articulosParaHoja,
  cargarDatosDelAlmacen,
  estaBajoMinimo,
  hojaDeExistencias,
  hojaDeUnidadesConSerie,
  siglaDelEdificio,
  unidadesParaHoja,
} from '@/features/inventory/exportarAlmacen'
import { type Rango, nombrePeriodo, sumaDias } from '../periodos'

// -----------------------------------------------------------------------------
// El periodo, en instantes
// -----------------------------------------------------------------------------

/** Los dos extremos del periodo como instantes: de medianoche a medianoche de Madrid. */
function limites(r: Rango): { desde: number; hasta: number } {
  return {
    desde: inicioDelDia(r.start).getTime(),
    hasta: inicioDelDia(sumaDias(r.end, 1)).getTime(),
  }
}

/** `2026-11-16` → `16/11/2026`, que es como se escribe una fecha en una hoja. */
function diaLegible(iso: string): string {
  return iso.split('-').reverse().join('/')
}

/**
 * El día de un instante como número de serie de Excel.
 *
 * A mediodía UTC del día de Madrid: `fechaAExcel` toma el día en la zona del
 * aparato, y una medianoche a secas, en un iPad con la zona en América, es la
 * tarde del día anterior. A mediodía cae en el mismo día en cualquier zona del
 * campus.
 */
function serieDelInstante(iso: string): number | null {
  return fechaAExcel(`${diaEnMadrid(new Date(iso))}T12:00:00Z`)
}

/** `{ 4: 'fecha' }` → el array de formatos que espera `HojaNueva`. */
function formatos(porIndice: Record<number, Formato>): Array<Formato | undefined> {
  const maximo = Math.max(...Object.keys(porIndice).map(Number))
  const out = new Array<Formato | undefined>(maximo + 1).fill(undefined)
  for (const [i, f] of Object.entries(porIndice)) out[Number(i)] = f
  return out
}

// -----------------------------------------------------------------------------
// Lo que pasó con cada artículo en el periodo
// -----------------------------------------------------------------------------

/** El balance de un artículo: lo que había, lo que se movió y lo que quedó. */
export interface BalanceDelArticulo {
  id: string
  nombre: string
  unidad: string
  activo: boolean
  minimo: number
  /** La suma de sus movimientos anteriores al periodo. */
  alAbrir: number
  /** Compras y devoluciones del periodo. */
  entradas: number
  /** Consumos del periodo, en positivo. */
  salidas: number
  /** Lo demás —los ajustes—, con su signo. */
  ajustes: number
  /** `alAbrir + entradas − salidas + ajustes`: la suma de sus movimientos hasta el final del periodo. */
  alCerrar: number
  /** Apuntes del periodo, del tipo que sean. */
  movimientos: number
  /** Partes distintos en los que se usó. */
  partes: number
  /** Aulas distintas a las que fue. */
  aulas: number
}

/** A qué aula fue un movimiento: la suya, o la del parte del que cuelga. */
function aulaDe(m: FilaMovimiento, aulaDelParte: Map<string, string | null>): string | null {
  return m.room_id ?? (m.incident_id ? (aulaDelParte.get(m.incident_id) ?? null) : null)
}

/**
 * El balance de cada artículo en el periodo.
 *
 * Salen los artículos vivos —todos, se hayan movido o no: un libro de stock en
 * el que falta lo que no se ha tocado no es un libro de stock— y los retirados
 * que todavía tenían saldo o movimiento en esas fechas. Un retirado a cero que
 * no se movió no pinta nada aquí.
 *
 * **Las cuatro columnas cuadran por construcción**, no por casualidad: todo
 * movimiento del periodo cae en exactamente una de las tres —entradas, salidas
 * o ajustes— según su clase, lleve el signo que lleve, así que lo que no es una
 * compra, una devolución ni un consumo se queda en «ajustes» con su signo y la
 * suma no pierde nada.
 */
export function balanceDelPeriodo(
  d: Pick<DatosDelAlmacen, 'articulos' | 'movimientos' | 'incidencias'>,
  rango: Rango,
): BalanceDelArticulo[] {
  const { desde, hasta } = limites(rango)
  const aulaDelParte = new Map(d.incidencias.map((i) => [i.id, i.room_id]))

  interface Acumulado {
    alAbrir: number
    entradas: number
    salidas: number
    ajustes: number
    movimientos: number
    partes: Set<string>
    aulas: Set<string>
  }
  const por = new Map<string, Acumulado>()
  const de = (id: string): Acumulado => {
    const previo = por.get(id)
    if (previo) return previo
    const nuevo: Acumulado = {
      alAbrir: 0,
      entradas: 0,
      salidas: 0,
      ajustes: 0,
      movimientos: 0,
      partes: new Set(),
      aulas: new Set(),
    }
    por.set(id, nuevo)
    return nuevo
  }

  for (const m of d.movimientos) {
    const t = new Date(m.occurred_at).getTime()
    // Lo posterior al periodo no existe todavía para este libro.
    if (!(t < hasta)) continue
    const a = de(m.stock_item_id)
    if (t < desde) {
      a.alAbrir += m.qty
      continue
    }
    a.movimientos += 1
    if (m.kind === 'consumo') {
      a.salidas += -m.qty
      if (m.incident_id) a.partes.add(m.incident_id)
      const aula = aulaDe(m, aulaDelParte)
      if (aula) a.aulas.add(aula)
    } else if (m.kind === 'compra' || m.kind === 'devolucion') {
      a.entradas += m.qty
    } else {
      a.ajustes += m.qty
    }
  }

  return d.articulos
    .map((art): BalanceDelArticulo => {
      const a = por.get(art.id)
      const alAbrir = a?.alAbrir ?? 0
      const entradas = a?.entradas ?? 0
      const salidas = a?.salidas ?? 0
      const ajustes = a?.ajustes ?? 0
      return {
        id: art.id,
        nombre: art.name,
        unidad: art.unit,
        activo: art.active,
        minimo: art.min_threshold,
        alAbrir,
        entradas,
        salidas,
        ajustes,
        alCerrar: alAbrir + entradas - salidas + ajustes,
        movimientos: a?.movimientos ?? 0,
        partes: a?.partes.size ?? 0,
        aulas: a?.aulas.size ?? 0,
      }
    })
    .filter((b) => b.activo || b.movimientos > 0 || b.alAbrir !== 0 || b.alCerrar !== 0)
}

const COL_BALANCE = [
  'Artículo',
  'Unidad',
  'Stock al abrir',
  'Entradas',
  'Salidas',
  'Ajustes',
  'Stock al cerrar',
  'Variación',
  'Movimientos',
  'Partes',
  'Aulas',
  'Mínimo',
  'Situación',
]

/** En blanco si es cero: una columna de ceros esconde las tres cifras que hay que mirar. */
const siHay = (n: number): number | null => (n === 0 ? null : n)

/**
 * La hoja «Stock del periodo».
 *
 * Primero lo que se ha movido —que es a lo que se viene—, por nombre; después
 * lo que no se ha tocado, también por nombre; y al final los retirados,
 * apagados. Es una tabla: quien quiera otro orden lo tiene en la flecha de la
 * cabecera.
 *
 * En verde, el artículo en el que ha entrado material: es la reposición hecha.
 * «Stock al abrir» y «Stock al cerrar» llevan su cero, porque un agotado es un
 * dato; las columnas de movimiento van en blanco cuando no hubo ninguno.
 */
export function hojaDeStockDelPeriodo(balance: BalanceDelArticulo[]): HojaNueva {
  const filas: ValorCelda[][] = [COL_BALANCE]
  const tintes: Array<Tinte | undefined> = []

  const ordenados = [...balance].sort(
    (a, b) =>
      Number(b.activo) - Number(a.activo) ||
      Number(b.movimientos > 0) - Number(a.movimientos > 0) ||
      a.nombre.localeCompare(b.nombre, 'es', { numeric: true }),
  )

  for (const b of ordenados) {
    filas.push([
      b.nombre,
      b.unidad,
      b.alAbrir,
      siHay(b.entradas),
      siHay(b.salidas),
      siHay(b.ajustes),
      b.alCerrar,
      siHay(b.alCerrar - b.alAbrir),
      siHay(b.movimientos),
      siHay(b.partes),
      siHay(b.aulas),
      b.minimo,
      b.activo ? 'Activo' : 'Retirado',
    ])
    tintes.push(!b.activo ? 'apagado' : b.entradas > 0 ? 'ok' : undefined)
  }

  return {
    nombre: 'Stock del periodo',
    filas,
    anchos: [40, 9, 15, 11, 10, 10, 16, 12, 14, 9, 9, 10, 12],
    formatos: formatos({
      2: 'entero',
      3: 'entero',
      4: 'entero',
      5: 'entero',
      6: 'entero',
      7: 'entero',
      8: 'entero',
      9: 'entero',
      10: 'entero',
      11: 'entero',
    }),
    tintes,
    caracter: 'app',
  }
}

// -----------------------------------------------------------------------------
// Los movimientos del periodo, con su saldo de verdad
// -----------------------------------------------------------------------------

const COL_MOVIMIENTOS = [
  'Fecha',
  'Hora',
  'Artículo',
  'Movimiento',
  'Entrada',
  'Salida',
  'Saldo',
  'Incidencia',
  'Solicitud',
  'Edificio',
  'Aula',
  'Quién',
  'Nota',
]

/** Cómo se llama cada movimiento cuando lo lee una persona. Los mismos nombres que la hoja de la sincronización. */
const NOMBRE_DEL_MOVIMIENTO: Record<string, string> = {
  compra: 'Compra',
  consumo: 'Consumo',
  ajuste: 'Ajuste',
  devolucion: 'Devolución',
}

/** Y los mismos colores: la compra en verde; la devolución y el ajuste, que corrigen algo, en ámbar. */
const TINTE_DEL_MOVIMIENTO: Record<string, Tinte> = {
  compra: 'ok',
  devolucion: 'aviso',
  ajuste: 'aviso',
}

/**
 * La hoja «Movimientos del periodo».
 *
 * Es la hoja de movimientos del almacén recortada a esos días, con una
 * diferencia que es todo el motivo de que no se reutilice aquella: **el
 * saldo**. Aquella lo acumula desde cero sobre lo que recibe, y está bien
 * porque recibe la historia entera. Con solo los movimientos de una semana, el
 * primer consumo dejaría el saldo en −1. Aquí se recorre la historia completa
 * para llevar la cuenta y solo se escriben las filas del periodo, así que cada
 * renglón dice cuánto quedaba DE VERDAD de ese artículo después de ese apunte.
 *
 * La cuenta se lleva por artículo —por su identificador, no por su nombre: dos
 * artículos pueden llamarse igual— y en el orden en que pasaron las cosas.
 *
 * La hora solo sale en lo que se apuntó desde la aplicación. Lo que entró por
 * el Excel trae un día y nada más, y la hora que tiene en la base es la de la
 * importación: escribirla sería inventarse cuándo pasó.
 */
export function hojaDeMovimientosDelPeriodo(
  d: Pick<DatosDelAlmacen, 'articulos' | 'movimientos' | 'incidencias' | 'salas' | 'zonas' | 'edificios' | 'perfiles'>,
  rango: Rango,
): HojaNueva {
  const { desde, hasta } = limites(rango)
  const articulo = new Map(d.articulos.map((a) => [a.id, a.name]))
  const aula = new Map(d.salas.map((s) => [s.id, s]))
  const zona = new Map(d.zonas.map((z) => [z.id, z]))
  const edificio = new Map(d.edificios.map((e) => [e.id, e]))
  const parte = new Map(d.incidencias.map((i) => [i.id, i]))
  const persona = new Map(d.perfiles.map((p) => [p.id, p.full_name?.trim() ?? '']))

  // Por instante; a igual instante, el orden de llegada, que `sort` conserva.
  const ordenados = [...d.movimientos].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))

  const filas: ValorCelda[][] = [COL_MOVIMIENTOS]
  const tintes: Array<Tinte | undefined> = []
  const saldo = new Map<string, number>()

  for (const m of ordenados) {
    const t = new Date(m.occurred_at).getTime()
    if (!(t < hasta)) continue
    const acumulado = (saldo.get(m.stock_item_id) ?? 0) + m.qty
    saldo.set(m.stock_item_id, acumulado)
    if (t < desde) continue

    const p = m.incident_id ? parte.get(m.incident_id) : undefined
    const s = (m.room_id ? aula.get(m.room_id) : undefined) ?? (p?.room_id ? aula.get(p.room_id) : undefined)
    filas.push([
      serieDelInstante(m.occurred_at),
      m.source === 'app' ? horaCorta(m.occurred_at) || null : null,
      articulo.get(m.stock_item_id) ?? '—',
      NOMBRE_DEL_MOVIMIENTO[m.kind] ?? m.kind,
      m.qty > 0 ? m.qty : null,
      m.qty < 0 ? -m.qty : null,
      acumulado,
      p && p.kind === 'incidencia' ? p.external_ref || null : null,
      p && p.kind === 'solicitud' ? p.external_ref || null : null,
      s ? siglaDelEdificio(edificio.get(zona.get(s.zone_id)?.building_id ?? '')) : null,
      s?.code ?? null,
      // Lo que entró por el Excel lo dice la columna: un hueco ahí se lee como
      // un dato perdido.
      m.by_user ? persona.get(m.by_user) || null : m.source === 'sharepoint' ? 'Excel' : null,
      m.note,
    ])
    tintes.push(TINTE_DEL_MOVIMIENTO[m.kind])
  }

  return {
    nombre: 'Movimientos del periodo',
    filas,
    anchos: [11, 8, 38, 14, 10, 10, 10, 16, 16, 12, 16, 22, 40],
    formatos: formatos({ 0: 'fecha', 4: 'entero', 5: 'entero', 6: 'entero', 12: 'textoAjustado' }),
    tintes,
    caracter: 'app',
  }
}

// -----------------------------------------------------------------------------
// Adónde fue el material
// -----------------------------------------------------------------------------

const COL_CONSUMO = ['Edificio', 'Aula', 'Artículo', 'Unidades', 'Partes', 'Último día']

/**
 * La hoja «Consumo por aula»: cada artículo que se ha llevado a cada aula.
 *
 * El aula es la del propio movimiento —el material que se apunta desde la
 * ficha del aula lleva sala y a veces ningún parte— y, si no la trae, la del
 * parte. Lo que no tiene ni lo uno ni lo otro sale igual, en una fila «Sin
 * aula»: es material que salió del almacén, y dejarlo fuera haría que esta
 * hoja sumara menos que las salidas de la otra.
 */
export function hojaDeConsumoPorAula(
  d: Pick<DatosDelAlmacen, 'articulos' | 'movimientos' | 'incidencias' | 'salas' | 'zonas' | 'edificios'>,
  rango: Rango,
): HojaNueva {
  const { desde, hasta } = limites(rango)
  const articulo = new Map(d.articulos.map((a) => [a.id, a.name]))
  const aula = new Map(d.salas.map((s) => [s.id, s]))
  const zona = new Map(d.zonas.map((z) => [z.id, z]))
  const edificio = new Map(d.edificios.map((e) => [e.id, e]))
  const aulaDelParte = new Map(d.incidencias.map((i) => [i.id, i.room_id]))

  interface Linea {
    edificio: string | null
    aula: string
    articulo: string
    unidades: number
    partes: Set<string>
    ultimo: string
  }
  const por = new Map<string, Linea>()

  for (const m of d.movimientos) {
    if (m.kind !== 'consumo') continue
    const t = new Date(m.occurred_at).getTime()
    if (t < desde || !(t < hasta)) continue
    const s = aula.get(aulaDe(m, aulaDelParte) ?? '')
    const clave = `${s?.id ?? ''}|${m.stock_item_id}`
    const linea = por.get(clave) ?? {
      edificio: s ? siglaDelEdificio(edificio.get(zona.get(s.zone_id)?.building_id ?? '')) : null,
      aula: s?.code ?? 'Sin aula',
      articulo: articulo.get(m.stock_item_id) ?? '—',
      unidades: 0,
      partes: new Set<string>(),
      ultimo: m.occurred_at,
    }
    linea.unidades += -m.qty
    if (m.incident_id) linea.partes.add(m.incident_id)
    if (m.occurred_at > linea.ultimo) linea.ultimo = m.occurred_at
    por.set(clave, linea)
  }

  const lineas = [...por.values()].sort(
    (a, b) =>
      // Lo que no tiene aula, al final: es la excepción, no por donde se empieza.
      Number(a.aula === 'Sin aula') - Number(b.aula === 'Sin aula') ||
      (a.edificio ?? '').localeCompare(b.edificio ?? '', 'es', { numeric: true }) ||
      a.aula.localeCompare(b.aula, 'es', { numeric: true }) ||
      a.articulo.localeCompare(b.articulo, 'es', { numeric: true }),
  )

  const filas: ValorCelda[][] = [COL_CONSUMO]
  for (const l of lineas) {
    filas.push([l.edificio, l.aula, l.articulo, l.unidades, siHay(l.partes.size), serieDelInstante(l.ultimo)])
  }

  return {
    nombre: 'Consumo por aula',
    filas,
    anchos: [12, 16, 40, 11, 9, 12],
    formatos: formatos({ 3: 'entero', 4: 'entero', 5: 'fecha' }),
    caracter: 'app',
  }
}

// -----------------------------------------------------------------------------
// El resumen: el contexto del libro
// -----------------------------------------------------------------------------

/** Las cifras que resumen el libro. Son las mismas que cuentan las hojas, sumadas. */
export interface CifrasDelLibro {
  movimientos: number
  salidas: number
  entradas: number
  articulosMovidos: number
  aulasServidas: number
  articulosActivos: number
  conExistencias: number
  bajoMinimo: number
  unidadesEnAlmacen: number
}

/** Ancho de la columna de texto del resumen, en caracteres: de él sale el alto de cada fila. */
const ANCHO_DEL_TEXTO = 96

function altoDeFila(texto: string): number {
  return Math.max(15, Math.ceil(texto.length / ANCHO_DEL_TEXTO) * 15)
}

/**
 * La hoja «Resumen».
 *
 * Tres columnas: qué es, cuánto es y qué quiere decir. Las cifras van como
 * números —se pueden copiar y sumar— y la explicación al lado, que es lo que
 * hace que el libro se entienda sin el informe delante.
 */
export function hojaDeResumen(o: {
  titulo: string
  rango: Rango
  /** Cuándo se hizo, ya escrito en hora de Madrid: `20/11/2026, 9:14`. */
  emitido: string
  cifras: CifrasDelLibro
  /** Los artículos por debajo de su mínimo, por nombre. */
  porReponer: string[]
}): HojaNueva {
  const { cifras: c } = o
  const filas: ValorCelda[][] = [[o.titulo, null, null], [null, null, null]]
  const estilos: Record<string, ClaveDeEstilo> = { A1: 'titulo' }
  const altos: Record<number, number> = { 1: 24 }

  const linea = (etiqueta: string | null, valor: ValorCelda, texto: string | null): void => {
    filas.push([etiqueta, valor, texto])
    const fila = filas.length
    if (etiqueta) estilos[`A${fila}`] = 'etiqueta'
    estilos[`B${fila}`] = typeof valor === 'number' ? 'entero' : 'textoSinBorde'
    estilos[`C${fila}`] = 'textoSinBorde'
    if (texto) altos[fila] = altoDeFila(texto)
  }
  const hueco = (): void => void filas.push([null, null, null])
  /** Un rótulo de apartado: la etiqueta sola, sin cifra. */
  const apartado = (texto: string): void => {
    filas.push([texto, null, null])
    estilos[`A${filas.length}`] = 'titulo'
    altos[filas.length] = 20
  }

  linea('Periodo', null, `${nombrePeriodo(o.rango)} (${diaLegible(o.rango.start)} – ${diaLegible(o.rango.end)}).`)
  linea('Generado', null, `${o.emitido}, hora de Madrid. Acompaña al informe del mismo periodo.`)
  hueco()

  apartado('En el periodo')
  linea('Movimientos', c.movimientos, 'Apuntes del almacén en esos días: consumos, compras, devoluciones y ajustes.')
  linea(
    'Unidades servidas',
    c.salidas,
    c.salidas > 0
      ? `Lo que ha salido del almacén: ${c.articulosMovidos === 1 ? '1 artículo distinto' : `${c.articulosMovidos} artículos distintos`} que se han movido${c.aulasServidas > 0 ? `, y material para ${c.aulasServidas === 1 ? '1 aula' : `${c.aulasServidas} aulas`}` : ''}.`
      : 'No ha salido material del almacén en el periodo.',
  )
  linea(
    'Unidades que han entrado',
    c.entradas,
    c.entradas > 0 ? 'Compras y devoluciones: lo que se ha repuesto.' : 'Sin compras ni devoluciones en el periodo.',
  )
  hueco()

  apartado('El almacén, hoy')
  linea('Artículos', c.articulosActivos, `En el catálogo del almacén. Con existencias, ${c.conExistencias}.`)
  linea(
    'Por debajo de su mínimo',
    c.bajoMinimo,
    c.bajoMinimo > 0
      ? `Para reponer: ${o.porReponer.slice(0, 8).join(', ')}${o.porReponer.length > 8 ? ` y ${o.porReponer.length - 8} más` : ''}.`
      : 'Ninguno: todo lo que tiene un mínimo fijado está por encima de él.',
  )
  linea(
    'Unidades con n.º de serie',
    c.unidadesEnAlmacen,
    'Aparatos con número de serie que están en el almacén, listos para instalar.',
  )
  hueco()

  apartado('Qué hay en cada hoja')
  linea(
    'Stock del periodo',
    null,
    'Una fila por artículo: lo que había al abrir el periodo, lo que entró, lo que salió, los ajustes y lo que quedaba al cerrarlo. Las columnas cuadran: abrir + entradas − salidas + ajustes = cerrar. Primero lo que se ha movido; en verde, donde ha entrado material; en gris, lo retirado.',
  )
  linea(
    'Movimientos del periodo',
    null,
    'Una fila por apunte, del más antiguo al más reciente, y detrás de cada uno el saldo que quedaba de ese artículo. El parte que gastó el material va en «Incidencia» o en «Solicitud». Las compras en verde; las devoluciones y los ajustes en ámbar. La hora solo sale en lo apuntado desde la aplicación.',
  )
  linea(
    'Consumo por aula',
    null,
    'Adónde fue el material: una fila por aula y artículo, con las unidades, los partes en los que se usó y el último día. Lo que salió sin aula va al final, en «Sin aula».',
  )
  linea(
    'Stock actual',
    null,
    'Lo que hay hoy en el almacén, artículo a artículo, con cuántas hay de cada estado, el mínimo y si está por debajo. En rojo, lo que está bajo mínimo; en ámbar, lo agotado sin mínimo fijado; en gris, lo retirado.',
  )
  linea(
    'Unidades con n.º de serie',
    null,
    'Cada aparato con número de serie —los ordenadores de repuesto, entre ellos—: cómo está y dónde está, en el almacén, instalado en un aula o de baja.',
  )
  hueco()
  linea(
    null,
    null,
    'Las hojas de datos son tablas de Excel: se filtran y se ordenan desde la cabecera. El stock de un día pasado es la suma de los movimientos hasta ese día, así que este libro dice lo mismo se genere cuando se genere; «Stock actual» es la única hoja que cambia, porque es la de hoy.',
  )

  /*
   * Y cada celda con su estilo, también las vacías. El escritor de hojas pinta
   * toda celda que no lo traiga como una celda de datos —con su borde— y la
   * primera fila como cabecera, con su fondo gris: sin esto el resumen salía
   * con una rejilla de casillas en blanco entre párrafo y párrafo. Lo que no
   * es una cifra va sin borde; la cifra se queda con el suyo, que la enmarca.
   */
  filas.forEach((fila, i) => {
    fila.forEach((_, c) => {
      const ref = `${'ABC'[c]}${i + 1}`
      if (!estilos[ref]) estilos[ref] = 'textoSinBorde'
    })
  })

  return {
    nombre: 'Resumen',
    filas,
    anchos: [30, 12, ANCHO_DEL_TEXTO],
    inmovilizar: false,
    autofiltro: false,
    estilos,
    altos,
    caracter: 'discreta',
    tabla: false,
  }
}

// -----------------------------------------------------------------------------
// El libro
// -----------------------------------------------------------------------------

export interface LibroDelPeriodo {
  hojas: HojaNueva[]
  cifras: CifrasDelLibro
}

/**
 * Las seis hojas, a partir de lo leído. Aparte para poder probarlo sin red.
 *
 * «Stock actual» y «Unidades con n.º de serie» son las mismas hojas que saca la
 * pestaña Almacén, con el mismo código: lo que diga aquel Excel del almacén de
 * hoy lo dice este, y si un día se le añade una columna, sale en los dos.
 */
export function libroDelPeriodo(
  d: DatosDelAlmacen,
  rango: Rango,
  o: { titulo: string; emitido: string },
): LibroDelPeriodo {
  const balance = balanceDelPeriodo(d, rango)
  const articulos = articulosParaHoja(d)
  const unidades = unidadesParaHoja(d)
  const activos = articulos.filter((a) => a.activo)
  const porReponer = activos
    .filter(estaBajoMinimo)
    .sort((a, b) => a.existencias - a.minimo - (b.existencias - b.minimo))
    .map((a) => a.nombre)

  const { desde, hasta } = limites(rango)
  const aulaDelParte = new Map(d.incidencias.map((i) => [i.id, i.room_id]))
  const aulas = new Set<string>()
  for (const m of d.movimientos) {
    if (m.kind !== 'consumo') continue
    const t = new Date(m.occurred_at).getTime()
    if (t < desde || !(t < hasta)) continue
    const aula = aulaDe(m, aulaDelParte)
    if (aula) aulas.add(aula)
  }

  const cifras: CifrasDelLibro = {
    movimientos: balance.reduce((s, b) => s + b.movimientos, 0),
    salidas: balance.reduce((s, b) => s + b.salidas, 0),
    entradas: balance.reduce((s, b) => s + b.entradas, 0),
    articulosMovidos: balance.filter((b) => b.movimientos > 0).length,
    aulasServidas: aulas.size,
    articulosActivos: activos.length,
    conExistencias: activos.filter((a) => a.existencias > 0).length,
    bajoMinimo: porReponer.length,
    unidadesEnAlmacen: unidades.filter((u) => u.situacion === 'disponible').length,
  }

  return {
    cifras,
    hojas: [
      hojaDeResumen({ titulo: o.titulo, rango, emitido: o.emitido, cifras, porReponer }),
      hojaDeStockDelPeriodo(balance),
      hojaDeMovimientosDelPeriodo(d, rango),
      hojaDeConsumoPorAula(d, rango),
      // La hoja de existencias de la pestaña Almacén, con su nombre de aquí: en
      // este libro hay dos stocks —el del periodo y el de hoy— y «Existencias»
      // a secas no dice cuál de los dos es.
      { ...hojaDeExistencias(articulos, d.estados != null), nombre: 'Stock actual' },
      hojaDeUnidadesConSerie(unidades),
    ],
  }
}

/** El Excel hecho, listo para entregar. */
export interface ExcelDelPeriodo {
  nombre: string
  blob: Blob
  cifras: CifrasDelLibro
}

/**
 * Lee el almacén y devuelve el Excel del periodo.
 *
 * Lanza —con un mensaje que se puede enseñar— si no hay conexión o si alguna
 * lectura falla o viene incompleta: un libro con la mitad de los movimientos
 * sale con saldos que no cuadran, y nadie lo nota hasta que alguien suma. Quien
 * llama decide qué hacer con el fallo; el informe, que no depende de este
 * libro, sale igual.
 */
export async function prepararExcelDelPeriodo(
  rango: Rango,
  o: { titulo: string; nombre: string; emitido: string },
): Promise<ExcelDelPeriodo> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('Sin conexión: el Excel del almacén se hace con los datos del servidor.')
  }
  const datos = await cargarDatosDelAlmacen()
  const libro = libroDelPeriodo(datos, rango, { titulo: o.titulo, emitido: o.emitido })
  const bytes = await libroNuevo(libro.hojas)
  return {
    nombre: o.nombre,
    blob: new Blob([bytes as unknown as BlobPart], { type: TIPO_XLSX }),
    cifras: libro.cifras,
  }
}
