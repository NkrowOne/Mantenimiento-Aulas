-- =============================================================================
-- La insignia de «incidencias abiertas» deja de contar observaciones
--
-- `room_overview.open_incidents` es el número que la lista de salas pinta al
-- lado de cada aula, y baja al dispositivo con el espejo. Contaba todo lo no
-- resuelto menos los borradores — observaciones incluidas. Y las observaciones
-- importadas del Excel llevan «abiertas» desde 2025 por definición: son notas
-- de seguimiento («el mando aparece en el cajón») que nadie tiene que cerrar,
-- así que un aula bien atendida y muy anotada salía en la lista con un «3»
-- naranja eterno.
--
-- La pestaña de Incidencias ya las excluye —es la lista de lo que hay que
-- arreglar— y `alerts_stale_incidents` también, desde `20260730000700`. La
-- insignia era el único recuento que seguía contándolas, y un número que no
-- cuadra con la lista que se abre al pulsarlo enseña a no fiarse de ninguno
-- de los dos.
--
-- Las solicitudes SÍ siguen contando: «instalar una cámara» es trabajo
-- pendiente de verdad, y está en la pestaña.
--
-- La vista se reescribe entera porque una vista no se parchea por trozos; todo
-- lo demás queda exactamente como en `20260730000700`.
-- =============================================================================

create or replace view room_overview as
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
  coalesce(oi.open_count, 0)::int as open_incidents,
  r.short_ref,
  lv.occurred_at      as last_inventory_at
from rooms r
join zones z     on z.id = r.zone_id
join buildings b on b.id = z.building_id
left join lateral (
  select i.occurred_at, i.overall
  from inspections_vigentes i
  where i.room_id = r.id
  order by i.occurred_at desc, i.corrected_at desc nulls first
  limit 1
) li on true
left join lateral (
  select v.occurred_at
  from room_inventories v
  where v.room_id = r.id
  order by v.occurred_at desc
  limit 1
) lv on true
left join lateral (
  select count(*) as open_count
  from incidents inc
  where inc.room_id = r.id
    and inc.state not in ('resuelta', 'borrador')
    and inc.kind <> 'observacion'
) oi on true
where r.active;

alter view room_overview set (security_invoker = on);

comment on view room_overview is
  'Las salas activas con su contexto. open_incidents cuenta averías y solicitudes vivas: ni borradores ni observaciones, igual que la pestaña de Incidencias.';

notify pgrst, 'reload schema';
