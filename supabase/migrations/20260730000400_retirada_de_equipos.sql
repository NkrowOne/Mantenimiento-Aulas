-- =============================================================================
-- Sacar un equipo de una sala: quién lo pide y quién lo autoriza
--
-- Faltaba el camino de vuelta. Dar de alta inventario desde el aula estaba
-- resuelto —y con su bandeja de validación—, pero **quitarlo** era un botón
-- suelto: «Retirar de la sala», un toque, y el equipo desaparecía del
-- inventario sin que nadie se enterara ni pudiera decir que no.
--
-- Y las dos formas de quitarlo no son la misma cosa, que es justo lo que el
-- botón único ocultaba:
--
--  - **Baja** — el aparato se ha muerto. Sale del inventario y no vuelve.
--  - **Al almacén** — el aparato está bien y se lleva a la estantería. Sale del
--    inventario **y suma una unidad al almacén**, porque físicamente está allí.
--    Sin esta distinción, cada equipo que volvía al almacén era una unidad que
--    el sistema perdía: el aula dejaba de tenerla y el almacén nunca la
--    ingresaba.
--
-- Las dos pasan a ser una **solicitud**: el técnico la firma en el aula —sin
-- cobertura, como todo lo demás— y un coordinador la autoriza. Mientras tanto
-- el equipo sigue en la sala y marcado, que es la verdad: todavía está ahí.
--
-- Y la otra mitad, la del equipo que un coordinador NO autoriza: se borra. Un
-- equipo sin validar es una propuesta, y rechazar una propuesta no deja un
-- aparato retirado en el histórico de una sala donde nunca hubo nada — deja la
-- fila de auditoría de quien lo descartó, que es todo lo que hay que conservar.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — Descartar lo que no se autoriza
--
-- Solo alcanza a lo que está **sin validar**. Un equipo ya confirmado no se
-- descarta: se retira con una solicitud, que es el camino de abajo y el que
-- deja el rastro que un aparato real merece.
--
-- Borra o retira, y lo decide lo que cuelgue de él, igual que `delete_room`:
-- si alguna revisión lo comprobó, si tiene eventos o si hay una incidencia
-- apuntándole, borrarlo dejaría huecos en cosas que ya se firmaron. Entonces se
-- retira, que a efectos de la sala es lo mismo —desaparece de la lista, del
-- formulario de revisión y del dispositivo— pero no rompe nada.
-- -----------------------------------------------------------------------------

create or replace function public.reject_asset(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_confirmed boolean;
  v_atado boolean;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador descarta equipos'
      using errcode = 'insufficient_privilege';
  end if;

  select confirmed into v_confirmed from assets where id = p_id;
  if v_confirmed is null then
    raise exception 'Ese equipo ya no existe';
  end if;
  if v_confirmed then
    raise exception 'Ese equipo ya está validado: para sacarlo de la sala hace falta una solicitud de retirada';
  end if;

  select exists (select 1 from inspection_checks where check_key = 'asset:' || p_id::text)
      or exists (select 1 from asset_events where asset_id = p_id)
      or exists (select 1 from incidents where asset_id = p_id)
    into v_atado;

  if v_atado then
    update assets set status = 'retirado' where id = p_id;
    return 'retirado';
  end if;

  -- El rastro no se pierde: `assets` lleva disparador de auditoría desde el
  -- principio, así que el borrado deja fila con autor y con la fila entera de
  -- antes en `old_data`.
  delete from assets where id = p_id;
  return 'borrado';
end;
$$;

comment on function public.reject_asset(uuid) is
  'Descarta un equipo sin validar. Devuelve «borrado» o «retirado» según cuelgue algo de él.';

-- -----------------------------------------------------------------------------
-- 2 — La solicitud de retirada
--
-- Va en tabla propia y no como una incidencia de tipo «solicitud» porque tiene
-- que **hacer algo al aprobarse** —retirar el equipo y, si vuelve al almacén,
-- ingresar la unidad—, y una incidencia resuelta no mueve inventario.
--
-- Sube por la cola de salida como una fila más, así que se firma en el aula sin
-- cobertura, que es donde se decide que un aparato sobra.
-- -----------------------------------------------------------------------------

create table if not exists asset_removals (
  -- uuid v7 del cliente: es la clave de idempotencia de la cola de salida.
  id           uuid primary key,
  asset_id     uuid not null references assets(id) on delete cascade,
  -- La sala de la que sale, guardada aparte porque el equipo la pierde al
  -- aprobarse y el histórico de la sala tiene que seguir sabiéndolo.
  room_id      uuid references rooms(id) on delete set null,
  destino      text not null check (destino in ('baja', 'almacen')),
  reason       text,
  state        text not null default 'pendiente'
               check (state in ('pendiente', 'aprobada', 'rechazada')),
  requested_at timestamptz not null,
  requested_by uuid references profiles(id),
  decided_at   timestamptz,
  decided_by   uuid references profiles(id),
  decision_note text
);

comment on table asset_removals is
  'Solicitud de sacar un equipo de una sala: de baja, o de vuelta al almacén. La autoriza un coordinador.';
comment on column asset_removals.destino is
  'baja = el aparato se ha muerto. almacen = está bien y vuelve a la estantería, sumando una unidad.';

-- Una sola solicitud viva por equipo. Dos técnicos pidiendo lo mismo la misma
-- mañana acabarían retirando dos veces el mismo aparato y, con destino almacén,
-- ingresando dos unidades que no existen.
create unique index if not exists asset_removals_pendiente_idx
  on asset_removals (asset_id) where state = 'pendiente';

create index if not exists asset_removals_cola_idx
  on asset_removals (requested_at) where state = 'pendiente';

alter table asset_removals enable row level security;

drop policy if exists "personal lee solicitudes de retirada" on asset_removals;
create policy "personal lee solicitudes de retirada" on asset_removals
  for select to authenticated using (public.is_staff());

-- La firma quien está en el aula, y solo la suya. `state` cerrado a 'pendiente'
-- para que nadie se autoapruebe una retirada colándola ya aprobada.
drop policy if exists "personal solicita retiradas" on asset_removals;
create policy "personal solicita retiradas" on asset_removals
  for insert to authenticated
  with check (
    public.is_staff()
    and requested_by = (select auth.uid())
    and state = 'pendiente'
  );

-- Y puede retirar lo que pidió mientras nadie lo haya decidido: equivocarse al
-- pulsar no puede costar una visita al coordinador.
drop policy if exists "personal cancela su solicitud" on asset_removals;
create policy "personal cancela su solicitud" on asset_removals
  for delete to authenticated
  using (public.is_staff() and requested_by = (select auth.uid()) and state = 'pendiente');

-- No hay política de UPDATE, y es a propósito: decidir se hace por
-- `decide_asset_removal`, que son cuatro escrituras que tienen que pasar juntas.

drop trigger if exists asset_removals_audit on asset_removals;
create trigger asset_removals_audit
  after insert or update or delete on asset_removals
  for each row execute function public.audit_trigger();

/**
 * Autorizar o rechazar una retirada.
 *
 * Aprobar es cuatro cosas a la vez, y por eso va en una función: retirar el
 * equipo, dejar el evento que lo cuenta en el histórico de la sala, ingresar la
 * unidad en el almacén si vuelve allí, y cerrar la solicitud. A medias quedaría
 * un aparato retirado que nadie ingresó, o una unidad de almacén que no salió de
 * ningún sitio.
 *
 * Devuelve qué ha pasado, en palabras, porque una de las salidas no es ni éxito
 * ni fallo: `almacen_sin_articulo` es un equipo que vuelve a la estantería pero
 * cuyo tipo no tiene artículo de almacén con el que contarlo. La retirada es
 * correcta y el ingreso no se puede hacer; callarlo dejaría al coordinador
 * creyendo que ha sumado una unidad que no ha sumado.
 */
create or replace function public.decide_asset_removal(
  p_id      uuid,
  p_aprobar boolean,
  p_note    text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  s          record;
  v_type     uuid;
  v_item     uuid;
  v_evento   uuid := gen_random_uuid();
  v_yo       uuid := (select auth.uid());
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador autoriza una retirada'
      using errcode = 'insufficient_privilege';
  end if;

  select * into s from asset_removals where id = p_id;
  if s.id is null then
    raise exception 'Esa solicitud ya no existe';
  end if;
  if s.state <> 'pendiente' then
    raise exception 'Esa solicitud ya está %', s.state;
  end if;

  if not p_aprobar then
    update asset_removals
       set state = 'rechazada', decided_at = now(), decided_by = v_yo, decision_note = p_note
     where id = p_id;
    return 'rechazada';
  end if;

  -- El tipo se resuelve siguiendo las fusiones: si el catálogo se agrupó por
  -- medio, el artículo de almacén cuelga del tipo bueno y no de la lápida.
  select coalesce(t.merged_into, t.id) into v_type
    from assets a join asset_types t on t.id = a.asset_type_id
   where a.id = s.asset_id;

  update assets
     set status = 'retirado',
         -- De baja conserva la sala: el aparato ya no existe, y dónde estuvo es
         -- lo único que queda de él. El que vuelve al almacén sí la pierde,
         -- porque físicamente ya no está en ninguna.
         room_id = case when s.destino = 'almacen' then null else room_id end
   where id = s.asset_id;

  -- La `room_id` va en el evento y no se deja deducir del equipo: con destino
  -- almacén el equipo se queda sin sala, y `room_timeline` colgaría la baja de
  -- ninguna parte.
  insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
  values (
    v_evento, s.asset_id, s.room_id, 'baja', now(), v_yo,
    jsonb_build_object(
      'destino', s.destino,
      'solicitud', s.id,
      'solicitado_por', s.requested_by,
      'nota', coalesce(nullif(btrim(coalesce(p_note, '')), ''), s.reason)
    )
  );

  update asset_removals
     set state = 'aprobada', decided_at = now(), decided_by = v_yo, decision_note = p_note
   where id = p_id;

  if s.destino <> 'almacen' then
    return 'baja';
  end if;

  select id into v_item
    from stock_items
   where asset_type_id = v_type and active
   order by name
   limit 1;

  if v_item is null then
    return 'almacen_sin_articulo';
  end if;

  -- `devolucion` y no `compra`: no ha entrado nada nuevo en el centro, ha vuelto
  -- algo que ya era suyo. La sala queda anotada, que es lo que permite leer el
  -- movimiento como «salió de allí» en vez de como una entrada sin origen.
  insert into stock_movements (id, stock_item_id, qty, kind, room_id, occurred_at, by_user, note)
  values (
    gen_random_uuid(), v_item, 1, 'devolucion', s.room_id, now(), v_yo,
    'Devuelto desde el aula al retirar un equipo'
  );

  return 'almacen';
end;
$$;

comment on function public.decide_asset_removal(uuid, boolean, text) is
  'Autoriza o rechaza una retirada. Al aprobar retira el equipo y, si vuelve al almacén, ingresa la unidad.';

-- -----------------------------------------------------------------------------
-- 3 — La cola, con todo lo que hace falta para decidir
--
-- El panel necesita el aparato, la sala, quién lo pidió y —si vuelve al
-- almacén— en qué artículo va a caer la unidad. Resuelto en una vista, el panel
-- hace una consulta en vez de cinco, y sobre todo puede enseñar «no hay artículo
-- de almacén para esto» ANTES de aprobar en vez de después.
-- -----------------------------------------------------------------------------

create or replace view asset_removal_queue as
select
  rm.id,
  rm.asset_id,
  rm.destino,
  rm.reason,
  rm.requested_at,
  rm.requested_by,
  p.full_name        as requested_by_name,
  a.label            as asset_label,
  a.serial,
  a.model,
  a.confirmed        as asset_confirmed,
  t.name             as type_name,
  rm.room_id,
  r.code             as room_code,
  r.name             as room_name,
  b.code             as building_code,
  si.id              as stock_item_id,
  si.name            as stock_item_name
from asset_removals rm
join assets a         on a.id = rm.asset_id
left join asset_types t on t.id = a.asset_type_id
left join rooms r      on r.id = rm.room_id
left join zones z      on z.id = r.zone_id
left join buildings b  on b.id = z.building_id
left join profiles p   on p.id = rm.requested_by
-- Lateral y no `join` a secas: un tipo puede tener más de un artículo de
-- almacén, y con un join normal la solicitud saldría repetida en la cola.
left join lateral (
  select s.id, s.name
    from stock_items s
   where s.asset_type_id = coalesce(t.merged_into, t.id) and s.active
   order by s.name
   limit 1
) si on true
where rm.state = 'pendiente';

alter view asset_removal_queue set (security_invoker = on);

comment on view asset_removal_queue is
  'Retiradas por autorizar, con la sala, quién la pidió y el artículo de almacén al que iría la unidad.';

grant execute on function public.reject_asset(uuid)                            to authenticated;
grant execute on function public.decide_asset_removal(uuid, boolean, text)     to authenticated;

notify pgrst, 'reload schema';
