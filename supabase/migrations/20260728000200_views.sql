-- =============================================================================
-- Claves diferidas, vistas derivadas y alertas
--
-- Todo lo que en el Excel es un número tecleado a mano, aquí es una consulta.
-- Por eso no puede volver a haber stock negativo por descuido.
-- =============================================================================

-- Se declaran ahora porque `incidents` e `inspections` se crean después de
-- `stock_movements` en el fichero anterior.
alter table stock_movements
  add constraint stock_movements_incident_fk
    foreign key (incident_id) references incidents(id) on delete set null,
  add constraint stock_movements_inspection_fk
    foreign key (inspection_id) references inspections(id) on delete set null;

-- -----------------------------------------------------------------------------
-- Existencias actuales
-- -----------------------------------------------------------------------------
create view stock_levels as
select
  si.id                                    as stock_item_id,
  si.name,
  si.unit,
  si.min_threshold,
  coalesce(sum(sm.qty), 0)::int            as on_hand,
  coalesce(sum(sm.qty) filter (where sm.kind = 'consumo'), 0)::int * -1 as total_consumed,
  coalesce(sum(sm.qty) filter (where sm.kind = 'compra'), 0)::int       as total_purchased,
  -- Solo alerta si alguien fijó un mínimo de verdad. Con `>= 0` por defecto,
  -- los 68 artículos que solo aparecen citados en el histórico (saldo 0, umbral
  -- sin configurar) llenaban el panel de avisos falsos.
  si.min_threshold > 0 and coalesce(sum(sm.qty), 0) <= si.min_threshold as below_threshold
from stock_items si
left join stock_movements sm on sm.stock_item_id = si.id
where si.active
group by si.id, si.name, si.unit, si.min_threshold;

-- Consumo por mes y artículo: reemplaza las doce columnas Enero..Diciembre
-- de la hoja Bolsa, que había que rellenar a mano.
create view stock_monthly_consumption as
select
  sm.stock_item_id,
  si.name,
  date_trunc('month', sm.occurred_at)::date as month,
  sum(-sm.qty)::int                          as consumed
from stock_movements sm
join stock_items si on si.id = sm.stock_item_id
where sm.kind = 'consumo'
group by sm.stock_item_id, si.name, date_trunc('month', sm.occurred_at);

-- -----------------------------------------------------------------------------
-- Salas con su contexto: es la consulta que alimenta la lista de revisión
-- -----------------------------------------------------------------------------
create view room_overview as
select
  r.id                as room_id,
  r.code              as room_code,
  r.name              as room_name,
  r.kind,
  r.capabilities,
  r.projector_hours,
  r.lamp_pct,
  z.id                as zone_id,
  z.name              as zone_name,
  b.id                as building_id,
  b.code              as building_code,
  b.name              as building_name,
  b.sort_order        as building_order,
  z.sort_order        as zone_order,
  li.occurred_at      as last_inspection_at,
  li.overall          as last_inspection_overall,
  coalesce(oi.open_count, 0)::int as open_incidents
from rooms r
join zones z     on z.id = r.zone_id
join buildings b on b.id = z.building_id
left join lateral (
  select i.occurred_at, i.overall
  from inspections i
  where i.room_id = r.id and i.status = 'completa'
  order by i.occurred_at desc
  limit 1
) li on true
left join lateral (
  select count(*) as open_count
  from incidents inc
  where inc.room_id = r.id and inc.state <> 'resuelta'
) oi on true
where r.active;

-- -----------------------------------------------------------------------------
-- Alertas — cada una responde a un problema real observado en vuestros datos
-- -----------------------------------------------------------------------------
create view alerts_lamp_low as
select room_id, building_code, room_code, room_name, lamp_pct, projector_hours
from room_overview
where lamp_pct is not null and lamp_pct < 0.20
order by lamp_pct asc;

create view alerts_stale_incidents as
select
  i.id, i.title, i.severity, i.opened_at, i.state,
  ro.building_code, ro.room_code, ro.room_name,
  extract(day from now() - i.opened_at)::int as days_open
from incidents i
left join room_overview ro on ro.room_id = i.room_id
where i.state <> 'resuelta'
  and i.opened_at < now() - interval '7 days'
order by i.opened_at asc;

create view alerts_overdue_rooms as
select room_id, building_code, room_code, room_name, last_inspection_at,
       extract(day from now() - last_inspection_at)::int as days_since
from room_overview
where last_inspection_at is null
   or last_inspection_at < now() - interval '180 days'
order by last_inspection_at asc nulls first;

-- Salas que fallan de forma repetida: dos revisiones seguidas con incidencia.
-- Es el patrón que delata un problema de fondo, no una avería puntual.
create view alerts_repeat_offenders as
with ranked as (
  select
    i.room_id,
    i.overall,
    row_number() over (partition by i.room_id order by i.occurred_at desc) as rn
  from inspections i
  where i.status = 'completa'
)
select ro.room_id, ro.building_code, ro.room_code, ro.room_name
from ranked r1
join ranked r2 on r2.room_id = r1.room_id and r2.rn = 2
join room_overview ro on ro.room_id = r1.room_id
where r1.rn = 1
  and r1.overall = 'con_incidencias'
  and r2.overall = 'con_incidencias';
