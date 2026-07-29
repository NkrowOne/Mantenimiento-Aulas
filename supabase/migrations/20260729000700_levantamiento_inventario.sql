-- =============================================================================
-- Levantar el inventario de una sala
--
-- Hay 41 aulas con cero equipos registrados y 75 equipos sin número de serie.
-- La aplicación no puede distinguir las dos cosas que eso significa:
--
--   a) el aula no tiene nada —un seminario con pizarra, un pasillo—, o
--   b) nadie ha ido nunca a mirar.
--
-- Y esa es exactamente la razón por la que **no puede insistir**. Un aviso que
-- sale en 41 salas y no se puede quitar se convierte en ruido en dos días: todo
-- el mundo aprende a saltárselo, y con él se saltan el que sí importaba. Lo que
-- hace falta no es avisar más fuerte, es **dejar que una persona lo resuelva una
-- vez**: «he mirado, esto es todo lo que hay». A partir de ahí la sala deja de
-- estar pendiente y no se vuelve a preguntar.
--
-- Eso es un levantamiento de inventario, y va como tabla propia y append-only —
-- no como una fecha dentro de `rooms`— por tres motivos:
--
--  1. **Se repite.** El recuento anual es el mismo acto otra vez. Con un campo
--     se perdería el anterior; así queda la serie entera.
--  2. **Sube por la cola de salida sin inventar nada.** Es una fila nueva con
--     todas sus columnas, que es lo único que el sincronizador sabe hacer. Un
--     campo dentro de `rooms` habría necesitado un PATCH parcial, y `rooms` solo
--     la escribe un administrador.
--  3. **Es una afirmación de alguien, con fecha.** «Ana confirmó el 3 de marzo
--     que el aula 1.7 tiene lo que dice tener» vale como registro; una fecha
--     suelta en una columna no dice quién ni se puede auditar.
--
-- Confirmar el inventario **no** es lo mismo que añadir un equipo: se puede
-- añadir un proyector y seguir sin saber si falta algo más. Por eso es un acto
-- explícito y no un efecto secundario de otra cosa.
-- =============================================================================

create table if not exists room_inventories (
  id          uuid primary key,
  room_id     uuid not null references rooms(id) on delete cascade,
  by_user     uuid references profiles(id),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  -- Cuántos equipos había en la sala al confirmar. Es la foto del momento: sin
  -- ella, un levantamiento antiguo no se puede distinguir de uno hecho sobre un
  -- aula que entonces estaba vacía.
  asset_count int not null default 0,
  note        text,
  source      text not null default 'app'
);

comment on table room_inventories is
  'Cada vez que alguien confirma «he mirado el aula y esto es todo lo que hay». Append-only.';

create index if not exists room_inventories_room_idx
  on room_inventories(room_id, occurred_at desc);

-- -----------------------------------------------------------------------------
-- Permisos
--
-- Lo levanta quien está en el aula, que es el técnico. Y no se corrige: si al
-- día siguiente aparece un proyector que no se vio, se levanta otra vez y la
-- serie lo cuenta.
-- -----------------------------------------------------------------------------

alter table room_inventories enable row level security;

create policy "personal lee levantamientos" on room_inventories
  for select to authenticated using (public.is_staff());

create policy "personal levanta inventario" on room_inventories
  for insert to authenticated
  with check (public.is_staff() and by_user = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- La sala sabe cuándo se levantó por última vez
--
-- Va en `room_overview` porque es la vista que el dispositivo copia entera: sin
-- esto, saber si una sala está pendiente costaría una consulta por sala, y la
-- lista de trabajo se pinta sin conexión.
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
  -- Al final de la lista y no en su sitio lógico: `create or replace view` solo
  -- deja AÑADIR columnas, nunca insertarlas en medio ni renombrarlas. Ponerla
  -- donde tocaba habría intentado rebautizar `open_incidents` y la migración
  -- muere. El orden de las columnas de una vista no lo lee nadie —el cliente
  -- pide por nombre— y recrearla obligaría a tirar las tres vistas de alertas
  -- que cuelgan de esta.
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
  where inc.room_id = r.id and inc.state <> 'resuelta'
) oi on true;

alter view public.room_overview set (security_invoker = on);

-- -----------------------------------------------------------------------------
-- Y sale en el histórico, que es donde se mira «¿cuándo se revisó esto?»
-- -----------------------------------------------------------------------------

create or replace view room_timeline as
with eventos as (

select
  i.id                                        as ref_id,
  'revision'::text                            as kind,
  i.status::text                              as subkind,
  i.room_id,
  i.occurred_at                               as at,
  case i.overall
    when 'ok'              then 'Revisión sin incidencias'
    when 'con_incidencias' then 'Revisión con incidencias'
    else 'Revisión'
  end                                         as title,
  nullif(i.notes, '')                         as detail,
  null::int                                   as qty,
  i.by_user
from inspections i
where i.room_id is not null

union all

select
  inc.id,
  'incidencia',
  'abierta',
  inc.room_id,
  inc.opened_at,
  inc.title,
  coalesce(nullif(inc.external_ref, '') || ' · ', '') || coalesce(nullif(inc.description, ''), ''),
  null::int,
  inc.opened_by
from incidents inc
where inc.room_id is not null

union all

select
  inc.id,
  'incidencia',
  'resuelta',
  inc.room_id,
  inc.resolved_at,
  'Resuelta: ' || inc.title,
  nullif(inc.resolution, ''),
  null::int,
  inc.resolved_by
from incidents inc
where inc.room_id is not null and inc.resolved_at is not null

union all

select
  sm.id,
  'material',
  sm.kind::text,
  sm.room_id,
  sm.occurred_at,
  si.name,
  nullif(sm.note, ''),
  sm.qty,
  sm.by_user
from stock_movements sm
join stock_items si on si.id = sm.stock_item_id
where sm.room_id is not null

union all

-- `created_by is not null` separa lo que alguien dio de alta desde el aula de
-- los 1.094 equipos que entraron con la importación, que comparten todos la
-- fecha del despliegue.
select
  a.id,
  'equipo',
  'alta',
  a.room_id,
  a.created_at,
  coalesce(a.label, t.name, 'Equipo'),
  nullif(concat_ws(' · ', a.model, a.serial), ''),
  null::int,
  a.created_by
from assets a
left join asset_types t on t.id = a.asset_type_id
where a.room_id is not null and a.created_by is not null

union all

select
  ae.id,
  'equipo',
  ae.kind::text,
  coalesce(ae.room_id, a.room_id),
  ae.occurred_at,
  coalesce(a.label, t.name, 'Equipo'),
  nullif(ae.meta ->> 'nota', ''),
  null::int,
  ae.by_user
from asset_events ae
join assets a on a.id = ae.asset_id
left join asset_types t on t.id = a.asset_type_id
where coalesce(ae.room_id, a.room_id) is not null

union all

-- El levantamiento. Entra en la familia «equipo» y no en una quinta propia: son
-- cuatro colores y cuatro botones de filtro, y un quinto por un evento que pasa
-- una vez al año por sala haría la leyenda más larga que la lista.
select
  v.id,
  'equipo',
  'inventario',
  v.room_id,
  v.occurred_at,
  'Inventario confirmado',
  coalesce(nullif(v.note, ''), v.asset_count || ' equipos en la sala'),
  null::int,
  v.by_user
from room_inventories v

)
select
  e.*,
  r.code  as room_code,
  r.name  as room_name,
  z.building_id,
  b.code  as building_code
from eventos e
join rooms r     on r.id = e.room_id
join zones z     on z.id = r.zone_id
join buildings b on b.id = z.building_id;

alter view public.room_timeline set (security_invoker = on);

-- La auditoría se instala tabla a tabla y el bucle de `auth_rls.sql` no conoce
-- esta. No hace falta: es append-only y cada fila ya lleva su autor y su fecha,
-- que es exactamente lo que un registro de auditoría guardaría.
