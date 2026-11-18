-- =============================================================================
-- El parte de material dice cuál
--
-- Hasta hoy el parte de una incidencia decía «3 teclados» y nada más. De cuáles
-- —nuevos o usados— lo decidía la base al cerrar, por su orden de siempre: lo
-- usado primero. Y de un artículo con número de serie no quedaba apuntado qué
-- aparato se había llevado: se descontaba uno y la unidad seguía «en el
-- almacén» hasta que alguien la corregía a mano.
--
-- Desde hoy cada fila del parte puede decir cuál:
--
--   condicion      de qué estado salen esas unidades (nuevo, usado,
--                  reacondicionado, averiado, sin_indicar);
--   stock_unit_id  qué aparato es, por su número de serie. Una fila por aparato.
--
-- Las dos son opcionales, y eso es lo importante: **quien no dice nada sigue
-- como estaba**. La aplicación solo pregunta cuando hay algo que elegir —un
-- artículo con existencias en más de un estado, o con unidades con número de
-- serie—; si no, apunta como siempre y la base saca de lo que haya.
--
-- Cómo se cuadra el almacén con el parte, por artículo:
--
--  - Lo que el parte pide de un estado sale de ESE estado mientras queden en
--    él. Si no llegan —la cifra del iPad era de ayer—, lo que falta sale de lo
--    que haya, por el orden de siempre. El cierre no se tumba por el estado:
--    solo por el total, como hasta ahora.
--  - Lo que el parte no dice de qué estado, sale de lo que haya.
--  - Si el parte baja después del cierre, vuelve lo que sobra AL ESTADO DEL QUE
--    SALIÓ. Antes todo volvía «usado», que es lo que entra por defecto una
--    devolución; pero corregir un parte no es desinstalar nada, y un teclado
--    nuevo apuntado de más sigue en su caja. Cambiar «1 nuevo» por «1 usado»
--    en un parte cerrado devuelve el nuevo a los nuevos y saca un usado.
--  - Repetir la cuenta sin que cambie el parte no apunta nada.
--
-- Y las unidades con número de serie:
--
--  - Al cerrar, la unidad apuntada sale del almacén: pasa a «instalada» en el
--    aula de la incidencia. Si en esa aula ya hay un equipo con su número de
--    serie, apunta a él; si no, queda a la espera, y el equipo que llegue
--    después con ese número la recoge (punto 4).
--  - Si otro se la llevó antes —ya no está disponible—, no se toca: su unidad
--    se descuenta igual, que es lo que de verdad salió de la estantería.
--  - Quitarla del parte después del cierre la devuelve al almacén, salvo que ya
--    conste como equipo de un aula: entonces se retira desde el aula, que es
--    donde está el camino de vuelta con su autorización.
--
-- Las dos escrituras de `unidad_sacada` vuelven a disparar la cuenta —es un
-- `update` del parte de una incidencia cerrada—, y esa segunda vuelta no
-- encuentra nada que hacer: por eso repetirla tiene que ser gratis.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — Las dos columnas
-- -----------------------------------------------------------------------------

alter table incident_materials
  add column if not exists condicion text;

alter table incident_materials
  drop constraint if exists incident_materials_condicion_check,
  add constraint incident_materials_condicion_check
    check (condicion is null
           or condicion in ('nuevo', 'usado', 'reacondicionado', 'averiado', 'sin_indicar'));

alter table incident_materials
  add column if not exists stock_unit_id uuid references stock_units(id) on delete set null;

-- Un aparato no se gasta dos veces en la misma incidencia. La aplicación
-- reutiliza la fila de la unidad —quitarla es ponerla a cero, volver a
-- apuntarla es ponerla a uno—, y esto lo garantiza aunque dos iPads la
-- apunten a la vez.
create unique index if not exists incident_materials_unidad_idx
  on incident_materials (incident_id, stock_unit_id)
  where stock_unit_id is not null;

-- Si esta fila sacó su unidad del almacén. Lo escribe la cuenta de abajo, no la
-- aplicación: es lo que le dice, cuando la fila baja a cero, que esa unidad la
-- puso en el aula ESTA incidencia y es ella quien la devuelve. Sin la marca, una
-- fila que se quitó antes del cierre le quitaría la unidad a quien la instaló
-- después por otro camino.
alter table incident_materials
  add column if not exists unidad_sacada boolean not null default false;

comment on column incident_materials.unidad_sacada is
  'La pone material_de_incidencia_al_almacen cuando esta fila saca su unidad del almacén, y la quita cuando la devuelve. La aplicación no la escribe.';

comment on column incident_materials.condicion is
  'De qué estado salen las unidades de esta fila: nuevo, usado, reacondicionado, averiado o sin_indicar. NULL es «no lo dice»: al cerrar salen de lo que haya, por el orden de stock_movement_con_estado. Dicho, es una preferencia: sale de ahí mientras queden, y el resto de lo que haya.';

comment on column incident_materials.stock_unit_id is
  'El aparato concreto, si el artículo lleva número de serie: una fila por unidad, con qty 1 (o 0 si se quitó). Al cerrar la incidencia la unidad pasa a instalada en su aula.';

-- -----------------------------------------------------------------------------
-- 2 — La cuenta, por estados y con las unidades
--
-- La misma función de `20260924000100`, con la misma firma y los mismos dos
-- disparadores que la llaman. Lo que cambia es que ya no compara un total con
-- otro sino cada estado con el suyo.
--
-- Por artículo, con el cerrojo del artículo tomado (el mismo de
-- `stock_no_negativo` y `stock_movement_con_estado`: dentro de la transacción
-- se vuelve a tomar sin esperar):
--
--   quiere[e]  lo que el parte pide del estado e. Las filas con unidad cuentan
--              en el estado de su unidad.
--   sin        lo que el parte pide sin decir de cuál.
--   ya[e]      lo que la incidencia tiene descontado del estado e, neto.
--
--   - ya[e] > quiere[e]: sobran. Primero tapan lo pedido sin estado —es de
--     donde salió—, por el orden en que se saca; lo que aún sobre vuelve a e.
--   - ya[e] < quiere[e]: faltan. Salen de e las que queden en e; las que no,
--     pasan a «sin estado» y salen de lo que haya.
--
-- Las devoluciones van antes que los consumos —un cambio de estado en un parte
-- cerrado no puede dejar el total un instante por debajo de cero—, y los
-- consumos que dicen su estado antes que el que no lo dice, para que este no
-- se lleve lo que aquellos tenían contado.
--
-- Por qué repetirla no apunta nada: lo que no pudo salir de su estado salió de
-- otro, y ahí está, sobrando; la vez siguiente tapa lo que sigue faltando y la
-- cuenta sale a cero.
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
  v_room      uuid;
  v_cuando    timestamptz := coalesce(p_cuando, now());
  v_item      uuid;
  -- El orden en que vuelve lo que sobra: el mismo en que sale.
  v_estados   text[] := array['usado', 'reacondicionado', 'sin_indicar', 'nuevo', 'averiado'];
  v_e         text;
  v_quiere    jsonb;
  v_ya        jsonb;
  v_sin       int;
  v_q         int;
  v_y         int;
  v_hay       int;
  v_toma      int;
  v_negativo  int;
  v_sobra     jsonb;
  v_sacar     jsonb;
  v_devolver  int;
  v_total     int;
  v_u         record;
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
  for v_item in
    select distinct stock_item_id
      from incident_materials
     where incident_id = p_incidencia
       and stock_item_id is not null
       and (p_articulo is null or stock_item_id = p_articulo)
  loop
    perform pg_advisory_xact_lock(hashtextextended('stock_item:' || v_item, 0));

    -- Lo que el parte pide, por estado. La clave vacía es «no lo dice».
    select coalesce(jsonb_object_agg(x.estado, x.unidades), '{}'::jsonb),
           coalesce(sum(x.unidades), 0)::int
      into v_quiere, v_total
      from (
        select coalesce(im.condicion, u.condicion, '') as estado,
               sum(greatest(im.qty, 0))::int           as unidades
          from incident_materials im
          left join stock_units u on u.id = im.stock_unit_id
         where im.incident_id = p_incidencia
           and im.stock_item_id = v_item
         group by 1
      ) x;
    v_sin := coalesce((v_quiere ->> '')::int, 0);

    -- Lo que la incidencia ya tiene descontado de cada estado, **neto**: los
    -- consumos menos las devoluciones.
    select coalesce(jsonb_object_agg(x.condicion, x.unidades), '{}'::jsonb)
      into v_ya
      from (
        select condicion, (-sum(qty))::int as unidades
          from stock_movements
         where incident_id = p_incidencia
           and stock_item_id = v_item
           and kind in ('consumo', 'devolucion')
         group by condicion
      ) x;

    -- Un estado en negativo es de antes de hoy: lo que salió nuevo y volvió
    -- «usado», que es como volvía todo. No es que la incidencia deba unidades
    -- de ese estado: se compensa con lo que tenga descontado de los demás, y
    -- lo que aún quede es total que vuelve a faltar.
    v_negativo := 0;
    foreach v_e in array v_estados loop
      v_y := coalesce((v_ya ->> v_e)::int, 0);
      if v_y < 0 then
        v_negativo := v_negativo - v_y;
        v_ya := v_ya || jsonb_build_object(v_e, 0);
      end if;
    end loop;
    if v_negativo > 0 then
      foreach v_e in array array['nuevo', 'sin_indicar', 'reacondicionado', 'usado', 'averiado'] loop
        v_y := coalesce((v_ya ->> v_e)::int, 0);
        continue when v_y <= 0;
        v_toma := least(v_y, v_negativo);
        v_ya := v_ya || jsonb_build_object(v_e, v_y - v_toma);
        v_negativo := v_negativo - v_toma;
        exit when v_negativo = 0;
      end loop;
      v_sin := v_sin + v_negativo;
    end if;

    -- Estado por estado: qué sobra y qué hay que sacar.
    v_sobra  := '{}'::jsonb;
    v_sacar  := '{}'::jsonb;
    foreach v_e in array v_estados loop
      v_q := coalesce((v_quiere ->> v_e)::int, 0);
      v_y := coalesce((v_ya ->> v_e)::int, 0);
      if v_y > v_q then
        v_sobra := v_sobra || jsonb_build_object(v_e, v_y - v_q);
      elsif v_q > v_y then
        select greatest(coalesce(max(b.on_hand), 0), 0)::int into v_hay
          from stock_balances_por_estado b
         where b.stock_item_id = v_item and b.condicion = v_e;
        v_toma := least(v_q - v_y, v_hay);
        if v_toma > 0 then
          v_sacar := v_sacar || jsonb_build_object(v_e, v_toma);
        end if;
        -- Las que no quedan en su estado salen de lo que haya.
        v_sin := v_sin + (v_q - v_y - v_toma);
      end if;
    end loop;

    -- Lo que sobra tapa primero lo pedido sin estado, por el orden en que la
    -- base lo habría sacado —lo usado antes que lo nuevo—, y el resto vuelve al
    -- estado del que salió. Así, bajar a dos un parte de tres que se llevó un
    -- usado y dos nuevos devuelve un NUEVO: los dos que se quedan son los que
    -- se habrían cogido primero.
    foreach v_e in array v_estados loop
      exit when v_sin = 0;
      v_toma := least(coalesce((v_sobra ->> v_e)::int, 0), v_sin);
      continue when v_toma <= 0;
      v_sobra := v_sobra || jsonb_build_object(v_e, (v_sobra ->> v_e)::int - v_toma);
      v_sin   := v_sin - v_toma;
    end loop;

    foreach v_e in array v_estados loop
      v_devolver := coalesce((v_sobra ->> v_e)::int, 0);
      continue when v_devolver <= 0;
      insert into stock_movements (id, stock_item_id, qty, kind, incident_id, room_id, occurred_at, by_user, source, note, condicion)
      values (gen_random_uuid(), v_item, v_devolver, 'devolucion', p_incidencia, v_room,
              v_cuando, p_quien, 'app',
              format('El parte baja la cantidad a %s: vuelven %s al almacén', v_total, v_devolver),
              v_e);
    end loop;

    foreach v_e in array v_estados loop
      v_toma := coalesce((v_sacar ->> v_e)::int, 0);
      continue when v_toma <= 0;
      insert into stock_movements (id, stock_item_id, qty, kind, incident_id, room_id, occurred_at, by_user, source, condicion)
      values (gen_random_uuid(), v_item, -v_toma, 'consumo', p_incidencia, v_room,
              v_cuando, p_quien, 'app', v_e);
    end loop;

    if v_sin > 0 then
      insert into stock_movements (id, stock_item_id, qty, kind, incident_id, room_id, occurred_at, by_user, source)
      values (gen_random_uuid(), v_item, -v_sin, 'consumo', p_incidencia, v_room,
              v_cuando, p_quien, 'app');
    end if;
  end loop;

  -- Las unidades con número de serie que nombra el parte.
  for v_u in
    select im.id as fila, im.qty, im.unidad_sacada, u.id, u.status, u.asset_id, u.serial
      from incident_materials im
      join stock_units u on u.id = im.stock_unit_id
     where im.incident_id = p_incidencia
       and (p_articulo is null or im.stock_item_id = p_articulo)
       for update of u
  loop
    if v_u.qty > 0 and v_u.status = 'disponible' then
      -- Sale del almacén. Si su número de serie ya es un equipo de esa aula,
      -- apunta a él; si no, el que llegue después la recoge.
      update stock_units
         set status       = 'instalado',
             room_id      = v_room,
             asset_id     = (
               select a.id from assets a
                where v_room is not null
                  and a.room_id = v_room
                  and a.status <> 'retirado'
                  and a.serial is not null
                  and upper(regexp_replace(a.serial, '[\s\-_./]', '', 'g'))
                    = upper(regexp_replace(v_u.serial, '[\s\-_./]', '', 'g'))
                order by a.created_at desc
                limit 1),
             installed_at = least(v_cuando, now()),
             retired_at   = null,
             updated_at   = now()
       where id = v_u.id;
      update incident_materials set unidad_sacada = true where id = v_u.fila;
    elsif v_u.qty <= 0 and v_u.unidad_sacada then
      if v_u.status = 'instalado' and v_u.asset_id is not null then
        raise exception 'La unidad S/N % ya consta como equipo de un aula: para devolverla al almacén, retírala desde el inventario del aula.', v_u.serial
          using errcode = '22023';
      end if;
      -- Quitada del parte y sin equipo: vuelve a la estantería como estaba. Si
      -- ya no está instalada —alguien la dio de baja—, se queda como esté.
      update stock_units
         set status = 'disponible', room_id = null, installed_at = null, updated_at = now()
       where id = v_u.id and status = 'instalado';
      update incident_materials set unidad_sacada = false where id = v_u.fila;
    end if;
  end loop;
end;
$$;

comment on function public.material_de_incidencia_al_almacen(uuid, uuid, timestamptz, uuid) is
  'Cuadra el almacén con el parte de material de una incidencia, artículo por artículo y estado por estado: lo que el parte pide de un estado sale de él mientras queden y el resto de lo que haya; lo que sobra vuelve al estado del que salió. Las unidades con número de serie que nombra el parte pasan a instaladas en el aula de la incidencia, y vuelven si se quitan. Repetirla sin que cambie el parte no apunta nada. No hace nada si el parte no tiene ninguna fila apuntada desde la aplicación.';

revoke all on function public.material_de_incidencia_al_almacen(uuid, uuid, timestamptz, uuid)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3 — El equipo que llega con el número de serie de una unidad que ya salió
--
-- `20261027000200` (punto 7): cuando un equipo con sala lleva el número de
-- serie de una unidad DISPONIBLE, la unidad pasa a instalada y apunta a él.
-- Desde hoy hay otra unidad que espera a su equipo: la que salió por el parte
-- de una incidencia, que está instalada y todavía no apunta a ninguno. Cuando
-- el técnico —o el Excel— da de alta el aparato en el aula, la recoge igual, y
-- se queda en el aula donde de verdad está el equipo.
--
-- Sigue sin apuntar movimiento: el descuento ya lo hizo quien la sacó.
-- -----------------------------------------------------------------------------
create or replace function public.stock_unit_se_instala_por_su_serie()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.serial is null or new.status = 'retirado' or new.room_id is null then
    return null;
  end if;

  update stock_units
     set status       = 'instalado',
         asset_id     = new.id,
         room_id      = new.room_id,
         installed_at = coalesce(installed_at, now()),
         updated_at   = now()
   where (status = 'disponible' or (status = 'instalado' and asset_id is null))
     and upper(regexp_replace(serial, '[\s\-_./]', '', 'g'))
       = upper(regexp_replace(new.serial, '[\s\-_./]', '', 'g'));

  return null;
end $$;

comment on function public.stock_unit_se_instala_por_su_serie() is
  'Disparador de assets: cuando un equipo no retirado con sala lleva el número de serie de una unidad disponible —o de una que salió por el parte de una incidencia y aún no apunta a ningún equipo—, la unidad pasa a instalada y apunta a él. No apunta movimiento de almacén.';

revoke all on function public.stock_unit_se_instala_por_su_serie() from public, anon, authenticated;

notify pgrst, 'reload schema';
