-- =============================================================================
-- Lo que entra del Excel al almacén lleva su aula y su año
--
-- Dos movimientos que la sincronización apuntaba a medias, y los dos se veían
-- en la hoja «Movimientos de Almacén» y en el informe antes que en la base:
--
-- -----------------------------------------------------------------------------
-- 1 — El consumo de un parte que viene del Excel no decía en qué aula fue
--
-- `stock_movements.room_id` existe desde julio (`consumo_con_destino`) porque
-- el almacén sabe cuánto queda y no dónde fue, y esa es justo la pregunta que
-- se hace después: cuánto material se lleva un edificio. Lo que se apunta
-- desde la aplicación lo lleva; lo que entra por «Material Usado» de la hoja
-- de partes —`sync_material_del_parte`— no: el consumo se apuntaba con el
-- parte y sin la sala, y el parte sí sabe de qué aula es. La hoja salía con
-- esas filas sin aula, y el reparto por edificio del informe las perdía.
--
-- Ahora el movimiento lleva la sala del parte, en los tres casos —consumo,
-- devolución por bajar la cantidad y devolución por quitar la línea—, y lo que
-- ya estaba apuntado sin aula la recibe de su parte, igual que hizo julio con
-- lo de antes.
--
-- -----------------------------------------------------------------------------
-- 2 — La compra con la que entra un artículo nuevo se fechaba hoy
--
-- `sync_celda_de_articulo` ya fecha el cuadre de «Total Comprado» dentro del
-- año de la hoja (migración 20260830000900): sincronizar la bolsa de 2026 en
-- enero de 2027 no puede meter la compra en 2027. Pero `sync_alta` —el
-- artículo que la bolsa lista y el almacén no conocía— seguía con `now()`, y
-- es la misma columna del mismo libro. El año viaja ahora con el alta y la
-- compra se fecha como en el cuadre: dentro de su año, y lo más cerca de hoy
-- que se pueda.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — El material de un parte, con su aula
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
  for v_sobra in
    select sm.stock_item_id as item, (-sum(sm.qty))::int as neto
      from stock_movements sm
     where sm.incident_id = p_incidencia
       and sm.kind in ('consumo', 'devolucion')
     group by sm.stock_item_id
    having -sum(sm.qty) > 0
  loop
    if v_sobra.item = any (v_vistos) then continue; end if;
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
  'Rehace el material de un parte con lo que diga el Excel y cuadra el almacén con la diferencia neta, a nombre del parte y de su aula. Bajar una cantidad o quitar una línea devuelve las unidades.';

revoke all on function public.sync_material_del_parte(uuid, jsonb) from public, anon, authenticated;

-- Lo que ya entró del Excel sin aula: la recibe de su parte. Es el mismo
-- arreglo que hizo julio con lo apuntado desde la aplicación, y por la misma
-- razón: el informe reparte el material por edificio con esta columna.
update stock_movements sm
   set room_id = i.room_id
  from incidents i
 where sm.incident_id = i.id
   and sm.room_id is null
   and i.room_id is not null;

-- -----------------------------------------------------------------------------
-- 2 — El alta de un artículo, con la compra fechada en el año de su bolsa
-- -----------------------------------------------------------------------------

create or replace function public.sync_alta(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tipo    text := p->>'tipo';
  v_hoja    text := p->>'hoja';
  v_clave   text;
  v_numero  text;
  v_id      uuid;
  v_room    uuid := nullif(p->>'sala_id', '')::uuid;
  v_aula    text := nullif(btrim(coalesce(p->>'aula', '')), '');
  v_abierta date := nullif(p->>'abierta', '')::date;
  v_resuelta date := nullif(p->>'resuelta', '')::date;
  v_pedido  text := nullif(btrim(coalesce(p->>'numero', '')), '');
  v_nombre  text;
  v_cantidad int;
  v_anyo    int;
  v_cuando  timestamptz;
  c         record;
begin
  if v_tipo = 'incidencia' then
    if v_room is not null and not exists (select 1 from rooms where id = v_room) then
      raise exception 'la sala «%» no existe en el maestro', v_room;
    end if;

    insert into incidents (id, room_id, title, description, resolution, state,
                           opened_at, resolved_at, source)
    values (gen_random_uuid(), v_room,
            btrim(p->>'problema'),
            nullif(btrim(coalesce(p->>'observacion', '')), ''),
            nullif(btrim(coalesce(p->>'resolucion', '')), ''),
            case when v_resuelta is not null then 'resuelta'::incident_state else 'abierta'::incident_state end,
            coalesce(v_abierta, v_resuelta, current_date)::timestamptz,
            v_resuelta::timestamptz,
            'sharepoint')
    returning id, external_ref into v_id, v_numero;

    -- El número que la fila traía se respeta si está libre y bien formado. Si
    -- no, manda el de la base y la fila se corrige al escribir el libro.
    if v_pedido is not null
       and v_pedido ~ '^[A-Z]\d{6}_\d{4}$'
       and not exists (select 1 from incidents where external_ref = v_pedido) then
      update incidents set external_ref = v_pedido where id = v_id;
      v_numero := v_pedido;
    end if;

    if jsonb_typeof(p->'detalle') = 'array' and jsonb_array_length(p->'detalle') > 0 then
      perform public.sync_material_del_parte(v_id, p->'detalle');
    end if;

    -- El aula tal y como la escribió el técnico queda de alias de la sala: es
    -- lo que hace que la próxima vez cruce sola. Un alias que ya es de otra
    -- sala no se pisa.
    if v_room is not null and v_aula is not null then
      insert into room_aliases (room_id, alias, alias_norm)
      values (v_room, v_aula, public.norm_text(v_aula))
      on conflict (alias_norm) do nothing;
    end if;

    -- Sin sala, el texto del aula se guarda donde «Incidencias sin sala» lo
    -- busca: en la cuarentena, con el motivo que esa pantalla reconoce. Así un
    -- parte que entró sin aula se puede colocar después desde el panel.
    if v_room is null then
      perform public.cuarentena_apuntar(
        'SharePoint',
        v_numero,
        jsonb_build_object('ref', v_numero, 'aula', v_aula, 'problema', btrim(p->>'problema'),
                           'hoja', v_hoja, 'fila', p->>'fila'),
        'No se pudo identificar la sala');
    end if;

    v_clave := v_numero;

  elsif v_tipo = 'articulo' then
    v_nombre := btrim(coalesce(p->>'nombre', ''));
    if v_nombre = '' then raise exception 'un artículo necesita nombre'; end if;
    select id into v_id from stock_items where public.norm_text(name) = public.norm_text(v_nombre);
    if v_id is null then
      insert into stock_items (name, aliases)
      values (v_nombre,
              case when nullif(btrim(coalesce(p->>'nombre_alternativo', '')), '') is null
                   then '{}'::text[] else array[btrim(p->>'nombre_alternativo')] end)
      returning id into v_id;
    end if;
    v_cantidad := nullif(p->>'comprado', '')::int;
    if v_cantidad is not null and v_cantidad > 0 then
      -- Lo comprado es lo comprado ESE año: la compra va dentro del año de la
      -- bolsa, y lo más cerca de hoy que se pueda, igual que en el cuadre de
      -- una celda. Sin año se supone el corriente, que es lo que era antes.
      v_anyo := coalesce(
        nullif(p->>'anyo', '')::int,
        extract(year from (now() at time zone 'Europe/Madrid'))::int
      );
      v_cuando := least(
        greatest(now(), make_timestamptz(v_anyo, 1, 1, 0, 0, 0, 'Europe/Madrid')),
        make_timestamptz(v_anyo, 12, 31, 23, 59, 59, 'Europe/Madrid')
      );
      insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user, source, note)
      values (gen_random_uuid(), v_id, v_cantidad, 'compra', v_cuando, null, 'sharepoint',
              format('Comprado según la bolsa de %s del Excel, al dar de alta el artículo', v_anyo));
    end if;
    v_clave := v_id::text;

  elsif v_tipo = 'unidad' then
    v_id := public.stock_unit_alta(jsonb_build_object(
      'articulo', p->>'articulo', 'marca', p->>'marca', 'modelo', p->>'modelo',
      'serial', p->>'serial', 'observaciones', p->>'observaciones', 'source', 'sharepoint'));
    v_clave := v_id::text;

  else
    raise exception 'no sé dar de alta «%»', v_tipo;
  end if;

  -- El antepasado de la fila, bajo su clave nueva.
  if v_hoja is not null and jsonb_typeof(p->'celdas') = 'object' then
    for c in select key, value from jsonb_each(p->'celdas') loop
      insert into sync_celdas (hoja, ref, columna, valor_base, entidad)
      values (v_hoja, v_clave, c.key,
              case when jsonb_typeof(c.value) = 'null' then null else c.value #>> '{}' end,
              v_tipo)
      on conflict (hoja, ref, columna) do update
        set valor_base = excluded.valor_base, at = now();
    end loop;
    -- Y la columna del número, si es un parte, dice el número que la base puso.
    if v_tipo = 'incidencia' and nullif(p->>'columna_numero', '') is not null then
      insert into sync_celdas (hoja, ref, columna, valor_base, entidad)
      values (v_hoja, v_clave, p->>'columna_numero', v_numero, v_tipo)
      on conflict (hoja, ref, columna) do update
        set valor_base = excluded.valor_base, at = now();
    end if;
  end if;

  return jsonb_build_object('clave', v_clave, 'numero', v_numero, 'id', v_id);
end $$;

comment on function public.sync_alta(jsonb) is
  'Da de alta un parte, un artículo o un ordenador de repuesto que el libro tiene y la aplicación no, deja el antepasado de la fila bajo su clave nueva y devuelve esa clave. El número del parte lo pone la base; la compra de un artículo nuevo se fecha en el año de su bolsa.';

revoke all on function public.sync_alta(jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';
