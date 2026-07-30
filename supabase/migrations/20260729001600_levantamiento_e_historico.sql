-- =============================================================================
-- El levantamiento de inventario, y UNA sola línea de tiempo por sala
--
-- Aquí se juntan dos trabajos que se hicieron en paralelo y que, sin querer,
-- crearon **dos vistas distintas con el mismo nombre**: `room_timeline`.
--
--   - La de `registros_y_borradores` mezcla incidencias, solicitudes y
--     observaciones con las revisiones. Es la que alimenta la ficha de sala.
--   - La otra añadía el material consumido y las altas, bajas y traslados de
--     equipo, y alimenta el panel plegado de la revisión y la pestaña Historial.
--
-- Dos vistas con el mismo nombre no pueden convivir, pero es que además **no
-- deben**: la respuesta a «qué le ha pasado a esta sala» no puede depender de
-- qué pantalla la pregunte. Así que esta migración deja una sola, con la unión
-- de las dos: se conservan íntegras las columnas y el vocabulario de `kind` que
-- ya consume la ficha —para no romper nada de lo que hay— y se añaden encima
-- las columnas y las familias que faltaban.
--
-- El resultado es que la ficha de sala pasa a enseñar también el material que se
-- gastó allí y los equipos que entraron y salieron, sin tocar una línea de su
-- consulta. Que es lo que se le pedía desde el principio.
--
-- Y lo primero de todo, la pieza que faltaba del inventario.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — Levantar el inventario de una sala
--
-- Hay 41 aulas con cero equipos registrados. La aplicación no puede distinguir
-- las dos cosas que eso significa —el aula no tiene nada, o nadie ha ido nunca a
-- mirar— y esa es exactamente la razón por la que no puede insistir: un aviso
-- que sale en 41 sitios y no se puede quitar es ruido en dos días, y arrastra
-- consigo a los avisos que sí importaban. Lo que hace falta es dejar que una
-- persona lo resuelva una vez: «he mirado, esto es todo lo que hay».
--
-- Va como tabla append-only y no como una fecha dentro de `rooms` por tres
-- motivos: el recuento se repite y así queda la serie entera en vez de pisarse;
-- sube por la cola de salida como una fila con todas sus columnas, que es lo
-- único que el sincronizador sabe hacer —y `rooms` solo la escribe un
-- administrador—; y es la afirmación de alguien con fecha, que vale como
-- registro donde una columna suelta no.
-- -----------------------------------------------------------------------------

create table if not exists room_inventories (
  id          uuid primary key,
  room_id     uuid not null references rooms(id) on delete cascade,
  by_user     uuid references profiles(id),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  -- Cuántos equipos había al confirmar. Es la foto del momento: sin ella, un
  -- levantamiento antiguo no se distingue de uno hecho sobre un aula vacía.
  asset_count int not null default 0,
  note        text,
  source      text not null default 'app'
);

comment on table room_inventories is
  'Cada vez que alguien confirma «he mirado el aula y esto es todo lo que hay». Append-only.';

create index if not exists room_inventories_room_idx
  on room_inventories(room_id, occurred_at desc);

alter table room_inventories enable row level security;

drop policy if exists "personal lee levantamientos" on room_inventories;
create policy "personal lee levantamientos" on room_inventories
  for select to authenticated using (public.is_staff());

-- Lo levanta quien está en el aula. Y no se corrige: si al día siguiente
-- aparece un proyector que no se vio, se levanta otra vez y la serie lo cuenta.
drop policy if exists "personal levanta inventario" on room_inventories;
create policy "personal levanta inventario" on room_inventories
  for insert to authenticated
  with check (public.is_staff() and by_user = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- 2 — La sala sabe cuándo se levantó por última vez
--
-- `create or replace view` solo deja AÑADIR columnas al final, así que
-- `last_inventory_at` va detrás de `short_ref` y no en su sitio lógico. El orden
-- de las columnas de una vista no lo lee nadie —el cliente pide por nombre— y
-- recrearla obligaría a tirar las tres vistas de alertas que cuelgan de esta.
-- -----------------------------------------------------------------------------

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
  from inspections i
  where i.room_id = r.id and i.status = 'completa'
  order by i.occurred_at desc
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
  -- Los borradores no cuentan como incidencia abierta: una nota a medio
  -- escribir no es trabajo pendiente en la sala.
  where inc.room_id = r.id and inc.state not in ('resuelta', 'borrador')
) oi on true
where r.active;

alter view room_overview set (security_invoker = on);

-- -----------------------------------------------------------------------------
-- 3 — Una sola línea de tiempo
--
-- Se tira y se rehace en vez de reemplazarse: cambian las columnas, y
-- `create or replace` solo sabe añadirlas al final. No cuelga nada de ella.
--
-- El vocabulario de `kind` es el que ya consume la ficha de sala —incidencia,
-- solicitud, observacion, revision_ok, revision_ko— más las tres familias que
-- faltaban: `material`, `equipo` e `inventario`. Y las columnas son la unión:
-- `ref`, `who` y `state` para la ficha; `ref_id`, `subkind`, `detail`, `qty` y
-- el contexto de sala y edificio para el panel de la revisión y la pestaña
-- Historial, que filtra y pagina contra el servidor.
-- -----------------------------------------------------------------------------

drop view if exists room_timeline;

create view room_timeline as
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

-- …y el cierre, como fila propia. Abrir en enero y resolver en marzo son dos
-- cosas que pasaron, en dos momentos, y entre las dos fechas está lo que se
-- tardó. Solo para lo que se rompió: una observación o una solicitud no se
-- «resuelven» en el mismo sentido y ensuciarían la línea.
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
  ins.status::text,
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
from inspections ins
where ins.status = 'completa'

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
--
-- `created_by is not null` separa lo que alguien dio de alta desde el aula de
-- los 1.094 equipos que entraron con la importación: comparten todos la fecha
-- del despliegue, y sin el filtro cada sala abriría su histórico con seis altas
-- idénticas por delante de las incidencias reales de 2025.
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
-- El contexto de sala y edificio se añade una vez, fuera de la unión. Lo pide
-- la pestaña Historial, que filtra por edificio y busca por código de aula:
-- hacerlo en el cliente obligaría a descargar el histórico entero para pintar
-- una página. `who` sale aquí por lo mismo — un `join` en vez de siete.
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
left join profiles p on p.id = e.by_user;

alter view room_timeline set (security_invoker = on);

comment on view room_timeline is
  'Todo lo que le ha pasado a una sala: registros, revisiones, material, equipos e inventarios.';

notify pgrst, 'reload schema';
