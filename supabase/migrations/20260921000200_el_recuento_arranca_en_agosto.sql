-- =============================================================================
-- El recuento del almacén arranca el 1 de agosto de 2026
--
-- La aplicación tomó el almacén el 1 de agosto de 2026 con lo que «Bolsa 2026»
-- decía ese día en «Total Comprado» como saldo de partida (el importador lo
-- metió como «saldo inicial» y la migración anterior lo reclasificó como
-- compra). Todo lo de antes —los partes de enero a julio y lo que descontaron—
-- se había quedado como estaba en el libro, y la gente lo quiere así: lo que
-- importa es de agosto en adelante.
--
-- Pero la sincronización no lo sabía, y en la primera pasada con el libro
-- reformateado hacía tres cosas mal a la vez:
--
--  1. Leía los partes de enero a julio con su «Material Usado» y descontaba del
--     almacén lo que no tuviera descontado ya. Ese material salió de un
--     almacén que la aplicación no llevaba y ya estaba fuera del recuento de
--     partida: descontarlo otra vez dejaba tres artículos en negativo.
--  2. Escribía en la bolsa los meses de enero a julio sumando esos partes,
--     encima de lo que alguien apuntó a mano en enero y febrero.
--  3. Contaba como compras de 2026 dos compras de prueba del 29 de julio, y
--     «Total Comprado» no cuadraba nunca por dos unidades.
--
-- Ahora la hoja declara desde cuándo lleva la aplicación el almacén (el
-- `arranque` del mapa, `2026-08-01`) y viaja con cada corrección y cada alta:
--
--  - `sync_material_del_parte` recibe la fecha y, si el parte es anterior,
--    guarda su material en el parte tal y como lo dice la hoja y **no mueve
--    nada**: ni sale ni vuelve.
--  - `sync_celda_de_articulo` cuenta lo comprado del año desde esa fecha, y
--    fecha la compra que cuadra «Total Comprado» a partir de ella.
--  - Los saldos de partida importados se fechan en el arranque, que es de lo
--    que hablan: lo que había el 1 de agosto.
--
-- Los meses de enero a julio los deja en paz el cliente (son del libro, `dueno:
-- 'libro'`): aquí no llegan.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — El material de un parte anterior al arranque no mueve el almacén
-- -----------------------------------------------------------------------------

-- La firma cambia (un parámetro más, con valor por defecto). Con las dos firmas
-- a la vez una llamada con dos argumentos sería ambigua: la vieja se va.
drop function if exists public.sync_material_del_parte(uuid, jsonb);

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
  v_sin      int := 0;
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

  if v_sin > 0 then
    return format('%s material(es) sin artículo del catálogo: se guarda el texto y no se descuenta del almacén', v_sin);
  end if;
  return null;
end $$;

comment on function public.sync_material_del_parte(uuid, jsonb, date) is
  'Rehace el material de un parte con lo que diga el Excel y cuadra el almacén con la diferencia neta, a nombre del parte y de su aula. Un 0 delante se apunta sin descontar; bajar una cantidad o quitar una línea devuelve las unidades. Un parte anterior a p_arranque (desde cuándo lleva la aplicación el almacén) se apunta y no mueve nada.';

revoke all on function public.sync_material_del_parte(uuid, jsonb, date) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2 — Quien llama pasa la fecha: la celda de material y el alta del parte
-- -----------------------------------------------------------------------------

create or replace function public.sync_celda_de_incidencia(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campo   text := p->>'campo';
  v_clave   text := p->>'clave';
  v_valor   text := p->>'valor';
  v_id      uuid;
  v_cuantas int;
  v_room    uuid;
begin
  select count(*) into v_cuantas from incidents where external_ref = v_clave;

  if v_cuantas = 0 then
    return format('el parte «%s» no está en la aplicación', v_clave);
  end if;
  if v_cuantas > 1 then
    -- Elegir una escribiría la resolución de un aula en la de otra.
    return format(
      'el número «%s» está en %s incidencias distintas: hay que separarlas desde la aplicación antes de que la hoja pueda corregirlas',
      v_clave, v_cuantas);
  end if;

  select id into v_id from incidents where external_ref = v_clave;

  case v_campo
    when 'incidencia.abierta' then
      if v_valor is null or v_valor = '' then return null; end if;
      update incidents set opened_at = v_valor::date::timestamptz where id = v_id;

    when 'incidencia.resuelta' then
      if v_valor is null or v_valor = '' then
        return 'para reabrir un parte hay que hacerlo desde la aplicación';
      end if;
      update incidents
         set resolved_at = v_valor::date::timestamptz,
             state = 'resuelta'
       where id = v_id;

    when 'incidencia.problema' then
      if v_valor is null or btrim(v_valor) = '' then return null; end if;
      update incidents set title = v_valor where id = v_id;

    when 'incidencia.observacion' then
      update incidents set description = nullif(btrim(coalesce(v_valor, '')), '') where id = v_id;

    when 'incidencia.resolucion' then
      update incidents set resolution = nullif(btrim(coalesce(v_valor, '')), '') where id = v_id;

    when 'incidencia.material' then
      -- Con el arranque del recuento de la hoja: un parte anterior se apunta y
      -- no descuenta.
      return public.sync_material_del_parte(
        v_id, coalesce(p->'detalle', '[]'::jsonb), nullif(p->>'arranque', '')::date);

    when 'sala.code' then
      if v_valor is null or btrim(v_valor) = '' then return null; end if;
      if (select count(*) from rooms r
           where public.norm_text(r.code) = public.norm_text(v_valor) and r.active) > 1 then
        return format('«%s» es el código de más de una sala: hace falta el edificio', v_valor);
      end if;
      select r.id into v_room from rooms r
       where public.norm_text(r.code) = public.norm_text(v_valor) and r.active
       limit 1;
      if v_room is null then
        return format('«%s» no es ninguna sala del maestro', v_valor);
      end if;
      update incidents set room_id = v_room where id = v_id;

    else
      return format('«%s» no se aplica a un parte desde el Excel', v_campo);
  end case;

  return null;
end $$;

revoke all on function public.sync_celda_de_incidencia(jsonb) from public, anon, authenticated;

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
      -- Con el arranque del recuento: un parte de antes entra con su material
      -- apuntado y el almacén quieto.
      perform public.sync_material_del_parte(v_id, p->'detalle', nullif(p->>'arranque', '')::date);
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
      insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user, source, note)
      values (gen_random_uuid(), v_id, v_cantidad, 'compra', now(), null, 'sharepoint',
              'Comprado según la bolsa del Excel, al dar de alta el artículo');
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
  'Da de alta un parte, un artículo o un ordenador de repuesto que el libro tiene y la aplicación no, deja el antepasado de la fila bajo su clave nueva y devuelve esa clave. El número del parte lo pone la base y se devuelve para escribirlo en la fila. Un parte anterior al arranque del recuento entra con su material apuntado y sin mover el almacén.';

revoke all on function public.sync_alta(jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3 — «Total Comprado» se cuenta desde el arranque
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
  v_desde  date;
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
    -- Desde cuándo lleva la aplicación el almacén de ese año. Lo comprado antes
    -- es de un almacén que no llevaba: el saldo de partida ya lo cuenta.
    v_desde := nullif(p->>'arranque', '')::date;

    select coalesce(sum(qty), 0) into v_ya
      from stock_movements
     where stock_item_id = v_item
       and kind = 'compra'
       and extract(year from (occurred_at at time zone 'Europe/Madrid')) = v_anyo
       and (v_desde is null or (occurred_at at time zone 'Europe/Madrid')::date >= v_desde);

    v_falta := v_valor::numeric - v_ya;
    if v_falta = 0 then return null; end if;

    if v_falta < 0 then
      return format(
        'la aplicación tiene %s unidades compradas en %s%s y la hoja dice %s: una compra no se deshace desde una celda',
        v_ya, v_anyo,
        case when v_desde is null then '' else format(' (desde el %s)', to_char(v_desde, 'DD/MM')) end,
        v_valor);
    end if;

    -- Dentro del año del que habla la hoja —y no antes del arranque—, y lo más
    -- cerca de hoy que se pueda: para el año en curso es ahora mismo, y para
    -- uno cerrado, su último día.
    v_cuando := least(
      greatest(
        now(),
        make_timestamptz(v_anyo, 1, 1, 0, 0, 0, 'Europe/Madrid'),
        coalesce(v_desde::timestamp at time zone 'Europe/Madrid', now())
      ),
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

-- -----------------------------------------------------------------------------
-- 4 — El saldo de partida se fecha en el arranque
-- -----------------------------------------------------------------------------
--
-- El importador fechó los saldos iniciales de «Bolsa 2026» el 1 de enero, y la
-- migración anterior los reclasificó como compra. Son lo que había el día que
-- la aplicación tomó el almacén, así que se fechan ese día: es lo que hace que
-- «Total Comprado» contado desde el arranque dé lo mismo que la hoja, y que las
-- dos compras de prueba del 29 de julio queden fuera de la cuenta sin borrarlas.
-- Los movimientos no se editan; por eso se levanta el disparador un momento.

alter table stock_movements disable trigger stock_movements_solo_alta;

update stock_movements
   set occurred_at = make_timestamptz(2026, 8, 1, 0, 0, 0, 'Europe/Madrid'),
       note = 'Saldo de partida del recuento: lo que «Total Comprado» de Bolsa 2026 decía cuando la aplicación tomó el almacén el 1/8/2026 (importado como saldo inicial; reclasificado como compra y fechado en el arranque el 21/09/2026)'
 where source = 'import'
   and kind = 'compra'
   and note = 'Compras de 2026 según «Total Comprado» de Bolsa 2026 (importado como saldo inicial; reclasificado el 21/09/2026)';

alter table stock_movements enable trigger stock_movements_solo_alta;
