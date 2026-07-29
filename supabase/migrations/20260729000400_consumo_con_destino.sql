-- =============================================================================
-- El consumo tiene destino: una incidencia y una sala
--
-- El almacén sabía cuánto quedaba de cada cosa y no sabía dónde había ido a
-- parar. Las dos mitades del dato vivían separadas:
--
--   - `incident_materials` guardaba las 320 líneas de «Material Usado» del
--     histórico —lo que de verdad se gastó, y en qué incidencia—, pero eran
--     filas sueltas que no tocaban el almacén.
--   - `stock_movements` no tenía ni un solo movimiento de tipo `consumo`. Los
--     34 que había eran ajustes de saldo inicial.
--
-- Consecuencia directa: `material_consumption_ranking` —el top de material del
-- informe diario y semanal— salía vacío, y `stock_monthly_consumption`, que
-- viene a sustituir las doce columnas Enero..Diciembre de la hoja Bolsa,
-- también. Se sustituyó la hoja por unas vistas que no tenían nada que contar.
--
-- Esta migración hace tres cosas:
--
--  1. Añade `room_id` al movimiento. La incidencia ya dice en qué sala fue,
--     pero no todo consumo nace de una incidencia —una instalación programada,
--     una sustitución preventiva— y sin la columna esos casos se quedan sin
--     destino. Es lo que permite responder «cuánto material se llevó el
--     edificio H», que hoy no se puede contestar.
--  2. Convierte el histórico en movimientos de verdad, con su fecha, su
--     incidencia y su sala.
--  3. **Y no mueve ni una unidad de las existencias**, que es la parte
--     delicada. El saldo que el equipo tiene por bueno —la columna «Stock
--     Disponible» de la Bolsa— ya viene con el histórico descontado. Meter
--     ahora esos consumos sin más los descontaría dos veces y dejaría medio
--     almacén en negativo. Así que cada artículo recibe primero un **saldo de
--     apertura** por exactamente lo que el histórico se llevó, fechado antes de
--     la primera incidencia. La suma final es idéntica a la de antes; lo que
--     cambia es que ahora hay una historia entre medias en vez de un número
--     caído del cielo.
--
-- El orden importa: primero las aperturas y después los consumos. Al revés, el
-- disparador de saldo no negativo rechazaría el primer consumo de cada
-- artículo, y con razón.
--
-- Y una línea que NO se convierte en movimiento: la que quedó apuntada contra
-- un artículo archivado. «50 pulgadas» o «20 mts Fibra» son un monitor y un
-- cable, pero el número que traen es de pulgadas y de metros, no de unidades.
-- Convertirlo en un consumo de 50 unidades de «pulgadas» no es un dato
-- incompleto: es un dato falso, y encima se colocaba en cabeza del informe de
-- material más consumido. La línea se queda en `incident_materials` con su
-- texto original —el histórico no pierde nada— y no toca el almacén.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — Dónde se gastó
-- -----------------------------------------------------------------------------

alter table stock_movements
  add column if not exists room_id uuid references rooms(id) on delete set null;

comment on column stock_movements.room_id is
  'Dónde se gastó. Redundante con la incidencia cuando la hay, imprescindible cuando no.';

create index if not exists stock_movements_room_idx on stock_movements(room_id) where room_id is not null;

-- Lo que ya estuviera enlazado a una incidencia hereda su sala.
update stock_movements sm
   set room_id = i.room_id
  from incidents i
 where i.id = sm.incident_id
   and sm.room_id is null
   and i.room_id is not null;

-- -----------------------------------------------------------------------------
-- 2 — Saldo de apertura: lo que el histórico se va a llevar
--
-- El id sale del artículo, así que volver a ejecutarlo no duplica nada.
-- -----------------------------------------------------------------------------

insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, source, note)
select md5('almacen:apertura:' || im.stock_item_id::text)::uuid,
       im.stock_item_id,
       sum(im.qty)::int,
       'ajuste',
       coalesce((select min(opened_at) from incidents) - interval '1 day', now()),
       'import',
       'Saldo de apertura: las unidades que el histórico de incidencias consumió después'
  from incident_materials im
  join stock_items si on si.id = im.stock_item_id and si.active
 where im.qty > 0
 group by im.stock_item_id
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- 3 — El histórico, ya como movimientos
--
-- `occurred_at` es la fecha de apertura de la incidencia y no la de resolución:
-- el material se coge cuando se va a arreglar, y es la única de las dos que
-- está siempre informada.
-- -----------------------------------------------------------------------------

insert into stock_movements
  (id, stock_item_id, qty, kind, incident_id, room_id, occurred_at, source, note)
select md5('almacen:consumo:' || im.id::text)::uuid,
       im.stock_item_id,
       -im.qty,
       'consumo',
       im.incident_id,
       i.room_id,
       i.opened_at,
       'import',
       case when im.serial is not null then 'N/S ' || im.serial end
  from incident_materials im
  join incidents i on i.id = im.incident_id
  join stock_items si on si.id = im.stock_item_id and si.active
 where im.qty > 0
on conflict (id) do nothing;
