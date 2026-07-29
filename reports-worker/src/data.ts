/**
 * Consultas del informe. Van directas a Postgres con el rol de servicio,
 * porque el worker no actúa en nombre de ningún usuario.
 */

import postgres from 'postgres'

export interface ReportData {
  kind: string
  periodStart: string
  periodEnd: string
  summary: {
    roomsTotal: number
    inspections: number
    roomsInspected: number
    incidentsOpened: number
    incidentsResolved: number
    incidentsOpen: number
    lampAlerts: number
    staleIncidents: number
  }
  byBuilding: Array<{ code: string; total: number }>
  /** Incidencias del histórico cuya sala no se pudo identificar al importar. */
  unassignedIncidents: number
  byMonth: Array<{ month: string; total: number }>
  lampRows: Array<{ building: string; room: string; hours: number | null; pct: number }>
  staleRows: Array<{ ref: string | null; title: string; building: string; days: number }>
  topMaterials: Array<{ name: string; consumed: number }>
}

export async function loadReportData(
  sql: postgres.Sql,
  kind: string,
  periodStart: string,
  periodEnd: string,
): Promise<ReportData> {
  const [counts] = await sql<
    Array<{
      rooms_total: number
      inspections: number
      rooms_inspected: number
      incidents_opened: number
      incidents_resolved: number
      incidents_open: number
      lamp_alerts: number
      stale_incidents: number
    }>
  >`
    select
      (select count(*) from rooms where active)                                  as rooms_total,
      -- Los límites del periodo son medianoche DE MADRID, no de UTC. Comparar
      -- un timestamptz con una cadena de fecha lo convertía usando la zona de
      -- la sesión, así que una revisión de las 00:30 caía en el informe del día
      -- anterior. inicio_del_dia lo hace explícito y aguanta el cambio de hora.
      (select count(*) from inspections
         where status = 'completa'
           and occurred_at >= public.inicio_del_dia(${periodStart}::date)
           and occurred_at <  public.inicio_del_dia(${periodEnd}::date + 1))
                                                                                 as inspections,
      (select count(distinct room_id) from inspections
         where status = 'completa'
           and occurred_at >= public.inicio_del_dia(${periodStart}::date)
           and occurred_at <  public.inicio_del_dia(${periodEnd}::date + 1))
                                                                                 as rooms_inspected,
      (select count(*) from incidents
         where opened_at >= public.inicio_del_dia(${periodStart}::date)
           and opened_at <  public.inicio_del_dia(${periodEnd}::date + 1))
                                                                                 as incidents_opened,
      (select count(*) from incidents
         where resolved_at >= public.inicio_del_dia(${periodStart}::date)
           and resolved_at <  public.inicio_del_dia(${periodEnd}::date + 1))
                                                                                 as incidents_resolved,
      (select count(*) from incidents where state <> 'resuelta')                 as incidents_open,
      (select count(*) from alerts_lamp_low)                                     as lamp_alerts,
      (select count(*) from alerts_stale_incidents)                              as stale_incidents
  `

  const byBuilding = await sql<Array<{ code: string; total: number }>>`
    select code, total from incidents_by_building order by total desc limit 10
  `
  const byMonth = await sql<Array<{ month: string; total: number }>>`
    select month, total from incidents_by_month order by month desc limit 12
  `
  const lampRows = await sql<
    Array<{ building: string; room: string; hours: number | null; pct: number }>
  >`
    select building_code as building, room_code as room,
           projector_hours as hours, lamp_pct as pct
    from alerts_lamp_low order by lamp_pct asc limit 20
  `
  const staleRows = await sql<
    Array<{ ref: string | null; title: string; building: string; days: number }>
  >`
    select i.external_ref as ref, a.title,
           coalesce(a.building_code, '—') as building, a.days_open as days
    from alerts_stale_incidents a
    join incidents i on i.id = a.id
    order by a.days_open desc limit 20
  `
  const topMaterials = await sql<Array<{ name: string; consumed: number }>>`
    select name, consumed from material_consumption_ranking limit 10
  `

  return {
    kind,
    periodStart,
    periodEnd,
    summary: {
      roomsTotal: Number(counts?.rooms_total ?? 0),
      inspections: Number(counts?.inspections ?? 0),
      roomsInspected: Number(counts?.rooms_inspected ?? 0),
      incidentsOpened: Number(counts?.incidents_opened ?? 0),
      incidentsResolved: Number(counts?.incidents_resolved ?? 0),
      incidentsOpen: Number(counts?.incidents_open ?? 0),
      lampAlerts: Number(counts?.lamp_alerts ?? 0),
      staleIncidents: Number(counts?.stale_incidents ?? 0),
    },
    // El cubo sin edificio sale del gráfico: con 118 incidencias sin sala
    // identificada eclipsaba a todos los edificios reales y hacía ilegible la
    // comparación. El número no se esconde, se cuenta aparte en el pie.
    byBuilding: byBuilding
      .filter((r) => r.code !== '—')
      .map((r) => ({ code: r.code, total: Number(r.total) })),
    unassignedIncidents: Number(byBuilding.find((r) => r.code === '—')?.total ?? 0),
    byMonth: [...byMonth].reverse().map((r) => ({ month: r.month, total: Number(r.total) })),
    lampRows: lampRows.map((r) => ({ ...r, pct: Number(r.pct), hours: r.hours ? Number(r.hours) : null })),
    staleRows: staleRows.map((r) => ({ ...r, days: Number(r.days) })),
    topMaterials: topMaterials.map((r) => ({ name: r.name, consumed: Number(r.consumed) })),
  }
}

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
