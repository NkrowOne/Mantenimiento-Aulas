-- =============================================================================
-- El espejo pregunta antes de bajarse
--
-- Cada dispositivo se baja el maestro entero —nueve tablas, paginadas— cada
-- dos minutos y cada vez que vuelve a primer plano, haya cambiado algo o no.
-- Dos de esas tablas son vistas caras: `room_overview` hace tres subconsultas
-- por sala y `stock_levels` suma todos los movimientos de la historia. Con
-- veinte iPads eso son cientos de ejecuciones por hora para no traer nada
-- nuevo la inmensa mayoría de las veces. Y al llegar, la aplicación reescribe
-- todas las filas del espejo, así que cada pantalla abierta se vuelve a
-- calcular y a pintar cada dos minutos sin motivo.
--
-- Esto da al dispositivo una pregunta barata: «¿ha cambiado algo desde la
-- última vez?». `espejo_version()` devuelve un sello por cada fuente del
-- espejo; si es el mismo que el guardado, no se baja nada.
--
--  - Lo editable ya deja rastro en `audit_log` (salas, edificios, plantas,
--    artículos, equipos, incidencias, tipos, retiradas…): basta su último `at`,
--    con un índice para que `max()` sea una lectura y no un barrido.
--  - Lo solo-alta no se audita a propósito (su historial ya es el registro),
--    así que lleva una marca aparte: `espejo_marcas`, una fila por tabla que
--    un disparador POR SENTENCIA pone al día. Por sentencia y no por fila: una
--    sincronización del Excel que inserte quinientos movimientos actualiza la
--    marca una vez.
--
-- La comparación por sellos de tiempo tiene una grieta conocida: una
-- transacción que empezó antes y confirmó después queda con un `at` menor que
-- el máximo ya leído, y su cambio no mueve la versión. Es una ventana de
-- milisegundos, y la aplicación la cubre bajándose entero al menos cada media
-- hora (ver `src/sync/version.ts`). Sincronizar a mano baja siempre.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — Marcas de las tablas solo-alta
-- -----------------------------------------------------------------------------

create table if not exists espejo_marcas (
  tabla text primary key,
  marca timestamptz not null default now()
);

comment on table espejo_marcas is
  'Última escritura de cada tabla solo-alta que alimenta el espejo del dispositivo. La pone al día un disparador por sentencia; la lee espejo_version().';

-- Nadie la toca directamente: escribe el disparador y lee la función, los dos
-- con permisos propios. Sin políticas, RLS lo niega todo a los demás.
alter table espejo_marcas enable row level security;

insert into espejo_marcas (tabla)
values ('inspections'), ('room_inventories'), ('stock_movements')
on conflict (tabla) do nothing;

create or replace function public.espejo_marcar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into espejo_marcas (tabla, marca)
  values (tg_table_name, now())
  on conflict (tabla) do update set marca = excluded.marca;
  return null;
end $$;

comment on function public.espejo_marcar() is
  'Disparador por sentencia: anota en espejo_marcas que la tabla acaba de cambiar.';

revoke all on function public.espejo_marcar() from public, anon, authenticated;

drop trigger if exists inspections_espejo on inspections;
create trigger inspections_espejo
  after insert or update or delete on inspections
  for each statement execute function public.espejo_marcar();

drop trigger if exists room_inventories_espejo on room_inventories;
create trigger room_inventories_espejo
  after insert or update or delete on room_inventories
  for each statement execute function public.espejo_marcar();

drop trigger if exists stock_movements_espejo on stock_movements;
create trigger stock_movements_espejo
  after insert or update or delete on stock_movements
  for each statement execute function public.espejo_marcar();

-- -----------------------------------------------------------------------------
-- 2 — El último cambio auditado, en una lectura
--
-- `audit_log` solo tenía índice por (tabla, fila, fecha): `max(at)` a secas
-- recorría la tabla entera, y crece con cada cambio de diez tablas.
-- -----------------------------------------------------------------------------

create index if not exists audit_log_at_idx on audit_log (at desc);

-- -----------------------------------------------------------------------------
-- 3 — La versión del espejo
-- -----------------------------------------------------------------------------

create or replace function public.espejo_version()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'auditoria',   (select max(at) from audit_log),
    'revisiones',  (select marca from espejo_marcas where tabla = 'inspections'),
    'inventarios', (select marca from espejo_marcas where tabla = 'room_inventories'),
    'movimientos', (select marca from espejo_marcas where tabla = 'stock_movements')
  )
$$;

comment on function public.espejo_version() is
  'Sello de cada fuente del espejo del dispositivo (último cambio auditado y marcas de revisiones, inventarios y movimientos). Si no cambia, no hace falta volver a bajar el maestro.';

revoke all on function public.espejo_version() from public, anon;
grant execute on function public.espejo_version() to authenticated;

notify pgrst, 'reload schema';
