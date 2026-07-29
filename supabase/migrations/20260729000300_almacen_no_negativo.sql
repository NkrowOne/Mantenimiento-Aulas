-- =============================================================================
-- Las existencias no pueden quedar en negativo
--
-- El esquema decía que esto era imposible —«la cantidad actual es una suma,
-- nunca un campo editable»— y no lo era. Que el saldo sea una suma impide el
-- descuadre de teclear una cifra a mano, que es de donde salían los negativos
-- de la hoja Bolsa; no impide restar más de lo que hay. Con el botón `−` de la
-- pantalla de Almacén, un artículo a cero se queda en −1 al siguiente toque, y
-- de ahí baja tanto como se pulse.
--
-- Un saldo negativo no es un dato: es una pregunta sin responder. Puede
-- significar que alguien apuntó un consumo que no hizo, que la compra que lo
-- respaldaba no llegó a registrarse, o que el recuento físico nunca se hizo. Lo
-- que no puede significar es que en el almacén haya menos cero cables, y
-- mientras la cifra siga ahí el informe de consumo la da por buena.
--
-- Dos piezas:
--
--  1. Un disparador que rechaza el movimiento que dejaría el saldo bajo cero.
--     Va en la base y no en la pantalla porque la pantalla se puede saltar: el
--     almacén escribe directo contra PostgREST.
--  2. El saneamiento de lo que ya estuviera en negativo, con el mismo criterio
--     que aplica el importador al Excel: se sube a cero con un ajuste y queda
--     anotado, pendiente de recuento físico. Inventar la cifra buena sería
--     peor que dejar constancia de que no se sabe.
--
-- Lo que el disparador **no** hace es bloquear la corrección. Si un saldo ya
-- está en negativo, la entrada que lo arregla se acepta aunque siga negativo
-- después: solo se rechaza lo que empeora la situación. Al revés, un almacén
-- descuadrado se quedaría sin forma de cuadrarse.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — Sanear lo que ya estuviera en negativo
--
-- Va antes del disparador porque si no, este ajuste tendría que pelearse con
-- él. En una base recién importada no hay ninguno: el importador ya sube a cero
-- los saldos negativos de la hoja Bolsa.
-- -----------------------------------------------------------------------------

with negativos as (
  select sm.stock_item_id, sum(sm.qty)::int as saldo
    from stock_movements sm
   group by sm.stock_item_id
  having sum(sm.qty) < 0
),
ajustes as (
  insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, source, note)
  select gen_random_uuid(), n.stock_item_id, -n.saldo, 'ajuste', now(), 'migracion',
         'Saldo negativo saneado a 0: pendiente de recuento físico'
    from negativos n
  returning stock_item_id, qty
)
insert into import_fixes (source, row_ref, field, original, corrected, reason)
select 'Almacén', si.name, 'stock_levels.on_hand', (-a.qty)::text, '0',
       'Existencias en negativo: se suben a 0 con un ajuste y queda pendiente de recuento físico'
  from ajustes a
  join stock_items si on si.id = a.stock_item_id;

-- -----------------------------------------------------------------------------
-- 2 — El disparador
-- -----------------------------------------------------------------------------

create or replace function public.stock_no_negativo()
returns trigger
language plpgsql
as $$
declare
  v_item   uuid;
  v_delta  int;
  v_saldo  int;
  v_nombre text;
begin
  -- Un movimiento puede tocar dos artículos: si un supervisor corrige el
  -- `stock_item_id` de una salida, la resta desaparece de un almacén y aparece
  -- en otro, y hay que mirar los dos.
  for v_item in
    select distinct x from unnest(array[
      case when tg_op <> 'DELETE' then new.stock_item_id end,
      case when tg_op <> 'INSERT' then old.stock_item_id end
    ]) as t(x) where x is not null
  loop
    -- Sin esto, dos técnicos que gastan a la vez la última unidad pasan los dos
    -- la comprobación: cada uno suma sin ver la fila del otro, todavía sin
    -- confirmar. El cerrojo es por artículo —no bloquea el almacén entero— y se
    -- suelta solo al terminar la transacción.
    --
    -- Se usa un cerrojo de aviso y no un `for update` sobre `stock_items` a
    -- propósito: la propia inserción ya toma un bloqueo de clave sobre esa
    -- fila, y pedir encima el fuerte enfrentaría a dos transacciones que se
    -- esperarían la una a la otra.
    perform pg_advisory_xact_lock(hashtextextended('stock_item:' || v_item, 0));

    select coalesce(sum(qty), 0)::int into v_saldo
      from stock_movements where stock_item_id = v_item;

    -- Cuánto ha movido la aguja este movimiento en ESTE artículo.
    v_delta :=
      coalesce((case when tg_op <> 'DELETE' and new.stock_item_id = v_item then new.qty end), 0) -
      coalesce((case when tg_op <> 'INSERT' and old.stock_item_id = v_item then old.qty end), 0);

    -- Solo se frena lo que empeora. Un almacén que ya está descuadrado tiene
    -- que poder cuadrarse.
    if v_saldo < 0 and v_delta < 0 then
      select name into v_nombre from stock_items where id = v_item;
      raise exception 'No hay tantas unidades de «%»: quedarían % en el almacén',
        coalesce(v_nombre, 'el artículo'), v_saldo
        using errcode = '23514',
              hint = 'Registra primero la compra o el ajuste que respalda esas unidades.';
    end if;
  end loop;

  return null;
end;
$$;

comment on function public.stock_no_negativo() is
  'Rechaza el movimiento que dejaría las existencias bajo cero. Deja pasar el que las corrige.';

-- `after` y no `before`: así comprueba el saldo ya con la fila puesta y el
-- mismo código vale para el alta, la corrección y el borrado.
drop trigger if exists stock_movements_no_negativo on stock_movements;
create trigger stock_movements_no_negativo
  after insert or update or delete on stock_movements
  for each row execute function public.stock_no_negativo();
