-- =============================================================================
-- Endurecimiento del backend
--
-- Sale de una auditoría del lado servidor. Tres de los hallazgos se
-- comprobaron ejecutándolos contra la base, no leyendo el código, y dos de
-- ellos exponían datos a Internet.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Las vistas se saltaban la RLS
--
-- Una vista normal se ejecuta con los privilegios de SU PROPIETARIO, no con los
-- de quien la consulta. `postgres` es el propietario y tiene BYPASSRLS, así que
-- toda la RLS de las tablas de debajo quedaba anulada al leer por una vista.
--
-- Medido antes de este cambio, con rol `anon` y sin token, o sea lo que puede
-- hacer cualquiera desde Internet contra `/rest/v1/room_overview`:
--
--     room_overview           276 filas   (todas las salas, con su equipamiento)
--     stock_levels            111 filas   (el almacén entero)
--     alerts_overdue_rooms    275 filas
--     alerts_lamp_low          11 filas
--     alerts_stale_incidents    2 filas   (con el título de la incidencia)
--     incidents_by_building     9 filas
--
-- La prueba de RLS «un anónimo no ve NADA» pasaba porque solo consultaba las
-- tablas base. Ahora también consulta las vistas.
--
-- `security_invoker` hace que la vista se evalúe con los permisos y la RLS de
-- quien pregunta. Requiere Postgres 15, que es lo que despliega el compose.
-- -----------------------------------------------------------------------------

do $$
declare v text;
begin
  foreach v in array array[
    'room_overview', 'stock_levels', 'stock_monthly_consumption',
    'alerts_lamp_low', 'alerts_stale_incidents', 'alerts_overdue_rooms',
    'alerts_repeat_offenders', 'incidents_by_building', 'incidents_by_month',
    'material_consumption_ranking'
  ] loop
    execute format('alter view public.%I set (security_invoker = on)', v);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Funciones `security definer` que cualquiera podía ejecutar
--
-- `alter default privileges … grant execute on functions to anon, authenticated`
-- (bootstrap_roles.sql:96) hace que toda función nazca ejecutable por anónimos.
-- Para las del catálogo eso da igual: comprueban el rol dentro y lanzan
-- excepción. Estas dos no comprobaban nada.
--
-- Verificado con rol `anon`: `link_tickets_by_ref()` se ejecutó entera, y
-- `request_report()` entró en el cuerpo y solo se detuvo porque el entorno de
-- prueba no tiene `pg_net`. En producción sí lo tiene: cualquiera desde
-- Internet podía disparar la generación de informes en bucle contra el worker,
-- y llenar el bucket.
--
-- Se arregla por partida doble —permiso y comprobación dentro— porque el
-- `alter default privileges` volverá a conceder execute a la siguiente función
-- que alguien escriba.
-- -----------------------------------------------------------------------------

-- Y de paso acepta el rango de fechas, que era decorativo: la pantalla de
-- Informes recogía «Desde» y «Hasta», los pasaba a la mutación y ahí se
-- perdían, porque esta función solo tenía el parámetro `kind`. Un supervisor
-- pedía marzo y recibía un PDF con los datos de AYER, etiquetado como
-- «personalizado». Un documento equivocado que parece legítimo es peor que un
-- error: se archiva y se cita.
create or replace function public.request_report(
  kind    text,
  p_start date default null,
  p_end   date default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  worker_url text;
  worker_tok text;
  request_id bigint;
  cuerpo     jsonb;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor puede pedir un informe'
      using errcode = 'insufficient_privilege';
  end if;

  if kind not in ('diario', 'semanal', 'personalizado') then
    raise exception 'Tipo de informe no válido: %', kind
      using errcode = 'invalid_parameter_value';
  end if;

  if kind = 'personalizado' and (p_start is null or p_end is null) then
    raise exception 'Un informe a medida necesita fecha de inicio y de fin'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_start is not null and p_end is not null then
    if p_end < p_start then
      raise exception 'La fecha final es anterior a la inicial'
        using errcode = 'invalid_parameter_value';
    end if;
    -- Un rango de años haría que el worker cargase el histórico entero.
    if p_end - p_start > 366 then
      raise exception 'El periodo no puede superar un año'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  select value into worker_url from app_config where key = 'reports_worker_url';
  select value into worker_tok from app_config where key = 'reports_worker_token';

  cuerpo := jsonb_build_object('kind', kind);
  if p_start is not null then
    cuerpo := cuerpo || jsonb_build_object('start', p_start::text, 'end', p_end::text);
  end if;

  select net.http_post(
    url     := worker_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || worker_tok),
    body    := cuerpo
  ) into request_id;

  return request_id;
end;
$$;

-- La firma vieja de un solo argumento sigue existiendo por el `create or
-- replace`; se retira para que nadie la llame sin fechas por descuido.
drop function if exists public.request_report(text);

create or replace function public.link_tickets_by_ref()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor puede enlazar tickets'
      using errcode = 'insufficient_privilege';
  end if;

  with linked as (
    update external_tickets et
    set linked_incident_id = i.id
    from incidents i
    where et.linked_incident_id is null
      and i.external_ref is not null
      and i.external_ref = et.external_id
    returning 1
  )
  select count(*)::int into n from linked;

  return n;
end;
$$;

-- El cron corre como `postgres`, que es superusuario: sigue pudiendo llamarla
-- aunque se le quite el permiso a todo el mundo.
revoke execute on function public.request_report(text, date, date) from public, anon;
revoke execute on function public.link_tickets_by_ref() from public, anon;
grant execute on function public.request_report(text, date, date) to authenticated;
grant execute on function public.link_tickets_by_ref() to authenticated;

-- `backfill_room_assets` inserta inventario en masa. No es `security definer`
-- —la RLS lo frena— pero no hay ningún motivo para que lo llame un técnico.
revoke execute on function public.backfill_room_assets() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. El catálogo de equipos no dejaba rastro de quién lo tocó
--
-- `asset_types` nació en la migración de inventario, después del bucle que
-- instala la auditoría, y se quedó fuera. Justo ahí es donde el coordinador
-- confirma, renombra y **fusiona** — y fusionar repunta los equipos de un tipo
-- a otro. Era el único sitio del sistema donde una decisión con consecuencias
-- sobre el inventario no quedaba registrada con autor.
-- -----------------------------------------------------------------------------

create trigger asset_types_audit
  after insert or update or delete on asset_types
  for each row execute function public.audit_trigger();

-- -----------------------------------------------------------------------------
-- 4. `reports` no tenía ninguna restricción única
--
-- El worker inserta con `on conflict do nothing` y el comentario dice «un
-- informe ya emitido no se regenera». No había con qué chocar: la única
-- restricción era la clave primaria, que es un uuid nuevo cada vez. Cada
-- ejecución añadía una fila más apuntando al mismo PDF.
--
-- El hash del contenido es la identidad real del documento.
-- -----------------------------------------------------------------------------

delete from reports a
 using reports b
 where a.content_hash is not null
   and a.content_hash = b.content_hash
   and a.kind = b.kind
   and a.period_start = b.period_start
   and a.ctid > b.ctid;

create unique index reports_unico_idx
  on reports (kind, period_start, period_end, content_hash)
  where content_hash is not null;

-- -----------------------------------------------------------------------------
-- 5. Un consumo de almacén tenía que poder ser negativo, y solo eso
--
-- `material_consumption_ranking` calcula `sum(-qty) where kind='consumo'`. Nada
-- impedía registrar un consumo con cantidad positiva, y ese informe habría
-- devuelto consumos negativos sin que nadie entendiera por qué.
-- -----------------------------------------------------------------------------

alter table stock_movements
  add constraint stock_movements_signo_check check (
    (kind = 'consumo' and qty < 0) or
    (kind = 'compra'  and qty > 0) or
    (kind in ('ajuste', 'devolucion'))
  ) not valid;

-- `not valid` + `validate` por separado: valida lo que ya hay sin bloquear la
-- tabla para escrituras mientras lo hace.
alter table stock_movements validate constraint stock_movements_signo_check;

-- -----------------------------------------------------------------------------
-- 6. Claves foráneas sin índice que respaldan consultas reales
--
-- Sin índice, `merge_asset_type` recorre los 1.094 equipos, y el recuento de
-- uso de la bandeja del coordinador hace lo mismo. Las demás FK sin índice se
-- dejan como están: son tablas pequeñas y un índice de más también cuesta.
-- -----------------------------------------------------------------------------

create index if not exists assets_type_idx           on assets(asset_type_id);
create index if not exists stock_items_type_idx      on stock_items(asset_type_id);
create index if not exists asset_events_asset_idx    on asset_events(asset_id);
create index if not exists incident_materials_inc_idx on incident_materials(incident_id);
create index if not exists asset_types_merged_idx    on asset_types(merged_into)
  where merged_into is not null;
