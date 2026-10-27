-- reejecutable: si
--
-- Todo lo que hay aquí da lo mismo la segunda vez que la primera: `add column
-- if not exists`, `create table if not exists`, `drop constraint if exists` y
-- `add constraint` en la misma sentencia, `create or replace` para las
-- funciones y la vista, `drop trigger if exists` delante de cada `create
-- trigger`, `drop policy if exists` delante de cada `create policy`, `comment`,
-- `grant`, `revoke` y `alter view … set (security_invoker = on)`. Los saldos por
-- estado se rehacen enteros desde los asientos, que es rehacerlos igual. Y el
-- único `update` de datos —qué artículos se llevan por número de serie— solo
-- corre la vez que nace la columna: va en un bloque que mira antes si la
-- columna ya estaba, así que repetir la migración no le devuelve el «serie» a un
-- artículo que un administrador haya pasado después a «cantidad». La deducción
-- automática no sabe leer ese bloque, así que se dice aquí.
-- =============================================================================
-- El estado, también por cantidad
--
-- Ayer cada unidad con número de serie aprendió a decir cómo está (nueva,
-- usada, reacondicionada, averiada). Pero la mayor parte del almacén no lleva
-- número de serie: teclados, ratones, cables, adaptadores. Se cuentan, y de
-- ellos lo que hace falta saber es «de estos 8, 5 son nuevos y 3 usados» —lo
-- que los programas de almacén llaman el estado del inventario—: el saldo de un
-- artículo no es una cifra sino una por estado, y cambiar el estado de tres es
-- moverlas de una cifra a otra sin que cambie el total.
--
-- Lo que hay desde hoy:
--
--  1. **Cada movimiento dice en qué estado entra o sale** (`condicion`). Lo de
--     antes de hoy, «sin indicar», que es lo que es.
--  2. **Cada artículo dice cómo se lleva** (`seguimiento`): por cantidad, con el
--     estado en los movimientos, o por número de serie, con el estado en cada
--     unidad. Los que ya tienen unidades empiezan por número de serie; el resto,
--     por cantidad. Lo cambia un administrador.
--  3. **Un disparador pone el estado a lo que llega sin él**, que es todo lo que
--     se escribe hoy: la aplicación vieja que queda en caché en algún iPad, la
--     cola de salida, el cierre de una incidencia, la sincronización del Excel,
--     la vuelta de un equipo al almacén. Ninguno de ellos cambia, y a ninguno lo
--     rechaza el estado: solo el total, como siempre.
--  4. **El saldo por estado se lleva al escribir**, como el total
--     (`20260923000400`): en `stock_balances_por_estado`, que se lee en la vista
--     `stock_levels_por_estado`. `stock_levels` no cambia.
--  5. **Cambiar el estado** de N unidades (`stock_cambiar_estado`) y **dar de
--     alta muchas unidades de golpe** (`stock_unit_alta_varias`).
--  6. Y tres retoques de ayer: la unidad que entra sumando apunta su estado en
--     el asiento, la que se instala descuenta de su estado si quedan en él, y lo
--     que vuelve de un aula entra usado.
--
-- Los errores llevan código, como los de ayer, y es lo que lee la pantalla:
--
--   42501  no le toca a ese rol;
--   22023  falta un dato o no vale: un estado que no existe, una cantidad de
--          cero, un artículo que se lleva por número de serie, una lista de
--          más de 500 números…;
--   23514  no quedan tantas. En un estado, para un artículo por cantidad:
--          «No quedan tantas en estado «Usado» de «Teclado»: hay 2.». En total,
--          el de siempre: «No hay tantas unidades de «Teclado»: quedarían -1 en
--          el almacén».
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — En qué estado entra o sale cada movimiento
--
-- Los mismos cinco valores que `stock_units.condicion`, y con un `check` con
-- nombre por lo mismo que allí: se quita y se pone en la misma sentencia.
--
-- Los movimientos son solo-alta (`20260729000500`): los que ya hay no se tocan
-- con un `update`, y no hace falta. La columna nace con `default
-- 'sin_indicar'`, que para una constante Postgres guarda en el catálogo sin
-- reescribir la tabla, y todas las filas de hasta hoy leen «sin indicar» sin que
-- nadie las escriba. Ese defecto se quita en el punto 4, en cuanto está el
-- disparador: una fila nueva que no diga el estado tiene que llegarle como NULL
-- —«no lo dice»— y no como un «sin indicar» que parecería dicho a propósito. El
-- `not null` se comprueba después de los disparadores BEFORE, así que ese NULL
-- no llega nunca a la tabla.
-- -----------------------------------------------------------------------------

alter table stock_movements
  add column if not exists condicion text not null default 'sin_indicar';

alter table stock_movements
  drop constraint if exists stock_movements_condicion_check,
  add constraint stock_movements_condicion_check
    check (condicion in ('nuevo', 'usado', 'reacondicionado', 'averiado', 'sin_indicar'));

comment on column stock_movements.condicion is
  'En qué estado entran o salen estas unidades: nuevo, usado, reacondicionado, averiado o sin_indicar. Si no se dice, lo pone el disparador stock_movement_con_estado: al entrar, por la clase (compra nuevo, devolución usado, ajuste sin_indicar); al salir, de lo que haya por este orden: usado, reacondicionado, sin_indicar, nuevo y, en último lugar, averiado. Lo anterior al 27/10/2026 está sin_indicar.';

-- -----------------------------------------------------------------------------
-- 2 — Cómo se lleva cada artículo
--
-- Por cantidad o por número de serie, como en cualquier programa de almacén:
--
--   cantidad  se cuentan, y el estado va en los movimientos: cuántas nuevas,
--             cuántas usadas. Cables, teclados, ratones.
--   serie     cada aparato con su número y su estado, en `stock_units`, y al
--             instalar se elige cuál. Ordenadores, proyectores, pantallas.
--
-- Empiezan por número de serie los artículos que ya tienen alguna unidad —de la
-- hoja de PCs, del despacho o de una vuelta al almacén—, y el resto por
-- cantidad. Después lo decide un administrador: la política «admin escribe
-- stock_items» (`20260728000300`) es la única que deja escribir en la tabla, y
-- vale también para esta columna.
--
-- Ese primer reparto es el `update` de la cabecera, y por eso va en un bloque:
-- solo corre si la columna no existía. Si se repite la migración, la columna ya
-- está, el bloque no hace nada, y lo que haya decidido un administrador se
-- queda como lo dejó. Con `not null default 'cantidad'` la columna nace con un
-- valor en cada fila sin reescribir la tabla, y el `update` solo toca los
-- artículos que pasan a «serie» —cada uno con su fila en la Actividad, que es
-- un cambio de verdad—.
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_attribute
     where attrelid = 'public.stock_items'::regclass
       and attname = 'seguimiento'
       and not attisdropped
  ) then
    alter table public.stock_items
      add column seguimiento text not null default 'cantidad';

    update public.stock_items si
       set seguimiento = 'serie'
     where exists (select 1 from public.stock_units u where u.stock_item_id = si.id);
  end if;
end $$;

alter table stock_items
  drop constraint if exists stock_items_seguimiento_check,
  add constraint stock_items_seguimiento_check
    check (seguimiento in ('cantidad', 'serie'));

comment on column stock_items.seguimiento is
  'Cómo se lleva el artículo: cantidad (se cuenta, y el estado va en los movimientos) o serie (cada unidad con su número y su estado en stock_units). Empezaron por serie los que ya tenían unidades el 27/10/2026; lo cambia un administrador.';

-- -----------------------------------------------------------------------------
-- 3 — El saldo de cada artículo, partido por estados
--
-- Una tabla aparte y no cinco columnas más en `stock_balances`. `stock_levels`
-- tiene las columnas congeladas (`contrato-saldos.test.ts`), y `stock_balances`
-- es lo que lee la comprobación del negativo: se queda exactamente como estaba,
-- con su disparador AFTER. Aquí va una fila por artículo y estado, solo de los
-- estados en los que ha habido movimiento, y la suma de las de un artículo es
-- su `on_hand`, siempre: los dos saldos suman los mismos asientos, uno agrupado
-- por artículo y el otro por artículo y estado.
--
-- Y la mantiene otro disparador, el BEFORE del punto 4 —el mismo que decide el
-- estado— y no uno AFTER como el del total. Allí se explica por qué.
--
-- Lo lee el personal (la vista corre con los permisos de quien consulta) y no
-- lo escribe nadie más que los disparadores, con permisos propios.
-- -----------------------------------------------------------------------------

create table if not exists stock_balances_por_estado (
  stock_item_id uuid not null references stock_items(id) on delete cascade,
  condicion     text not null
                constraint stock_balances_por_estado_condicion_check
                check (condicion in ('nuevo', 'usado', 'reacondicionado', 'averiado', 'sin_indicar')),
  on_hand       int  not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (stock_item_id, condicion)
);

comment on table stock_balances_por_estado is
  'Saldo de cada artículo en cada estado: la suma de sus movimientos agrupada por condicion. La mantiene el disparador stock_movement_con_estado al escribir (y stock_balances_por_estado_mantener en una reparación a mano); stock_balances_recalcular() la rehace desde los asientos. La suma de las filas de un artículo es su on_hand.';

alter table stock_balances_por_estado enable row level security;

-- `(select …)`: una vez por consulta y no una por fila (prueba 80).
drop policy if exists "personal lee saldos por estado" on stock_balances_por_estado;
create policy "personal lee saldos por estado" on stock_balances_por_estado
  for select to authenticated using ((select public.is_staff()));

revoke all on public.stock_balances_por_estado from anon;
revoke insert, update, delete, truncate on public.stock_balances_por_estado from authenticated;
grant select on public.stock_balances_por_estado to authenticated;

/** Suma unas unidades al saldo de un artículo en un estado (o las resta, en negativo). */
create or replace function public.stock_balance_por_estado_sumar(p_item uuid, p_condicion text, p_qty int)
returns void
language sql
security definer
set search_path = public
as $$
  insert into stock_balances_por_estado (stock_item_id, condicion, on_hand, updated_at)
  values (p_item, p_condicion, p_qty, now())
  on conflict (stock_item_id, condicion) do update
    set on_hand    = stock_balances_por_estado.on_hand + excluded.on_hand,
        updated_at = now();
$$;

revoke all on function public.stock_balance_por_estado_sumar(uuid, text, int) from public, anon, authenticated;

/**
 * Rehacer los saldos desde el libro: el total, como desde septiembre, y ahora
 * también el de cada estado. Solo desde la terminal, después de una reparación
 * a mano con los disparadores apagados.
 *
 * El `lock` es nuevo: sin él, un movimiento que entrara mientras tanto podría
 * apuntarse en una tabla a medio rehacer. En `share` deja leer y espera a los
 * que escriben.
 */
create or replace function public.stock_balances_recalcular()
returns int
language plpgsql
set search_path = public
as $$
declare
  n int;
begin
  lock table stock_movements in share mode;

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

  -- Los mismos asientos, por artículo y estado.
  delete from stock_balances_por_estado;
  insert into stock_balances_por_estado (stock_item_id, condicion, on_hand, updated_at)
  select sm.stock_item_id, sm.condicion, sum(sm.qty)::int, now()
    from stock_movements sm
   group by sm.stock_item_id, sm.condicion;

  return n;
end $$;

comment on function public.stock_balances_recalcular() is
  'Rehace stock_balances y stock_balances_por_estado enteras desde stock_movements. Devuelve cuántos artículos tienen saldo. Para después de una reparación a mano.';

revoke all on function public.stock_balances_recalcular() from public, anon, authenticated;

-- La primera carga, para que el disparador del punto 4 encuentre ya cada saldo
-- en su sitio. Se vuelve a rehacer allí, en cuanto el disparador está puesto:
-- con `migrar` todo esto es una sola transacción y nadie escribe en medio, pero
-- `deploy.sh` aplica el fichero sentencia a sentencia, y lo que entrara entre
-- esta carga y el disparador se quedaría sin contar.
select public.stock_balances_recalcular();

-- -----------------------------------------------------------------------------
-- 4 — El disparador que pone el estado y lo cuenta
--
-- BEFORE INSERT: puede cambiar la fila antes de que entre. Hace cuatro cosas, en
-- este orden.
--
-- 4a — El reenvío no hace nada. La cola sube cada movimiento con `on conflict
--      (id) do nothing`, y un BEFORE se ejecuta también para la fila que luego
--      choca y se descarta (la trampa que ayer esquivaba `stock_unit_installs`
--      siendo AFTER). Así que lo primero es mirar si el id ya está: si está, es
--      un reenvío, y no se cuenta ni se reparte nada. Se le pone un estado —el
--      de la fila que ya está— solo porque Postgres comprueba el `not null` y
--      los `check` ANTES de decidir el conflicto: devuelta sin estado, el
--      reenvío de una aplicación vieja moriría con «null value in column
--      condicion» en vez de no hacer nada. Y antes de mirar, el cerrojo del
--      artículo, el mismo que toma `stock_no_negativo`: dos reenvíos a la vez
--      del mismo movimiento se esperan, y el segundo ya ve el primero.
--
-- 4b — Lo que entra, en el estado que diga y, si no dice ninguno, por su
--      clase: una compra entra nueva, una devolución usada y un ajuste sin
--      indicar. Da igual cómo se lleve el artículo.
--
-- 4c — Lo que sale diciendo de qué estado, depende:
--        - por cantidad, lo que se pide es lo que se saca. «Saca 2 usadas» con
--          una usada en la estantería no es «una usada y una nueva»: es un
--          error que la pantalla tiene que enseñar, 23514 con cuántas hay.
--        - por número de serie, el estado de cada aparato está en su unidad, y
--          el del movimiento es la cuenta de al lado: lo que se dice es una
--          preferencia —se saca primero de ahí y después por el orden de 4d—,
--          nunca un rechazo.
--
-- 4d — Lo que sale sin decir de qué estado sale de lo que haya, por este
--      orden: usado, reacondicionado, sin indicar, nuevo y, en último lugar,
--      averiado. Lo usado antes que lo nuevo, como haría quien va a la
--      estantería; y lo averiado solo si no queda otra cosa. Nunca se elige por
--      delante de algo que funcione, pero quien no dice el estado —el cierre
--      de una incidencia, la cola de una aplicación vieja, el Excel— no puede
--      quedar rechazado porque lo que queda esté roto: el aparato ya salió, y
--      el total cuadra igual. Es el mismo orden que `ORDEN_PARA_SACAR` en la
--      pantalla.
--
--      Si el primer estado con existencias no llega, la fila se queda con lo
--      que hay en él y el resto sale en filas nuevas —mismo artículo, clase,
--      fecha, autor, sala, incidencia, revisión, nota y origen; id nuevo— de
--      los estados siguientes. La fila de origen conserva su id: es el que la
--      cola reenvía, y lo que hace que el reenvío no haga nada. Las cuentas que
--      suman por incidencia y clase (el parte de material, el Excel) siguen
--      dando lo mismo, porque todas las filas llevan las dos.
--
--      Si ni con todo llega, no se reparte: la fila entra entera y la rechaza la
--      comprobación del total (`stock_no_negativo`, AFTER) con su mensaje de
--      siempre. Es la única que puede rechazar un movimiento sin estado.
--
-- Por qué el saldo por estado lo apunta este disparador y no uno AFTER como el
-- del total: quien decide de qué estado sale una fila tiene que ver lo que se
-- llevó la anterior, y los AFTER de una sentencia se disparan todos al final de
-- ella. Con el saldo en un AFTER, dos filas de la misma sentencia sacarían las
-- dos de las mismas «usadas». Aquí cada fila se cuenta en el momento en que se
-- decide; si después algo la rechaza —el total, una clave ajena, la RLS—, el
-- rechazo deshace la sentencia y la cuenta con ella. Y por eso ningún saldo por
-- estado baja de cero: lo que sale sin estado sale de lo que hay, y lo que sale
-- con él o tiene bastante, o se rechaza (por cantidad), o se reparte (por
-- número de serie). Si un administrador cambia cómo se lleva un artículo, sus
-- cifras siguen sumando su total.
--
-- Una salvedad que hoy no pisa nadie: las filas extra de un reparto son
-- sentencias propias, y la comprobación del total de cada una no ve las
-- entradas de ese mismo artículo que vinieran en la misma sentencia de varias
-- filas. Podría rechazar de más, nunca de menos. La cola sube fila a fila y las
-- funciones apuntan un asiento por sentencia.
-- -----------------------------------------------------------------------------

/** «Usado», «Sin indicar»: el estado como se escribe en un mensaje o en una nota. */
create or replace function public.condicion_etiqueta(p text)
returns text
language sql
immutable
as $$
  select case p
    when 'nuevo'           then 'Nuevo'
    when 'usado'           then 'Usado'
    when 'reacondicionado' then 'Reacondicionado'
    when 'averiado'        then 'Averiado'
    when 'sin_indicar'     then 'Sin indicar'
    else p
  end
$$;

revoke all on function public.condicion_etiqueta(text) from public, anon, authenticated;

create or replace function public.stock_movement_con_estado()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seguimiento text;
  v_nombre      text;
  v_saldos      jsonb;
  v_hay         int;
  v_libres      int;
  v_falta       int;
  v_toma        int;
  v_estado      text;
  v_orden       text[] := array['usado', 'reacondicionado', 'sin_indicar', 'nuevo', 'averiado'];
  v_primera     boolean := true;
begin
  -- Como lo escriba quien lo mande; en blanco es que no lo dice.
  new.condicion := nullif(lower(btrim(new.condicion)), '');

  -- 4a — El cerrojo, y el reenvío.
  if new.stock_item_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('stock_item:' || new.stock_item_id, 0));
  end if;
  if exists (select 1 from stock_movements where id = new.id) then
    new.condicion := coalesce(new.condicion,
                              (select m.condicion from stock_movements m where m.id = new.id),
                              'sin_indicar');
    return new;
  end if;

  -- Lo que no va a entrar no se cuenta ni se reparte: que lo rechace la
  -- restricción que le toque, con su mensaje de siempre. El estado se rellena
  -- para que el `not null` no se adelante a ella.
  if new.stock_item_id is null or new.qty is null or new.qty = 0 or new.kind is null
     or (new.kind = 'consumo' and new.qty > 0)
     or (new.kind = 'compra' and new.qty < 0)
     or (new.condicion is not null
         and new.condicion not in ('nuevo', 'usado', 'reacondicionado', 'averiado', 'sin_indicar')) then
    new.condicion := coalesce(new.condicion, 'sin_indicar');
    return new;
  end if;

  select si.seguimiento, si.name into v_seguimiento, v_nombre
    from stock_items si
   where si.id = new.stock_item_id;
  if not found then
    -- La clave ajena lo dirá.
    new.condicion := coalesce(new.condicion, 'sin_indicar');
    return new;
  end if;

  -- 4b — Lo que entra.
  if new.qty > 0 then
    new.condicion := coalesce(new.condicion,
                              case new.kind
                                when 'compra'     then 'nuevo'
                                when 'devolucion' then 'usado'
                                else 'sin_indicar'
                              end);
    perform public.stock_balance_por_estado_sumar(new.stock_item_id, new.condicion, new.qty);
    return new;
  end if;

  select coalesce(jsonb_object_agg(e.condicion, e.on_hand), '{}'::jsonb)
    into v_saldos
    from stock_balances_por_estado e
   where e.stock_item_id = new.stock_item_id;

  -- 4c — Lo que sale con estado, de un artículo por cantidad: lo que se pide.
  if new.condicion is not null and v_seguimiento = 'cantidad' then
    v_hay := coalesce((v_saldos ->> new.condicion)::int, 0);
    if v_hay < -new.qty then
      raise exception 'No quedan tantas en estado «%» de «%»: hay %.',
        public.condicion_etiqueta(new.condicion), v_nombre, greatest(v_hay, 0)
        using errcode = '23514',
              hint = 'Saca las que haya en ese estado, o cambia antes el estado de las que vas a sacar.';
    end if;
    perform public.stock_balance_por_estado_sumar(new.stock_item_id, new.condicion, new.qty);
    return new;
  end if;

  -- 4c y 4d — Lo que sale sin estado, o con uno preferido por número de serie.
  if new.condicion is not null then
    v_orden := array_prepend(new.condicion, array_remove(v_orden, new.condicion));
  end if;

  select coalesce(sum(greatest(x.value::int, 0)), 0)::int
    into v_libres
    from jsonb_each_text(v_saldos) x;
  v_falta := -new.qty;

  if v_libres < v_falta then
    -- Ni con todo: entra entera y la rechaza la comprobación del total.
    new.condicion := coalesce(new.condicion, 'sin_indicar');
    perform public.stock_balance_por_estado_sumar(new.stock_item_id, new.condicion, new.qty);
    return new;
  end if;

  foreach v_estado in array v_orden loop
    v_hay := coalesce((v_saldos ->> v_estado)::int, 0);
    continue when v_hay <= 0;
    v_toma := least(v_hay, v_falta);
    if v_primera then
      -- La fila que llegó, con su id, se queda con el primer trozo.
      v_primera := false;
      new.condicion := v_estado;
      new.qty := -v_toma;
      perform public.stock_balance_por_estado_sumar(new.stock_item_id, v_estado, -v_toma);
    else
      -- El resto, en filas nuevas que dicen su estado: este mismo disparador las
      -- cuenta al entrar, y ya no las reparte.
      insert into stock_movements (id, stock_item_id, qty, kind, incident_id, inspection_id,
                                   occurred_at, recorded_at, by_user, source, note, room_id, condicion)
      values (gen_random_uuid(), new.stock_item_id, -v_toma, new.kind, new.incident_id, new.inspection_id,
              new.occurred_at, new.recorded_at, new.by_user, new.source, new.note, new.room_id, v_estado);
    end if;
    v_falta := v_falta - v_toma;
    exit when v_falta = 0;
  end loop;

  -- No puede sobrar nada: el orden recorre los cinco estados, los mismos que
  -- suma `v_libres`. Si algún día dejara de ser así, mejor un error que una
  -- salida apuntada por menos de lo que salió.
  if v_falta > 0 then
    raise exception 'La salida de «%» no se ha podido repartir entre sus estados: faltan %.', v_nombre, v_falta;
  end if;

  return new;
end $$;

comment on function public.stock_movement_con_estado() is
  'Disparador BEFORE INSERT de stock_movements: pone el estado (condicion) a lo que llega sin él y lo cuenta en stock_balances_por_estado. Un reenvío (el id ya está) no cuenta nada. Entrada: el estado dicho o el de su clase. Salida sin estado: de lo que haya, usado, reacondicionado, sin_indicar, nuevo y averiado en último lugar, repartida en filas nuevas si un estado no llega; si ni con todo llega, la rechaza stock_no_negativo. Salida con estado: estricta por cantidad (23514), preferencia por número de serie.';

revoke all on function public.stock_movement_con_estado() from public, anon, authenticated;

drop trigger if exists stock_movement_con_estado on stock_movements;
create trigger stock_movement_con_estado
  before insert on stock_movements
  for each row execute function public.stock_movement_con_estado();

-- Y la reparación a mano, como en el total: con el disparador de inmutabilidad
-- apagado, una fila corregida o borrada deshace lo que contaba y cuenta lo
-- nuevo. Por la vía normal no se llega nunca: `stock_movements_solo_alta` corta
-- antes.
create or replace function public.stock_balances_por_estado_mantener()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.stock_balance_por_estado_sumar(old.stock_item_id, old.condicion, -old.qty);
  if tg_op = 'UPDATE' then
    perform public.stock_balance_por_estado_sumar(new.stock_item_id, new.condicion, new.qty);
  end if;
  return null;
end $$;

comment on function public.stock_balances_por_estado_mantener() is
  'Disparador AFTER UPDATE OR DELETE de stock_movements: corrige stock_balances_por_estado en una reparación a mano. El alta la cuenta stock_movement_con_estado.';

revoke all on function public.stock_balances_por_estado_mantener() from public, anon, authenticated;

drop trigger if exists stock_movements_corrige_saldo_por_estado on stock_movements;
create trigger stock_movements_corrige_saldo_por_estado
  after update or delete on stock_movements
  for each row execute function public.stock_balances_por_estado_mantener();

-- Con el disparador puesto, el saldo otra vez desde los asientos —lo que haya
-- entrado desde la primera carga queda contado— y, ahora sí, fuera el defecto
-- de la columna.
select public.stock_balances_recalcular();

alter table stock_movements
  alter column condicion drop default;

-- -----------------------------------------------------------------------------
-- 5 — La vista: cuántas hay de cada artículo, y en qué estado
--
-- Una fila por artículo activo, con las columnas que lee la pantalla
-- (`NivelPorEstado` en `src/domain/estados.ts`):
--
--   on_hand      el mismo de `stock_levels`: el saldo de `stock_balances`.
--   nuevo … sin_indicar
--                por cantidad, el saldo de cada estado. Por número de serie, las
--                unidades disponibles en cada estado; y lo que el almacén cuenta
--                y ninguna unidad nombra —ocho teclados contados, cinco con su
--                número— va a «sin indicar».
--   disponibles  las que se pueden usar: todas menos las averiadas.
--
-- Ninguna cifra sale negativa. Por cantidad no lo es ninguna (punto 4), y el
-- `greatest` es por si algún día una reparación a mano dejara una; por número
-- de serie, las unidades que no cuenta el almacén —se dieron de alta sin sumar y
-- nunca se sumaron— pueden hacer que las averiadas pasen de `on_hand`, y
-- «disponibles» se queda en cero en vez de deber.
-- -----------------------------------------------------------------------------

create or replace view public.stock_levels_por_estado as
with por_estado as (
  select e.stock_item_id,
         greatest(coalesce(sum(e.on_hand) filter (where e.condicion = 'nuevo'), 0), 0)::int           as nuevo,
         greatest(coalesce(sum(e.on_hand) filter (where e.condicion = 'usado'), 0), 0)::int           as usado,
         greatest(coalesce(sum(e.on_hand) filter (where e.condicion = 'reacondicionado'), 0), 0)::int as reacondicionado,
         greatest(coalesce(sum(e.on_hand) filter (where e.condicion = 'averiado'), 0), 0)::int        as averiado,
         greatest(coalesce(sum(e.on_hand) filter (where e.condicion = 'sin_indicar'), 0), 0)::int     as sin_indicar
    from stock_balances_por_estado e
   group by e.stock_item_id
),
unidades as (
  select u.stock_item_id,
         count(*) filter (where u.condicion = 'nuevo')::int           as nuevo,
         count(*) filter (where u.condicion = 'usado')::int           as usado,
         count(*) filter (where u.condicion = 'reacondicionado')::int as reacondicionado,
         count(*) filter (where u.condicion = 'averiado')::int        as averiado,
         count(*) filter (where u.condicion = 'sin_indicar')::int     as sin_indicar,
         count(*)::int                                                as todas
    from stock_units u
   where u.status = 'disponible'
     and u.stock_item_id is not null
   group by u.stock_item_id
),
cifras as (
  select
    si.id                                         as stock_item_id,
    si.seguimiento,
    coalesce(b.on_hand, 0)::int                   as on_hand,
    case when si.seguimiento = 'serie' then coalesce(un.nuevo, 0)
         else coalesce(pe.nuevo, 0) end           as nuevo,
    case when si.seguimiento = 'serie' then coalesce(un.usado, 0)
         else coalesce(pe.usado, 0) end           as usado,
    case when si.seguimiento = 'serie' then coalesce(un.reacondicionado, 0)
         else coalesce(pe.reacondicionado, 0) end as reacondicionado,
    case when si.seguimiento = 'serie' then coalesce(un.averiado, 0)
         else coalesce(pe.averiado, 0) end        as averiado,
    case when si.seguimiento = 'serie'
         then coalesce(un.sin_indicar, 0) + greatest(coalesce(b.on_hand, 0) - coalesce(un.todas, 0), 0)
         else coalesce(pe.sin_indicar, 0) end     as sin_indicar
  from stock_items si
  left join stock_balances b on b.stock_item_id = si.id
  left join por_estado pe    on pe.stock_item_id = si.id
  left join unidades un      on un.stock_item_id = si.id
  where si.active
)
select
  c.stock_item_id,
  c.seguimiento,
  c.on_hand,
  c.nuevo,
  c.usado,
  c.reacondicionado,
  c.averiado,
  c.sin_indicar,
  greatest(c.on_hand - c.averiado, 0)::int as disponibles
from cifras c;

-- Sin esto la vista correría con los privilegios de su propietario, que se
-- salta la RLS, y PostgREST la publicaría con cualquier token.
alter view public.stock_levels_por_estado set (security_invoker = on);

comment on view public.stock_levels_por_estado is
  'Cuántas hay de cada artículo activo y en qué estado. Por cantidad, los saldos de stock_balances_por_estado; por número de serie, las unidades disponibles de cada estado, y a sin_indicar lo contado que ninguna unidad nombra. on_hand es el de stock_levels; disponibles, todas menos las averiadas. Ninguna cifra es negativa.';

-- Como `stock_unit_list`: con `security_invoker` la vista no abre nada que las
-- tablas no abran, y el GRANT va explícito porque el defecto del arranque no
-- alcanza lo que crea otro rol y se lo daba también a `anon`.
revoke all on public.stock_levels_por_estado from anon;
grant select on public.stock_levels_por_estado to authenticated;

-- -----------------------------------------------------------------------------
-- 6 — Cambiar el estado de unas cuantas
--
-- «3 de las usadas, a averiadas»: dos ajustes en el mismo instante, uno que
-- saca N del estado de partida y otro que mete N en el de llegada. El total no
-- se mueve, y el libro dice quién lo cambió, cuándo y por qué, como cualquier
-- otro asiento.
--
-- Lo puede hacer el personal: quien tiene el teclado delante es quien ve que
-- está roto, y suele ser un técnico. Por eso es `security definer`: un técnico
-- solo puede apuntar consumos (`20260728000300`) y esto son ajustes, que aquí
-- van firmados por él.
--
-- Solo para lo que se lleva por cantidad. Lo que se lleva por número de serie
-- tiene el estado en cada unidad, y se cambia en ella (`stock_unit_editar`):
-- cambiarlo aquí dejaría las cifras diciendo una cosa y las unidades otra.
--
-- El id lo pone el cliente, como en la cola: si la respuesta se pierde y se
-- repite, ese id ya está en el libro y no se hace dos veces. El de la segunda
-- fila sale del primero, así que el par se encuentra a partir de cualquiera de
-- los dos. Y el cerrojo del artículo va antes de mirarlo, como en el
-- disparador: dos envíos simultáneos del mismo cambio se esperan, y el segundo
-- ve el primero.
-- -----------------------------------------------------------------------------

create or replace function public.stock_cambiar_estado(
  p_id       uuid,
  p_item     uuid,
  p_cantidad int,
  p_de       text,
  p_a        text,
  p_nota     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_de     text := nullif(lower(btrim(coalesce(p_de, ''))), '');
  v_a      text := nullif(lower(btrim(coalesce(p_a, ''))), '');
  v_nota   text := nullif(btrim(coalesce(p_nota, '')), '');
  v_item   stock_items%rowtype;
  v_hay    int;
  v_cuando timestamptz := now();
  v_yo     uuid := (select auth.uid());
  v_texto  text;
begin
  if not public.is_staff() then
    raise exception 'Solo el personal cambia el estado de lo que hay en el almacén.'
      using errcode = '42501';
  end if;
  if p_id is null then
    raise exception 'Falta el identificador del cambio de estado.' using errcode = '22023';
  end if;
  if p_item is null then
    raise exception 'Ese artículo no existe o está retirado del almacén.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('stock_item:' || p_item, 0));
  if exists (select 1 from stock_movements where id = p_id) then
    return;
  end if;

  if p_cantidad is null or p_cantidad < 1 then
    raise exception 'La cantidad tiene que ser 1 o más: «%» no vale.', coalesce(p_cantidad::text, '')
      using errcode = '22023';
  end if;
  if v_de is null or v_de not in ('nuevo', 'usado', 'reacondicionado', 'averiado', 'sin_indicar') then
    raise exception '«%» no es un estado: tiene que ser nuevo, usado, reacondicionado, averiado o sin indicar.',
      coalesce(p_de, '')
      using errcode = '22023';
  end if;
  if v_a is null or v_a not in ('nuevo', 'usado', 'reacondicionado', 'averiado', 'sin_indicar') then
    raise exception '«%» no es un estado: tiene que ser nuevo, usado, reacondicionado, averiado o sin indicar.',
      coalesce(p_a, '')
      using errcode = '22023';
  end if;
  if v_de = v_a then
    raise exception 'Para cambiar de estado, el de partida y el de llegada tienen que ser distintos.'
      using errcode = '22023';
  end if;

  select * into v_item from stock_items where id = p_item;
  if not found or not v_item.active then
    raise exception 'Ese artículo no existe o está retirado del almacén.' using errcode = '22023';
  end if;
  if v_item.seguimiento = 'serie' then
    raise exception 'Este artículo se controla por número de serie: cambia el estado en cada unidad.'
      using errcode = '22023';
  end if;

  -- El disparador lo comprobaría igual al sacarlas; se dice aquí antes de
  -- escribir nada, con las mismas palabras.
  select coalesce(max(e.on_hand), 0) into v_hay
    from stock_balances_por_estado e
   where e.stock_item_id = p_item and e.condicion = v_de;
  if v_hay < p_cantidad then
    raise exception 'No quedan tantas en estado «%» de «%»: hay %.',
      public.condicion_etiqueta(v_de), v_item.name, greatest(v_hay, 0)
      using errcode = '23514';
  end if;

  v_texto := format('Cambio de estado: %s de «%s» a «%s»',
                    p_cantidad, public.condicion_etiqueta(v_de), public.condicion_etiqueta(v_a))
             || coalesce(' · ' || v_nota, '');

  insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user, source, note, condicion)
  values (p_id, p_item, -p_cantidad, 'ajuste', v_cuando, v_yo, 'app', v_texto, v_de);

  insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user, source, note, condicion)
  values (md5('stock_cambiar_estado:' || p_id::text)::uuid, p_item, p_cantidad, 'ajuste',
          v_cuando, v_yo, 'app', v_texto, v_a);
end $$;

comment on function public.stock_cambiar_estado(uuid, uuid, int, text, text, text) is
  'Pasa p_cantidad unidades de un artículo por cantidad del estado p_de al p_a: dos ajustes en el mismo instante (p_id saca, el otro mete), firmados por quien llama, con la nota «Cambio de estado: N de «X» a «Y»». Idempotente por p_id. Personal. 22023 si algo no vale o el artículo se lleva por número de serie; 23514 si no quedan tantas en p_de.';

revoke all on function public.stock_cambiar_estado(uuid, uuid, int, text, text, text) from public, anon;
grant execute on function public.stock_cambiar_estado(uuid, uuid, int, text, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 7 — Dar de alta unidades: el asiento con su estado, y muchas de golpe
--
-- 7a — `stock_unit_alta`, la de ayer, con un cambio y solo uno: el +1 de una
--      unidad que entra sumando dice el estado de la unidad. Sin él, un aparato
--      averiado que entra en un artículo por cantidad contaría como «sin
--      indicar», y de ahí lo sacaría el primer consumo sin estado. La clase del
--      asiento sigue siendo la de ayer —compra si es nueva, ajuste si no— y en
--      un artículo por número de serie el estado del asiento es solo la cuenta
--      de al lado: el que manda es el de la unidad.
-- -----------------------------------------------------------------------------

/**
 * Da de alta una unidad del almacén. Idempotente por número de serie: si ya
 * existe, se le actualizan los datos que vengan y se devuelve su id.
 *
 *   p: {articulo, marca, modelo, serial, observaciones, source,
 *       stock_item_id?, condicion?, sumar?}
 */
create or replace function public.stock_unit_alta(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_serial      text := btrim(coalesce(p->>'serial', ''));
  v_articulo    text := btrim(coalesce(p->>'articulo', ''));
  v_modelo      text := nullif(btrim(coalesce(p->>'modelo', '')), '');
  v_marca       text := nullif(btrim(coalesce(p->>'marca', '')), '');
  v_notas       text := nullif(btrim(coalesce(p->>'observaciones', '')), '');
  v_source      text := coalesce(nullif(btrim(coalesce(p->>'source', '')), ''), 'app');
  v_crudo       text;
  v_nombrado    boolean := false;
  v_item        uuid;
  v_item_nombre text;
  v_tipo        uuid;
  v_condicion   text;
  v_sumar       boolean;
  v_id          uuid;
  v_asset       uuid;
  v_room        uuid;
  v_estado      text;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor da de alta unidades del almacén.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_serial = '' then
    raise exception 'Una unidad del almacén necesita número de serie.'
      using errcode = '22023';
  end if;

  -- El estado, si viene. En blanco es que no viene.
  v_condicion := nullif(lower(btrim(coalesce(p->>'condicion', ''))), '');
  if v_condicion is not null
     and v_condicion not in ('nuevo', 'usado', 'reacondicionado', 'averiado', 'sin_indicar') then
    raise exception '«%» no es un estado de unidad: tiene que ser nuevo, usado, reacondicionado o averiado.',
      p->>'condicion'
      using errcode = '22023';
  end if;

  -- «sumar», como lo mande la pantalla: un booleano de JSON o su texto.
  begin
    v_sumar := coalesce(nullif(btrim(coalesce(p->>'sumar', '')), '')::boolean, false);
  exception when invalid_text_representation then
    raise exception '«%» no vale para «sumar»: tiene que ser sí o no.', p->>'sumar'
      using errcode = '22023';
  end;

  v_crudo := nullif(btrim(coalesce(p->>'stock_item_id', '')), '');
  if v_crudo is not null then
    -- El artículo nombrado: tiene que existir y estar en el almacén.
    begin
      v_item := v_crudo::uuid;
    exception when invalid_text_representation then
      raise exception '«%» no es un artículo del almacén.', v_crudo
        using errcode = '22023';
    end;
    select si.name, si.asset_type_id
      into v_item_nombre, v_tipo
      from stock_items si
     where si.id = v_item and si.active;
    if not found then
      raise exception 'Ese artículo no existe o está retirado del almacén.'
        using errcode = '22023';
    end if;
    v_nombrado := true;
    if v_articulo = '' then v_articulo := v_item_nombre; end if;
  else
    -- El camino de siempre, sin un cambio: el artículo se busca por nombre y
    -- alias, primero como «artículo modelo» —la hoja dice «Ordenador Tiny» y
    -- «M710Q» en dos columnas y la bolsa «Ordenador Tiny M710Q» en una—.
    if v_articulo = '' then v_articulo := 'Ordenador'; end if;

    select si.id into v_item from stock_items si
     where si.active
       and (
         (v_modelo is not null and public.norm_text(si.name) = public.norm_text(v_articulo || ' ' || v_modelo))
         or public.norm_text(v_articulo || ' ' || coalesce(v_modelo, '')) = any (
              select public.norm_text(a) from unnest(si.aliases) a)
       )
     limit 1;
    if v_item is null then
      select si.id into v_item from stock_items si
       where si.active
         and (public.norm_text(si.name) = public.norm_text(v_articulo)
              or public.norm_text(v_articulo) = any (select public.norm_text(a) from unnest(si.aliases) a))
       limit 1;
    end if;
    if v_item is not null then
      select asset_type_id into v_tipo from stock_items where id = v_item;
    end if;
    if v_tipo is null then
      v_tipo := public.asset_type_id('Ordenador');
    end if;
  end if;

  select id into v_id from stock_units
   where upper(regexp_replace(serial, '[\s\-_./]', '', 'g'))
       = upper(regexp_replace(v_serial, '[\s\-_./]', '', 'g'));

  if v_id is not null then
    -- Ya existe: se actualiza lo que venga, y solo si algo cambia, para que una
    -- segunda pasada del Excel no llene la Actividad de cambios que no lo son.
    if v_nombrado then
      update stock_units u
         set stock_item_id = v_item,
             articulo      = v_articulo,
             asset_type_id = v_tipo,
             brand         = coalesce(v_marca, u.brand),
             model         = coalesce(v_modelo, u.model),
             notes         = coalesce(v_notas, u.notes),
             condicion     = coalesce(v_condicion, u.condicion),
             updated_at    = now()
       where u.id = v_id
         and (u.stock_item_id, u.articulo, u.asset_type_id, u.brand, u.model, u.notes, u.condicion)
             is distinct from
             (v_item, v_articulo, v_tipo, coalesce(v_marca, u.brand), coalesce(v_modelo, u.model),
              coalesce(v_notas, u.notes), coalesce(v_condicion, u.condicion));
    else
      update stock_units u
         set articulo      = v_articulo,
             brand         = coalesce(v_marca, u.brand),
             model         = coalesce(v_modelo, u.model),
             notes         = coalesce(v_notas, u.notes),
             stock_item_id = coalesce(u.stock_item_id, v_item),
             asset_type_id = coalesce(u.asset_type_id, v_tipo),
             condicion     = coalesce(v_condicion, u.condicion),
             updated_at    = now()
       where u.id = v_id
         and (u.articulo, u.brand, u.model, u.notes, u.stock_item_id, u.asset_type_id, u.condicion)
             is distinct from
             (v_articulo, coalesce(v_marca, u.brand), coalesce(v_modelo, u.model), coalesce(v_notas, u.notes),
              coalesce(u.stock_item_id, v_item), coalesce(u.asset_type_id, v_tipo),
              coalesce(v_condicion, u.condicion));
    end if;
    return v_id;
  end if;

  -- ¿Ya está puesto en un aula? Entonces no está en el almacén, y decirlo
  -- sería mentir. Es el mismo aparato: la unidad nace apuntando a él.
  select a.id, a.room_id into v_asset, v_room
    from assets a
   where a.serial is not null
     and upper(regexp_replace(a.serial, '[\s\-_./]', '', 'g'))
       = upper(regexp_replace(v_serial, '[\s\-_./]', '', 'g'))
     and a.status <> 'retirado'
     and a.room_id is not null
   order by (a.serial = v_serial) desc, a.created_at desc
   limit 1;
  v_estado := case when v_asset is null then 'disponible' else 'instalado' end;

  insert into stock_units (stock_item_id, asset_type_id, articulo, brand, model, serial, notes,
                           status, condicion, asset_id, room_id, installed_at, source)
  values (v_item, v_tipo, v_articulo, v_marca, v_modelo, v_serial, v_notas,
          v_estado, coalesce(v_condicion, 'sin_indicar'),
          v_asset, v_room, case when v_asset is not null then now() end, v_source)
  returning id into v_id;

  -- El asiento lleva el estado de la unidad que entra (`20261027000300`).
  if v_sumar and v_item is not null and v_estado = 'disponible' then
    insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user, source, note, condicion)
    values (gen_random_uuid(), v_item, 1,
            (case when coalesce(v_condicion, 'sin_indicar') = 'nuevo' then 'compra' else 'ajuste' end)::stock_movement_kind,
            now(), (select auth.uid()), v_source,
            format('Entrada de la unidad S/N %s', v_serial),
            coalesce(v_condicion, 'sin_indicar'));
  end if;

  return v_id;
end $$;

comment on function public.stock_unit_alta(jsonb) is
  'Da de alta una unidad del almacén por número de serie (idempotente). Con stock_item_id, ese artículo y su tipo tal cual; sin él, casa el artículo por nombre o «artículo modelo» y supone Ordenador. condicion opcional (22023 si no existe). sumar = true apunta +1 (compra si nuevo, ajuste si no, con el estado de la unidad) solo si la unidad nace aquí, con artículo y en el almacén. Si el número ya es de un equipo en un aula, nace instalada y apuntando a él.';

revoke all on function public.stock_unit_alta(jsonb) from public, anon;
grant execute on function public.stock_unit_alta(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 7b — Muchas de golpe
--
-- La lista que se pega del albarán, de una columna del Excel o del lector de
-- códigos de barras, todas del mismo artículo y con el mismo estado, marca y
-- modelo. Lo que se hace con cada número es exactamente `stock_unit_alta` —la
-- misma función, no una copia—, con dos diferencias que son las de una lista:
--
--   - una unidad que ya existe NO se toca: se dice «ya estaba» y se sigue. En
--     una lista pegada, un número repetido es casi siempre uno que ya se apuntó
--     ayer, y reescribirle el estado y la marca con los de hoy sería corregir
--     de tapadillo lo que alguien dijo de ella;
--   - un número que falla no tumba los demás: cada uno va en su propia
--     subtransacción y vuelve con su motivo.
--
-- Lo que vale para toda la lista se comprueba antes de empezar, una vez: quién
-- llama, el artículo, el estado, «sumar» y el tamaño. Esos errores no son de un
-- número, y quinientas filas con el mismo «el artículo está retirado» no le
-- dicen a nadie nada mejor que una.
--
-- Los números se limpian como en la pantalla (`seriesDeUnaLista`): sin los
-- espacios de los extremos, sin los vacíos y sin repetir, comparando como el
-- índice `stock_units_serial_idx` —sin espacios, guiones, barras bajas, puntos
-- ni barras, y en mayúsculas—. Como mucho 500 de una vez, el mismo
-- `MAXIMO_DE_UNA_LISTA` de la pantalla.
--
--   p: {stock_item_id, seriales: [texto…], condicion?, marca?, modelo?,
--       observaciones?, sumar?}
--
-- Devuelve una fila por número, en el orden en que llegaron:
--
--   {serial, id, resultado: 'nueva'}       y, si su número ya estaba puesto en
--                                          un aula, un `mensaje` que lo dice:
--                                          nace instalada y no suma;
--   {serial, id, resultado: 'ya_estaba'}  y, si es de otro artículo, un
--                                          `mensaje` que dice de cuál;
--   {serial, id: null, resultado: 'error', mensaje}
-- -----------------------------------------------------------------------------

create or replace function public.stock_unit_alta_varias(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_crudo     text;
  v_item      uuid;
  v_condicion text;
  v_sumar     boolean;
  v_raro      text;
  v_series    text[];
  v_claves    text[];
  v_base      jsonb;
  v_id        uuid;
  v_unidad    stock_units%rowtype;
  v_donde     text;
  v_out       jsonb := '[]'::jsonb;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor da de alta unidades del almacén.'
      using errcode = 'insufficient_privilege';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'El alta llega vacía.' using errcode = '22023';
  end if;

  -- El artículo: aquí siempre nombrado. Una lista se pega desde un artículo.
  v_crudo := nullif(btrim(coalesce(p->>'stock_item_id', '')), '');
  if v_crudo is null then
    raise exception 'Elige el artículo del almacén al que pertenecen las unidades.'
      using errcode = '22023';
  end if;
  begin
    v_item := v_crudo::uuid;
  exception when invalid_text_representation then
    raise exception '«%» no es un artículo del almacén.', v_crudo using errcode = '22023';
  end;
  if not exists (select 1 from stock_items where id = v_item and active) then
    raise exception 'Ese artículo no existe o está retirado del almacén.' using errcode = '22023';
  end if;

  -- El estado y «sumar», con las mismas palabras que `stock_unit_alta`.
  v_condicion := nullif(lower(btrim(coalesce(p->>'condicion', ''))), '');
  if v_condicion is not null
     and v_condicion not in ('nuevo', 'usado', 'reacondicionado', 'averiado', 'sin_indicar') then
    raise exception '«%» no es un estado de unidad: tiene que ser nuevo, usado, reacondicionado o averiado.',
      p->>'condicion'
      using errcode = '22023';
  end if;
  begin
    v_sumar := coalesce(nullif(btrim(coalesce(p->>'sumar', '')), '')::boolean, false);
  exception when invalid_text_representation then
    raise exception '«%» no vale para «sumar»: tiene que ser sí o no.', p->>'sumar'
      using errcode = '22023';
  end;

  -- La lista.
  if jsonb_typeof(p->'seriales') is distinct from 'array' then
    raise exception 'Falta la lista de números de serie.' using errcode = '22023';
  end if;
  select t.e::text into v_raro
    from jsonb_array_elements(p->'seriales') as t(e)
   where jsonb_typeof(t.e) not in ('string', 'number', 'null')
   limit 1;
  if v_raro is not null then
    raise exception 'Cada número de serie de la lista tiene que ser un texto, y «%» no lo es.', v_raro
      using errcode = '22023';
  end if;

  select coalesce(array_agg(x.serial order by x.orden), '{}'),
         coalesce(array_agg(x.clave  order by x.orden), '{}')
    into v_series, v_claves
    from (
      select distinct on (l.clave) l.serial, l.clave, l.orden
        from (
          select btrim(t.e) as serial,
                 upper(regexp_replace(btrim(t.e), '[\s\-_./]', '', 'g')) as clave,
                 t.orden
            from jsonb_array_elements_text(p->'seriales') with ordinality as t(e, orden)
           where t.e is not null
        ) l
       where l.clave <> ''
       order by l.clave, l.orden
    ) x;

  if cardinality(v_series) > 500 then
    raise exception 'Son % números de serie, y de una vez se dan de alta como mucho 500: pártelos en varias listas.',
      cardinality(v_series)
      using errcode = '22023';
  end if;

  v_base := jsonb_build_object(
    'stock_item_id', v_item,
    'condicion',     v_condicion,
    'marca',         p->'marca',
    'modelo',        p->'modelo',
    'observaciones', p->'observaciones',
    'sumar',         v_sumar,
    'source',        coalesce(nullif(btrim(coalesce(p->>'source', '')), ''), 'app'));

  for i in 1 .. cardinality(v_series) loop
    select * into v_unidad
      from stock_units
     where upper(regexp_replace(serial, '[\s\-_./]', '', 'g')) = v_claves[i];
    if found then
      -- Si es de otro artículo, se dice de cuál: «ya estaba» a secas haría creer
      -- que está en el que se está apuntando.
      v_out := v_out || jsonb_build_array(
        jsonb_build_object('serial', v_series[i], 'id', v_unidad.id, 'resultado', 'ya_estaba')
        || case when v_unidad.stock_item_id is distinct from v_item
                then jsonb_build_object('mensaje', format('Ya está apuntada en otro artículo: «%s».',
                       coalesce((select si.name from stock_items si where si.id = v_unidad.stock_item_id),
                                v_unidad.articulo)))
                else '{}'::jsonb
           end);
      continue;
    end if;

    begin
      v_id := public.stock_unit_alta(v_base || jsonb_build_object('serial', v_series[i]));

      v_donde := null;
      select format('%s %s', r.code, b.code) into v_donde
        from stock_units u
        join rooms r     on r.id = u.room_id
        join zones z     on z.id = r.zone_id
        join buildings b on b.id = z.building_id
       where u.id = v_id and u.status = 'instalado';

      v_out := v_out || jsonb_build_array(
        jsonb_build_object('serial', v_series[i], 'id', v_id, 'resultado', 'nueva')
        || case when v_donde is null then '{}'::jsonb
                else jsonb_build_object('mensaje', format(
                  'Ese número de serie ya está puesto en %s: la unidad nace instalada y no suma al almacén.',
                  v_donde))
           end);
    exception when others then
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'serial', v_series[i], 'id', null, 'resultado', 'error', 'mensaje', sqlerrm));
    end;
  end loop;

  return v_out;
end $$;

comment on function public.stock_unit_alta_varias(jsonb) is
  'Da de alta de golpe una lista de números de serie de un artículo, con el mismo estado, marca, modelo y observaciones, como stock_unit_alta cada uno (sumar incluido). Limpia, quita vacíos y repetidos (normalizados como stock_units_serial_idx), como mucho 500. Una unidad que ya existe no se toca (ya_estaba); un número que falla no tumba los demás (error, con su mensaje). Devuelve [{serial, id, resultado, mensaje?}] en el orden de llegada. Supervisor.';

revoke all on function public.stock_unit_alta_varias(jsonb) from public, anon;
grant execute on function public.stock_unit_alta_varias(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 8 — La unidad que se instala descuenta de su estado
--
-- Las dos instalaciones —la de ayer (`instalar_unidad_del_almacen`, que usan
-- `stock_unit_instalar_en` y la cola) y la de septiembre que siguen llamando
-- las aplicaciones viejas (`stock_unit_instalar`)— apuntan un −1 del artículo
-- de la unidad. Desde hoy ese −1 dice el estado de la unidad que se va al
-- aula, si en ese estado quedan: instalar un aparato nuevo saca uno de los
-- nuevos, no el primero usado que encuentre el disparador.
--
-- «Si quedan», y no a secas, porque en un artículo por cantidad un estado dicho
-- es estricto (punto 4c), y una instalación no se tumba por la cuenta del
-- almacén —ya lo decía septiembre: el aparato está en el aula igual—. Si en ese
-- estado no queda ninguno, el −1 llega sin estado y sale de lo que haya. Lo
-- decide `stock_estado_si_quedan`, que toma el mismo cerrojo que el disparador
-- para que lo que mira siga siendo verdad cuando el asiento entra.
--
-- Las dos funciones van enteras porque `create or replace` no sabe cambiar
-- media; están copiadas sin un cambio salvo el del asiento. `stock_unit_baja`
-- no apunta ningún movimiento —la unidad de baja ya no se contaba desde que
-- se dio de alta sin sumar, o se descuadra a propósito y se cuadra en el
-- almacén— y se queda como está.
-- -----------------------------------------------------------------------------

/** El estado del que sacar `p_cantidad` de un artículo, si quedan tantas en él; si no, null. */
create or replace function public.stock_estado_si_quedan(p_item uuid, p_condicion text, p_cantidad int default 1)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_item is null or p_condicion is null then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('stock_item:' || p_item, 0));
  if exists (
    select 1 from stock_balances_por_estado e
     where e.stock_item_id = p_item
       and e.condicion = p_condicion
       and e.on_hand >= greatest(coalesce(p_cantidad, 1), 1)
  ) then
    return p_condicion;
  end if;
  return null;
end $$;

comment on function public.stock_estado_si_quedan(uuid, text, int) is
  'Interna: devuelve p_condicion si al artículo le quedan al menos p_cantidad en ese estado, y null si no, para que un asiento prefiera un estado sin exigirlo. Toma el cerrojo del artículo.';

revoke all on function public.stock_estado_si_quedan(uuid, text, int) from public, anon, authenticated;

create or replace function public.instalar_unidad_del_almacen(
  p_unit      uuid,
  p_room      uuid,
  p_sustituye uuid,
  p_destino   text,
  p_nota      text,
  p_asset_id  uuid,
  p_label     text,
  p_cuando    timestamptz,
  p_quien     uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_u           stock_units%rowtype;
  v_cuando      timestamptz := least(coalesce(p_cuando, now()), now());
  v_destino     text := replace(lower(btrim(coalesce(p_destino, 'almacen'))), 'é', 'e');
  v_nota        text := nullif(btrim(coalesce(p_nota, '')), '');
  v_propuesta   text := nullif(btrim(coalesce(p_label, '')), '');
  v_tipo        uuid;
  v_tipo_nombre text;
  v_donde       text;
  v_previo      assets%rowtype;
  v_viejo       assets%rowtype;
  v_reutiliza   boolean := false;
  v_asset       uuid;
  v_label       text;
  v_motivo      text;
  v_solicitud   uuid;
  v_aprobada    boolean := false;
  v_fin         text;
begin
  -- 1 — Lo que tiene que ser verdad antes de tocar nada.
  select * into v_u from stock_units where id = p_unit for update;
  if not found then
    raise exception 'Esa unidad no existe.' using errcode = '22023';
  end if;
  if v_u.status = 'instalado' then
    select format(' en %s %s', r.code, b.code) into v_donde
      from rooms r
      join zones z     on z.id = r.zone_id
      join buildings b on b.id = z.building_id
     where r.id = v_u.room_id;
    raise exception 'Esa unidad ya no está en el almacén: está instalada%.', coalesce(v_donde, '')
      using errcode = '22023';
  elsif v_u.status <> 'disponible' then
    raise exception 'Esa unidad ya no está en el almacén: está dada de baja.'
      using errcode = '22023';
  end if;

  if p_room is null or not exists (select 1 from rooms where id = p_room and active) then
    raise exception 'Esa sala no existe o está archivada.' using errcode = '22023';
  end if;

  select coalesce(tf.id, t.id), coalesce(tf.name, t.name)
    into v_tipo, v_tipo_nombre
    from asset_types t
    left join asset_types tf on tf.id = t.merged_into
   where t.id = coalesce(v_u.asset_type_id,
                         (select si.asset_type_id from stock_items si where si.id = v_u.stock_item_id));
  if v_tipo is null then
    raise exception 'Este artículo no dice qué tipo de equipo es: enlázalo con un tipo en el almacén.'
      using errcode = '22023';
  end if;

  if v_destino not in ('almacen', 'baja') then
    raise exception 'Lo sustituido va a «baja» o a «almacen», no a «%».', coalesce(p_destino, '')
      using errcode = '22023';
  end if;

  if p_sustituye is not null then
    select * into v_previo from assets where id = p_sustituye for update;
    if not found or v_previo.status = 'retirado' or v_previo.room_id is distinct from p_room then
      raise exception 'El equipo que se sustituye tiene que estar en esa sala y sin retirar.'
        using errcode = '22023';
    end if;
  end if;

  -- El mismo número de serie en otro equipo es este mismo aparato, que ya
  -- constaba: de baja, de vuelta en el almacén, o en otra aula por error.
  select * into v_viejo
    from assets a
   where a.serial is not null
     and upper(regexp_replace(a.serial, '[\s\-_./]', '', 'g'))
       = upper(regexp_replace(v_u.serial, '[\s\-_./]', '', 'g'))
   order by (a.serial = v_u.serial) desc, (a.status <> 'retirado') desc, a.created_at desc
   limit 1
   for update;
  if found then
    v_reutiliza := true;
    v_asset := v_viejo.id;
    if v_asset = p_sustituye then
      raise exception 'Un equipo no se sustituye a sí mismo: ese número de serie es el del equipo que se quita.'
        using errcode = '22023';
    end if;
  end if;

  v_motivo := format('Sustituido por %s S/N %s', v_tipo_nombre, v_u.serial);

  -- La unidad sale del almacén lo primero, y suelta el equipo al que apuntaba
  -- de su vida anterior. Lo que viene detrás mueve unidades por su cuenta —la
  -- aprobación de lo sustituido devuelve al almacén la unidad de un equipo, o
  -- la busca por su número de serie; el disparador del número de serie engancha
  -- las disponibles— y ninguno de los dos puede tomar esta por otra.
  update stock_units
     set status = 'instalado', asset_id = null, room_id = p_room, updated_at = now()
   where id = v_u.id;

  -- 2 — Lo sustituido: la retirada, pedida o decidida.
  if p_sustituye is not null then
    select id into v_solicitud
      from asset_removals
     where asset_id = p_sustituye and state = 'pendiente'
     for update;

    if v_solicitud is null then
      v_solicitud := gen_random_uuid();
      insert into asset_removals (id, asset_id, room_id, destino, reason, requested_at, requested_by)
      values (v_solicitud, p_sustituye, p_room, v_destino, v_motivo, v_cuando, p_quien);
    else
      -- La que ya estaba pedida no se duplica —el índice de una sola viva por
      -- equipo lo impediría, y además sería mentira—: se le pone el destino de
      -- ahora, y el motivo de quien la pidió se respeta.
      update asset_removals
         set destino = v_destino,
             reason  = coalesce(nullif(btrim(reason), ''), v_motivo)
       where id = v_solicitud;
    end if;

    if public.is_supervisor() then
      v_fin := public.decide_asset_removal(v_solicitud, true, v_motivo);
      v_aprobada := true;
      if v_fin = 'almacen_sin_articulo' then
        raise notice 'Lo sustituido vuelve al almacén, pero su tipo no tiene artículo de almacén con el que contarlo.';
      end if;
    end if;
  end if;

  -- 3 y 4 — El equipo, con su etiqueta.
  if v_reutiliza
     and v_viejo.room_id = p_room
     and v_viejo.label is not null
     and not exists (
       select 1 from assets o
        where o.room_id = p_room and o.id <> v_asset and o.status <> 'retirado'
          and o.label is not null and public.norm_text(o.label) = public.norm_text(v_viejo.label)
     ) then
    v_label := v_viejo.label;
  elsif v_propuesta is not null
     and not exists (
       select 1 from assets o
        where o.room_id = p_room and (v_asset is null or o.id <> v_asset) and o.status <> 'retirado'
          and o.label is not null and public.norm_text(o.label) = public.norm_text(v_propuesta)
     ) then
    v_label := v_propuesta;
  else
    v_label := public.next_asset_label(p_room, v_tipo_nombre, v_asset);
  end if;

  if v_reutiliza then
    update assets
       set room_id       = p_room,
           status        = 'instalado',
           asset_type_id = v_tipo,
           label         = v_label,
           brand         = coalesce(v_u.brand, brand),
           model         = coalesce(v_u.model, model)
     where id = v_asset;
  else
    -- El id que propuso el cliente, para que la fila que ya enseña en el aula
    -- sea la misma que baje después. Si ya fuera de otro equipo, que no debería,
    -- uno nuevo: la instalación es real y no se tumba por un identificador.
    v_asset := coalesce(p_asset_id, gen_random_uuid());
    if exists (select 1 from assets where id = v_asset) then
      v_asset := gen_random_uuid();
    end if;
    insert into assets (id, asset_type_id, room_id, label, serial, brand, model,
                        status, confirmed, created_by, created_at)
    values (v_asset, v_tipo, p_room, v_label, v_u.serial, v_u.brand, v_u.model,
            'instalado', true, p_quien, v_cuando);
  end if;

  -- 5 — El alta, el descuento y la unidad. `nota` es lo que lee el Historial de
  -- la sala; `motivo`, lo que escribió la persona, sin el texto fijo, como en
  -- la ficha.
  insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
  values (
    gen_random_uuid(), v_asset, p_room, 'alta', v_cuando, p_quien,
    jsonb_build_object(
      'source',    'stock_units',
      'unidad',    v_u.id,
      'serial',    v_u.serial,
      'condicion', v_u.condicion,
      'nota',      coalesce(v_nota, format('Desde el almacén: %s, S/N %s', v_u.articulo, v_u.serial)),
      'motivo',    v_nota,
      'sustituye', p_sustituye
    )
  );

  if v_u.stock_item_id is not null then
    begin
      -- Del estado de la unidad si quedan en él; si no, de lo que haya
      -- (`20261027000300`).
      insert into stock_movements (id, stock_item_id, qty, kind, room_id, occurred_at, by_user, source, note, condicion)
      values (gen_random_uuid(), v_u.stock_item_id, -1, 'consumo', p_room, v_cuando, p_quien, 'app',
              format('Unidad S/N %s instalada', v_u.serial),
              public.stock_estado_si_quedan(v_u.stock_item_id, v_u.condicion, 1));
    exception when others then
      raise warning 'No se pudo descontar la unidad % del almacén: %', v_u.serial, sqlerrm;
    end;
  end if;

  update stock_units
     set status       = 'instalado',
         asset_id     = v_asset,
         room_id      = p_room,
         installed_at = v_cuando,
         retired_at   = null,
         updated_at   = now()
   where id = v_u.id;

  -- 6 — Y lo sustituido lo cuenta en su histórico.
  if p_sustituye is not null then
    insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
    values (
      gen_random_uuid(), p_sustituye, p_room, 'sustitucion', v_cuando, p_quien,
      jsonb_build_object('source', 'stock_units', 'por', v_asset, 'serial', v_u.serial, 'nota', v_motivo)
    );
    -- La baja que acaba de escribir la aprobación dice de dónde vino, como la
    -- de la ficha: es lo que lee la lista de movimientos.
    if v_aprobada then
      update asset_events
         set meta = meta || jsonb_build_object('source', 'stock_units', 'por', v_asset)
       where asset_id = p_sustituye
         and kind = 'baja'
         and meta ->> 'solicitud' = v_solicitud::text;
    end if;
  end if;

  return v_asset;
end $$;

comment on function public.instalar_unidad_del_almacen(uuid, uuid, uuid, text, text, uuid, text, timestamptz, uuid) is
  'Interna: la instalación de una unidad del almacén en un aula, común a stock_unit_instalar_en y a stock_unit_installs. Reutiliza el equipo con el mismo número de serie o crea uno validado, deja el alta, descuenta el artículo (del estado de la unidad si quedan en él), instala la unidad y, si sustituye un equipo, pide su retirada (la aprueba si quien instala es supervisor).';

revoke all on function public.instalar_unidad_del_almacen(uuid, uuid, uuid, text, text, uuid, text, timestamptz, uuid)
  from public, anon, authenticated;

/**
 * La instalación de septiembre, que siguen llamando las aplicaciones viejas:
 * la misma de siempre, y el −1 del estado de la unidad si quedan en él.
 */
create or replace function public.stock_unit_instalar(
  p_unit uuid,
  p_room uuid,
  p_note text default null,
  p_incident uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_u      stock_units%rowtype;
  v_yo     uuid := (select auth.uid());
  v_asset  uuid;
  v_previo uuid;
  v_tipo   uuid;
begin
  if not public.is_staff() then
    raise exception 'Solo el personal instala ordenadores'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_u from stock_units where id = p_unit for update;
  if not found then raise exception 'Esa unidad no existe'; end if;
  if v_u.status <> 'disponible' then
    raise exception 'Esa unidad no está disponible: está %', v_u.status;
  end if;
  if not exists (select 1 from rooms where id = p_room and active) then
    raise exception 'Esa sala no existe o está archivada';
  end if;

  v_tipo := coalesce(v_u.asset_type_id, public.asset_type_id('Ordenador'));
  if v_tipo is null then
    raise exception 'No hay un tipo de equipo «Ordenador» en el catálogo';
  end if;

  -- El mismo número de serie en otro equipo: es este mismo aparato, que ya
  -- constaba —de baja, o en otra aula por error—. Se reutiliza y se mueve.
  select id into v_asset from assets where serial = v_u.serial limit 1;

  -- El equipo que estaba puesto de ese tipo en el aula, si lo había, se retira.
  select id into v_previo from assets
   where room_id = p_room and asset_type_id = v_tipo and status = 'instalado'
     and (v_asset is null or id <> v_asset)
   order by created_at desc limit 1;

  if v_asset is null then
    insert into assets (asset_type_id, room_id, serial, model, brand, status, confirmed)
    values (v_tipo, p_room, v_u.serial, v_u.model, v_u.brand, 'instalado', true)
    returning id into v_asset;
  else
    update assets
       set room_id = p_room, status = 'instalado', asset_type_id = v_tipo,
           model = coalesce(v_u.model, model), brand = coalesce(v_u.brand, brand)
     where id = v_asset;
  end if;

  if v_previo is not null then
    update assets set status = 'retirado', room_id = null where id = v_previo;
    insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
    values (gen_random_uuid(), v_previo, p_room, 'sustitucion', now(), v_yo,
            jsonb_build_object('source', 'stock_units', 'por', v_asset,
                               'nota', 'sustituido por un ordenador de repuesto del almacén'));
  end if;

  insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
  values (gen_random_uuid(), v_asset, p_room, 'alta', now(), v_yo,
          jsonb_build_object('source', 'stock_units', 'unidad', v_u.id,
                             'nota', coalesce(p_note, 'ordenador de repuesto del almacén')));

  if v_u.stock_item_id is not null then
    begin
      -- Del estado de la unidad si quedan en él; si no, de lo que haya
      -- (`20261027000300`).
      insert into stock_movements (id, stock_item_id, qty, kind, incident_id, room_id, occurred_at, by_user, source, note, condicion)
      values (gen_random_uuid(), v_u.stock_item_id, -1, 'consumo', p_incident, p_room, now(), v_yo, 'app',
              format('Ordenador de repuesto %s instalado', v_u.serial),
              public.stock_estado_si_quedan(v_u.stock_item_id, v_u.condicion, 1));
    exception when others then
      raise warning 'No se pudo descontar la unidad % del almacén: %', v_u.serial, sqlerrm;
    end;
  end if;

  update stock_units
     set status = 'instalado', asset_id = v_asset, room_id = p_room,
         installed_at = now(), updated_at = now(),
         notes = case when p_note is null or btrim(p_note) = '' then notes
                      else concat_ws(' · ', notes, btrim(p_note)) end
   where id = p_unit;

  return v_asset;
end $$;

comment on function public.stock_unit_instalar(uuid, uuid, text, uuid) is
  'Lleva un ordenador de repuesto a un aula: crea el equipo con su número de serie, retira el que hubiera del mismo tipo, descuenta la unidad del almacén (de su estado si quedan en él) y deja la unidad como instalada.';

revoke all on function public.stock_unit_instalar(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.stock_unit_instalar(uuid, uuid, text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 9 — Lo que vuelve de un aula entra usado
--
-- `decide_asset_removal`, la de ayer, con un cambio: el +1 de la vuelta al
-- almacén dice «usado». Es lo que el disparador le pondría a una devolución que
-- no dice nada, pero aquí no es un defecto sino lo que pasa: el aparato viene
-- de estar puesto en un aula, y su unidad —la que vuelve o la que nace— vuelve
-- usada también. Copiada entera, sin otro cambio.
-- -----------------------------------------------------------------------------

/**
 * Autorizar o rechazar una retirada.
 *
 * Lo de siempre (`20260730000400`), sin un cambio en lo que ya hacía ni en lo
 * que devuelve —«rechazada», «baja», «almacen», «almacen_sin_articulo»—: retirar
 * el equipo, dejar el evento en el histórico de la sala, ingresar la unidad en
 * el artículo si vuelve al almacén —usada— y cerrar la solicitud. Y al final,
 * con destino almacén, la unidad con nombre de `20261027000200`.
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
  s             record;
  v_type        uuid;
  v_item        uuid;
  v_item_nombre text;
  v_evento      uuid := gen_random_uuid();
  v_yo          uuid := (select auth.uid());
  v_equipo      assets%rowtype;
  v_unidad      stock_units%rowtype;
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

  select id, name into v_item, v_item_nombre
    from stock_items
   where asset_type_id = v_type and active
   order by name
   limit 1;

  -- `devolucion` y no `compra`: no ha entrado nada nuevo en el centro, ha vuelto
  -- algo que ya era suyo. La sala queda anotada, que es lo que permite leer el
  -- movimiento como «salió de allí» en vez de como una entrada sin origen.
  -- Y entra usado: viene de estar puesto en un aula (`20261027000300`).
  if v_item is not null then
    insert into stock_movements (id, stock_item_id, qty, kind, room_id, occurred_at, by_user, note, condicion)
    values (
      gen_random_uuid(), v_item, 1, 'devolucion', s.room_id, now(), v_yo,
      'Devuelto desde el aula al retirar un equipo', 'usado'
    );
  end if;

  -- La unidad con nombre. Si el equipo ya tenía la suya, la ha devuelto
  -- `stock_unit_sigue_al_equipo` al retirarlo, y aquí no hay nada que hacer.
  select * into v_equipo from assets where id = s.asset_id;
  if v_equipo.serial is not null
     and not exists (select 1 from stock_units where asset_id = s.asset_id) then
    select * into v_unidad
      from stock_units
     where upper(regexp_replace(serial, '[\s\-_./]', '', 'g'))
         = upper(regexp_replace(v_equipo.serial, '[\s\-_./]', '', 'g'))
     for update;

    if not found then
      insert into stock_units (stock_item_id, asset_type_id, articulo, brand, model, serial,
                               status, condicion, asset_id, source)
      values (v_item, v_type,
              coalesce(v_item_nombre, (select name from asset_types where id = v_type), 'Equipo'),
              v_equipo.brand, v_equipo.model, v_equipo.serial,
              'disponible', 'usado', s.asset_id, 'retirada');
    elsif v_unidad.status <> 'instalado' then
      -- Ya constaba —de baja, o en el almacén sin equipo— y el aparato vuelve
      -- a estar en la estantería: es esa unidad, no otra.
      update stock_units
         set status        = 'disponible',
             asset_id      = s.asset_id,
             room_id       = null,
             retired_at    = null,
             installed_at  = null,
             condicion     = case when condicion in ('nuevo', 'sin_indicar') then 'usado' else condicion end,
             stock_item_id = coalesce(stock_item_id, v_item),
             asset_type_id = coalesce(asset_type_id, v_type),
             updated_at    = now()
       where id = v_unidad.id;
    end if;
    -- Instalada con otro equipo: esa fila dice dónde está el aparato, y no se
    -- le enmienda la plana desde aquí.
  end if;

  return case when v_item is null then 'almacen_sin_articulo' else 'almacen' end;
end;
$$;

comment on function public.decide_asset_removal(uuid, boolean, text) is
  'Autoriza o rechaza una retirada. Al aprobar retira el equipo y, si vuelve al almacén, ingresa la unidad en su artículo como usada y, si el equipo tiene número de serie y no tiene unidad, la crea (o devuelve la que hubiera con ese número) disponible y usada.';

grant execute on function public.decide_asset_removal(uuid, boolean, text) to authenticated;

-- PostgREST cachea el esquema: sin esto, la vista y las funciones nuevas no
-- existen para la aplicación hasta que alguien reinicie el servicio.
notify pgrst, 'reload schema';
