-- =============================================================================
-- El Excel cuadra el almacén
--
-- Tres cosas que la hoja «Bolsa 2026» decía y la base no sabía entender, y que
-- juntas explican por qué el stock de la aplicación y el del libro no cuadraban
-- nunca por mucho que se sincronizara:
--
-- -----------------------------------------------------------------------------
-- 1 — «Stock Disponible» manda cuando se ha elegido que mande el Excel
--
-- La celda es una fórmula (`Total Comprado − Total Instalado`) y no se escribe
-- jamás: eso está bien. Pero cuando la persona que sube el libro elige «Manda
-- el Excel», lo que dice esa celda es el inventario de verdad, y la aplicación
-- solo lo anotaba como «descuadre» en la hoja de sincronización, pasada tras
-- pasada. La documentación lo prometía desde el principio —«si los dos números
-- discrepan, entra un movimiento de ajuste con nota diciendo de qué celda
-- salió»— y nunca se llegó a hacer.
--
-- Ahora la celda viaja como `articulo.disponible` y la base cuadra el saldo con
-- un `ajuste`, positivo o negativo, con la nota que dice de dónde sale. El
-- disparador que impide el almacén en negativo sigue mandando: un disponible
-- que dejaría el saldo bajo cero no entra y la celda va a cuarentena con el
-- motivo.
--
-- -----------------------------------------------------------------------------
-- 2 — Un 0 delante en «Material Usado» es «apuntado, pero sin descontar»
--
-- Es la notación que ya usa la gente en la hoja de partes —`0 1 lampara NP44`,
-- `0 1 Proyector EB-FH54 EEB`— para el material que se instaló y no salió de la
-- bolsa: reciclado, de garantía, de stock antiguo. `sync_material_del_parte`
-- forzaba al menos una unidad por renglón, así que el 0 se convertía en un
-- consumo o el renglón entero quedaba como artículo desconocido. Ahora la
-- cantidad 0 se respeta: se guarda en `incident_materials` con su texto, y no
-- mueve el almacén.
--
-- -----------------------------------------------------------------------------
-- 3 — Lo que el importador metió como «saldo inicial de 2026» eran las compras
--     de 2026
--
-- El importador de arranque tradujo la columna «Total Comprado» de la bolsa de
-- 2026 a un movimiento de `ajuste` fechado el 1 de enero con la nota «Saldo
-- inicial importado de Bolsa 2026». Y `Total Comprado` se cuadra contra las
-- compras del año (`kind = 'compra'`, migración 20260830000900), así que la
-- base creía haber comprado 0 unidades en 2026 y, en la primera pasada de
-- verdad, iba a registrar la bolsa entera otra vez como compra: 28 cables de
-- fibra de 10 m encima de los 28 que ya estaban. Esas filas eran compras y se
-- reclasifican como tales. Los saldos no cambian —un ajuste positivo y una
-- compra suman lo mismo—; cambia lo que la base contesta cuando la hoja
-- pregunta cuánto se compró este año.
--
-- `stock_movements` es de solo alta a propósito (migración 20260729000500); una
-- reparación desde una migración es exactamente la puerta que aquella dejó:
-- desactivar el disparador, corregir y volver a activarlo, y que se note.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — «Stock Disponible»
-- -----------------------------------------------------------------------------

create or replace function public.sync_celda_de_articulo(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campo  text := p->>'campo';
  v_clave  text := p->>'clave';
  v_valor  text := p->>'valor';
  v_item   uuid;
  v_ya     numeric;
  v_falta  numeric;
  v_anyo   int;
  v_cuando timestamptz;
  v_saldo  numeric;
begin
  begin
    v_item := v_clave::uuid;
  exception when others then
    return format('«%s» no es un artículo del almacén', v_clave);
  end;
  if not exists (select 1 from stock_items where id = v_item) then
    return format('el artículo %s ya no está en el catálogo', v_clave);
  end if;

  if v_campo = 'articulo.nombreAlternativo' then
    if v_valor is null or btrim(v_valor) = '' then return null; end if;
    if exists (select 1 from stock_items o where o.id <> v_item
                 and public.norm_text(o.name) = public.norm_text(v_valor)) then
      return format('«%s» ya es el nombre de otro artículo', v_valor);
    end if;
    update stock_items
       set aliases = array(select distinct unnest(aliases || v_valor))
     where id = v_item
       and public.norm_text(v_valor) <> public.norm_text(name)
       and not exists (select 1 from unnest(aliases) a
                        where public.norm_text(a) = public.norm_text(v_valor));
    return null;
  end if;

  if v_campo = 'articulo.comprado' then
    if v_valor is null or v_valor = '' then return null; end if;

    v_anyo := coalesce(
      nullif(p->>'anyo', '')::int,
      extract(year from (now() at time zone 'Europe/Madrid'))::int
    );

    select coalesce(sum(qty), 0) into v_ya
      from stock_movements
     where stock_item_id = v_item
       and kind = 'compra'
       and extract(year from (occurred_at at time zone 'Europe/Madrid')) = v_anyo;

    v_falta := v_valor::numeric - v_ya;
    if v_falta = 0 then return null; end if;

    if v_falta < 0 then
      return format(
        'la aplicación tiene %s unidades compradas en %s y la hoja dice %s: una compra no se deshace desde una celda',
        v_ya, v_anyo, v_valor);
    end if;

    -- Dentro del año del que habla la hoja, y lo más cerca de hoy que se pueda:
    -- para el año en curso es ahora mismo, y para uno cerrado, su último día.
    v_cuando := least(
      greatest(now(), make_timestamptz(v_anyo, 1, 1, 0, 0, 0, 'Europe/Madrid')),
      make_timestamptz(v_anyo, 12, 31, 23, 59, 59, 'Europe/Madrid')
    );

    insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user, source, note)
    values (gen_random_uuid(), v_item, v_falta::int, 'compra', v_cuando, null, 'sharepoint',
            format('Cuadre con «Total Comprado» del Excel: la hoja dice %s en %s y la base tenía %s',
                   v_valor, v_anyo, v_ya));
    return null;
  end if;

  -- El cuadre con «Stock Disponible». Solo llega aquí cuando la persona eligió
  -- que mande el Excel: el cliente no lo manda de otra forma. Va el último de
  -- la pasada, detrás de compras y consumos, así que la diferencia que se
  -- ajusta es la que queda DESPUÉS de todo lo demás.
  if v_campo = 'articulo.disponible' then
    if v_valor is null or v_valor = '' then return null; end if;
    if v_valor::numeric < 0 then
      return format('la hoja dice %s disponibles: el almacén no puede quedar en negativo. Revisar «Total Comprado»', v_valor);
    end if;

    select coalesce(sum(qty), 0) into v_saldo
      from stock_movements where stock_item_id = v_item;

    v_falta := v_valor::numeric - v_saldo;
    if v_falta = 0 then return null; end if;

    insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user, source, note)
    values (gen_random_uuid(), v_item, v_falta::int, 'ajuste', now(), null, 'sharepoint',
            format('Cuadre con «Stock Disponible» del Excel: la hoja dice %s y la base tenía %s (manda el Excel)',
                   v_valor, v_saldo));
    return null;
  end if;

  -- El nombre bueno de un artículo lo decide una persona en el catálogo, no una
  -- celda: lo que venga por aquí se guarda como alias, que es lo que es.
  if v_campo = 'articulo.nombre' then
    return public.sync_celda_de_articulo(
      jsonb_set(p, '{campo}', '"articulo.nombreAlternativo"'::jsonb)
    );
  end if;

  return format('«%s» no se aplica en el almacén', v_campo);
end $$;

revoke all on function public.sync_celda_de_articulo(jsonb) from public, anon, authenticated;

comment on function public.sync_celda_de_articulo(jsonb) is
  'Una celda de la hoja de bolsa. «Comprado» se cuadra contra las compras DE SU AÑO; «Stock Disponible», solo cuando manda el Excel, cuadra el saldo con un ajuste.';

-- -----------------------------------------------------------------------------
-- 2 — El 0 de «sin descontar»
-- -----------------------------------------------------------------------------

create or replace function public.sync_material_del_parte(p_incidencia uuid, p_detalle jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  r          jsonb;
  v_item     uuid;
  v_cantidad int;
  v_ya       int;
  v_falta    int;
  v_cuando   timestamptz;
  v_room     uuid;
  v_sin      int := 0;
  -- Los artículos que la hoja todavía nombra. Lo que no esté aquí y este parte
  -- tenga descontado, vuelve al almacén.
  v_vistos   uuid[] := array[]::uuid[];
  v_sobra    record;
begin
  -- La fecha y el aula del parte: el consumo ocurrió cuando y donde el parte
  -- dice, no cuando alguien sincronizó el libro.
  select coalesce(resolved_at, opened_at), room_id
    into v_cuando, v_room
    from incidents where id = p_incidencia;

  -- La descripción se rehace entera: es lo que dice el Excel, y no es un libro
  -- mayor sino la lista de lo que se puso.
  delete from incident_materials where incident_id = p_incidencia;

  for r in select * from jsonb_array_elements(coalesce(p_detalle, '[]'::jsonb)) loop
    v_item := nullif(r->>'articulo_id', '')::uuid;
    -- Un 0 es «apuntado sin descontar» y se respeta; lo que no diga cantidad
    -- es una unidad, como siempre.
    v_cantidad := greatest(0, coalesce((r->>'cantidad')::int, 1));

    insert into incident_materials (id, incident_id, stock_item_id, qty, raw_text)
    values (gen_random_uuid(), p_incidencia, v_item, v_cantidad, r->>'texto');

    if v_cantidad = 0 then
      -- Material reciclado, de garantía o de stock antiguo: queda escrito en el
      -- parte y el almacén no se toca. No cuenta como «sin artículo», porque
      -- el 0 lo puso alguien a propósito.
      if v_item is not null then v_vistos := v_vistos || v_item; end if;
      continue;
    end if;

    if v_item is null then
      -- Sin artículo no hay movimiento: un consumo con el artículo adivinado
      -- descuadra el almacén igual que no apuntarlo, y encima parece correcto.
      v_sin := v_sin + 1;
      continue;
    end if;

    v_vistos := v_vistos || v_item;

    -- Lo que este parte ya tiene descontado de ese artículo, **neto**: los
    -- consumos menos lo que ya se devolvió. Si no se restaran las devoluciones,
    -- la devolución de hoy sería el descuento de mañana.
    select coalesce(-sum(qty), 0)::int into v_ya
      from stock_movements
     where incident_id = p_incidencia and stock_item_id = v_item
       and kind in ('consumo', 'devolucion');

    v_falta := v_cantidad - v_ya;

    if v_falta > 0 then
      insert into stock_movements (id, stock_item_id, qty, kind, incident_id, room_id, occurred_at, by_user, source, note)
      values (gen_random_uuid(), v_item, -v_falta, 'consumo', p_incidencia, v_room,
              coalesce(v_cuando, now()), null, 'sharepoint',
              format('Material del parte según el Excel: %s', r->>'texto'));
    elsif v_falta < 0 then
      insert into stock_movements (id, stock_item_id, qty, kind, incident_id, room_id, occurred_at, by_user, source, note)
      values (gen_random_uuid(), v_item, -v_falta, 'devolucion', p_incidencia, v_room,
              coalesce(v_cuando, now()), null, 'sharepoint',
              format('El Excel baja la cantidad a %s: vuelven %s al almacén', v_cantidad, -v_falta));
    end if;
  end loop;

  -- Y lo que la hoja ya no nombra: si este parte lo tenía descontado, vuelve.
  -- Un renglón con 0 delante también cuenta como nombrado: si alguien pasa un
  -- cable de «1» a «0» lo que quiere es dejar de descontarlo, y eso lo hace la
  -- devolución de arriba, no ésta.
  for v_sobra in
    select sm.stock_item_id as item, (-sum(sm.qty))::int as neto
      from stock_movements sm
     where sm.incident_id = p_incidencia
       and sm.kind in ('consumo', 'devolucion')
     group by sm.stock_item_id
    having -sum(sm.qty) > 0
  loop
    if v_sobra.item = any (v_vistos) then
      -- Nombrado con 0: lo que tenía descontado vuelve, que es lo que pide el 0.
      if exists (select 1 from incident_materials im
                  where im.incident_id = p_incidencia and im.stock_item_id = v_sobra.item and im.qty > 0) then
        continue;
      end if;
    end if;
    insert into stock_movements (id, stock_item_id, qty, kind, incident_id, room_id, occurred_at, by_user, source, note)
    values (gen_random_uuid(), v_sobra.item, v_sobra.neto, 'devolucion', p_incidencia, v_room,
            coalesce(v_cuando, now()), null, 'sharepoint',
            'El Excel ya no lo cuenta en este parte: vuelve al almacén');
  end loop;

  if v_sin > 0 then
    return format('%s material(es) sin artículo del catálogo: se guarda el texto y no se descuenta del almacén', v_sin);
  end if;
  return null;
end $$;

comment on function public.sync_material_del_parte(uuid, jsonb) is
  'Rehace el material de un parte con lo que diga el Excel y cuadra el almacén con la diferencia neta, a nombre del parte y de su aula. Un 0 delante se apunta sin descontar; bajar una cantidad o quitar una línea devuelve las unidades.';

revoke all on function public.sync_material_del_parte(uuid, jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3 — Las compras de 2026 que el importador llamó «saldo inicial»
-- -----------------------------------------------------------------------------

alter table stock_movements disable trigger stock_movements_solo_alta;

update stock_movements
   set kind = 'compra',
       note = 'Compras de 2026 según «Total Comprado» de Bolsa 2026 (importado como saldo inicial; reclasificado el 21/09/2026)'
 where source = 'import'
   and kind = 'ajuste'
   and qty > 0
   and note = 'Saldo inicial importado de Bolsa 2026';

alter table stock_movements enable trigger stock_movements_solo_alta;
