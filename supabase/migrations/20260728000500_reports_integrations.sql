-- =============================================================================
-- Vistas del panel, informes programados y puerto de integración de tickets
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Agregados para los gráficos
-- -----------------------------------------------------------------------------

create view incidents_by_building as
select
  coalesce(b.code, '—')  as code,
  coalesce(b.name, 'Sin edificio') as name,
  count(*)::int          as total,
  count(*) filter (where i.state <> 'resuelta')::int as open_total
from incidents i
left join rooms r     on r.id = i.room_id
left join zones z     on z.id = r.zone_id
left join buildings b on b.id = z.building_id
group by b.code, b.name
order by count(*) desc;

create view incidents_by_month as
select
  to_char(date_trunc('month', opened_at), 'YYYY-MM') as month,
  count(*)::int as total,
  count(*) filter (where state <> 'resuelta')::int as open_total
from incidents
group by date_trunc('month', opened_at)
order by date_trunc('month', opened_at);

-- Cuánto material se gasta de cada cosa: sustituye a las doce columnas
-- Enero..Diciembre que hoy se rellenan a mano en la hoja Bolsa.
create view material_consumption_ranking as
select
  si.name,
  sum(-sm.qty)::int as consumed,
  count(distinct sm.incident_id)::int as incidents
from stock_movements sm
join stock_items si on si.id = sm.stock_item_id
where sm.kind = 'consumo'
group by si.name
order by sum(-sm.qty) desc;

-- -----------------------------------------------------------------------------
-- Informes programados
--
-- `pg_cron` no llama a localhost: dentro de Docker, la base de datos se
-- alcanzaría a sí misma. Se invoca al contenedor de informes por su nombre de
-- servicio en la red interna de Compose.
-- -----------------------------------------------------------------------------

-- En Supabase estas extensiones existen. En el Postgres desechable de
-- `npm run db:verify` no, y no queremos que su ausencia impida verificar RLS,
-- las vistas y el resto del esquema, que es lo que de verdad hay que probar.
do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'pg_cron no disponible: los informes no se programarán en este entorno';
end $$;

do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net no disponible: request_report no podrá llamar al worker';
end $$;

-- La URL del worker y su secreto viven en una tabla de configuración, no
-- incrustados en la definición del cron: cambiarlos no exige recrear el job.
create table app_config (
  key   text primary key,
  value text not null
);

insert into app_config (key, value) values
  ('reports_worker_url', 'http://reports-worker:8080/generate'),
  ('reports_worker_token', 'cambiame-en-produccion')
on conflict (key) do nothing;

alter table app_config enable row level security;
create policy "admin gestiona configuración" on app_config
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create or replace function public.request_report(kind text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  worker_url text;
  worker_tok text;
  request_id bigint;
begin
  select value into worker_url from app_config where key = 'reports_worker_url';
  select value into worker_tok from app_config where key = 'reports_worker_token';

  select net.http_post(
    url     := worker_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || worker_tok),
    body    := jsonb_build_object('kind', kind)
  ) into request_id;

  return request_id;
end;
$$;

-- Diario a las 07:00 y semanal los lunes a las 07:30, hora del servidor.
do $$
begin
  perform cron.schedule('informe-diario',  '0 7 * * *',  $c$select public.request_report('diario')$c$);
  perform cron.schedule('informe-semanal', '30 7 * * 1', $c$select public.request_report('semanal')$c$);
exception when others then
  raise notice 'Sin pg_cron: programa los informes con el cron del sistema';
end $$;

-- -----------------------------------------------------------------------------
-- Puerto de integración de tickets
--
-- Hoy no hay ninguna conexión con ServiceNow. Esto es el enchufe: una tabla
-- neutra donde cualquier origen deja sus tickets y un enlace opcional a la
-- incidencia propia. Implementar `ServiceNowSource` mañana no obliga a tocar
-- nada del resto de la aplicación.
-- -----------------------------------------------------------------------------

create table external_tickets (
  id                uuid primary key default gen_random_uuid(),
  source            text not null,
  external_id       text not null,
  status            text,
  title             text,
  payload           jsonb not null default '{}'::jsonb,
  linked_incident_id uuid references incidents(id) on delete set null,
  fetched_at        timestamptz not null default now(),
  unique (source, external_id)
);

create index external_tickets_unlinked_idx on external_tickets(source)
  where linked_incident_id is null;

alter table external_tickets enable row level security;

create policy "personal lee tickets externos" on external_tickets
  for select to authenticated using (public.is_staff());
create policy "supervisor enlaza tickets" on external_tickets
  for all to authenticated
  using (public.is_supervisor()) with check (public.is_supervisor());

-- El histórico ya trae las referencias `I260203_0051`, así que en cuanto haya
-- conexión con ServiceNow el enlace se puede reconstruir por esa clave.
create or replace function public.link_tickets_by_ref()
returns int
language sql
security definer
set search_path = public
as $$
  with linked as (
    update external_tickets et
    set linked_incident_id = i.id
    from incidents i
    where et.linked_incident_id is null
      and i.external_ref is not null
      and i.external_ref = et.external_id
    returning 1
  )
  select count(*)::int from linked;
$$;

-- -----------------------------------------------------------------------------
-- Fusión de edificios provisionales
--
-- Cuando el admin decide que `BC` era en realidad el CRAI, hay que llevarse
-- zonas, salas y alias al edificio correcto. Las zonas se fusionan por nombre
-- (`1ª PLANTA` de uno y del otro son la misma) porque `zones` tiene un único
-- por (building_id, name) y un traslado ciego lo violaría.
-- -----------------------------------------------------------------------------
create or replace function public.merge_building(from_building uuid, into_building uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  z record;
  target_zone uuid;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede fusionar edificios'
      using errcode = 'insufficient_privilege';
  end if;

  if from_building = into_building then
    raise exception 'No se puede fusionar un edificio consigo mismo';
  end if;

  for z in select * from zones where building_id = from_building loop
    select id into target_zone
    from zones
    where building_id = into_building and name = z.name;

    if target_zone is null then
      update zones set building_id = into_building where id = z.id;
    else
      update rooms set zone_id = target_zone where zone_id = z.id;
      delete from zones where id = z.id;
    end if;
  end loop;

  delete from buildings where id = from_building;
end;
$$;

grant execute on function public.merge_building(uuid, uuid) to authenticated;
