/**
 * Lo que la aplicación tiene que decir en cada celda.
 *
 * Es la mitad de la fusión que mira hacia dentro: dado lo que la base sabe de
 * una sala, de un parte o de un artículo, qué valor le corresponde a cada
 * columna del mapa. No compara con nada y no escribe nada — eso es
 * `sincronizar.ts`. Aquí solo se convierte.
 *
 * La regla que ordena todo el fichero: **se trabaja en el dominio de la
 * aplicación, no en el de la celda**. Una fecha es `2025-06-23` y no `45831`, un
 * porcentaje es `0.86` y no `'86%'`, y un sí es `true` y no `'SÍ'`. La conversión
 * a lo que se escribe en el fichero pasa una sola vez, al final, en
 * `valores.ts`. Sin esa disciplina, comparar el lado de la base con el del Excel
 * obliga a formatear los dos igual en cada comparación, y basta con que una se
 * escape para que la pasada dé por cambiadas 280 celdas que nadie tocó.
 *
 * Dos cosas que este fichero decide y conviene leer antes de discutirlas:
 *
 * **De una sala con dos proyectores, el Excel solo puede enseñar uno.** La hoja
 * tiene una columna `S/N Proyector`, no una lista. Se elige el instalado más
 * reciente y **se dice** que hay más: inventarse una segunda columna sería
 * cambiar el libro de la gente, y callarlo sería que el Excel afirme que la sala
 * tiene un proyector cuando tiene dos. El aviso sale en el parte de la pasada, y
 * la hoja `Inventario por Sala` los lleva todos.
 *
 * **El consumo del mes es la suma de los movimientos de ese mes, y va a cero si
 * no hubo ninguno.** Aquí sí se escribe un cero donde no hay nada, y es lo
 * contrario de lo que hace `valores.ts` con una celda ilegible: la diferencia es
 * que aquí la base **sabe** que no hubo consumo en marzo, mientras que un
 * `********` en la columna de horas no dice nada de las horas.
 */

import { ZONA } from './fechas'
import { EQUIPOS_EN_COLUMNAS, capacidadDe, equipoDe, mesDe } from './mapa'
import type { Columna, Hoja } from './mapa'
import { escribirMicrofono } from './valores'
import type { Valor } from './valores'

// -----------------------------------------------------------------------------
// Lo que hace falta saber de la base
// -----------------------------------------------------------------------------

export interface EquipoVolcado {
  id: string
  tipo: string
  serial: string | null
  model: string | null
  /** Para elegir cuál enseña la hoja cuando hay más de uno del mismo tipo. */
  desde: string | null
}

export interface SalaVolcada {
  id: string
  /** `SALA-000087`. La que va en la columna `Ref`. */
  shortRef: string
  edificio: string
  zona: string
  code: string
  /** `false` = archivada. Su fila sale del libro. */
  activa: boolean
  projectorHours: number | null
  lampPct: number | null
  botoneraEstado: string | null
  capacidades: Record<string, boolean>
  /** Fechas ISO de las dos últimas revisiones cerradas, la más nueva primero. */
  revisiones: string[]
  /** Las observaciones de la última revisión. */
  notas: string | null
  equipos: EquipoVolcado[]
}

export interface IncidenciaVolcada {
  id: string
  numero: string
  salaCode: string
  abierta: string | null
  resuelta: string | null
  problema: string | null
  observacion: string | null
  resolucion: string | null
  /** Ya escrito como lo escribe la gente: `2 Cable HDMI fibra 10 m`. */
  material: string | null
}

export interface ArticuloVolcado {
  id: string
  nombre: string
  /** Consumo por mes del año que toca, del 1 al 12. Cero es cero, no vacío. */
  meses: number[]
  comprado: number | null
}

// -----------------------------------------------------------------------------
// Una sala
// -----------------------------------------------------------------------------

/**
 * De todos los equipos de un tipo, el que enseña la hoja.
 *
 * El más recientemente instalado, y a igualdad de fecha el que tenga número de
 * serie: entre una fila que dice «hay un proyector» y otra que dice «hay un
 * proyector y es el 0340985RL», la segunda es la que sirve para algo.
 */
export function equipoQueSeVe(equipos: EquipoVolcado[], tipo: string): EquipoVolcado | null {
  const suyos = equipos.filter((e) => e.tipo === tipo)
  if (suyos.length === 0) return null
  return [...suyos].sort((a, b) => {
    const f = (b.desde ?? '').localeCompare(a.desde ?? '')
    if (f !== 0) return f
    return Number(Boolean(b.serial)) - Number(Boolean(a.serial))
  })[0]!
}

/** Los tipos de los que la sala tiene más de uno: el Excel no puede enseñarlos. */
export function equiposDeMas(sala: SalaVolcada): Array<{ tipo: string; cuantos: number }> {
  const out: Array<{ tipo: string; cuantos: number }> = []
  for (const tipo of EQUIPOS_EN_COLUMNAS) {
    const cuantos = sala.equipos.filter((e) => e.tipo === tipo).length
    if (cuantos > 1) out.push({ tipo, cuantos })
  }
  return out
}

/** El valor que le toca a una columna de la hoja de estado. */
export function valorDeSala(sala: SalaVolcada, c: Columna): Valor {
  const eq = equipoDe(c.campo)
  if (eq) {
    const equipo = equipoQueSeVe(sala.equipos, eq.tipo)
    return equipo ? (eq.campo === 'serial' ? equipo.serial : equipo.model) : null
  }

  const cap = capacidadDe(c.campo)
  if (cap) return sala.capacidades[cap] ?? null

  switch (c.campo) {
    case 'edificio':
      return sala.edificio
    case 'zona':
      return sala.zona
    case 'sala.code':
      return sala.code
    case 'revision.ultima':
      return sala.revisiones[0] ?? null
    case 'revision.penultima':
      return sala.revisiones[1] ?? null
    case 'revision.notas':
      return sala.notas
    case 'rooms.projector_hours':
      return sala.projectorHours
    case 'rooms.lamp_pct':
      return sala.lampPct
    case 'rooms.botonera_estado':
      return sala.botoneraEstado
    case 'microfono': {
      const micro = equipoQueSeVe(sala.equipos, 'Micrófono')
      return escribirMicrofono({
        hay: micro ? true : (sala.capacidades.microfono ?? null),
        serial: micro?.serial ?? null,
        modelo: micro?.serial ? null : (micro?.model ?? null),
      })
    }
    default:
      return null
  }
}

/** Toda la fila de una sala, por letra de columna. */
export function filaDeSala(sala: SalaVolcada, hoja: Hoja): Record<string, Valor> {
  const out: Record<string, Valor> = {}
  for (const c of hoja.columnas) out[c.letra] = valorDeSala(sala, c)
  return out
}

// -----------------------------------------------------------------------------
// Un parte
// -----------------------------------------------------------------------------

export function valorDeIncidencia(inc: IncidenciaVolcada, c: Columna): Valor {
  switch (c.campo) {
    case 'sala.code':
      return inc.salaCode
    case 'incidencia.numero':
      return inc.numero
    case 'incidencia.abierta':
      return inc.abierta
    case 'incidencia.resuelta':
      return inc.resuelta
    case 'incidencia.problema':
      return inc.problema
    case 'incidencia.observacion':
      return inc.observacion
    case 'incidencia.resolucion':
      return inc.resolucion
    case 'incidencia.material':
      return inc.material
    default:
      return null
  }
}

export function filaDeIncidencia(inc: IncidenciaVolcada, hoja: Hoja): Record<string, Valor> {
  const out: Record<string, Valor> = {}
  for (const c of hoja.columnas) out[c.letra] = valorDeIncidencia(inc, c)
  return out
}

// -----------------------------------------------------------------------------
// Un artículo del almacén
// -----------------------------------------------------------------------------

export function valorDeArticulo(art: ArticuloVolcado, c: Columna): Valor {
  const mes = mesDe(c.campo)
  if (mes !== null) return art.meses[mes - 1] ?? 0

  switch (c.campo) {
    case 'articulo.nombre':
      return art.nombre
    case 'articulo.comprado':
      return art.comprado
    default:
      // `Total Instalado` y `Stock Disponible` los calcula la hoja: aquí no hay
      // valor que dar, y darlo sería escribir un número encima de una fórmula.
      return null
  }
}

export function filaDeArticulo(art: ArticuloVolcado, hoja: Hoja): Record<string, Valor> {
  const out: Record<string, Valor> = {}
  for (const c of hoja.columnas) out[c.letra] = valorDeArticulo(art, c)
  return out
}

// -----------------------------------------------------------------------------
// El consumo por meses, que es lo que hoy está en blanco
// -----------------------------------------------------------------------------

export interface MovimientoVolcado {
  stockItemId: string
  qty: number
  kind: string
  occurredAt: string
}

/**
 * Reparte los movimientos de un año en las doce columnas de mes.
 *
 * Solo el consumo, y en positivo: la columna se llama `Total Instalado` y lo que
 * cuenta es cuánto material salió del almacén a las aulas. Una devolución
 * descuenta de su mes —es material que volvió— y una compra no pinta nada aquí:
 * va a `Total Comprado`, que es otra columna.
 *
 * El mes sale de `occurred_at`, no de `recorded_at`: un parte de diciembre que se
 * sincroniza en enero es consumo de diciembre. Es la misma razón por la que las
 * dos fechas existen por separado en toda la base.
 */
/**
 * El año y el mes de un instante **en Madrid**.
 *
 * `getFullYear()` usa el huso del aparato que pregunta, y aquí eso no vale: la
 * base cuadra `Comprado` filtrando por `extract(year from occurred_at at time
 * zone 'Europe/Madrid')`, así que una compra del 31 de diciembre a las 23:30
 * UTC sería de 2025 para la base y de 2026 para el navegador de quien
 * sincronice desde otro huso. Dos años distintos para el mismo movimiento son
 * una celda que no cuadra nunca.
 */
function enMadrid(iso: string): { anyo: number; mes: number } | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const [anyo, mes] = new Intl.DateTimeFormat('sv-SE', { timeZone: ZONA, dateStyle: 'short' })
    .format(d)
    .split('-')
    .map(Number)
  return { anyo: anyo!, mes: mes! }
}

export function consumoPorMes(movimientos: MovimientoVolcado[], anyo: number): number[] {
  const meses = new Array<number>(12).fill(0)
  for (const m of movimientos) {
    if (m.kind !== 'consumo' && m.kind !== 'devolucion') continue
    const cuando = enMadrid(m.occurredAt)
    if (cuando === null || cuando.anyo !== anyo) continue
    // El consumo se guarda en negativo —sale del almacén—: en la hoja se enseña
    // cuánto salió, así que se le da la vuelta.
    meses[cuando.mes - 1] = (meses[cuando.mes - 1] ?? 0) - m.qty
  }
  return meses.map((n) => Math.max(0, n))
}

/** Lo comprado en el año: los movimientos de compra, sumados. */
export function compradoEn(movimientos: MovimientoVolcado[], anyo: number): number {
  let total = 0
  for (const m of movimientos) {
    if (m.kind !== 'compra') continue
    const cuando = enMadrid(m.occurredAt)
    if (cuando === null || cuando.anyo !== anyo) continue
    total += m.qty
  }
  return total
}
