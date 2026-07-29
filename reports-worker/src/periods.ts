/**
 * Los periodos que cubre cada informe, en hora de Madrid.
 *
 * Vive aparte de `data.ts` a propósito. Son fechas puras: no tocan la base de
 * datos y no deben arrastrar `postgres` a quien solo quiera calcular un rango.
 * `scripts/worker-periodos.ts` los prueba desde la raíz del proyecto, donde esa
 * dependencia —declarada solo en `reports-worker/package.json`— no existe, y
 * bastaba el import para que `tsc -b` fallase con «Cannot find module
 * 'postgres'» en un clon limpio.
 */

/** La zona en la que trabaja el equipo. Los instantes se guardan en UTC. */
export const ZONA = 'Europe/Madrid'

/**
 * Rango de fechas de cada tipo de informe.
 *
 * `personalizado` no tiene rango propio: sus fechas llegan en la petición. Si
 * llega aquí es que no llegaron, y devolver calladamente el día de ayer produce
 * un PDF con datos que nadie ha pedido y una etiqueta que dice otra cosa.
 */
export function periodFor(kind: string, today = new Date()): { start: string; end: string } {
  if (kind === 'personalizado') {
    throw new Error('Un informe a medida necesita fecha de inicio y de fin')
  }

  /*
   * La fecha del calendario **de Madrid**, no la de UTC.
   *
   * `toISOString()` devuelve la fecha UTC: en verano, a partir de las 22:00 hora
   * peninsular ya es el día siguiente en UTC, así que «ayer» se corría un día y
   * el informe diario cubría el día equivocado.
   *
   * El truco del formato `sv-SE` es que su fecha corta ya es `AAAA-MM-DD`, así
   * que no hay que recomponerla a mano a partir de las partes.
   */
  const iso = (d: Date): string =>
    new Intl.DateTimeFormat('sv-SE', { timeZone: ZONA, dateStyle: 'short' }).format(d)

  // Restar días sobre el instante y formatear después en Madrid: así el cálculo
  // no depende de la hora local del proceso que ejecuta el worker.
  const menosDias = (d: Date, n: number): Date => new Date(d.getTime() - n * 86_400_000)

  if (kind === 'semanal') {
    return { start: iso(menosDias(today, 7)), end: iso(menosDias(today, 1)) }
  }

  // El informe diario cubre la jornada anterior: emitido a las 07:00, hablar
  // de "hoy" sería hablar de una hora de actividad.
  const ayer = iso(menosDias(today, 1))
  return { start: ayer, end: ayer }
}
