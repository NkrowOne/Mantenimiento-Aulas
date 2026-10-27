/**
 * Las unidades del almacén: cada aparato guardado, con su número de serie y su
 * estado.
 *
 * El almacén cuenta —«quedan 8 teclados»— y eso basta para lo que se gasta y no
 * se distingue: un cable es igual que otro. Un proyector no. Cuando se va a
 * instalar uno hay que saber **cuál**: si es nuevo o vuelve de otra aula, si
 * está para reparar, qué número de serie se va a apuntar en la sala. Eso es una
 * unidad: una fila por aparato, dentro de su artículo.
 *
 * Empezaron siendo solo los ordenadores de repuesto (la hoja «PCs STOCK» del
 * Excel) y valen igual para cualquier artículo. El artículo sigue contando; las
 * unidades nombran lo contado. Pueden no cuadrar —«8 en el almacén, 3 con
 * número de serie»— y no es un error: son 5 que nadie ha apuntado todavía, y se
 * dice así.
 *
 * **El estado y la situación son dos cosas.** La situación es dónde está —en el
 * almacén, instalada en un aula, de baja— y la decide lo que se hace con ella.
 * El estado es cómo está —nueva, usada, reacondicionada, averiada— y lo dice
 * quien la tiene delante.
 */

import { norm } from './normalize'

export type Condicion = 'nuevo' | 'usado' | 'reacondicionado' | 'averiado' | 'sin_indicar'

/** Los estados que se pueden elegir. «Sin indicar» no: es lo que hay cuando nadie ha elegido. */
export const CONDICIONES: Array<Exclude<Condicion, 'sin_indicar'>> = ['nuevo', 'usado', 'reacondicionado', 'averiado']

export const CONDICION_LABEL: Record<Condicion, string> = {
  nuevo: 'Nuevo',
  usado: 'Usado',
  reacondicionado: 'Reacondicionado',
  averiado: 'Averiado',
  sin_indicar: 'Sin indicar',
}

/** Lo que significa cada estado, en una línea, para quien lo elige por primera vez. */
export const CONDICION_AYUDA: Record<Exclude<Condicion, 'sin_indicar'>, string> = {
  nuevo: 'Sin estrenar, en su caja.',
  usado: 'Ha estado instalado y funciona.',
  reacondicionado: 'Reparado o con la imagen rehecha, listo para instalar.',
  averiado: 'No funciona: no se instala hasta repararlo.',
}

export type SituacionDeUnidad = 'disponible' | 'instalado' | 'baja'

export const SITUACION_LABEL: Record<SituacionDeUnidad, string> = {
  disponible: 'En almacén',
  instalado: 'Instalada',
  baja: 'De baja',
}

/** Una fila de la vista `stock_unit_list`: una unidad con su artículo, su tipo y su sala. */
export interface UnidadDeAlmacen {
  id: string
  stock_item_id: string | null
  /** El nombre del artículo del almacén al que pertenece, si se pudo casar. */
  item_name: string | null
  item_active: boolean | null
  /** Lo que decía la hoja o el alta, tal cual: «Ordenador Tiny». */
  articulo: string
  asset_type_id: string | null
  type_name: string | null
  /** Va en la hoja «PCs STOCK» del Excel y cuenta como ordenador de repuesto en el informe. */
  es_ordenador: boolean
  brand: string | null
  model: string | null
  serial: string
  notes: string | null
  status: SituacionDeUnidad
  condicion: Condicion
  asset_id: string | null
  room_id: string | null
  room_code: string | null
  room_name: string | null
  building_code: string | null
  installed_at: string | null
  retired_at: string | null
  source: string | null
  created_at: string | null
  updated_at: string | null
}

/** Un número de serie como se compara: sin espacios ni separadores, en mayúsculas. */
export function serialComparable(serial: string): string {
  return String(serial ?? '').replace(/[\s\-_./]/g, '').toUpperCase()
}

/** «Lenovo ThinkCentre M710Q»: lo que se lee junto al número de serie. */
export function descripcionDeUnidad(u: Pick<UnidadDeAlmacen, 'brand' | 'model'>): string {
  return [u.brand, u.model].filter(Boolean).join(' ')
}

/**
 * ¿Responde esta unidad a lo buscado?
 *
 * Un número de serie se teclea a medias y con separadores distintos —`s4gm`,
 * `S4G-M18`—, así que se compara sin ellos. El resto (artículo, marca, modelo,
 * aula) palabra a palabra, sin tildes.
 */
export function coincideUnidad(u: UnidadDeAlmacen, consulta: string): boolean {
  const q = consulta.trim()
  if (!q) return true
  if (serialComparable(u.serial).includes(serialComparable(q))) return true
  const texto = norm(
    [u.articulo, u.item_name, u.brand, u.model, u.room_code, u.building_code, CONDICION_LABEL[u.condicion]]
      .filter(Boolean)
      .join(' '),
  )
  return norm(q)
    .split(' ')
    .filter(Boolean)
    .every((p) => texto.includes(p))
}

const ORDEN_SITUACION: Record<SituacionDeUnidad, number> = { disponible: 0, instalado: 1, baja: 2 }
const ORDEN_CONDICION: Record<Condicion, number> = {
  nuevo: 0,
  reacondicionado: 1,
  usado: 2,
  sin_indicar: 3,
  averiado: 4,
}

/**
 * En el orden en que se eligen: primero lo que está en el almacén, y dentro de
 * eso lo que se instalaría antes —lo nuevo, lo reacondicionado, lo usado— y lo
 * averiado al final, que es lo último que se quiere llevar a un aula.
 */
export function ordenarUnidades(unidades: UnidadDeAlmacen[]): UnidadDeAlmacen[] {
  return [...unidades].sort(
    (a, b) =>
      ORDEN_SITUACION[a.status] - ORDEN_SITUACION[b.status] ||
      ORDEN_CONDICION[a.condicion] - ORDEN_CONDICION[b.condicion] ||
      a.serial.localeCompare(b.serial, 'es', { numeric: true }),
  )
}

/** «3 nuevas · 1 usada»: cómo están las del almacén, en una línea. */
export function resumenDeCondiciones(unidades: Array<Pick<UnidadDeAlmacen, 'condicion' | 'status'>>): string {
  const enAlmacen = unidades.filter((u) => u.status === 'disponible')
  const cuenta = new Map<Condicion, number>()
  for (const u of enAlmacen) cuenta.set(u.condicion, (cuenta.get(u.condicion) ?? 0) + 1)
  const orden: Condicion[] = ['nuevo', 'reacondicionado', 'usado', 'averiado', 'sin_indicar']
  const FEM: Record<Condicion, [string, string]> = {
    nuevo: ['nueva', 'nuevas'],
    reacondicionado: ['reacondicionada', 'reacondicionadas'],
    usado: ['usada', 'usadas'],
    averiado: ['averiada', 'averiadas'],
    sin_indicar: ['sin estado', 'sin estado'],
  }
  return orden
    .filter((c) => (cuenta.get(c) ?? 0) > 0)
    .map((c) => {
      const n = cuenta.get(c)!
      return `${n} ${FEM[c][n === 1 ? 0 : 1]}`
    })
    .join(' · ')
}

/**
 * ¿La unidad que se da de alta entra ahora en el almacén, o ya estaba contada?
 *
 * Las dos cosas pasan. Quien pone por fin número de serie a los ocho teclados
 * que ya cuenta el almacén no debe acabar con dieciséis; quien recibe un
 * proyector nuevo sí tiene que verlo sumar. Se propone lo probable —si todas las
 * contadas ya tienen número, esta es nueva— y se puede cambiar antes de
 * guardar.
 */
export function entraPorDefecto(existencias: number, conSerieEnAlmacen: number): boolean {
  return conSerieEnAlmacen >= existencias
}

/** Lo que el almacén tiene sin número de serie: las contadas que ninguna unidad nombra. */
export function sinNumeroDeSerie(existencias: number, conSerieEnAlmacen: number): number {
  return Math.max(0, existencias - conSerieEnAlmacen)
}
