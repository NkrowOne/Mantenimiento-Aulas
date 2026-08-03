-- =============================================================================
-- La incidencia tiene dueño, tiene vuelta atrás, y por fin se puede medir
--
-- Desde que cierra quien arregla, faltan tres piezas que antes no hacían falta
-- porque la cola era de una sola persona:
--
--   1. NADIE ERA DUEÑO DE NADA. «En curso» decía que alguien la había empezado y
--      no decía quién. Con 276 aulas y varios técnicos, eso es dos personas
--      subiendo al mismo aula el mismo día y enterándose al llegar. Y desde que
--      cualquiera puede cerrar, también es cerrarle el parte a quien lo tenía a
--      medias.
--   2. NO HABÍA MARCHA ATRÁS. Cerrar pasó a ser fácil para todo el equipo, y
--      reabrir no se podía desde la aplicación ni siendo supervisor: la política
--      lo permitía y ninguna pantalla lo ofrecía. El primer cierre equivocado se
--      arreglaba con SQL.
--   3. NO SE PODÍA MEDIR. `resolved_at` y `resolved_by` llevaban meses vacíos
--      porque nada los rellenaba; ahora se llenan y no hay un solo número que
--      diga cuánto se tarda en cerrar una avería, que es la pregunta que hace
--      quien lleva el servicio.
--
-- Y una cuarta, que es un fallo silencioso que llevaba aquí desde el principio:
-- un técnico no podía leer el nombre de sus compañeros. La política «ver
-- perfiles» deja ver el perfil propio y, si eres supervisor, todos. Como
-- `room_timeline` y `room_inspections` resuelven el nombre con un `left join` a
-- `profiles` y son `security_invoker`, a un técnico el histórico le salía **sin
-- quién** en todo lo que no hubiera firmado él. Sin error y sin hueco visible:
-- simplemente no aparecía el nombre.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — Quién lleva cada incidencia
--
-- Autoasignación y no reparto: la coge quien va a subir, no la manda nadie. Es
-- lo que encaja con cómo se trabaja —el técnico ve la lista, elige y sube— y lo
-- que evita inventar una pantalla de asignación que nadie ha pedido.
--
-- `assigned_to` y no «el que la puso en curso»: son la misma persona hoy, pero
-- el estado dice en qué punto está el trabajo y esto dice de quién es. Mezclarlos
-- obligaría a leer el histórico para saber a quién preguntar.
-- -----------------------------------------------------------------------------

alter table incidents
  add column if not exists assigned_to uuid references profiles(id) on delete set null,
  add column if not exists assigned_at timestamptz;

comment on column incidents.assigned_to is
  'Quién la lleva. Se autoasigna al pulsar «La cojo yo»; se suelta al liberarla y se limpia al reabrirla. NULL = nadie la ha cogido.';

comment on column incidents.assigned_at is
  'Cuándo la cogió. Separado de `state`: el estado dice en qué punto está el trabajo, esto de quién es.';

-- «¿Qué llevo yo?» es la consulta que hace cada técnico al abrir la aplicación.
create index if not exists incidents_asignadas_idx
  on incidents(assigned_to) where assigned_to is not null and state <> 'resuelta';

-- Y «cuánto se tarda», que recorre lo cerrado por fecha de cierre.
create index if not exists incidents_resueltas_idx
  on incidents(resolved_at) where resolved_at is not null;

-- -----------------------------------------------------------------------------
-- 2 — El nombre de un compañero no es un secreto
--
-- Una vista con dos columnas y nada más. `profiles` guarda además el email, el
-- rol y si la cuenta está activa, y eso sí es de administración: por eso no se
-- abre la tabla, se abre exactamente lo que hace falta para escribir «la lleva
-- Ana Ruiz» debajo de una avería.
--
-- Sin `security_invoker`, o sea que la vista lee `profiles` con el permiso de su
-- dueño y el filtro lo pone ella: `is_staff()`. Quien no es del equipo no ve ni
-- una fila.
-- -----------------------------------------------------------------------------

create or replace view personal as
select p.id, p.full_name, p.active
from profiles p
where public.is_staff();

comment on view personal is
  'Los nombres del equipo, y solo los nombres. Para poder decir quién lleva una incidencia o quién firmó una revisión sin abrir `profiles`, que guarda el email y el rol.';

grant select on personal to authenticated;

-- Y las dos vistas que se quedaban sin nombre pasan a usarla. Las columnas no
-- cambian —`create or replace view` no lo permitiría—: cambia de dónde sale el
-- nombre, que antes venía en blanco para todo el que no fuera supervisor.
create or replace view room_timeline as
with eventos as (

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

select
  ins.id,
  case ins.overall when 'ok' then 'revision_ok' else 'revision_ko' end,
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
-- `personal` y no `profiles`: con la tabla, un técnico veía el histórico entero
-- sin un solo nombre salvo el suyo.
left join personal p on p.id = e.by_user;

alter view room_timeline set (security_invoker = on);

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
left join personal p on p.id = i.by_user
left join inspections base on base.id = i.corrects
left join lateral (
  select c.id, c.corrected_at, c.by_user
  from inspections c
  where c.corrects = i.id and c.status = 'completa'
  order by c.corrected_at desc nulls last
  limit 1
) sig on true
left join personal sp on sp.id = sig.by_user
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
-- 3 — Los tres verbos de una incidencia, en una sola puerta
--
-- Se reemplaza `avanzar_incidencia` conservando su firma EXACTA: hay
-- dispositivos con cierres encolados que la van a llamar con esos tres nombres
-- de parámetro, y cambiarlos convertiría un cierre pendiente en un rechazo
-- permanente en la pantalla de alguien.
--
-- Lo que cambia es que `abierta` deja de ser un estado prohibido y pasa a
-- significar dos cosas distintas según de dónde se venga, que es justo como se
-- dice en voz alta:
--
--   en curso → abierta   «la suelto»      — el dueño, o un supervisor
--   resuelta → abierta   «hay que volver» — supervisor, y diciendo por qué
--
-- Soltar lo puede hacer quien la lleva porque es deshacer lo suyo. Reabrir no:
-- es revisar la decisión de otro, y encima es el único camino que devuelve
-- trabajo a la cola de todos.
-- -----------------------------------------------------------------------------

create or replace function public.avanzar_incidencia(
  p_id        uuid,
  p_estado    incident_state,
  p_resolucion text default null
)
returns incidents
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v      incidents;
  v_yo   uuid   := (select auth.uid());
  v_texto text  := nullif(btrim(coalesce(p_resolucion, '')), '');
begin
  if not public.is_staff() then
    raise exception 'Solo el personal puede cambiar el estado de una incidencia'
      using errcode = 'insufficient_privilege';
  end if;

  if p_estado not in ('abierta', 'en_curso', 'resuelta') then
    raise exception 'Un borrador se completa desde su bandeja, no se mueve desde aquí'
      using errcode = 'check_violation';
  end if;

  select * into v from incidents where id = p_id for update;

  -- `check_violation` y no un código de «no existe»: PostgREST traduce lo que no
  -- conoce a un 500, y un 500 la cola lo reintenta para siempre. Esto no se
  -- arregla reintentando.
  if not found then
    raise exception 'Esa incidencia no existe (id=%)', p_id
      using errcode = 'check_violation';
  end if;

  if v.state = 'borrador' then
    raise exception 'Un borrador se completa desde la bandeja de Incidencias, no se cierra (id=%)', p_id
      using errcode = 'check_violation';
  end if;

  -- ---------------------------------------------------------------- cerrar ---
  if p_estado = 'resuelta' then
    if v_texto is null or length(v_texto) < 3 then
      raise exception 'Para cerrar una incidencia hay que escribir qué se ha hecho (id=%)', p_id
        using errcode = 'check_violation';
    end if;

    -- Idempotente: el reenvío de un cierre cuya respuesta se perdió no es un
    -- error, y no puede pisar ni la fecha ni la firma del cierre de verdad.
    if v.state = 'resuelta' then
      return v;
    end if;

    update incidents
       set state       = 'resuelta',
           resolved_at = now(),
           resolved_by = v_yo,
           resolution  = v_texto
     where id = p_id
    returning * into v;

    return v;
  end if;

  -- --------------------------------------------------------------- cogerla ---
  if p_estado = 'en_curso' then
    if v.state = 'resuelta' then
      raise exception 'Esa incidencia ya está cerrada: para volver a ella hay que reabrirla (id=%)', p_id
        using errcode = 'check_violation';
    end if;

    -- Ya la lleva alguien y no soy yo: no se le quita de las manos a nadie por
    -- pulsar un botón. Que la suelte él, o que la reasigne un supervisor.
    if v.assigned_to is not null and v.assigned_to <> v_yo and not public.is_supervisor() then
      raise exception 'Esa incidencia ya la lleva otra persona (id=%)', p_id
        using errcode = 'check_violation';
    end if;

    update incidents
       set state       = 'en_curso',
           assigned_to = v_yo,
           assigned_at = coalesce(
             case when v.assigned_to = v_yo then v.assigned_at end, now())
     where id = p_id
    returning * into v;

    return v;
  end if;

  -- --------------------------------------------------- soltarla o reabrirla ---
  if v.state = 'resuelta' then
    if not public.is_supervisor() then
      raise exception 'Reabrir una incidencia cerrada es cosa de un supervisor (id=%)', p_id
        using errcode = 'insufficient_privilege';
    end if;
    if v_texto is null or length(v_texto) < 3 then
      raise exception 'Para reabrir una incidencia hay que decir por qué (id=%)', p_id
        using errcode = 'check_violation';
    end if;

    /*
     * Lo que se cerró no se borra: se cuenta.
     *
     * La resolución anterior y el motivo de la reapertura bajan a la
     * descripción, que es el campo que la lista y el histórico SÍ pintan. Con
     * `resolution` a secas, reabrir habría hecho desaparecer en silencio lo que
     * alguien dijo que había hecho — y ese es justo el dato que hace falta para
     * entender por qué no funcionó.
     */
    update incidents
       set state       = 'abierta',
           description = btrim(
             coalesce(v.description || E'\n\n', '') ||
             'Reabierta el ' || to_char(now() at time zone 'Europe/Madrid', 'DD/MM/YYYY') ||
             ': ' || v_texto ||
             coalesce(' · Se había cerrado con: ' || nullif(btrim(v.resolution), ''), '')),
           resolution  = null,
           resolved_at = null,
           resolved_by = null,
           assigned_to = null,
           assigned_at = null
     where id = p_id
    returning * into v;

    return v;
  end if;

  -- Soltar: solo tiene sentido sobre lo que uno lleva.
  if v.state <> 'en_curso' then
    return v;
  end if;

  if v.assigned_to is not null and v.assigned_to <> v_yo and not public.is_supervisor() then
    raise exception 'Esa incidencia la lleva otra persona: no puedes soltarla tú (id=%)', p_id
      using errcode = 'check_violation';
  end if;

  update incidents
     set state = 'abierta', assigned_to = null, assigned_at = null
   where id = p_id
  returning * into v;

  return v;
end;
$fn$;

comment on function public.avanzar_incidencia(uuid, incident_state, text) is
  'La única puerta por la que el personal mueve una incidencia: cogerla (en_curso, se autoasigna), cerrarla (resuelta, exige escribir qué se ha hecho), soltarla (abierta desde en_curso, el dueño o un supervisor) y reabrirla (abierta desde resuelta, supervisor y diciendo por qué). La tabla sigue cerrada a UPDATE para quien no sea supervisor.';

revoke all on function public.avanzar_incidencia(uuid, incident_state, text) from public, anon;
grant execute on function public.avanzar_incidencia(uuid, incident_state, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 4 — Cuánto se tarda en cerrar una avería
--
-- Una fila, y las cifras que caben en una baldosa del panel. Se compara con los
-- treinta días anteriores porque un número solo no dice nada: «3,4 días» puede
-- ser una buena noticia o una mala según de dónde se venga.
--
-- Mediana además de media, y no por gusto estadístico: una avería que se quedó
-- ocho meses colgada del histórico importado se lleva la media del mes entero.
-- La mediana dice lo que pasa normalmente; la media, si hay algo atascado.
--
-- Solo `incidencia`: una solicitud tarda lo que tarde en aprobarse un
-- presupuesto y mezclarlas haría que el número dejara de significar nada.
-- -----------------------------------------------------------------------------

create or replace view incident_resolution_speed as
with cerradas as (
  select
    i.resolved_at,
    extract(epoch from (i.resolved_at - i.opened_at)) / 86400.0 as dias
  from incidents i
  where i.kind = 'incidencia'
    and i.state = 'resuelta'
    and i.resolved_at is not null
    -- Una resolución anterior a su apertura es una fila del Excel mal fechada,
    -- no un cierre instantáneo: contarla en negativo hundiría la media.
    and i.resolved_at >= i.opened_at
)
select
  count(*) filter (where resolved_at >= now() - interval '30 days')::int          as cerradas_30d,
  round(avg(dias) filter (where resolved_at >= now() - interval '30 days')::numeric, 1)
                                                                                 as dias_medio_30d,
  round((percentile_cont(0.5) within group (order by dias)
          filter (where resolved_at >= now() - interval '30 days'))::numeric, 1)  as dias_mediana_30d,
  count(*) filter (where resolved_at >= now() - interval '60 days'
                     and resolved_at <  now() - interval '30 days')::int          as cerradas_previo,
  round(avg(dias) filter (where resolved_at >= now() - interval '60 days'
                            and resolved_at <  now() - interval '30 days')::numeric, 1)
                                                                                 as dias_medio_previo
from cerradas;

alter view incident_resolution_speed set (security_invoker = on);

comment on view incident_resolution_speed is
  'Cuánto se tarda en cerrar una avería: cierres y días (media y mediana) de los últimos 30 días, con los 30 anteriores al lado para poder comparar. Solo incidencias; una solicitud tarda lo que tarde un presupuesto.';

notify pgrst, 'reload schema';
