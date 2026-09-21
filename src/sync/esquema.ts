/**
 * Cuando el servidor va por detrás de la aplicación.
 *
 * La aplicación se despliega con su base, pero no siempre a la vez: un
 * despliegue del front sin la migración que le toca, un registro de migraciones
 * que anota como aplicada una que no corrió, o una API que no recargó su caché
 * del esquema. Desde el aula se ve siempre igual: la cola manda una fila con
 * una columna nueva y PostgREST contesta 400 con «Could not find the 'x' column
 * of 'tabla' in the schema cache» (PGRST204). No es un rechazo del contenido
 * —el técnico no ha hecho nada mal— y tratarlo como un 4xx permanente dejaba el
 * cierre de una avería en rojo, «avisa a administración», para siempre: pasó el
 * 21 de septiembre con `easyvista_ref` en `incident_resolutions`.
 *
 * Aquí se reconoce ese fallo y se dice qué columna falta. Lo que se hace con
 * ello está en `outbox.ts`: si la columna va vacía se reintenta sin ella, y si
 * lleva dato se espera —con el motivo a la vista— a que la base se migre.
 */

export interface FalloDelServidor {
  message: string
  status?: number
  code?: string
}

/** PostgREST no conoce una columna que la fila trae: a la base le falta una migración. */
export function servidorPorDetras(fallo: FalloDelServidor): boolean {
  return fallo.code === 'PGRST204' || /in the schema cache/i.test(fallo.message)
}

/** La columna que el servidor no conoce, si el mensaje la nombra. */
export function columnaQueFalta(mensaje: string): string | null {
  const m = /Could not find the '([^']+)' column/i.exec(mensaje)
  return m?.[1] ?? null
}

/** Con qué se explica en la lámpara: qué pasa y a quién le toca. */
export function motivoDeServidorPorDetras(fallo: FalloDelServidor): string {
  const columna = columnaQueFalta(fallo.message)
  const que = columna ? `no conoce la columna «${columna}»` : 'no conoce algo que la aplicación le manda'
  return `El servidor va por detrás de la aplicación: ${que}. Le falta una migración; avisa a administración. (${fallo.message})`
}

/** La misma fila sin esa columna: lo que se manda cuando la columna iba vacía. */
export function sinLaColumna(fila: Record<string, unknown>, columna: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fila).filter(([k]) => k !== columna))
}
