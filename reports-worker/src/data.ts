/**
 * Consultas del informe. Van directas a Postgres con el rol de servicio,
 * porque el worker no actúa en nombre de ningún usuario.
 *
 * Dos reglas que ordenan todo este fichero:
 *
 *  1. **Lo del periodo se mide en el periodo.** El informe anterior enseñaba el
 *     histórico acumulado por edificio en un documento titulado «semanal»: un
 *     gráfico que no se movía de una semana a la siguiente, porque contaba tres
 *     años de incidencias. Aquí cada cifra dice explícitamente si habla del
 *     periodo o de la situación a día de hoy.
 *  2. **Un número solo no informa.** Todo lo que se cuenta en el periodo se
 *     cuenta también en el tramo anterior de la misma duración, y el informe
 *     enseña las dos cifras. «18 revisiones» no es bueno ni malo hasta que se
 *     sabe que la semana pasada fueron 31.
 *
 * Los borradores no entran en ninguna cuenta. Todavía no se sabe qué son, y
 * contarlos como incidencias abiertas infla el número que más se mira.
 */

import postgres from 'postgres'
import {
  diasDelPeriodo,
  nombreComparacion,
  nombrePeriodo,
  periodoAnterior,
  type Periodo,
} from './periods.js'

/** Lo que se puede contar dentro de un periodo. Se calcula dos veces: ahora y antes. */
export interface Contadores {
  revisiones: number
  salasRevisadas: number
  registros: number
  incidencias: number
  solicitudes: number
  observaciones: number
  gravedadAlta: number
  resueltas: number
  materialConsumido: number
}

/** La foto de hoy. No depende del periodo y por eso se cuenta aparte. */
export interface Situacion {
  salasTotal: number
  incidenciasAbiertas: number
  estancadas: number
  lamparasAlLimite: number
  salasSinRevisarHace6Meses: number
  salasNuncaRevisadas: number
  articulosBajoMinimo: number
}

export interface ReportData {
  kind: string
  period: Periodo
  anterior: Periodo
  /** El periodo escrito para una portada: «del 27 al 31 de julio de 2026». */
  periodoTexto: string
  /** Cómo se llama el tramo con el que se compara: «la semana anterior». */
  comparacionTexto: string
  dias: number

  ahora: Contadores
  antes: Contadores
  situacion: Situacion

  serieDiaria: Array<{ dia: string; revisiones: number; abiertas: number; resueltas: number }>
  porEdificio: Array<{
    code: string
    name: string
    salas: number
    revisadas: number
    abiertas: number
    pendientes: number
  }>
  porTipo: Array<{ tipo: string; total: number }>
  porGravedad: Array<{ gravedad: string; total: number }>
  porMes: Array<{ month: string; total: number }>

  topSalas: Array<{
    building: string
    room: string
    name: string
    total: number
    fiabilidad: number | null
    hayDatos: boolean
  }>
  resolucion: {
    resueltas: number
    medianaDias: number | null
    mediaDias: number | null
    enMenosDe48h: number
  }
  lamparas: Array<{ building: string; room: string; horas: number | null; pct: number }>
  estancadas: Array<{
    ref: string | null
    titulo: string
    building: string
    room: string
    dias: number
    gravedad: string
  }>
  materiales: Array<{ name: string; unidad: string; consumido: number; incidencias: number }>
  reincidentes: Array<{ building: string; room: string; item: string; veces: number }>
  olvidadas: Array<{ building: string; room: string; dias: number | null }>
  equipo: Array<{ nombre: string; revisiones: number; registros: number }>

  /**
   * Cada revisión hecha en el periodo, con su sala, su hora y su resultado.
   *
   * Es el registro del trabajo, no un agregado: «31 revisiones» dice cuánto se
   * hizo y no dice qué se hizo. Un supervisor que quiere saber si se pasó por el
   * CRAI el martes necesita las filas, no el total.
   */
  revisiones: Array<{
    dia: string
    hora: string
    building: string
    room: string
    name: string
    quien: string | null
    resultado: string
    fallos: number
    aperturas: number
  }>
  /** Cuántas hubo en total, para decirlo cuando la tabla se corta. */
  revisionesTotal: number

  /** Todo lo demás que pasó, en orden: altas, cierres, material, inventarios, equipos. */
  eventos: Array<{
    dia: string
    hora: string
    tipo: string
    subtipo: string
    titulo: string
    detalle: string | null
    cantidad: number | null
    ref: string | null
    building: string
    room: string
    quien: string | null
  }>
  eventosTotal: number

  /** Registros del periodo cuya sala no se pudo identificar (el histórico importado los trae). */
  sinSala: number
}

/**
 * Tope de filas de las dos tablas largas.
 *
 * Una semana normal cabe entera. Un informe de un trimestre no, y ahí hay que
 * elegir entre cortar o imprimir cuarenta páginas de listado. Se corta, y se
 * dice cuántas se han quedado fuera: una tabla truncada en silencio se lee como
 * si eso fuera todo lo que pasó.
 */
const TOPE_FILAS = 150

/**
 * Los dos extremos del periodo como instantes.
 *
 * Los límites son medianoche DE MADRID, no de UTC. Comparar un `timestamptz`
 * con una cadena de fecha lo convierte usando la zona de la sesión, así que una
 * revisión de las 00:30 caía en el informe del día anterior. `inicio_del_dia`
 * lo hace explícito y aguanta el cambio de hora.
 *
 * Se devuelven los dos trozos por separado —y no la condición entera— porque el
 * nombre de la columna cambia en cada consulta y algunas van con alias de tabla.
 * Interpolar el identificador con `sql(campo)` habría hecho lo mismo con menos
 * texto, pero un ayudante de identificador al PRINCIPIO de un fragmento no
 * encuentra la palabra clave que le dice qué es y revienta al construir la
 * consulta. Escribir la columna a mano en cada sitio, además, la deja a la
 * vista de quien lea la consulta.
 */
function limites(sql: postgres.Sql, p: Periodo): { desde: postgres.Fragment; hasta: postgres.Fragment } {
  return {
    desde: sql`public.inicio_del_dia(${p.start}::date)`,
    hasta: sql`public.inicio_del_dia(${p.end}::date + 1)`,
  }
}

const num = (v: unknown): number => Number(v ?? 0)

async function contadores(sql: postgres.Sql, p: Periodo): Promise<Contadores> {
  const { desde, hasta } = limites(sql, p)
  const [c] = await sql<Array<Record<string, string>>>`
    select
      (select count(*) from inspections
         where status = 'completa' and occurred_at >= ${desde} and occurred_at < ${hasta})        as revisiones,
      (select count(distinct room_id) from inspections
         where status = 'completa' and occurred_at >= ${desde} and occurred_at < ${hasta})        as salas_revisadas,
      (select count(*) from incidents
         where state <> 'borrador' and opened_at >= ${desde} and opened_at < ${hasta})          as registros,
      (select count(*) from incidents
         where state <> 'borrador' and kind = 'incidencia'
           and opened_at >= ${desde} and opened_at < ${hasta})                                 as incidencias,
      (select count(*) from incidents
         where state <> 'borrador' and kind = 'solicitud'
           and opened_at >= ${desde} and opened_at < ${hasta})                                 as solicitudes,
      (select count(*) from incidents
         where state <> 'borrador' and kind = 'observacion'
           and opened_at >= ${desde} and opened_at < ${hasta})                                 as observaciones,
      (select count(*) from incidents
         where state <> 'borrador' and severity = 'alta'
           and opened_at >= ${desde} and opened_at < ${hasta})                                 as gravedad_alta,
      (select count(*) from incidents
         where state = 'resuelta' and resolved_at >= ${desde} and resolved_at < ${hasta})         as resueltas,
      (select coalesce(sum(-qty), 0) from stock_movements
         where kind = 'consumo' and occurred_at >= ${desde} and occurred_at < ${hasta})           as material_consumido
  `
  return {
    revisiones: num(c?.['revisiones']),
    salasRevisadas: num(c?.['salas_revisadas']),
    registros: num(c?.['registros']),
    incidencias: num(c?.['incidencias']),
    solicitudes: num(c?.['solicitudes']),
    observaciones: num(c?.['observaciones']),
    gravedadAlta: num(c?.['gravedad_alta']),
    resueltas: num(c?.['resueltas']),
    materialConsumido: num(c?.['material_consumido']),
  }
}

export async function loadReportData(
  sql: postgres.Sql,
  kind: string,
  periodStart: string,
  periodEnd: string,
): Promise<ReportData> {
  const period: Periodo = { start: periodStart, end: periodEnd }
  const anterior = periodoAnterior(period)
  const { desde, hasta } = limites(sql, period)

  const ahora = await contadores(sql, period)
  const antes = await contadores(sql, anterior)

  const [sit] = await sql<Array<Record<string, string>>>`
    select
      (select count(*) from rooms where active)                                    as salas_total,
      -- Fuera los borradores, y no solo las resueltas: un borrador es una nota a
      -- medias, y contarlo aquí infla justo el número que más se mira.
      (select count(*) from incidents
         where state not in ('resuelta', 'borrador'))                              as incidencias_abiertas,
      (select count(*) from incidents
         where state not in ('resuelta', 'borrador')
           and opened_at < now() - interval '7 days')                              as estancadas,
      (select count(*) from alerts_lamp_low)                                       as lamparas,
      (select count(*) from room_overview
         where last_inspection_at is not null
           and last_inspection_at < now() - interval '180 days')                   as sin_revisar,
      (select count(*) from room_overview where last_inspection_at is null)        as nunca_revisadas,
      (select count(*) from stock_levels where below_threshold)                    as bajo_minimo
  `

  /*
   * La serie diaria con `generate_series` y no con un bucle en Node: así el
   * gráfico tiene una barra por cada día del periodo, incluidos los que no
   * tuvieron actividad. Sin los días vacíos, una semana con dos jornadas de
   * trabajo se dibuja igual que una semana entera y el hueco no se ve.
   */
  const serieDiaria = await sql<
    Array<{ dia: string; revisiones: string; abiertas: string; resueltas: string }>
  >`
    with dias as (
      select generate_series(${period.start}::date, ${period.end}::date, interval '1 day')::date as dia
    ),
    rev as (
      select public.dia_local(occurred_at) as dia, count(*) as n
      from inspections
      where status = 'completa' and occurred_at >= ${desde} and occurred_at < ${hasta}
      group by 1
    ),
    abre as (
      select public.dia_local(opened_at) as dia, count(*) as n
      from incidents
      where state <> 'borrador' and opened_at >= ${desde} and opened_at < ${hasta}
      group by 1
    ),
    cierra as (
      select public.dia_local(resolved_at) as dia, count(*) as n
      from incidents
      where state = 'resuelta' and resolved_at >= ${desde} and resolved_at < ${hasta}
      group by 1
    )
    select to_char(d.dia, 'YYYY-MM-DD') as dia,
           coalesce(rev.n, 0) as revisiones,
           coalesce(abre.n, 0) as abiertas,
           coalesce(cierra.n, 0) as resueltas
    from dias d
    left join rev    on rev.dia = d.dia
    left join abre   on abre.dia = d.dia
    left join cierra on cierra.dia = d.dia
    order by d.dia
  `

  const porEdificio = await sql<
    Array<{ code: string; name: string; salas: string; revisadas: string; abiertas: string; pendientes: string }>
  >`
    with salas as (
      select b.id, b.code, b.name, count(r.id) as n
      from buildings b
      join zones z on z.building_id = b.id
      join rooms r on r.zone_id = z.id and r.active
      group by b.id, b.code, b.name
    ),
    revisadas as (
      select z.building_id as id, count(distinct i.room_id) as n
      from inspections i
      join rooms r on r.id = i.room_id
      join zones z on z.id = r.zone_id
      where i.status = 'completa' and i.occurred_at >= ${desde} and i.occurred_at < ${hasta}
      group by z.building_id
    ),
    abiertas as (
      select z.building_id as id, count(*) as n
      from incidents i
      join rooms r on r.id = i.room_id
      join zones z on z.id = r.zone_id
      where i.state <> 'borrador' and i.opened_at >= ${desde} and i.opened_at < ${hasta}
      group by z.building_id
    ),
    pendientes as (
      select z.building_id as id, count(*) as n
      from incidents i
      join rooms r on r.id = i.room_id
      join zones z on z.id = r.zone_id
      where i.state not in ('resuelta', 'borrador')
      group by z.building_id
    )
    select s.code, s.name, s.n as salas,
           coalesce(rv.n, 0) as revisadas,
           coalesce(ab.n, 0) as abiertas,
           coalesce(pe.n, 0) as pendientes
    from salas s
    left join revisadas  rv on rv.id = s.id
    left join abiertas   ab on ab.id = s.id
    left join pendientes pe on pe.id = s.id
    order by coalesce(ab.n, 0) desc, s.n desc
  `

  const porTipo = await sql<Array<{ tipo: string; total: string }>>`
    select kind::text as tipo, count(*) as total
    from incidents
    where state <> 'borrador' and opened_at >= ${desde} and opened_at < ${hasta}
    group by kind
    order by count(*) desc
  `

  const porGravedad = await sql<Array<{ gravedad: string; total: string }>>`
    select severity::text as gravedad, count(*) as total
    from incidents
    where state <> 'borrador' and kind = 'incidencia'
      and opened_at >= ${desde} and opened_at < ${hasta}
    group by severity
  `

  const porMes = await sql<Array<{ month: string; total: string }>>`
    select month, total from incidents_by_month order by month desc limit 12
  `

  const topSalas = await sql<
    Array<{ building: string; room: string; name: string; total: string; fiabilidad: string | null; hay_datos: boolean }>
  >`
    select ro.building_code as building, ro.room_code as room, ro.room_name as name,
           count(*) as total, rr.score as fiabilidad, coalesce(rr.hay_datos, false) as hay_datos
    from incidents i
    join room_overview ro on ro.room_id = i.room_id
    left join room_reliability rr on rr.room_id = i.room_id
    where i.state <> 'borrador' and i.kind = 'incidencia'
      and i.opened_at >= ${desde} and i.opened_at < ${hasta}
    group by ro.building_code, ro.room_code, ro.room_name, rr.score, rr.hay_datos
    order by count(*) desc, ro.building_code, ro.room_code
    limit 8
  `

  const [res] = await sql<Array<Record<string, string | null>>>`
    select
      count(*) as resueltas,
      -- La mediana y no solo la media: dos incidencias del histórico abiertas
      -- hace un año arrastran la media a semanas y esconden que el trabajo del
      -- día se cierra en horas. Van las dos, y la mediana primero.
      percentile_cont(0.5) within group (
        order by extract(epoch from (resolved_at - opened_at)) / 86400
      ) as mediana,
      avg(extract(epoch from (resolved_at - opened_at)) / 86400) as media,
      count(*) filter (where resolved_at - opened_at <= interval '48 hours') as rapidas
    from incidents
    where state = 'resuelta' and resolved_at >= ${desde} and resolved_at < ${hasta}
  `

  const lamparas = await sql<
    Array<{ building: string; room: string; horas: string | null; pct: string }>
  >`
    select building_code as building, room_code as room,
           projector_hours as horas, lamp_pct as pct
    from alerts_lamp_low order by lamp_pct asc limit 12
  `

  /*
   * Las estancadas se consultan aquí y no con `alerts_stale_incidents`, que
   * filtra por `state <> 'resuelta'` y por tanto arrastra borradores. En un
   * panel se disimula; en un informe firmado, una nota a medias listada como
   * «47 días abierta» es una acusación falsa.
   */
  const estancadas = await sql<
    Array<{ ref: string | null; titulo: string; building: string; room: string; dias: string; gravedad: string }>
  >`
    select i.external_ref as ref,
           i.title as titulo,
           coalesce(ro.building_code, '—') as building,
           coalesce(ro.room_code, '') as room,
           extract(day from now() - i.opened_at)::int as dias,
           i.severity::text as gravedad
    from incidents i
    left join room_overview ro on ro.room_id = i.room_id
    where i.state not in ('resuelta', 'borrador')
      and i.opened_at < now() - interval '7 days'
    order by i.opened_at asc
    limit 12
  `

  const materiales = await sql<
    Array<{ name: string; unidad: string; consumido: string; incidencias: string }>
  >`
    select si.name, si.unit as unidad,
           sum(-sm.qty) as consumido,
           count(distinct sm.incident_id) as incidencias
    from stock_movements sm
    join stock_items si on si.id = sm.stock_item_id
    where sm.kind = 'consumo' and sm.occurred_at >= ${desde} and sm.occurred_at < ${hasta}
    group by si.name, si.unit
    order by sum(-sm.qty) desc
    limit 10
  `

  const reincidentes = await sql<
    Array<{ building: string; room: string; item: string; veces: string }>
  >`
    select ro.building_code as building, ro.room_code as room, rro.item, rro.veces
    from room_repeat_offenders rro
    join room_overview ro on ro.room_id = rro.room_id
    order by rro.veces desc
    limit 6
  `

  const olvidadas = await sql<Array<{ building: string; room: string; dias: string | null }>>`
    select building_code as building, room_code as room, days_since as dias
    from alerts_overdue_rooms
    order by days_since desc nulls first
    limit 10
  `

  /*
   * Actividad del equipo. Va con nombre porque el informe es interno y quien lo
   * lee ya sabe quién está de turno; lo que NO sale de aquí es hacia la IA, que
   * recibe estas filas sin nombres (ver `ia.ts`). No es un ranking: un técnico
   * con seis revisiones y otro con dos pueden haber trabajado lo mismo si el
   * segundo ha estado desmontando una botonera toda la tarde.
   */
  const equipo = await sql<Array<{ nombre: string; revisiones: string; registros: string }>>`
    with rev as (
      select by_user, count(*) as n from inspections
      where status = 'completa' and by_user is not null and occurred_at >= ${desde} and occurred_at < ${hasta}
      group by by_user
    ),
    reg as (
      select opened_by as by_user, count(*) as n from incidents
      where state <> 'borrador' and opened_by is not null and opened_at >= ${desde} and opened_at < ${hasta}
      group by opened_by
    )
    select p.full_name as nombre,
           coalesce(rev.n, 0) as revisiones,
           coalesce(reg.n, 0) as registros
    from profiles p
    left join rev on rev.by_user = p.id
    left join reg on reg.by_user = p.id
    where coalesce(rev.n, 0) + coalesce(reg.n, 0) > 0
    order by coalesce(rev.n, 0) + coalesce(reg.n, 0) desc
    limit 12
  `

  /*
   * LAS REVISIONES, UNA A UNA.
   *
   * `fallos` son las comprobaciones que salieron mal dentro de la revisión y
   * `aperturas` los registros que nacieron de ella. No son lo mismo y la
   * diferencia importa: tres comprobaciones malas que se arreglaron ahí mismo
   * dejan la sala en «con incidencias» sin abrir nada, y eso es trabajo hecho,
   * no trabajo pendiente.
   */
  const revisiones = await sql<
    Array<{
      dia: string
      hora: string
      building: string
      room: string
      name: string
      quien: string | null
      resultado: string
      fallos: string
      aperturas: string
    }>
  >`
    select
      to_char(public.dia_local(ins.occurred_at), 'YYYY-MM-DD')                as dia,
      to_char(ins.occurred_at at time zone 'Europe/Madrid', 'HH24:MI')        as hora,
      ro.building_code as building, ro.room_code as room, ro.room_name as name,
      p.full_name as quien,
      coalesce(ins.overall::text, 'ok') as resultado,
      (select count(*) from inspection_checks c
        where c.inspection_id = ins.id and c.result = 'incidencia')           as fallos,
      (select count(*) from incidents i
        where i.opened_from_inspection_id = ins.id and i.state <> 'borrador') as aperturas
    from inspections ins
    join room_overview ro on ro.room_id = ins.room_id
    left join profiles p on p.id = ins.by_user
    where ins.status = 'completa'
      and ins.occurred_at >= ${desde} and ins.occurred_at < ${hasta}
    order by ins.occurred_at
    limit ${TOPE_FILAS}
  `

  /*
   * EL DIARIO.
   *
   * Se arma aquí y no se lee de `room_timeline`, que ya une casi lo mismo, por
   * dos motivos. El primero es que esa vista exige sala —hace `join rooms`— y
   * deja fuera precisamente los registros huérfanos del histórico, que también
   * pasaron. El segundo es que en ella una apertura y un cierre solo se
   * distinguen por si el título empieza por «Resuelta:», y de una cadena de
   * texto no se cuelga la lectura de un informe.
   *
   * Las revisiones no entran: tienen su propia tabla y su recuento en la
   * cabecera de cada día. Repetirlas aquí llenaría el diario de una sola cosa.
   */
  const eventos = await sql<
    Array<{
      dia: string
      hora: string
      tipo: string
      subtipo: string
      titulo: string
      detalle: string | null
      cantidad: string | null
      ref: string | null
      building: string | null
      room: string | null
      quien: string | null
    }>
  >`
    with e as (
      select 'apertura' as tipo, i.kind::text as subtipo, i.opened_at as at,
             coalesce(i.title, '(sin describir)') as titulo,
             nullif(i.description, '') as detalle, null::int as cantidad,
             i.external_ref as ref, i.room_id, i.opened_by as by_user
      from incidents i
      where i.state <> 'borrador'
        and i.opened_at >= ${desde} and i.opened_at < ${hasta}

      union all

      select 'cierre', i.kind::text, i.resolved_at,
             coalesce(i.title, '(sin describir)'),
             nullif(i.resolution, ''), null::int,
             i.external_ref, i.room_id, i.resolved_by
      from incidents i
      where i.state = 'resuelta'
        and i.resolved_at >= ${desde} and i.resolved_at < ${hasta}

      union all

      select 'material', sm.kind::text, sm.occurred_at,
             si.name, nullif(sm.note, ''), sm.qty,
             null, sm.room_id, sm.by_user
      from stock_movements sm
      join stock_items si on si.id = sm.stock_item_id
      where sm.occurred_at >= ${desde} and sm.occurred_at < ${hasta}

      union all

      select 'inventario', 'levantamiento', v.occurred_at,
             'Inventario confirmado',
             coalesce(nullif(v.note, ''), v.asset_count || ' equipos en la sala'), null::int,
             null, v.room_id, v.by_user
      from room_inventories v
      where v.occurred_at >= ${desde} and v.occurred_at < ${hasta}

      union all

      select 'equipo', ae.kind::text, ae.occurred_at,
             coalesce(a.label, t.name, 'Equipo'),
             nullif(ae.meta ->> 'nota', ''), null::int,
             a.serial, coalesce(ae.room_id, a.room_id), ae.by_user
      from asset_events ae
      join assets a on a.id = ae.asset_id
      left join asset_types t on t.id = a.asset_type_id
      where ae.occurred_at >= ${desde} and ae.occurred_at < ${hasta}
    )
    select
      to_char(public.dia_local(e.at), 'YYYY-MM-DD')                  as dia,
      to_char(e.at at time zone 'Europe/Madrid', 'HH24:MI')          as hora,
      e.tipo, e.subtipo, e.titulo, e.detalle, e.cantidad, e.ref,
      ro.building_code as building, ro.room_code as room,
      p.full_name as quien
    from e
    left join room_overview ro on ro.room_id = e.room_id
    left join profiles p on p.id = e.by_user
    order by e.at
    limit ${TOPE_FILAS}
  `

  const [totales] = await sql<Array<{ revisiones: string; eventos: string }>>`
    select
      (select count(*) from inspections
        where status = 'completa'
          and occurred_at >= ${desde} and occurred_at < ${hasta})                     as revisiones,
      (select count(*) from incidents
        where state <> 'borrador' and opened_at >= ${desde} and opened_at < ${hasta})
      + (select count(*) from incidents
        where state = 'resuelta' and resolved_at >= ${desde} and resolved_at < ${hasta})
      + (select count(*) from stock_movements
        where occurred_at >= ${desde} and occurred_at < ${hasta})
      + (select count(*) from room_inventories
        where occurred_at >= ${desde} and occurred_at < ${hasta})
      + (select count(*) from asset_events
        where occurred_at >= ${desde} and occurred_at < ${hasta})                     as eventos
  `

  const [sinSala] = await sql<Array<{ total: string }>>`
    select count(*) as total from incidents
    where room_id is null and state <> 'borrador' and opened_at >= ${desde} and opened_at < ${hasta}
  `

  const redondea = (v: string | null | undefined): number | null =>
    v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10

  return {
    kind,
    period,
    anterior,
    periodoTexto: nombrePeriodo(period),
    comparacionTexto: nombreComparacion(period),
    dias: diasDelPeriodo(period),
    ahora,
    antes,
    situacion: {
      salasTotal: num(sit?.['salas_total']),
      incidenciasAbiertas: num(sit?.['incidencias_abiertas']),
      estancadas: num(sit?.['estancadas']),
      lamparasAlLimite: num(sit?.['lamparas']),
      salasSinRevisarHace6Meses: num(sit?.['sin_revisar']),
      salasNuncaRevisadas: num(sit?.['nunca_revisadas']),
      articulosBajoMinimo: num(sit?.['bajo_minimo']),
    },
    serieDiaria: serieDiaria.map((r) => ({
      dia: r.dia,
      revisiones: num(r.revisiones),
      abiertas: num(r.abiertas),
      resueltas: num(r.resueltas),
    })),
    porEdificio: porEdificio.map((r) => ({
      code: r.code,
      name: r.name,
      salas: num(r.salas),
      revisadas: num(r.revisadas),
      abiertas: num(r.abiertas),
      pendientes: num(r.pendientes),
    })),
    porTipo: porTipo.map((r) => ({ tipo: r.tipo, total: num(r.total) })),
    porGravedad: porGravedad.map((r) => ({ gravedad: r.gravedad, total: num(r.total) })),
    porMes: [...porMes].reverse().map((r) => ({ month: r.month, total: num(r.total) })),
    topSalas: topSalas.map((r) => ({
      building: r.building,
      room: r.room,
      name: r.name,
      total: num(r.total),
      fiabilidad: r.fiabilidad === null ? null : num(r.fiabilidad),
      hayDatos: r.hay_datos,
    })),
    resolucion: {
      resueltas: num(res?.['resueltas']),
      medianaDias: redondea(res?.['mediana']),
      mediaDias: redondea(res?.['media']),
      enMenosDe48h: num(res?.['rapidas']),
    },
    lamparas: lamparas.map((r) => ({
      building: r.building,
      room: r.room,
      horas: r.horas === null ? null : num(r.horas),
      pct: num(r.pct),
    })),
    estancadas: estancadas.map((r) => ({
      ref: r.ref,
      titulo: r.titulo,
      building: r.building,
      room: r.room,
      dias: num(r.dias),
      gravedad: r.gravedad,
    })),
    materiales: materiales.map((r) => ({
      name: r.name,
      unidad: r.unidad,
      consumido: num(r.consumido),
      incidencias: num(r.incidencias),
    })),
    reincidentes: reincidentes.map((r) => ({
      building: r.building,
      room: r.room,
      item: r.item,
      veces: num(r.veces),
    })),
    olvidadas: olvidadas.map((r) => ({
      building: r.building,
      room: r.room,
      dias: r.dias === null ? null : num(r.dias),
    })),
    equipo: equipo.map((r) => ({
      nombre: r.nombre,
      revisiones: num(r.revisiones),
      registros: num(r.registros),
    })),
    revisiones: revisiones.map((r) => ({
      dia: r.dia,
      hora: r.hora,
      building: r.building,
      room: r.room,
      name: r.name,
      quien: r.quien,
      resultado: r.resultado,
      fallos: num(r.fallos),
      aperturas: num(r.aperturas),
    })),
    revisionesTotal: num(totales?.revisiones),
    eventos: eventos.map((e) => ({
      dia: e.dia,
      hora: e.hora,
      tipo: e.tipo,
      subtipo: e.subtipo,
      titulo: e.titulo,
      detalle: e.detalle,
      cantidad: e.cantidad === null ? null : num(e.cantidad),
      ref: e.ref,
      building: e.building ?? '—',
      room: e.room ?? '',
      quien: e.quien,
    })),
    eventosTotal: num(totales?.eventos),
    sinSala: num(sinSala?.total),
  }
}
