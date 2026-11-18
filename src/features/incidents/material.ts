/**
 * Qué hacer cuando alguien apunta material, sube la cantidad, la baja o la quita.
 *
 * Vive aparte de la pantalla para poder probarlo con filas en la mano, y porque
 * la regla cambió de sitio: **el almacén ya no se toca al apuntar**.
 *
 * Antes cada toque era un asiento en `stock_movements` —un consumo, o la
 * devolución que corregía el toque de más— y el libro mayor no se reescribe,
 * así que el Historial de la sala acababa con «+1 +1 −1 −1 −1» para un hub, y
 * el almacén se movía con la solicitud todavía abierta. Ahora lo apuntado es un
 * **parte**: una fila por artículo en `incident_materials` con las unidades que
 * dice el parte. Se reenvía con el mismo id cuantas veces cambie —la cola pisa—
 * y el servidor descuenta la diferencia neta cuando la incidencia se cierra. Un
 * asiento por artículo, con la fecha del cierre.
 *
 * Así que aquí ya no hay que distinguir lo que subió de lo que no: una fila del
 * parte se corrige igual esté donde esté. Lo que sí hay que decidir es a qué
 * fila va cada toque —el parte puede traer dos filas del mismo artículo, si
 * vinieron del Excel— y qué es «quitar»: una fila **a cero**, no borrada, para
 * que el servidor sepa que el artículo ya no cuenta y, si la incidencia ya
 * estaba cerrada, devuelva lo que tuviera descontado.
 *
 * **Y desde el 18/11/2026 una fila puede decir cuál.** De qué estado salen sus
 * unidades —nuevas, usadas— o qué aparato es, por su número de serie. Solo
 * cuando hay algo que elegir (`cual.ts`): si no, la fila no dice nada, como
 * siempre, y el servidor saca de lo que haya. Así que un artículo puede tener
 * varias filas —una por estado, una por aparato, una «sin decir»— y cada toque
 * va a la suya: lo que identifica a una fila dentro de su artículo es su
 * `claveDe`.
 */

import type { Condicion } from '@/domain/unidades'

/** Una fila del parte de material de una incidencia, esté donde esté. */
export interface LineaDelParte {
  id: string
  stockItemId: string
  /** Unidades que dice el parte. Cero es «quitada». */
  qty: number
  /**
   * `en_cola` — escrita en el dispositivo y sin salir.
   * `arriba` — el servidor la tiene, o esta pantalla la mandó y aún no la ha visto volver.
   */
  donde: 'en_cola' | 'arriba'
  /** De qué estado salen. Sin él, de lo que haya. */
  condicion?: Condicion | null
  /** Qué aparato es, si lleva número de serie. Entonces `qty` es 1 o 0. */
  unitId?: string | null
}

/**
 * Lo elegido al apuntar una unidad: un estado, un aparato (con su estado, que
 * es el que descuenta), o nada —«la que haya»—.
 */
export type Cual = { condicion: Condicion; unitId?: undefined } | { unitId: string; condicion: Condicion } | null

/**
 * Qué fila es, dentro de su artículo: `u:<unidad>`, `c:<estado>` o `''` para la
 * que no dice nada. Dos filas con la misma clave son la misma cosa apuntada dos
 * veces, y se suman.
 */
export function claveDe(l: { condicion?: Condicion | null; unitId?: string | null }): string {
  if (l.unitId) return `u:${l.unitId}`
  if (l.condicion) return `c:${l.condicion}`
  return ''
}

/** La clave de lo elegido: la de la fila a la que va el toque. */
export function claveDeCual(cual: Cual): string {
  return cual ? claveDe(cual) : ''
}

/** Una fila del parte con otra cantidad: lo que la pantalla tiene que encolar. */
export interface Cambio {
  id: string
  stockItemId: string
  qty: number
  condicion?: Condicion | null
  unitId?: string | null
}

/** Una fila con otra cantidad, sin perder lo que dice de cuál. */
function conCantidad(l: LineaDelParte, qty: number): Cambio {
  return {
    id: l.id,
    stockItemId: l.stockItemId,
    qty,
    ...(l.condicion ? { condicion: l.condicion } : {}),
    ...(l.unitId ? { unitId: l.unitId } : {}),
  }
}

/** Lo apuntado de un artículo, partido por lo que se eligió. */
export interface DetalleDeMaterial {
  /** `claveDe` de sus filas. */
  clave: string
  condicion: Condicion | null
  unitId: string | null
  unidades: number
}

/** Una línea de la lista: un artículo y lo que el parte dice de él. */
export interface LineaDeMaterial {
  stockItemId: string
  /** Unidades apuntadas. Siempre positivo: las líneas a cero no se enseñan. */
  unidades: number
  /** `true` si algo de esta línea todavía no ha llegado al servidor. */
  sinSubir: boolean
  /**
   * Cuáles son: una entrada por estado elegido, una por aparato y una para las
   * que no dicen nada. Solo las que tienen unidades. Si todas son «sin decir»,
   * es una sola entrada con clave vacía.
   */
  detalle: DetalleDeMaterial[]
}

/** Solo las de ese artículo, en el orden del parte. */
function suyas(parte: LineaDelParte[], stockItemId: string): LineaDelParte[] {
  return parte.filter((l) => l.stockItemId === stockItemId)
}

/** Lo que el parte dice de un artículo: la suma de sus filas. */
export function unidadesApuntadas(parte: LineaDelParte[], stockItemId: string): number {
  return suyas(parte, stockItemId).reduce((n, l) => n + Math.max(0, l.qty), 0)
}

/**
 * Las líneas, una por artículo y en el orden en que se apuntaron.
 *
 * Una por artículo porque quien lo lee quiere saber cuántos cables ha puesto,
 * no cuántas filas tiene el parte. El orden lo da el id más bajo de cada
 * artículo, que en las filas de la aplicación es el momento en que se apuntó
 * —son uuid v7— y no la fuente de la que llegó la fila: si dependiera de eso,
 * la línea que se acaba de tocar saltaría al principio a cada toque.
 *
 * Las que quedan a cero desaparecen: es un artículo quitado, y enseñarlo sería
 * contar el error en vez del trabajo.
 */
export function lineasDeMaterial(parte: LineaDelParte[]): LineaDeMaterial[] {
  const primerId = new Map<string, string>()
  for (const l of parte) {
    const visto = primerId.get(l.stockItemId)
    if (visto === undefined || l.id < visto) primerId.set(l.stockItemId, l.id)
  }

  return [...primerId.entries()]
    .sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([stockItemId]) => ({
      stockItemId,
      unidades: unidadesApuntadas(parte, stockItemId),
      sinSubir: suyas(parte, stockItemId).some((l) => l.donde === 'en_cola'),
      detalle: detalleDe(parte, stockItemId),
    }))
    .filter((l) => l.unidades > 0)
}

/**
 * Lo apuntado de un artículo, por lo que se eligió, en el orden en que se
 * apuntó cada cosa (el id más bajo de cada clave, como las líneas).
 */
export function detalleDe(parte: LineaDelParte[], stockItemId: string): DetalleDeMaterial[] {
  const porClave = new Map<string, DetalleDeMaterial & { primerId: string }>()
  for (const l of suyas(parte, stockItemId)) {
    const clave = claveDe(l)
    const ya = porClave.get(clave)
    if (ya) {
      ya.unidades += Math.max(0, l.qty)
      if (l.id < ya.primerId) ya.primerId = l.id
    } else {
      porClave.set(clave, {
        clave,
        condicion: l.condicion ?? null,
        unitId: l.unitId ?? null,
        unidades: Math.max(0, l.qty),
        primerId: l.id,
      })
    }
  }
  return [...porClave.values()]
    .filter((d) => d.unidades > 0)
    .sort((a, b) => (a.primerId < b.primerId ? -1 : a.primerId > b.primerId ? 1 : 0))
    .map(({ primerId: _primerId, ...d }) => d)
}

/**
 * Una unidad más de ese artículo, de la que se haya elegido.
 *
 * Si el parte ya tiene una fila de ESA elección —el mismo estado, el mismo
 * aparato, o ninguna de las dos cosas— se le sube la cantidad a esa, la primera;
 * si no, se abre una con el id que dé `nuevoId`. El id lo pone quien llama
 * porque nace con la fila y viaja con ella: reenviarla no duplica, y probar
 * esto no necesita un generador.
 *
 * Un aparato es uno: su fila vale 1 aunque se toque dos veces.
 */
export function planSumar(
  parte: LineaDelParte[],
  stockItemId: string,
  nuevoId: () => string,
  cual: Cual = null,
): Cambio[] {
  const clave = claveDeCual(cual)
  const [suya] = suyas(parte, stockItemId).filter((l) => claveDe(l) === clave)
  if (cual?.unitId) {
    if (suya) return suya.qty >= 1 ? [] : [conCantidad(suya, 1)]
    return [{ id: nuevoId(), stockItemId, qty: 1, condicion: cual.condicion, unitId: cual.unitId }]
  }
  if (suya) return [conCantidad(suya, Math.max(0, suya.qty) + 1)]
  return [{ id: nuevoId(), stockItemId, qty: 1, ...(cual ? { condicion: cual.condicion } : {}) }]
}

/**
 * Una unidad menos. De la primera fila que tenga unidades, y no de la primera a
 * secas: una que ya está a cero no puede bajar más.
 *
 * Con `clave`, de las filas de esa elección: es el `−` de «2 nuevas». Sin ella,
 * de la primera que tenga, que es lo que hace el `−` de una línea que no dice
 * cuáles.
 */
export function planRestar(parte: LineaDelParte[], stockItemId: string, clave?: string): Cambio[] {
  const conUnidades = suyas(parte, stockItemId).find(
    (l) => l.qty > 0 && (clave === undefined || claveDe(l) === clave),
  )
  if (!conUnidades) return []
  return [conCantidad(conUnidades, conUnidades.qty - 1)]
}

/**
 * Quitar el artículo entero de la avería: todas sus filas a cero.
 *
 * A cero y no borradas. La cola solo sabe reenviar filas, y el servidor
 * necesita ver el cero: si la incidencia ya estaba cerrada cuando llega, es lo
 * que le dice que devuelva al almacén lo que tuviera descontado.
 */
export function planQuitar(parte: LineaDelParte[], stockItemId: string): Cambio[] {
  return suyas(parte, stockItemId)
    .filter((l) => l.qty > 0)
    .map((l) => conCantidad(l, 0))
}

/**
 * Juntar de dónde puede venir una fila del parte sin perder ninguna y sin
 * contar dos.
 *
 * Son tres sitios:
 *
 *  1. **La cola del dispositivo.** Lo que se acaba de apuntar y no ha salido.
 *  2. **El servidor.** Lo que ya está guardado.
 *  3. **Lo que esta pantalla ha encolado y ya no está en la cola**, que es el
 *     hueco: la cola BORRA la fila al subirla, y hasta que la lista del servidor
 *     se vuelve a pedir la fila no está en ningún sitio. Quien no ve lo que
 *     acaba de apuntar, lo apunta otra vez.
 *
 * El id manda: es el mismo en los tres sitios, así que la misma fila vista
 * desde dos no se cuenta dos veces. Gana la cola, que tiene la cantidad más
 * reciente; después lo recordado, que es más nuevo que la copia del servidor.
 */
export function mezclarParte(
  enCola: LineaDelParte[],
  enElServidor: LineaDelParte[],
  apuntadasAqui: LineaDelParte[],
): LineaDelParte[] {
  const vistas = new Set(enCola.map((l) => l.id))
  const out = [...enCola]

  for (const l of [...apuntadasAqui, ...enElServidor]) {
    if (vistas.has(l.id)) continue
    vistas.add(l.id)
    out.push({ ...l, donde: 'arriba' })
  }
  return out
}
