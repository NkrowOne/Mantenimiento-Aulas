/**
 * Qué hacer cuando alguien apunta material, sube la cantidad, la baja o la quita.
 *
 * Vive aparte de la pantalla por una razón concreta: **quitar un apunte no es
 * una sola cosa**, y de cuál sea depende que el almacén cuadre o no.
 *
 *  - Si el apunte **sigue en la cola**, no ha salido del dispositivo. Borrarlo
 *    de la cola es que nunca ocurrió, y es lo que hay que hacer: meter una
 *    devolución de algo que el servidor no ha visto le sumaría una unidad de la
 *    nada.
 *  - Si **ya subió**, `stock_movements` es un libro de asientos y no se
 *    reescribe: la corrección es una `devolucion`, que es el tipo que existe
 *    justo para esto y el único al que el signo no le pone condiciones. Lo dejó
 *    escrito `20260830001100`, que arregló lo mismo por el lado del Excel.
 *  - Y si está **saliendo** —la cola lo tiene marcado «enviando»— se trata como
 *    si ya hubiera subido. Borrarlo entonces es una carrera que se puede
 *    perder: la petición ya va por el aire y la fila llegaría igual, pero sin
 *    nada que la compense.
 *
 * Esa decisión es la que se prueba aquí. La pantalla solo ejecuta lo que salga.
 *
 * El signo es el de la base, no el de la cabeza de quien lo lee: un `consumo`
 * lleva `qty` negativo y una `devolucion` positivo, así que lo que queda usado
 * de un artículo es **menos la suma** de sus movimientos.
 */

/** Un movimiento de material de una incidencia, esté donde esté. */
export interface ApunteDeMaterial {
  id: string
  stockItemId: string
  /** Como en la base: negativo si se gastó, positivo si volvió. */
  qty: number
  kind: 'consumo' | 'devolucion'
  /**
   * `en_cola` — escrito en el dispositivo y sin salir. Se puede cambiar o borrar.
   * `saliendo` — la cola lo está subiendo ahora mismo. Ya no se toca.
   * `arriba` — el servidor lo tiene. Solo se corrige con otro asiento.
   */
  donde: 'en_cola' | 'saliendo' | 'arriba'
}

/** Lo que la pantalla tiene que hacer. Una lista, porque quitar puede ser dos. */
export type Operacion =
  /** Reencolar esa misma fila con otra cantidad. Mismo id: no duplica. */
  | { tipo: 'editar'; id: string; qty: number }
  /** Sacarla de la cola. No llegó a salir, así que no ocurrió. */
  | { tipo: 'borrar'; id: string }
  /** Un apunte nuevo de consumo, en unidades (positivas). */
  | { tipo: 'consumo'; unidades: number }
  /** Devolver al almacén lo que ya subió, en unidades (positivas). */
  | { tipo: 'devolucion'; unidades: number }

/** Una línea de la lista: un artículo y lo que lleva gastado en esta avería. */
export interface LineaDeMaterial {
  stockItemId: string
  /** Unidades que la avería tiene gastadas ahora mismo. Siempre positivo. */
  unidades: number
  /** `true` si algo de esta línea todavía no ha llegado al servidor. */
  sinSubir: boolean
}

/** Solo los de ese artículo. */
function suyos(apuntes: ApunteDeMaterial[], stockItemId: string): ApunteDeMaterial[] {
  return apuntes.filter((a) => a.stockItemId === stockItemId)
}

/** Lo que queda gastado de un artículo: consumos menos devoluciones. */
export function unidadesUsadas(apuntes: ApunteDeMaterial[], stockItemId: string): number {
  return -suyos(apuntes, stockItemId).reduce((n, a) => n + a.qty, 0)
}

/**
 * El consumo de ese artículo que todavía se puede tocar, si lo hay.
 *
 * Solo uno y el primero: la pantalla mantiene un apunte por artículo mientras
 * no salga, así que en la práctica no hay dos. Y si los hubiera —dos técnicos,
 * o una cola que se atascó— tocar uno cualquiera es correcto: la cuenta que
 * importa es la suma.
 */
function editable(apuntes: ApunteDeMaterial[], stockItemId: string): ApunteDeMaterial | null {
  return suyos(apuntes, stockItemId).find((a) => a.kind === 'consumo' && a.donde === 'en_cola') ?? null
}

/**
 * Las líneas, agrupadas por artículo y en el orden en que se apuntaron.
 *
 * Agrupadas y no una fila por movimiento porque quien lo lee quiere saber
 * cuántos cables ha puesto, no cuántas veces tocó el `+`. Las que quedan a cero
 * —apuntado y devuelto— desaparecen: son dos asientos que se anulan, y
 * enseñarlos sería contar el error en vez del trabajo.
 */
export function lineasDeMaterial(apuntes: ApunteDeMaterial[]): LineaDeMaterial[] {
  const orden: string[] = []
  for (const a of apuntes) if (!orden.includes(a.stockItemId)) orden.push(a.stockItemId)

  return orden
    .map((stockItemId) => ({
      stockItemId,
      unidades: unidadesUsadas(apuntes, stockItemId),
      sinSubir: suyos(apuntes, stockItemId).some((a) => a.donde !== 'arriba'),
    }))
    .filter((l) => l.unidades > 0)
}

/**
 * Una unidad más de ese artículo.
 *
 * Si hay un apunte suyo todavía en la cola, se le sube la cantidad en vez de
 * abrir otro: así una avería con cinco cables llega al servidor como un asiento
 * de cinco y no como cinco de uno, que es lo que se lee después en el histórico.
 */
export function planSumar(apuntes: ApunteDeMaterial[], stockItemId: string): Operacion[] {
  const edit = editable(apuntes, stockItemId)
  if (edit) return [{ tipo: 'editar', id: edit.id, qty: edit.qty - 1 }]
  return [{ tipo: 'consumo', unidades: 1 }]
}

/** Una unidad menos. Si era la última del apunte en cola, se borra entero. */
export function planRestar(apuntes: ApunteDeMaterial[], stockItemId: string): Operacion[] {
  if (unidadesUsadas(apuntes, stockItemId) <= 0) return []

  const edit = editable(apuntes, stockItemId)
  if (edit && edit.qty < 0) {
    return edit.qty === -1
      ? [{ tipo: 'borrar', id: edit.id }]
      : [{ tipo: 'editar', id: edit.id, qty: edit.qty + 1 }]
  }
  return [{ tipo: 'devolucion', unidades: 1 }]
}

/**
 * Quitar el artículo entero de la avería.
 *
 * Lo que no ha salido se borra —no ocurrió— y de lo que sí salió se devuelve
 * exactamente lo que quede gastado. Los dos a la vez, porque una línea puede
 * tener las dos mitades: dos cables que subieron esta mañana y un tercero
 * apuntado hace un minuto en un aula sin cobertura.
 */
export function planQuitar(apuntes: ApunteDeMaterial[], stockItemId: string): Operacion[] {
  const usadas = unidadesUsadas(apuntes, stockItemId)
  if (usadas <= 0) return []

  const enCola = suyos(apuntes, stockItemId).filter(
    (a) => a.kind === 'consumo' && a.donde === 'en_cola',
  )
  const ops: Operacion[] = enCola.map((a) => ({ tipo: 'borrar', id: a.id }))

  const seVanConLaCola = -enCola.reduce((n, a) => n + a.qty, 0)
  const quedan = usadas - seVanConLaCola
  if (quedan > 0) ops.push({ tipo: 'devolucion', unidades: quedan })

  return ops
}
