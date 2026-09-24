-- =============================================================================
-- El material de una incidencia sale del almacén cuando la incidencia se cierra
--
-- Lo que se veía en el Historial de un aula, con la solicitud todavía abierta:
--
--     Material — Hub USB   +1   +1   −1   −1   −1
--
-- Cinco líneas para un hub. Cada toque en el «+» o el «−» del apunte de
-- material era un asiento en `stock_movements` —un consumo, o la devolución
-- que lo compensaba— y el libro mayor no se reescribe: corregir un toque de
-- más era otro asiento, y el Historial los enseñaba todos. Y el almacén se
-- movía con cada toque, con la solicitud sin terminar.
--
-- Desde aquí, mientras la incidencia está abierta el material es un **parte**:
-- una fila por artículo en `incident_materials` que se sube, se baja o se
-- quita las veces que haga falta sin que el almacén se entere. Cuando la
-- incidencia pasa a `resuelta`, un disparador compara lo que el parte dice con
-- lo que la incidencia ya tiene descontado y apunta **la diferencia neta, un
-- asiento por artículo**, con la fecha del cierre y a nombre de quien cerró.
-- El Historial enseña entonces una línea por artículo, no una por toque.
--
-- Es la misma cuenta que hace `sync_material_del_parte` con el Excel —lo que
-- el parte dice menos lo que ya salió— y a propósito: así el libro y la
-- aplicación pueden tocar el mismo parte sin descontar nada dos veces.
--
-- Lo que se decide aquí:
--
--  - **`incident_materials` es el parte de material, también el de la
--    aplicación.** Existía desde el primer esquema para las 320 líneas de
--    «Material Usado» del Excel, y es la misma cosa: la lista de lo que se
--    puso. Una columna nueva, `origen`, distingue lo que entró del libro
--    (`excel`) de lo que se apuntó desde el aula (`app`).
--  - **El personal escribe en él.** Hasta ahora solo el supervisor; el técnico
--    apuntaba movimientos directamente. Puede dar de alta filas `app` y
--    corregir cualquier fila del parte, que al corregirla pasa a ser `app`.
--  - **El almacén se toca al cerrar, no al apuntar.** Y solo en los partes con
--    alguna fila `app`: un parte que solo tiene lo que trajo el Excel lo lleva
--    el propio Excel, que además sabe si es anterior al arranque del recuento
--    y no debe descontar.
--  - **Si el parte llega detrás del cierre** —la cola sube el material y el
--    cierre en pasadas distintas, o alguien lo apunta a posteriori— se
--    reconcilia en ese momento, con la fecha de ahora. Lo que el parte dice es
--    la verdad, y el almacén la sigue.
--  - **Sin existencias, el cierre no entra.** El disparador que impide el
--    saldo negativo sigue mandando: el cierre vuelve rechazado a la cola con
--    su motivo («No hay tantas unidades de …») y se reintenta cuando se
--    registre la compra o se baje la cantidad del parte. Es preferible a
--    cerrar en silencio con el almacén descuadrado.
--  - **Lo ya apuntado en las incidencias abiertas se conserva.** Sus consumos
--    están en el libro y ahí se quedan; se copian al parte como filas `app`
--    con las unidades netas, así la pantalla los enseña y al cerrar no salen
--    otra vez.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — El parte de material: de dónde viene cada fila y quién lo escribe
-- -----------------------------------------------------------------------------

alter table incident_materials
  add column if not exists origen text not null default 'excel';

alter table incident_materials drop constraint if exists incident_materials_origen_check;
alter table incident_materials
  add constraint incident_materials_origen_check check (origen in ('excel', 'app'));

-- Una fila a cero es «quitada»: se conserva para que el servidor sepa que el
-- artículo ya no cuenta y, si la incidencia ya estaba cerrada, devuelva lo que
-- tuviera descontado. Negativa no significa nada. `not valid` porque las filas
-- que ya hay no se revisan aquí; las nuevas, sí.
alter table incident_materials drop constraint if exists incident_materials_qty_check;
alter table incident_materials
  add constraint incident_materials_qty_check check (qty >= 0) not valid;

create index if not exists incident_materials_incidencia_idx
  on incident_materials(incident_id);

comment on column incident_materials.origen is
  'De dónde salió la fila: excel (columna «Material Usado» del libro) o app (apuntada desde el aula). Solo los partes con alguna fila app se descuentan del almacén al cerrar; los que solo trae el Excel los descuenta el propio Excel.';

-- `(select …)` y no la llamada a secas: envuelta se evalúa una vez por consulta
-- y no una por fila (lo vigila la prueba 80 de `rls-test.sql`).
drop policy if exists "personal apunta material" on incident_materials;
create policy "personal apunta material" on incident_materials
  for insert to authenticated
  with check ((select public.is_staff()) and origen = 'app');

-- Corregir vale para cualquier fila del parte, también las que trajo el Excel:
-- quien tiene el cable en la mano sabe mejor que la hoja cuántos puso. La fila
-- corregida pasa a ser `app`, y con eso el cierre la reconcilia.
drop policy if exists "personal corrige el parte de material" on incident_materials;
create policy "personal corrige el parte de material" on incident_materials
  for update to authenticated
  using ((select public.is_staff()))
  with check ((select public.is_staff()) and origen = 'app');

-- -----------------------------------------------------------------------------
-- 2 — La cuenta: lo que el parte dice menos lo que ya salió
--
-- Interna: la llaman los dos disparadores de abajo y nadie más. `security
-- definer` porque el técnico no puede apuntar devoluciones ni firmar por
-- otro, y aquí hay que hacer las dos cosas: la devolución es la corrección de
-- un parte que baja, y el asiento va a nombre de quien cerró.
-- -----------------------------------------------------------------------------
create or replace function public.material_de_incidencia_al_almacen(
  p_incidencia uuid,
  p_articulo   uuid default null,
  p_cuando     timestamptz default null,
  p_quien      uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room  uuid;
  v_linea record;
  v_ya    int;
  v_falta int;
begin
  -- Un parte sin ninguna fila de la aplicación no es asunto de esta cuenta: lo
  -- que trajo el Excel lo descuenta el Excel, que además sabe si el parte es
  -- anterior al arranque del recuento y no debe descontar nada.
  if not exists (
    select 1 from incident_materials
     where incident_id = p_incidencia and origen = 'app'
  ) then
    return;
  end if;

  select room_id into v_room from incidents where id = p_incidencia;

  -- Todas las filas del artículo, vengan de donde vengan: el parte es la suma.
  -- Una fila a cero cuenta —es la forma de decir «ya no»— y una sin artículo
  -- no puede descontar nada.
  for v_linea in
    select stock_item_id as item, greatest(sum(qty), 0)::int as unidades
      from incident_materials
     where incident_id = p_incidencia
       and stock_item_id is not null
       and (p_articulo is null or stock_item_id = p_articulo)
     group by stock_item_id
  loop
    -- Lo que la incidencia ya tiene descontado de ese artículo, **neto**: los
    -- consumos menos las devoluciones. La misma resta que hace el Excel.
    select coalesce(-sum(qty), 0)::int into v_ya
      from stock_movements
     where incident_id = p_incidencia
       and stock_item_id = v_linea.item
       and kind in ('consumo', 'devolucion');

    v_falta := v_linea.unidades - v_ya;

    if v_falta > 0 then
      insert into stock_movements (id, stock_item_id, qty, kind, incident_id, room_id, occurred_at, by_user, source)
      values (gen_random_uuid(), v_linea.item, -v_falta, 'consumo', p_incidencia, v_room,
              coalesce(p_cuando, now()), p_quien, 'app');
    elsif v_falta < 0 then
      insert into stock_movements (id, stock_item_id, qty, kind, incident_id, room_id, occurred_at, by_user, source, note)
      values (gen_random_uuid(), v_linea.item, -v_falta, 'devolucion', p_incidencia, v_room,
              coalesce(p_cuando, now()), p_quien, 'app',
              format('El parte baja la cantidad a %s: vuelven %s al almacén', v_linea.unidades, -v_falta));
    end if;
  end loop;
end;
$$;

comment on function public.material_de_incidencia_al_almacen(uuid, uuid, timestamptz, uuid) is
  'Cuadra el almacén con el parte de material de una incidencia: por artículo, lo que el parte dice menos lo que la incidencia ya tiene descontado. Más es un consumo, menos una devolución. No hace nada si el parte no tiene ninguna fila apuntada desde la aplicación.';

revoke all on function public.material_de_incidencia_al_almacen(uuid, uuid, timestamptz, uuid)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3 — Cuándo se hace la cuenta
-- -----------------------------------------------------------------------------

-- Al cerrar: la incidencia pasa a resuelta, venga el cierre de donde venga
-- —`incident_resolutions`, el supervisor, el Excel—. Con la fecha del cierre y
-- a nombre de quien cerró, que es lo que el Historial de la sala enseña.
create or replace function public.material_al_cerrar_la_incidencia()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.material_de_incidencia_al_almacen(
    new.id, null, coalesce(new.resolved_at, now()), new.resolved_by);
  return null;
end;
$$;

revoke all on function public.material_al_cerrar_la_incidencia() from public, anon, authenticated;

drop trigger if exists incidents_material_al_cerrar on incidents;
create trigger incidents_material_al_cerrar
  after update of state on incidents
  for each row
  when (new.state = 'resuelta' and old.state is distinct from 'resuelta')
  execute function public.material_al_cerrar_la_incidencia();

-- Y al tocar el parte de una incidencia que ya está cerrada: el material que
-- llega detrás del cierre —la cola los sube en pasadas distintas— o el que se
-- apunta a posteriori. Solo una fila de la aplicación dispara la cuenta: las
-- que rehace el Excel las cuadra el propio Excel en la misma operación, y
-- cuando el Excel borra las de la aplicación para rehacer el parte, la cuenta
-- se encuentra sin filas `app` y no hace nada.
create or replace function public.material_de_incidencia_cerrada()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_incidencia uuid := coalesce(new.incident_id, old.incident_id);
  v_cerrada    boolean;
begin
  if coalesce(new.origen, '') <> 'app' and coalesce(old.origen, '') <> 'app' then
    return null;
  end if;

  select state = 'resuelta' into v_cerrada from incidents where id = v_incidencia;
  if not coalesce(v_cerrada, false) then
    return null;
  end if;

  -- El artículo de la fila, y el anterior si se cambió de artículo.
  if new.stock_item_id is not null then
    perform public.material_de_incidencia_al_almacen(v_incidencia, new.stock_item_id, now(), auth.uid());
  end if;
  if old.stock_item_id is not null and old.stock_item_id is distinct from new.stock_item_id then
    perform public.material_de_incidencia_al_almacen(v_incidencia, old.stock_item_id, now(), auth.uid());
  end if;

  return null;
end;
$$;

revoke all on function public.material_de_incidencia_cerrada() from public, anon, authenticated;

drop trigger if exists incident_materials_de_incidencia_cerrada on incident_materials;
create trigger incident_materials_de_incidencia_cerrada
  after insert or update or delete on incident_materials
  for each row execute function public.material_de_incidencia_cerrada();

-- -----------------------------------------------------------------------------
-- 4 — Lo que las incidencias abiertas ya tenían apuntado
--
-- Sus consumos están en el libro y ahí se quedan. Al parte van las unidades
-- netas de cada artículo, como filas `app`: la pantalla las enseña, se pueden
-- corregir, y al cerrar la cuenta sale a cero y no descuenta nada otra vez.
-- Donde el parte ya tuviera una fila del artículo —la trajo el Excel— no se
-- añade otra.
-- -----------------------------------------------------------------------------
insert into incident_materials (id, incident_id, stock_item_id, qty, origen)
select gen_random_uuid(), sm.incident_id, sm.stock_item_id, (-sum(sm.qty))::int, 'app'
  from stock_movements sm
  join incidents i on i.id = sm.incident_id
 where i.state <> 'resuelta'
   and sm.kind in ('consumo', 'devolucion')
   and not exists (
     select 1 from incident_materials im
      where im.incident_id = sm.incident_id and im.stock_item_id = sm.stock_item_id
   )
 group by sm.incident_id, sm.stock_item_id
having -sum(sm.qty) > 0;

notify pgrst, 'reload schema';
