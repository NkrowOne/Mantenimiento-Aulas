-- =============================================================================
-- El saldo del almacén no se vuelve a sumar
--
-- «La cantidad actual es SUM(qty), no un campo editable» sigue siendo la
-- regla: nadie teclea un saldo. Lo que cambia es CUÁNDO se suma. Hasta hoy,
-- cada lectura de `stock_levels` —la pestaña Almacén, el panel, el informe y
-- la bajada del espejo de cada dispositivo— recorría todos los movimientos de
-- la historia, y el disparador que impide el negativo volvía a sumarlos en
-- cada alta. Con unos miles de asientos no se nota; con los años son cientos
-- de miles, y el almacén es la pantalla que se abre en el aula.
--
-- Ahora el saldo se mantiene al escribir: `stock_balances` lleva una fila por
-- artículo y un disparador por fila la pone al día con cada movimiento. Como
-- los movimientos son solo-alta, mantenerlo es sumar; las ramas de corrección
-- y borrado están igualmente cubiertas para la reparación a mano que
-- desactiva el disparador de inmutabilidad. `stock_levels` pasa a leer esa
-- tabla con las mismas columnas y en el mismo orden, así que nadie que la
-- consulte nota el cambio salvo en el tiempo.
--
-- Y si alguna vez el saldo y el libro dejaran de cuadrar —una reparación a
-- mano que tocó movimientos con los disparadores apagados—,
-- `stock_balances_recalcular()` lo rehace entero desde los asientos.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — La tabla de saldos
-- -----------------------------------------------------------------------------

create table if not exists stock_balances (
  stock_item_id   uuid primary key references stock_items(id) on delete cascade,
  on_hand         int not null default 0,
  -- Unidades consumidas, en positivo (los consumos van con signo negativo).
  total_consumed  int not null default 0,
  total_purchased int not null default 0,
  updated_at      timestamptz not null default now()
);

comment on table stock_balances is
  'Saldo de cada artículo, mantenido por el disparador stock_movements_actualiza_saldo. Es la suma de los movimientos, no un campo que se edite; stock_balances_recalcular() lo rehace desde los asientos.';

alter table stock_balances enable row level security;

-- Lo lee el personal (la vista corre con los permisos de quien consulta);
-- lo escribe solo el disparador, con permisos propios.
drop policy if exists "personal lee saldos" on stock_balances;
create policy "personal lee saldos" on stock_balances
  for select to authenticated using (public.is_staff());

-- -----------------------------------------------------------------------------
-- 2 — El disparador que lo mantiene
-- -----------------------------------------------------------------------------

/** Suma un movimiento al saldo de su artículo (o lo resta, pasando la cantidad cambiada de signo). */
create or replace function public.stock_balance_sumar(p_item uuid, p_qty int, p_kind text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into stock_balances (stock_item_id, on_hand, total_consumed, total_purchased, updated_at)
  values (
    p_item,
    p_qty,
    case when p_kind = 'consumo' then -p_qty else 0 end,
    case when p_kind = 'compra'  then  p_qty else 0 end,
    now()
  )
  on conflict (stock_item_id) do update
    set on_hand         = stock_balances.on_hand         + excluded.on_hand,
        total_consumed  = stock_balances.total_consumed  + excluded.total_consumed,
        total_purchased = stock_balances.total_purchased + excluded.total_purchased,
        updated_at      = now();
$$;

revoke all on function public.stock_balance_sumar(uuid, int, text) from public, anon, authenticated;

create or replace function public.stock_balances_mantener()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Corrección o borrado: se deshace lo que aportaba la fila anterior.
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.stock_balance_sumar(old.stock_item_id, -old.qty, old.kind);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.stock_balance_sumar(new.stock_item_id, new.qty, new.kind);
  end if;
  return null;
end $$;

comment on function public.stock_balances_mantener() is
  'Disparador por fila de stock_movements: mantiene stock_balances con cada asiento.';

revoke all on function public.stock_balances_mantener() from public, anon, authenticated;

-- El nombre importa: Postgres dispara los `after` del mismo evento por orden
-- alfabético, y este tiene que ir ANTES de `stock_movements_no_negativo`, que
-- ahora lee el saldo en vez de sumarlo («actualiza» < «no_negativo»).
drop trigger if exists stock_movements_actualiza_saldo on stock_movements;
create trigger stock_movements_actualiza_saldo
  after insert or update or delete on stock_movements
  for each row execute function public.stock_balances_mantener();

-- -----------------------------------------------------------------------------
-- 3 — El disparador del negativo lee el saldo en vez de sumarlo
--
-- Mismo criterio que antes: solo se frena lo que empeora un saldo bajo cero.
-- El cerrojo por artículo se conserva; con el saldo en una fila, la propia
-- actualización ya serializa a dos técnicos que gastan a la vez la última
-- unidad, pero el cerrojo no estorba y protege la lectura si algún día el
-- orden de los disparadores cambiara.
-- -----------------------------------------------------------------------------

create or replace function public.stock_no_negativo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item   uuid;
  v_delta  int;
  v_saldo  int;
  v_nombre text;
begin
  for v_item in
    select distinct x from unnest(array[
      case when tg_op <> 'DELETE' then new.stock_item_id end,
      case when tg_op <> 'INSERT' then old.stock_item_id end
    ]) as t(x) where x is not null
  loop
    perform pg_advisory_xact_lock(hashtextextended('stock_item:' || v_item, 0));
    -- Una lectura: el saldo ya lleva este movimiento (ver el orden de arriba).
    select coalesce(b.on_hand, 0) into v_saldo
      from stock_balances b where b.stock_item_id = v_item;
    v_saldo := coalesce(v_saldo, 0);
    v_delta :=
      coalesce((case when tg_op <> 'DELETE' and new.stock_item_id = v_item then new.qty end), 0) -
      coalesce((case when tg_op <> 'INSERT' and old.stock_item_id = v_item then old.qty end), 0);
    if v_saldo < 0 and v_delta < 0 then
      select name into v_nombre from stock_items where id = v_item;
      raise exception 'No hay tantas unidades de «%»: quedarían % en el almacén',
        coalesce(v_nombre, 'el artículo'), v_saldo
        using errcode = '23514',
              hint = 'Registra primero la compra o el ajuste que respalda esas unidades.';
    end if;
  end loop;
  return null;
end $$;

comment on function public.stock_no_negativo() is
  'Rechaza el movimiento que dejaría las existencias bajo cero. Deja pasar el que las corrige. Lee stock_balances.';

-- -----------------------------------------------------------------------------
-- 4 — Rehacer los saldos desde el libro (y la primera carga)
--
-- Solo desde la terminal: la aplicación no la necesita nunca, y quien repara
-- a mano con los disparadores apagados es quien tiene que llamarla después.
-- -----------------------------------------------------------------------------

create or replace function public.stock_balances_recalcular()
returns int
language plpgsql
set search_path = public
as $$
declare
  n int;
begin
  delete from stock_balances;
  insert into stock_balances (stock_item_id, on_hand, total_consumed, total_purchased, updated_at)
  select sm.stock_item_id,
         coalesce(sum(sm.qty), 0)::int,
         coalesce(sum(sm.qty) filter (where sm.kind = 'consumo'), 0)::int * -1,
         coalesce(sum(sm.qty) filter (where sm.kind = 'compra'),  0)::int,
         now()
    from stock_movements sm
   group by sm.stock_item_id;
  get diagnostics n = row_count;
  return n;
end $$;

comment on function public.stock_balances_recalcular() is
  'Rehace stock_balances entera desde stock_movements. Devuelve cuántos artículos tienen saldo. Para después de una reparación a mano.';

revoke all on function public.stock_balances_recalcular() from public, anon, authenticated;

select public.stock_balances_recalcular();

-- -----------------------------------------------------------------------------
-- 5 — La vista, con las mismas columnas y en el mismo orden
-- -----------------------------------------------------------------------------

create or replace view stock_levels as
select
  si.id                                    as stock_item_id,
  si.name,
  si.unit,
  si.min_threshold,
  coalesce(b.on_hand, 0)::int              as on_hand,
  coalesce(b.total_consumed, 0)::int       as total_consumed,
  coalesce(b.total_purchased, 0)::int      as total_purchased,
  -- Solo alerta si alguien fijó un mínimo de verdad (igual que antes).
  si.min_threshold > 0 and coalesce(b.on_hand, 0) <= si.min_threshold as below_threshold
from stock_items si
left join stock_balances b on b.stock_item_id = si.id
where si.active;

alter view stock_levels set (security_invoker = on);

notify pgrst, 'reload schema';
