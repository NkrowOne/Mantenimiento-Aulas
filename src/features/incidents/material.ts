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
 */

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
}

/** Una fila del parte con otra cantidad: lo que la pantalla tiene que encolar. */
export interface Cambio {
  id: string
  stockItemId: string
  qty: number
}

/** Una línea de la lista: un artículo y lo que el parte dice de él. */
export interface LineaDeMaterial {
  stockItemId: string
  /** Unidades apuntadas. Siempre positivo: las líneas a cero no se enseñan. */
  unidades: number
  /** `true` si algo de esta línea todavía no ha llegado al servidor. */
  sinSubir: boolean
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
    }))
    .filter((l) => l.unidades > 0)
}

/**
 * Una unidad más de ese artículo.
 *
 * Si el parte ya tiene una fila suya se le sube la cantidad a esa —la primera,
 * que es la que se apuntó antes—; si no, se abre una con el id que dé
 * `nuevoId`. El id lo pone quien llama porque nace con la fila y viaja con
 * ella: reenviarla no duplica, y probar esto no necesita un generador.
 */
export function planSumar(parte: LineaDelParte[], stockItemId: string, nuevoId: () => string): Cambio[] {
  const [primera] = suyas(parte, stockItemId)
  if (primera) return [{ id: primera.id, stockItemId, qty: Math.max(0, primera.qty) + 1 }]
  return [{ id: nuevoId(), stockItemId, qty: 1 }]
}

/**
 * Una unidad menos. De la primera fila que tenga unidades, y no de la primera a
 * secas: una que ya está a cero no puede bajar más.
 */
export function planRestar(parte: LineaDelParte[], stockItemId: string): Cambio[] {
  const conUnidades = suyas(parte, stockItemId).find((l) => l.qty > 0)
  if (!conUnidades) return []
  return [{ id: conUnidades.id, stockItemId, qty: conUnidades.qty - 1 }]
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
    .map((l) => ({ id: l.id, stockItemId, qty: 0 }))
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
