-- =============================================================================
-- La hora es la de Madrid
--
-- Los instantes se siguen guardando en UTC, que es lo correcto y no se toca:
-- `timestamptz` almacena siempre UTC internamente. Lo que cambia es **cómo se
-- interpretan** al agrupar y al comparar con fechas.
--
-- El problema concreto: los contenedores no fijan `TZ`, así que Postgres corría
-- en UTC. Una revisión hecha a las 00:30 del 1 de marzo en Madrid son las 23:30
-- del 28 de febrero en UTC — caía en el informe del día anterior y en el mes
-- anterior. En verano el desfase son dos horas.
--
-- Se resuelve con la zona **escrita en la consulta**, no confiando en la del
-- servidor. Es deliberado: si dependiera de la sesión, la misma vista daría
-- números distintos desde la aplicación, desde `psql` y desde cualquier
-- herramienta que se conecte mañana. Un informe tiene que dar lo mismo lo
-- pregunte quien lo pregunte.
--
-- Lo que NO cambia, y por qué: `alerts_stale_incidents` y `alerts_overdue_rooms`
-- calculan `now() - opened_at`, que es un intervalo. Un intervalo es la
-- distancia entre dos instantes y no depende de ninguna zona. Tocarlo habría
-- sido ruido.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Las dos operaciones que hacen falta, con la zona en un solo sitio
-- -----------------------------------------------------------------------------

-- `stable` y no `immutable` a propósito: la definición de una zona horaria puede
-- cambiar —los gobiernos mueven los cambios de hora— así que Postgres no permite
-- marcarlas inmutables. Como `stable`, el planificador las evalúa una vez por
-- consulta, que es lo que hace falta para que un rango siga usando el índice.
create or replace function public.dia_local(t timestamptz)
returns date
language sql
stable
strict
parallel safe
as $$ select (t at time zone 'Europe/Madrid')::date $$;

comment on function public.dia_local(timestamptz) is
  'En qué día de Madrid ocurrió un instante. Una revisión de las 00:30 pertenece a ese día, no al anterior.';

create or replace function public.inicio_del_dia(d date)
returns timestamptz
language sql
stable
strict
parallel safe
as $$ select (d::timestamp at time zone 'Europe/Madrid') $$;

comment on function public.inicio_del_dia(date) is
  'La medianoche de Madrid de ese día, como instante. Tiene en cuenta el cambio de hora.';

-- -----------------------------------------------------------------------------
-- Agrupaciones por mes
--
-- `date_trunc('month', occurred_at)` trunca en la zona de la SESIÓN. Un consumo
-- del 1 de marzo a las 00:30 caía en febrero.
-- -----------------------------------------------------------------------------

create or replace view stock_monthly_consumption as
select
  sm.stock_item_id,
  si.name,
  date_trunc('month', sm.occurred_at at time zone 'Europe/Madrid')::date as month,
  sum(-sm.qty)::int                                                       as consumed
from stock_movements sm
join stock_items si on si.id = sm.stock_item_id
where sm.kind = 'consumo'
group by sm.stock_item_id, si.name,
         date_trunc('month', sm.occurred_at at time zone 'Europe/Madrid');

create or replace view incidents_by_month as
select
  to_char(date_trunc('month', opened_at at time zone 'Europe/Madrid'), 'YYYY-MM') as month,
  count(*)::int as total,
  count(*) filter (where state <> 'resuelta')::int as open_total
from incidents
group by date_trunc('month', opened_at at time zone 'Europe/Madrid')
order by date_trunc('month', opened_at at time zone 'Europe/Madrid');

-- `create or replace view` no reinstala las opciones, así que hay que volver a
-- ponerlas: sin esto se reabriría la fuga que cerró la migración anterior.
alter view stock_monthly_consumption set (security_invoker = on);
alter view incidents_by_month set (security_invoker = on);

-- -----------------------------------------------------------------------------
-- La zona por defecto de la base
--
-- Con las consultas ya explícitas esto no cambia ningún número, pero hace que
-- `now()`, los registros y cualquier consulta a mano se lean en hora local en
-- vez de obligar a restar dos horas mentalmente.
-- -----------------------------------------------------------------------------

do $$
begin
  execute format('alter database %I set timezone to ''Europe/Madrid''', current_database());
exception when insufficient_privilege then
  raise notice 'Sin permiso para fijar la zona de la base; fíjala en el postgresql.conf';
end $$;

-- -----------------------------------------------------------------------------
-- Y la del planificador de tareas
--
-- `pg_cron` interpreta sus horarios en la zona que diga `cron.timezone`, que por
-- defecto es GMT. Sin esto, «diario a las 07:00» disparaba a las 09:00 de Madrid
-- en verano y a las 08:00 en invierno — y encima cambiaba de hora dos veces al
-- año sin que nadie tocara nada.
--
-- `alter system` necesita superusuario y puede estar bloqueado en un Postgres
-- gestionado; si falla, se dice qué hacer en vez de romper el despliegue.
-- -----------------------------------------------------------------------------

do $$
begin
  execute 'alter system set cron.timezone to ''Europe/Madrid''';
  perform pg_reload_conf();
  raise notice 'pg_cron programado en hora de Madrid';
exception when others then
  raise notice 'No se pudo fijar cron.timezone (%). Si usas pg_cron, añade cron.timezone = ''Europe/Madrid'' al postgresql.conf', sqlerrm;
end $$;
