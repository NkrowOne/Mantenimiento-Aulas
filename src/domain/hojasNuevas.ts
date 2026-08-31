/**
 * Las hojas que el libro no tiene y hacen falta para que diga la verdad entera.
 *
 * Las cinco de siempre están construidas alrededor de una idea: **una fila por
 * cosa, y el estado de hoy**. Una fila por aula con su última revisión, una fila
 * por artículo con lo que queda. Eso vale para mirar cómo está el parque, y no
 * vale para nada de lo que se pidió aquí: *revisiones, horas, salidas de
 * material, entradas, movimientos al stock*. Ninguna de esas cosas es un estado;
 * todas son **un historial**, y un historial no cabe en una celda.
 *
 * La hoja de estado tiene dos columnas de fecha de revisión. Dos. La aplicación
 * guarda todas, con quién la hizo, a qué hora, qué comprobó y qué salió mal.
 * Meter eso en la hoja de siempre exigiría o inventarse cuarenta columnas o
 * tirar lo que no cupiera, así que va donde cabe: en tres hojas nuevas con una
 * fila por evento.
 *
 * Cuatro decisiones sobre cómo se ven:
 *
 * **Llevan la matrícula, y por eso se pueden cruzar.** `Revisiones` y
 * `Inventario por Sala` traen `Ref`, la misma columna que la hoja de estado, así
 * que un `BUSCARV` las une sin que nadie tenga que casar nombres a mano. Es la
 * diferencia entre tres hojas nuevas y tres hojas útiles.
 *
 * **Los movimientos llevan el saldo detrás.** Una lista de entradas y salidas
 * contesta «qué pasó» y no contesta «cuánto queda», que es la que se hace la
 * gente. Va calculado y en orden de fecha, así que se puede señalar el renglón
 * donde el stock se torció.
 *
 * **Las fechas se escriben como fechas**, con el estilo que el propio libro usa
 * en sus columnas de fecha. Una hoja de revisiones que enseña `45831` no la mira
 * nadie dos veces.
 *
 * **No hay fotos.** Se pidió expresamente, y además una foto en una celda pesa
 * más que todo el resto del libro junto.
 */

import type { Formato, HojaNueva } from './libro'
import type { ValorCelda } from './xlsx'
import { fechaAExcel } from './valores'

// -----------------------------------------------------------------------------
// Revisiones
// -----------------------------------------------------------------------------

export interface RevisionParaHoja {
  shortRef: string
  edificio: string
  zona: string
  sala: string
  /** ISO completo: de aquí salen la fecha y la hora, que van en columnas aparte. */
  cuando: string
  quien: string | null
  estado: string
  resultado: string | null
  horasProyector: number | null
  lampara: number | null
  /** `altavoces: ok · cámara: incidencia`, ya montado. */
  comprobaciones: string | null
  incidenciasAbiertas: number
  notas: string | null
}

const COL_REVISIONES = [
  'Ref',
  'Edificio',
  'Planta/Módulo',
  'Aula',
  'Fecha',
  'Hora',
  'Revisó',
  'Estado',
  'Resultado',
  'Horas Proyector',
  '% Lámparas',
  'Comprobaciones',
  'Incidencias abiertas',
  'Observaciones',
]

export function hojaDeRevisiones(revisiones: RevisionParaHoja[]): HojaNueva {
  const filas: ValorCelda[][] = [COL_REVISIONES]

  // De la más reciente a la más vieja: es el orden en que se busca algo en un
  // historial, y deja arriba lo que se acaba de sincronizar.
  const ordenadas = [...revisiones].sort((a, b) => b.cuando.localeCompare(a.cuando))

  for (const r of ordenadas) {
    filas.push([
      r.shortRef,
      r.edificio,
      r.zona,
      r.sala,
      fechaAExcel(r.cuando),
      horaDe(r.cuando),
      r.quien,
      r.estado,
      r.resultado,
      r.horasProyector,
      r.lampara,
      r.comprobaciones,
      r.incidenciasAbiertas,
      r.notas,
    ])
  }

  return {
    nombre: 'Revisiones',
    filas,
    anchos: [14, 22, 16, 16, 11, 8, 22, 12, 16, 14, 12, 40, 10, 46],
    formatos: formatos({ 4: 'fecha', 10: 'porcentaje' }),
  }
}

/**
 * La hora, como texto y en 24 horas.
 *
 * Va aparte de la fecha y no junta con ella a propósito: en una sola celda con
 * formato de fecha y hora, filtrar «las revisiones del martes» deja de funcionar
 * porque cada instante es distinto. Separadas, la columna de fecha filtra por
 * día y la de hora sigue estando cuando hace falta.
 */
function horaDe(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  // Si solo vino la fecha, no hay hora que enseñar.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// -----------------------------------------------------------------------------
// Movimientos de almacén
// -----------------------------------------------------------------------------

export interface MovimientoParaHoja {
  cuando: string
  articulo: string
  /** En positivo entra y en negativo sale, como está en la base. */
  cantidad: number
  tipo: string
  incidencia: string | null
  sala: string | null
  quien: string | null
  nota: string | null
}

const COL_MOVIMIENTOS = [
  'Fecha',
  'Artículo',
  'Movimiento',
  'Entrada',
  'Salida',
  'Saldo',
  'Incidencia',
  'Aula',
  'Quién',
  'Nota',
]

/** Cómo se llama cada movimiento cuando lo lee una persona. */
const NOMBRE_DEL_MOVIMIENTO: Record<string, string> = {
  compra: 'Compra',
  consumo: 'Consumo',
  ajuste: 'Ajuste',
  devolucion: 'Devolución',
}

export function hojaDeMovimientos(movimientos: MovimientoParaHoja[]): HojaNueva {
  const filas: ValorCelda[][] = [COL_MOVIMIENTOS]

  // Por artículo y por fecha, que es el orden en el que el saldo significa algo.
  // Dentro del mismo día, el orden de llegada: dos movimientos del mismo día no
  // se pueden ordenar mejor que eso sin inventarse una hora.
  const ordenados = [...movimientos].sort(
    (a, b) => a.articulo.localeCompare(b.articulo, 'es') || a.cuando.localeCompare(b.cuando),
  )

  const saldo = new Map<string, number>()
  for (const m of ordenados) {
    const acumulado = (saldo.get(m.articulo) ?? 0) + m.cantidad
    saldo.set(m.articulo, acumulado)
    filas.push([
      fechaAExcel(m.cuando),
      m.articulo,
      NOMBRE_DEL_MOVIMIENTO[m.tipo] ?? m.tipo,
      m.cantidad > 0 ? m.cantidad : null,
      m.cantidad < 0 ? -m.cantidad : null,
      acumulado,
      m.incidencia,
      m.sala,
      m.quien,
      m.nota,
    ])
  }

  return {
    nombre: 'Movimientos de Almacén',
    filas,
    anchos: [11, 38, 14, 10, 10, 10, 16, 16, 22, 40],
    formatos: formatos({ 0: 'fecha' }),
  }
}

// -----------------------------------------------------------------------------
// Inventario por sala
// -----------------------------------------------------------------------------

export interface EquipoParaHoja {
  shortRef: string
  edificio: string
  zona: string
  sala: string
  tipo: string
  modelo: string | null
  serial: string | null
  estado: string
  desde: string | null
  etiqueta: string | null
}

const COL_INVENTARIO = [
  'Ref',
  'Edificio',
  'Planta/Módulo',
  'Aula',
  'Equipo',
  'Modelo',
  'N.º de serie',
  'Estado',
  'Desde',
  'Etiqueta',
]

/**
 * Una fila por equipo instalado.
 *
 * Es la hoja que contesta lo que la de estado no puede: **un aula con dos
 * proyectores**. La hoja de siempre tiene una columna `S/N Proyector` y por
 * fuerza enseña uno solo; aquí salen los dos, con su fecha de alta, y se ve cuál
 * es el que la otra hoja está enseñando.
 */
export function hojaDeInventario(equipos: EquipoParaHoja[]): HojaNueva {
  const filas: ValorCelda[][] = [COL_INVENTARIO]

  const ordenados = [...equipos].sort(
    (a, b) =>
      a.edificio.localeCompare(b.edificio, 'es') ||
      a.sala.localeCompare(b.sala, 'es', { numeric: true }) ||
      a.tipo.localeCompare(b.tipo, 'es'),
  )

  for (const e of ordenados) {
    filas.push([
      e.shortRef,
      e.edificio,
      e.zona,
      e.sala,
      e.tipo,
      e.modelo,
      e.serial,
      e.estado,
      e.desde ? fechaAExcel(e.desde) : null,
      e.etiqueta,
    ])
  }

  return {
    nombre: 'Inventario por Sala',
    filas,
    anchos: [14, 22, 16, 16, 16, 26, 22, 12, 11, 14],
    formatos: formatos({ 8: 'fecha' }),
  }
}

// -----------------------------------------------------------------------------
// El parte de la pasada
// -----------------------------------------------------------------------------

export interface LineaDelParte {
  hoja: string
  celda: string
  que: string
  detalle: string
}

const COL_PARTE = ['Hoja', 'Celda', 'Qué pasó', 'Detalle']

/**
 * Lo que la pasada no pudo decidir, dentro del propio libro.
 *
 * Existe por una razón muy concreta: **quien abre el Excel no abre la
 * aplicación**. Si los choques y la cuarentena solo se ven en una bandeja de
 * administración, en seis meses hay quinientos y nadie los ha mirado. Aquí los
 * ve la misma persona que está mirando la celda.
 *
 * Se reescribe entera en cada pasada, y eso es lo correcto: no es un historial,
 * es la lista de lo que sigue pendiente hoy.
 */
export function hojaDelParte(lineas: LineaDelParte[], cuando: string): HojaNueva {
  const filas: ValorCelda[][] = [COL_PARTE]

  if (lineas.length === 0) {
    filas.push(['', '', 'Todo cuadra', `Última sincronización: ${cuando}. Nada quedó pendiente.`])
  } else {
    filas.push(['', '', `Última sincronización`, cuando])
    for (const l of lineas) filas.push([l.hoja, l.celda, l.que, l.detalle])
  }

  return {
    nombre: 'Sincronización',
    filas,
    anchos: [30, 10, 26, 80],
    autofiltro: lineas.length > 0,
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
