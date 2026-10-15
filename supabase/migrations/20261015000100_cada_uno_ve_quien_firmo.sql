-- =============================================================================
-- Cada uno ve quién firmó
--
-- Un técnico abría en el móvil la ficha de un aula que había revisado un
-- compañero y no encontraba su revisión: estaba, pero ponía «Sin firma». Y en el
-- Historial ni eso. El nombre no se perdía al guardar —`by_user` está en cada
-- fila—, se perdía al leer.
--
-- La causa es la política de `profiles` (`20260728000300_auth_rls.sql`): un
-- técnico solo ve SU perfil. Las vistas que ponen nombre a las cosas
-- —`room_inspections` y `room_timeline`— son `security_invoker`, así que el
-- `left join profiles` corre con esa misma política y, para un técnico, el
-- nombre de cualquier otro sale nulo. Un supervisor sí lo veía todo, y por eso
-- desde el panel nadie lo notó.
--
-- No se abre `profiles`. Lleva el correo y el rol, y para saber quién firmó una
-- revisión basta el nombre. Se abre solo eso, con una función que devuelve
-- `(id, full_name)` al personal y nada a nadie más. Las dos vistas se
-- reescriben enteras —una vista no se parchea por trozos— copiadas sin un
-- cambio de `20260730000700_corregir_revisiones.sql` salvo la línea del `join`.
--
-- La misma función la usa la aplicación para el directorio de nombres que baja
-- al dispositivo: las incidencias se leen del espejo y solo traen `opened_by`,
-- un uuid que sin esto no se puede traducir a una persona.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — Los nombres del personal
--
-- `security definer` para saltarse la política de `profiles`, y por eso mismo
-- la comprobación va dentro: sin `is_staff()` cualquier sesión, incluida una sin
-- rol, leería la plantilla entera.
-- -----------------------------------------------------------------------------

create or replace function public.nombres_del_personal()
returns table (id uuid, full_name text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.full_name
  from profiles p
  where (select public.is_staff())
$$;

comment on function public.nombres_del_personal() is
  'Quién es quién: id y nombre de cada perfil, solo para el personal. Lo que las vistas necesitan para firmar una fila sin abrir el correo ni el rol de profiles.';

revoke all on function public.nombres_del_personal() from public, anon;
grant execute on function public.nombres_del_personal() to authenticated;

-- -----------------------------------------------------------------------------
-- 2 — Las revisiones de una sala, con la firma de quien las hizo
-- -----------------------------------------------------------------------------

create or replace view room_inspections as
select
  i.id,
  i.room_id,
  i.occurred_at,
  i.recorded_at,
  i.overall::text                     as overall,
  i.notes,
  i.by_user,
  p.full_name                         as who,
  i.corrects,
  i.corrected_at,
  -- De qué fecha era la visita que corrige. La corrección conserva
  -- `occurred_at`, así que coinciden salvo que alguien corrigiera también el día.
  base.occurred_at                    as corrige_occurred_at,
  sig.id                              as corregida_por,
  sig.corrected_at                    as corregida_at,
  sp.full_name                        as corregida_por_quien,
  (sig.id is null)                    as vigente,
  coalesce(k.total, 0)                as comprobaciones,
  coalesce(k.fallos, 0)               as fallos,
  coalesce(k.no_aplica, 0)            as no_aplica,
  coalesce(f.fotos, 0)                as fotos,
  coalesce(inc.abiertas, 0)           as incidencias
from inspections i
left join public.nombres_del_personal() p on p.id = i.by_user
left join inspections base on base.id = i.corrects
left join lateral (
  select c.id, c.corrected_at, c.by_user
  from inspections c
  where c.corrects = i.id and c.status = 'completa'
  order by c.corrected_at desc nulls last
  limit 1
) sig on true
left join public.nombres_del_personal() sp on sp.id = sig.by_user
left join lateral (
  select
    count(*)::int                                            as total,
    count(*) filter (where c.result = 'incidencia')::int     as fallos,
    count(*) filter (where c.result = 'na')::int             as no_aplica
  from inspection_checks c
  where c.inspection_id = i.id
) k on true
left join lateral (
  select count(*)::int as fotos
  from attachments a
  where a.entity_type = 'inspection' and a.entity_id = i.id
) f on true
left join lateral (
  select count(*)::int as abiertas
  from incidents x
  where x.opened_from_inspection_id = i.id and x.state <> 'borrador'
) inc on true
where i.status = 'completa';

alter view room_inspections set (security_invoker = on);

-- -----------------------------------------------------------------------------
-- 3 — Y la línea de tiempo, que es lo que enseña el Historial
-- -----------------------------------------------------------------------------

create or replace view room_timeline as
with eventos as (

-- Incidencias, solicitudes y observaciones: la apertura --------------------
select
  i.id                                  as ref_id,
  case i.kind
    when 'solicitud'   then 'solicitud'
    when 'observacion' then 'observacion'
    else 'incidencia'
  end                                   as kind,
  i.state::text                         as subkind,
  i.room_id,
  i.opened_at                           as at,
  coalesce(i.title, '(sin describir)')  as title,
  nullif(i.description, '')             as detail,
  null::int                             as qty,
  i.opened_by                           as by_user,
  i.external_ref                        as ref,
  i.state::text                         as state
from incidents i

union all

-- …y el cierre, como fila propia.
select
  i.id,
  'incidencia',
  'resuelta',
  i.room_id,
  i.resolved_at,
  'Resuelta: ' || coalesce(i.title, '(sin describir)'),
  nullif(i.resolution, ''),
  null::int,
  i.resolved_by,
  i.external_ref,
  'resuelta'
from incidents i
where i.resolved_at is not null and i.kind = 'incidencia'

union all

-- Revisiones ----------------------------------------------------------------
select
  ins.id,
  case ins.overall when 'ok' then 'revision_ok' else 'revision_ko' end,
  -- La palabra que distingue una revisión de una corrección. `status` aquí es
  -- siempre 'completa' —la vista solo trae cerradas— así que no se pierde nada.
  case when ins.corrects is null then ins.status::text else 'corregida' end,
  ins.room_id,
  ins.occurred_at,
  case ins.overall
    when 'ok' then 'Revisión completa sin incidencias'
    else 'Revisión con incidencias'
  end,
  nullif(ins.notes, ''),
  null::int,
  ins.by_user,
  null,
  ins.status::text
from inspections_vigentes ins

union all

-- Material ------------------------------------------------------------------
select
  sm.id,
  'material',
  sm.kind::text,
  sm.room_id,
  sm.occurred_at,
  si.name,
  nullif(sm.note, ''),
  sm.qty,
  sm.by_user,
  null,
  sm.kind::text
from stock_movements sm
join stock_items si on si.id = sm.stock_item_id
where sm.room_id is not null

union all

-- Equipos: el alta ----------------------------------------------------------
select
  a.id,
  'equipo',
  'alta',
  a.room_id,
  a.created_at,
  coalesce(a.label, t.name, 'Equipo'),
  nullif(concat_ws(' · ', a.model, a.serial), ''),
  null::int,
  a.created_by,
  a.serial,
  a.status::text
from assets a
left join asset_types t on t.id = a.asset_type_id
where a.room_id is not null and a.created_by is not null

union all

-- Equipos: lo que les pasa después ------------------------------------------
select
  ae.id,
  'equipo',
  ae.kind::text,
  coalesce(ae.room_id, a.room_id),
  ae.occurred_at,
  coalesce(a.label, t.name, 'Equipo'),
  nullif(ae.meta ->> 'nota', ''),
  null::int,
  ae.by_user,
  a.serial,
  ae.kind::text
from asset_events ae
join assets a on a.id = ae.asset_id
left join asset_types t on t.id = a.asset_type_id
where coalesce(ae.room_id, a.room_id) is not null

union all

-- El levantamiento ----------------------------------------------------------
select
  v.id,
  'inventario',
  'levantamiento',
  v.room_id,
  v.occurred_at,
  'Inventario confirmado',
  coalesce(nullif(v.note, ''), v.asset_count || ' equipos en la sala'),
  null::int,
  v.by_user,
  null,
  'levantamiento'
from room_inventories v

)
select
  e.ref_id,
  e.kind,
  e.subkind,
  e.room_id,
  e.at,
  e.title,
  e.detail,
  e.qty,
  e.by_user,
  e.ref,
  e.state,
  p.full_name as who,
  r.code      as room_code,
  r.name      as room_name,
  z.building_id,
  b.code      as building_code
from eventos e
join rooms r     on r.id = e.room_id
join zones z     on z.id = r.zone_id
join buildings b on b.id = z.building_id
left join public.nombres_del_personal() p on p.id = e.by_user;

alter view room_timeline set (security_invoker = on);

notify pgrst, 'reload schema';
