-- reejecutable: si
-- =============================================================================
-- El almacén dice QUÉ material no reconoce
--
-- Al sincronizar el libro el 22/09/2026 quedaron 30 apuntes de cuarentena que
-- decían, los treinta, exactamente lo mismo: «1 material(es) sin artículo del
-- catálogo: se guarda el texto y no se descuenta del almacén». Treinta partes,
-- treinta materiales distintos, y ni uno nombrado. Para saber cuál había que
-- abrir el parte en el libro, y eran treinta.
--
-- El dato estaba delante: la función tiene el texto en la mano —lo acaba de
-- guardar en `incident_materials.raw_text` dos líneas antes— y lo tiraba para
-- sumarle uno a un contador. Ahora lo dice, y con eso se puede arreglar: casi
-- todos son lámparas escritas como se escriben en un aula («lampara NP30»,
-- «lamparas NP 30») frente al nombre del catálogo, «Lámpara proyector NP30».
--
-- Y de paso arregla algo que no se veía. El motivo llevaba el número dentro, y
-- el motivo forma parte de la clave que impide que la cuarentena se repita
-- (origen, fila, motivo; migración 20260830000600). Así que el día que ese
-- mismo parte pasara de un material sin reconocer a dos, no se actualizaba su
-- apunte: se abría uno nuevo y el viejo se quedaba abierto para siempre. Sin el
-- número dentro, el motivo solo cambia cuando cambia el material, que es
-- justamente cuando tiene que cambiar.
--
-- Lo que NO se toca: que un nombre que el catálogo no reconoce no mueva el
-- almacén. Adivinar ahí descuadra el stock, y descuadrarlo en silencio es peor
-- que no apuntarlo.
-- =============================================================================

create or replace function public.sync_material_del_parte(p_incidencia uuid, p_detalle jsonb, p_arranque date default null)
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
  -- Los materiales que el catálogo no reconoce, con su texto. Era un contador,
  -- y un número no se puede arreglar: «1 material(es) sin artículo» obliga a
  -- abrir el parte para saber cuál, y son treinta partes. Y como el número iba
  -- DENTRO del motivo, la clave que impide duplicar la cuarentena —(origen,
  -- fila, motivo)— cambiaba de forma en cuanto el parte pasaba de uno a dos: se
  -- abría un apunte nuevo y el viejo se quedaba abierto para siempre.
  v_sin      text[] := array[]::text[];
  -- El parte es de antes de que la aplicación llevara el almacén: su material
  -- se apunta y no se descuenta.
  v_anterior boolean := false;
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

  -- Con la misma fecha se decide si el parte es de antes del arranque. Un parte
  -- sin fecha no lo es: no hay forma de saberlo, y descontar es lo prudente.
  v_anterior := p_arranque is not null
                and v_cuando is not null
                and (v_cuando at time zone 'Europe/Madrid')::date < p_arranque;

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

    -- Anterior al arranque: apuntado queda, y aquí se acaba.
    if v_anterior then continue; end if;

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
      v_sin := v_sin || coalesce(nullif(btrim(r->>'texto'), ''), '(sin texto)');
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

  -- De un parte anterior al arranque no vuelve nada tampoco: lo que tuviera
  -- descontado es historia de otro almacén.
  if v_anterior then return null; end if;

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

  if array_length(v_sin, 1) > 0 then
    return format(
      'el almacén no reconoce %s: se guarda el texto en el parte y no se descuenta nada',
      array_to_string(v_sin, ', '));
  end if;
  return null;
end $$;

comment on function public.sync_material_del_parte(uuid, jsonb, date) is
  'Rehace el material de un parte con lo que diga el Excel y cuadra el almacén con la diferencia neta, a nombre del parte y de su aula. Un 0 delante se apunta sin descontar; bajar una cantidad o quitar una línea devuelve las unidades. Un parte anterior a p_arranque se apunta y no mueve nada. Lo que el catálogo no reconoce se devuelve NOMBRADO, para poder arreglarlo sin abrir el libro.';

revoke all on function public.sync_material_del_parte(uuid, jsonb, date) from public, anon, authenticated;

notify pgrst, 'reload schema';
