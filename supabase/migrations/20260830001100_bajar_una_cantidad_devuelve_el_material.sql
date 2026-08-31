-- =============================================================================
-- Bajar una cantidad devuelve el material al almacén; quitar una línea, también
--
-- `sync_material_del_parte` rehace la lista de material de un parte con lo que
-- diga el Excel, y del almacén apunta solo la diferencia para no descontar dos
-- veces lo mismo en cada pasada. La diferencia estaba bien calculada y mal
-- usada, porque solo contemplaba que fuera hacia arriba:
--
-- **Corregir «3» por «2» no entraba.** `v_falta` salía `-1` y se insertaba
-- `-v_falta`, o sea `+1`, con `kind = 'consumo'`. Un consumo positivo lo prohíbe
-- `stock_movements_signo_check` —y con razón: `material_consumption_ranking`
-- calcula `sum(-qty)` y habría sacado consumos en negativo—, así que la celda se
-- rechazaba con «la base lo rechazó», iba a cuarentena, y en la pasada siguiente
-- volvía a pasar lo mismo. Corregir una cantidad hacia abajo no se podía.
--
-- **Y borrar una línea entera no devolvía nada.** El bucle solo mira lo que la
-- hoja trae: un artículo que ya no está no se visita, así que su descuento se
-- quedaba en el almacén para siempre. La lista del parte decía que no se usó y
-- el stock seguía sin esas unidades — descuadre permanente, y de los que no se
-- ven hasta que alguien cuenta cajas.
--
-- Las dos se arreglan igual, y es lo que ya hacía la aplicación por su cuenta:
-- material que se apuntó y no se usó **vuelve** al almacén. Una `devolucion`,
-- que es el tipo que existe justo para esto y el único al que el signo no le
-- pone condiciones.
--
-- Y la cuenta de «lo que este parte ya tiene descontado» pasa a ser la neta —los
-- consumos menos las devoluciones—, que si no, la devolución de hoy sería el
-- descuento de mañana.
-- =============================================================================

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
  v_sin      int := 0;
  -- Los artículos que la hoja todavía nombra. Lo que no esté aquí y este parte
  -- tenga descontado, vuelve al almacén.
  v_vistos   uuid[] := array[]::uuid[];
  v_sobra    record;
begin
  select coalesce(resolved_at, opened_at) into v_cuando from incidents where id = p_incidencia;

  -- La descripción se rehace entera: es lo que dice el Excel, y no es un libro
  -- mayor sino la lista de lo que se puso.
  delete from incident_materials where incident_id = p_incidencia;

  for r in select * from jsonb_array_elements(coalesce(p_detalle, '[]'::jsonb)) loop
    v_item := nullif(r->>'articulo_id', '')::uuid;
    v_cantidad := greatest(1, coalesce((r->>'cantidad')::int, 1));

    insert into incident_materials (id, incident_id, stock_item_id, qty, raw_text)
    values (gen_random_uuid(), p_incidencia, v_item, v_cantidad, r->>'texto');

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
      insert into stock_movements (id, stock_item_id, qty, kind, incident_id, occurred_at, by_user, source, note)
      values (gen_random_uuid(), v_item, -v_falta, 'consumo', p_incidencia,
              coalesce(v_cuando, now()), null, 'sharepoint',
              format('Material del parte según el Excel: %s', r->>'texto'));
    elsif v_falta < 0 then
      insert into stock_movements (id, stock_item_id, qty, kind, incident_id, occurred_at, by_user, source, note)
      values (gen_random_uuid(), v_item, -v_falta, 'devolucion', p_incidencia,
              coalesce(v_cuando, now()), null, 'sharepoint',
              format('El Excel baja la cantidad a %s: vuelven %s al almacén', v_cantidad, -v_falta));
    end if;
  end loop;

  -- Y lo que la hoja ya no nombra: si este parte lo tenía descontado, vuelve.
  for v_sobra in
    select sm.stock_item_id as item, (-sum(sm.qty))::int as neto
      from stock_movements sm
     where sm.incident_id = p_incidencia
       and sm.kind in ('consumo', 'devolucion')
     group by sm.stock_item_id
    having -sum(sm.qty) > 0
  loop
    if v_sobra.item = any (v_vistos) then continue; end if;
    insert into stock_movements (id, stock_item_id, qty, kind, incident_id, occurred_at, by_user, source, note)
    values (gen_random_uuid(), v_sobra.item, v_sobra.neto, 'devolucion', p_incidencia,
            coalesce(v_cuando, now()), null, 'sharepoint',
            'El Excel ya no lo cuenta en este parte: vuelve al almacén');
  end loop;

  if v_sin > 0 then
    return format('%s material(es) sin artículo del catálogo: se guarda el texto y no se descuenta del almacén', v_sin);
  end if;
  return null;
end $$;

comment on function public.sync_material_del_parte(uuid, jsonb) is
  'Rehace el material de un parte con lo que diga el Excel y cuadra el almacén con la diferencia neta. Bajar una cantidad o quitar una línea devuelve las unidades: apuntarlas y no usarlas no puede dejar el stock descontado para siempre.';

revoke all on function public.sync_material_del_parte(uuid, jsonb) from public, anon, authenticated;
