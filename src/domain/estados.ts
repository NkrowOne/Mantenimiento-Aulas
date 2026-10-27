/**
 * El estado de lo que el almacén cuenta: «de estos 8 teclados, 5 son nuevos y 3
 * usados».
 *
 * Un teclado no lleva número de serie que valga la pena apuntar, pero sí importa
 * si está en su caja o vuelve de un aula. Es lo que los programas de almacén
 * llaman *estado del inventario*: la cantidad no es una cifra sino varias, una
 * por estado, y cambiar el estado de tres es moverlas de una cifra a otra sin
 * que cambie el total. Los mismos cuatro estados que las unidades con número de
 * serie —nuevo, usado, reacondicionado, averiado— y «sin estado» para lo que
 * nadie ha mirado todavía, que al principio es todo.
 *
 * **Cada artículo se lleva de una de dos maneras**, como en cualquier programa
 * de inventario: por cantidad (cables, teclados, ratones: se cuentan y se dice
 * cuántas hay de cada estado) o por número de serie (ordenadores, proyectores:
 * cada aparato con su número y su estado, y al instalar se elige cuál). Las
 * cifras de un artículo por número de serie salen de sus unidades; las de uno
 * por cantidad, de los movimientos, que llevan su estado.
 *
 * Todo esto es la lectura de la vista `stock_levels_por_estado`. Las cuentas las
 * hace la base: aquí solo se decide qué enseñar y qué proponer.
 */

import { ESTADOS_EN_ORDEN, cuantasEnEstado, serialComparable, type Condicion, type CuentaPorEstado } from './unidades'

export type Seguimiento = 'cantidad' | 'serie'

export const SEGUIMIENTO_LABEL: Record<Seguimiento, string> = {
  cantidad: 'Por cantidad',
  serie: 'Por número de serie',
}

export const SEGUIMIENTO_AYUDA: Record<Seguimiento, string> = {
  cantidad: 'Se cuentan y se dice cuántas hay de cada estado: 5 nuevas, 3 usadas. Para cables, teclados, ratones…',
  serie: 'Cada una se apunta con su número de serie y su estado, y al instalar se elige cuál. Para ordenadores, proyectores, pantallas…',
}

/** Una fila de `stock_levels_por_estado`: un artículo activo, con su cantidad partida por estados. */
export interface NivelPorEstado {
  stock_item_id: string
  seguimiento: Seguimiento
  on_hand: number
  nuevo: number
  usado: number
  reacondicionado: number
  averiado: number
  sin_indicar: number
  /** Las que se pueden usar: todas menos las averiadas. */
  disponibles: number
}

/** Las cuentas de una fila de la vista, como las cuenta el resumen. */
export function cuentaDe(n: NivelPorEstado): Record<Condicion, number> {
  return {
    nuevo: n.nuevo,
    usado: n.usado,
    reacondicionado: n.reacondicionado,
    averiado: n.averiado,
    sin_indicar: n.sin_indicar,
  }
}

/** Cómo se llama cada fila de la hoja del artículo: en plural, porque se habla de unidades. */
export const ESTADO_EN_PLURAL: Record<Condicion, string> = {
  nuevo: 'Nuevas',
  usado: 'Usadas',
  reacondicionado: 'Reacondicionadas',
  averiado: 'Averiadas',
  sin_indicar: 'Sin estado',
}

/**
 * ¿Hay algo que contar sobre el estado?
 *
 * Al principio todo está «sin estado» —nadie ha dicho aún cómo están los ocho
 * teclados— y ponerlo en cada fila de la lista sería repetir sesenta veces lo
 * mismo. La lista lo dice en cuanto alguien ha clasificado alguna.
 */
export function hayEstadoQueContar(cuenta: CuentaPorEstado): boolean {
  return ESTADOS_EN_ORDEN.some((c) => c !== 'sin_indicar' && (cuenta[c] ?? 0) > 0)
}

/**
 * De cuál se saca cuando no se dice: primero lo usado, después lo
 * reacondicionado, lo que nadie ha mirado y, al final, lo nuevo. Lo averiado
 * nunca: no se lleva a un aula sin querer.
 *
 * Es el mismo orden que sigue la base cuando un movimiento llega sin estado (un
 * parte cerrado con material, lo que entra por el Excel): así la cifra de la
 * pantalla y la del servidor bajan por el mismo sitio.
 */
export const ORDEN_PARA_SACAR: Condicion[] = ['usado', 'reacondicionado', 'sin_indicar', 'nuevo']

export function estadoParaSacar(cuenta: CuentaPorEstado): Condicion | null {
  return ORDEN_PARA_SACAR.find((c) => (cuenta[c] ?? 0) > 0) ?? null
}

/**
 * Qué movimiento es meter una en ese estado: una nueva es una compra; una
 * usada, reacondicionada o averiada es algo que vuelve —de un aula, del
 * técnico que la arregló—. Es lo que dirá la columna «Tipo» del Excel.
 */
export function claseAlMeter(c: Condicion): 'compra' | 'devolucion' {
  return c === 'nuevo' ? 'compra' : 'devolucion'
}

/**
 * Lo que dice la barra de «Deshacer»: «Sacada 1 usada de Teclado».
 * Sin estado, como antes: «Sacada 1 unidad de Teclado».
 */
export function textoDelMovimiento(qty: number, articulo: string, condicion?: Condicion | null): string {
  const n = Math.abs(qty)
  const verbo = qty > 0 ? (n === 1 ? 'Metida' : 'Metidas') : n === 1 ? 'Sacada' : 'Sacadas'
  const que = condicion && condicion !== 'sin_indicar' ? cuantasEnEstado(condicion, n) : n === 1 ? '1 unidad' : `${n} unidades`
  return `${verbo} ${que} de ${articulo}.`
}

// -----------------------------------------------------------------------------
// Repartir las que no tienen estado
// -----------------------------------------------------------------------------

export type Reparto = Partial<Record<Exclude<Condicion, 'sin_indicar'>, number>>

/** Cuántas se reparten y cuántas quedan sin estado. Más de las que hay no es un reparto. */
export function cuentaDelReparto(sinEstado: number, reparto: Reparto): { repartidas: number; quedan: number; pasado: boolean } {
  const repartidas = Object.values(reparto).reduce((s, n) => s + (n ?? 0), 0)
  return { repartidas, quedan: Math.max(0, sinEstado - repartidas), pasado: repartidas > sinEstado }
}

// -----------------------------------------------------------------------------
// Una lista de números de serie, pegada de golpe
// -----------------------------------------------------------------------------

/**
 * Lo pegado → los números de serie, en el orden en que venían y sin repetir.
 *
 * Una lista llega de tres sitios: una columna copiada del Excel (un número por
 * línea), el albarán del proveedor en un correo (separados por comas o punto y
 * coma) y un lector de códigos de barras, que escribe cada lectura y pulsa
 * Intro. Se corta por saltos de línea, comas, puntos y comas y tabuladores;
 * **no por espacios**, porque hay números de serie que los llevan («S4G M18»).
 *
 * Dos que solo se distinguen por guiones o mayúsculas son el mismo —así los
 * compara la base— y se apunta una vez.
 */
export function seriesDeUnaLista(texto: string): { series: string[]; repetidas: number } {
  const vistos = new Set<string>()
  const series: string[] = []
  let repetidas = 0
  for (const trozo of String(texto ?? '').split(/[\n\r,;\t]+/)) {
    const s = trozo.trim()
    if (!s) continue
    const clave = serialComparable(s)
    if (!clave) continue
    if (vistos.has(clave)) {
      repetidas += 1
      continue
    }
    vistos.add(clave)
    series.push(s)
  }
  return { series, repetidas }
}

/** El máximo que se apunta de una vez: lo mismo que acepta la base. */
export const MAXIMO_DE_UNA_LISTA = 500

/** Lo que devuelve `stock_unit_alta_varias` por cada número de serie. */
export interface ResultadoDeAlta {
  serial: string
  id: string | null
  resultado: 'nueva' | 'ya_estaba' | 'error'
  mensaje?: string | null
}

/** «10 apuntadas · 2 ya estaban · 1 con error». */
export function resumenDeLasAltas(r: ResultadoDeAlta[]): string {
  const nuevas = r.filter((x) => x.resultado === 'nueva').length
  const yaEstaban = r.filter((x) => x.resultado === 'ya_estaba').length
  const errores = r.filter((x) => x.resultado === 'error').length
  return [
    nuevas > 0 ? `${nuevas} ${nuevas === 1 ? 'apuntada' : 'apuntadas'}` : null,
    yaEstaban > 0 ? `${yaEstaban} ya ${yaEstaban === 1 ? 'estaba' : 'estaban'}` : null,
    errores > 0 ? `${errores} con error` : null,
  ]
    .filter(Boolean)
    .join(' · ') || 'Nada que apuntar.'
}
