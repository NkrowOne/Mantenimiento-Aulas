-- =============================================================================
-- Autorizar una retirada sin saber qué aparato es
--
-- `asset_removal_queue` se escribió antes de que existiera el catálogo, así que
-- lo que le enseña al coordinador es `assets.model`: el texto libre que en la
-- mitad del parque está vacío y en la otra mitad dice «M403H *». Con eso, una
-- fila de la cola pone
--
--   Ordenador · 2.4 · No enciende
--
-- y quien tiene que decidir no sabe si es el Lenovo de 2019 o el que se compró en
-- marzo. Y no es una curiosidad: la decisión que se le pide es distinta según cuál
-- sea —uno se da de baja sin pensarlo y el otro está en garantía—, y el aparato
-- está a un edificio de distancia.
--
-- También le faltaban dos cosas que ya se saben:
--
--  - **El tipo, siguiendo las fusiones.** Ponía `t.name` a secas, así que un
--    equipo cuyo tipo se fusionó ayer sale con el nombre viejo. El resto del
--    proyecto resuelve esto en todas partes; aquí se había quedado sin resolver.
--  - **Desde cuándo está puesto.** Es la mitad de la respuesta a «¿esto se da de
--    baja o se arregla?»: un proyector de hace ocho meses no se tira.
--
-- Se reconstruye sobre `asset_overview`, que ya monta la identidad completa
-- siguiendo las fusiones de tipo y de modelo. Repetir aquí el mismo join de cinco
-- tablas sería la tercera copia, y la tercera copia es la que se queda atrás.
-- =============================================================================

-- `drop` y no `create or replace`: la vista cambia de columnas —`model` pasa a
-- ser la del catálogo y entran `identidad`, `brand`, `model_libre` e
-- `installed_at`—, y `create or replace` solo sabe añadir al final.
drop view if exists asset_removal_queue;

create view asset_removal_queue as
select
  rm.id,
  rm.asset_id,
  rm.destino,
  rm.reason,
  rm.requested_at,
  rm.requested_by,
  p.full_name        as requested_by_name,

  ao.label           as asset_label,
  ao.serial,
  -- «Ordenador Lenovo U3302», ya montado. Es lo que la bandeja pinta en primera
  -- línea, y lo que hace que autorizar sea una decisión y no una firma a ciegas.
  ao.identidad,
  ao.brand,
  ao.model_name,
  -- El texto libre de antes del catálogo, para que un equipo sin modelo asignado
  -- no se quede mudo mientras nadie lo ha pasado al catálogo.
  ao.model_libre     as model,
  ao.model_confirmed,
  ao.installed_at,
  ao.confirmed       as asset_confirmed,
  ao.type_name,

  rm.room_id,
  ao.room_code,
  ao.room_name,
  ao.building_code,
  si.id              as stock_item_id,
  si.name            as stock_item_name
from asset_removals rm
join asset_overview ao on ao.id = rm.asset_id
left join profiles p   on p.id = rm.requested_by
-- El artículo se busca por el tipo ya resuelto, igual que antes. Lateral y no
-- `join` a secas: un tipo puede tener más de un artículo de almacén, y con un
-- join normal la solicitud saldría repetida en la cola.
left join lateral (
  select s.id, s.name
    from asset_types t
    left join asset_types tv on tv.id = t.merged_into
    join stock_items s on s.asset_type_id = coalesce(tv.id, t.id) and s.active
   where t.id = ao.asset_type_id
   order by s.name
   limit 1
) si on true
where rm.state = 'pendiente';

/*
 * `security_invoker` en las dos, y hace falta decirlo aquí.
 *
 * Esta vista lee de otra vista. Sin el `security_invoker` de ESTA, la RLS que se
 * aplicaría es la del dueño de la vista y no la de quien pregunta, y la cola de
 * retiradas —que dice qué hay en cada aula— quedaría legible para cualquiera con
 * un token. `asset_overview` ya lo lleva; encadenarlas no lo hereda.
 */
alter view asset_removal_queue set (security_invoker = on);

comment on view asset_removal_queue is
  'Retiradas por autorizar, con el aparato identificado (tipo, marca, modelo y serie), la sala, quién la pidió y el artículo de almacén al que iría la unidad.';

notify pgrst, 'reload schema';
