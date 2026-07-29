-- =============================================================================
-- El histórico de una sala, en un solo sitio
--
-- Lo que le pasa a un aula está repartido en cinco tablas y no hay forma de
-- verlo junto. El técnico que llega a la 1.7 y se encuentra el proyector
-- apagado no puede saber que hace tres semanas se cambió la lámpara, que en
-- enero hubo una incidencia por lo mismo y que el cable de fibra se sustituyó
-- dos veces. Esa es justo la información que decide si el problema de hoy es
-- nuevo o es el de siempre.
--
-- `room_timeline` lo une: revisiones, incidencias —abiertas y resueltas—,
-- material consumido, y las altas, bajas y traslados de equipo. Una fila por
-- cosa que pasó, con su fecha y su autor.
--
-- Es una vista y no una tabla nueva a propósito. Un registro de eventos aparte
-- sería un segundo sitio donde apuntar lo mismo, y el día que alguien escriba
-- en una tabla y olvide la otra el histórico empieza a mentir — que es peor que
-- no tenerlo. Aquí no puede desincronizarse: si está en `incidents`, sale.
--
-- El coste de la vista es unir cinco tablas pequeñas (283 incidencias, 158
-- revisiones, ~380 movimientos, 1.094 equipos) y todas las consultas van
-- filtradas por sala o por fecha, con índice.
-- =============================================================================

create or replace view room_timeline as
with eventos as (

-- Revisiones ------------------------------------------------------------------
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

-- Incidencias: la apertura -----------------------------------------------------
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

-- Incidencias: el cierre. Va como fila propia porque una incidencia abierta en
-- enero y resuelta en marzo son dos cosas que pasaron, en dos momentos.
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

-- Material ---------------------------------------------------------------------
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

-- Equipos: el alta. Sale de `assets` y no de `asset_events` porque el alta es
-- la fila misma: un equipo existe desde que se creó, y pedirle además un evento
-- sería obligar a apuntar dos veces lo mismo.
--
-- `created_by is not null` separa lo que alguien dio de alta desde el aula de
-- los 1.094 equipos que entraron con la importación. Los importados comparten
-- todos la fecha del despliegue, así que sin este filtro cada sala abriría su
-- histórico con seis altas idénticas fechadas el mismo día —por delante de las
-- incidencias reales de 2025— y el panel diría que el aula se equipó entera
-- ayer. El inventario de la sala ya está a la vista dos paneles más arriba; el
-- histórico es para lo que ha pasado, no para lo que hay.
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

-- Equipos: lo que les pasa después —baja, avería, traslado, sustitución—.
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

)
-- El contexto de la sala se añade **una vez**, fuera de la unión, y no dentro
-- de cada una de las seis ramas. Va aquí porque la pestaña de Historial filtra
-- por edificio y busca por código de aula, y hacerlo en el cliente obligaría a
-- descargar el histórico entero para enseñar una página.
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

comment on view room_timeline is
  'Todo lo que le ha pasado a una sala, en orden. Une revisiones, incidencias, material y equipos.';

-- Como el resto de vistas: sin esto se leen desde Internet sin ningún token.
alter view public.room_timeline set (security_invoker = on);

-- -----------------------------------------------------------------------------
-- Índices que la vista necesita
--
-- Los de sala ya estaban (`inspections_room_idx`, `incidents_room_idx`,
-- `assets_room_idx`, `stock_movements_room_idx`). Faltan los de fecha, que es
-- como se ordena y como filtra la pantalla de Historial: sin ellos, cada
-- consulta ordena de nuevo las cinco tablas enteras.
-- -----------------------------------------------------------------------------

create index if not exists incidents_resolved_idx on incidents(resolved_at desc)
  where resolved_at is not null;
create index if not exists assets_created_idx on assets(created_at desc);
create index if not exists asset_events_room_idx on asset_events(room_id, occurred_at desc)
  where room_id is not null;
create index if not exists asset_events_occurred_idx on asset_events(occurred_at desc);

-- -----------------------------------------------------------------------------
-- El puente entre el almacén y el catálogo de equipos
--
-- `stock_items.asset_type_id` existe desde el primer esquema y está a NULL en
-- los 68 artículos: se definió la columna y nunca se rellenó. Sin ella, el
-- almacén y el inventario de las aulas son dos mundos que no se tocan, y dar de
-- alta un proyector en un aula no tiene forma de saber que ese proyector salió
-- de una caja que había en el almacén.
--
-- Solo se enlaza lo que **es** un equipo de la sala. Una lámpara de proyector se
-- consume en un proyector pero no es un proyector, y un cable no es nada del
-- inventario: enlazarlos haría que al añadir «Proyector» a un aula se ofreciera
-- descontar una lámpara.
-- -----------------------------------------------------------------------------

create or replace function public.enlazar_almacen_con_catalogo()
returns integer
language plpgsql
as $$
declare
  v_enlazados integer;
begin
  update stock_items si
     set asset_type_id = public.asset_type_id(m.tipo)
    from (values
      ('Proyector Epson',                       'Proyector'),
      ('Proyector Epson (Ed. Antonio Gaudí)',   'Proyector'),
      ('Monitor 86" (edificio BC)',             'Pantalla'),
      ('Monitor NEC 49"',                       'Pantalla'),
      ('Monitor táctil iiyama T2454MSC 24,5"',  'Pantalla'),
      ('Altavoces',                             'Altavoces'),
      ('Micrófono Jabra con soporte de mesa',   'Micrófono'),
      ('Jabra Panacast 50',                     'Cámara'),
      ('Cámara Aver',                           'Cámara'),
      ('Botonera',                              'Botonera'),
      ('Ordenador Tiny M70Q',                   'Ordenador'),
      ('Ordenador Tiny M710Q',                  'Ordenador'),
      ('Ordenador Tiny M720Q',                  'Ordenador'),
      ('Ordenador Tiny Neo 50Q',                'Ordenador')
    ) as m(articulo, tipo)
   where public.norm_text(si.name) = public.norm_text(m.articulo)
     and si.asset_type_id is null
     and public.asset_type_id(m.tipo) is not null;

  get diagnostics v_enlazados = row_count;
  return v_enlazados;
end;
$$;

comment on function public.enlazar_almacen_con_catalogo() is
  'Enlaza cada artículo de almacén que ES un equipo con su tipo. Idempotente: solo toca los que están a NULL.';

comment on column stock_items.asset_type_id is
  'Qué tipo de equipo es este artículo, si es que es uno. NULL en los consumibles.';

-- Va como función y se llama dos veces por el orden de arranque, igual que
-- `backfill_room_assets`: en una instalación limpia las migraciones corren
-- **antes** del seed, así que aquí `stock_items` está vacía y esta llamada no
-- hace nada —el trabajo lo hace la llamada que el importador deja al final del
-- seed—. En una base que ya está en producción es al revés: es esta.
select public.enlazar_almacen_con_catalogo();
