-- =============================================================================
-- Los partes también vuelven, y la fila dice de qué habla
--
-- La vuelta funcionaba para la hoja de estado y **no funcionaba para las de
-- partes**, sin que nadie se enterara. El motivo es de los que solo se ven
-- ejecutándolo: `sync_aplicar_celda` decidía qué hacer mirando el nombre del
-- campo, y para todo lo que no fuera del almacén daba por hecho que la clave era
-- una matrícula de sala. Una corrección en un parte llegaba con la clave
-- `I260102_0002`, se buscaba `rooms.short_ref = 'I260102_0002'`, no existía, y
-- se rechazaba con un motivo **falso**: «la matrícula no existe». La bandeja de
-- cuarentena se llenaba de un error que no era el que había pasado, y ninguna
-- corrección de un parte entraba jamás.
--
-- Y hay un caso donde adivinar era directamente imposible: `sala.code` significa
-- dos cosas según la hoja —el código del aula en la de estado, y de qué aula es
-- el parte en la de material—. Con un solo nombre de campo no hay forma de
-- distinguirlas, así que la fila ahora dice de qué habla (`entidad`), que además
-- es la columna que `sync_celdas` ya tenía preparada y nadie rellenaba.
--
-- Sobre el material consumido, que es la parte delicada: **se reconcilia, no se
-- suma**. La columna `Material Usado` del Excel es la descripción de lo que se
-- gastó, y `stock_movements` es el libro mayor. Si se apuntara un consumo cada
-- vez que la sincronización lee esa celda, cada pasada descontaría otra vez las
-- mismas unidades y el almacén se hundiría solo. Así que se mira lo que ese
-- parte **ya tiene descontado** y se apunta únicamente la diferencia — la misma
-- regla que ya usa `Total Comprado`, y por la misma razón: es lo que hace que
-- repetir una pasada no cambie nada.
--
-- Lo que no se resuelve a un artículo del catálogo no se inventa: se guarda el
-- texto tal cual en `incident_materials.raw_text`, que existe exactamente para
-- eso, y no genera movimiento. Un consumo con el artículo adivinado descuadra el
-- almacén igual que no apuntarlo, pero encima parece correcto.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — La celda, sabiendo de qué fila viene
-- -----------------------------------------------------------------------------

create or replace function public.sync_aplicar_celda(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entidad text := coalesce(p->>'entidad', '');
  v_campo   text := p->>'campo';
begin
  -- La entidad manda. Si no viene —un plan de antes de esta migración— se
  -- deduce del nombre del campo, que es lo que se hacía y funciona para todo
  -- menos para `sala.code`.
  if v_entidad = '' then
    v_entidad := case
      when v_campo like 'articulo.%' then 'articulo'
      when v_campo like 'incidencia.%' then 'incidencia'
      else 'sala'
    end;
  end if;

  if v_entidad = 'articulo'   then return public.sync_celda_de_articulo(p);   end if;
  if v_entidad = 'incidencia' then return public.sync_celda_de_incidencia(p); end if;
  return public.sync_celda_de_sala(p);
end $$;

comment on function public.sync_aplicar_celda(jsonb) is
  'Aplica una celda según de qué habla su fila. Devuelve null si entró y el motivo si no: una fila mala no puede tumbar la pasada de las otras 275.';

-- -----------------------------------------------------------------------------
-- 2 — Un parte
-- -----------------------------------------------------------------------------

create or replace function public.sync_celda_de_incidencia(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campo text := p->>'campo';
  v_clave text := p->>'clave';
  v_valor text := p->>'valor';
  v_id    uuid;
  v_room  uuid;
begin
  select id into v_id from incidents where external_ref = v_clave;
  if v_id is null then
    return format('el parte «%s» no está en la aplicación', v_clave);
  end if;

  case v_campo
    when 'incidencia.abierta' then
      if v_valor is null or v_valor = '' then return null; end if;
      update incidents set opened_at = v_valor::date::timestamptz where id = v_id;

    when 'incidencia.resuelta' then
      if v_valor is null or v_valor = '' then
        -- Vaciar la fecha de resuelto es reabrir el parte, y eso no se hace
        -- desde una celda: se hace desde el aula, que es donde se ve.
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
      return public.sync_material_del_parte(v_id, coalesce(p->'detalle', '[]'::jsonb));

    when 'sala.code' then
      -- De qué aula es el parte. Se resuelve por código, y si hay más de una
      -- sala con ese código en edificios distintos no se elige: se dice.
      if v_valor is null or btrim(v_valor) = '' then return null; end if;
      select r.id into v_room from rooms r
       where public.norm_text(r.code) = public.norm_text(v_valor) and r.active
       limit 2;
      if v_room is null then
        return format('«%s» no es ninguna sala del maestro', v_valor);
      end if;
      if (select count(*) from rooms r
           where public.norm_text(r.code) = public.norm_text(v_valor) and r.active) > 1 then
        return format('«%s» es el código de más de una sala: hace falta el edificio', v_valor);
      end if;
      update incidents set room_id = v_room where id = v_id;

    else
      return format('«%s» no se aplica a un parte desde el Excel', v_campo);
  end case;

  return null;
end $$;

-- -----------------------------------------------------------------------------
-- 3 — El material de un parte
--
-- `detalle` viene ya partido y resuelto desde el navegador, que es donde vive el
-- catálogo de alias:
--
--   [{"articulo_id": "uuid|null", "cantidad": 2, "texto": "2 Cable Hdmi 10mts"}]
--
-- Se hace en el navegador y no aquí porque partir «1Pantalla 240X240» en un 1 y
-- una pantalla es exactamente el tipo de cosa que en SQL sale mal y en
-- `valores.ts` ya está escrita y probada.
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
  v_sin      int := 0;
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

    -- Lo que este parte ya tiene descontado de ese artículo. Se apunta solo la
    -- diferencia: si no, cada pasada volvería a descontar lo mismo.
    select coalesce(-sum(qty), 0) into v_ya
      from stock_movements
     where incident_id = p_incidencia and stock_item_id = v_item and kind = 'consumo';

    v_falta := v_cantidad - v_ya;
    if v_falta = 0 then continue; end if;

    insert into stock_movements (id, stock_item_id, qty, kind, incident_id, occurred_at, by_user, source, note)
    values (gen_random_uuid(), v_item, -v_falta, 'consumo', p_incidencia,
            coalesce(v_cuando, now()), null, 'sharepoint',
            format('Material del parte según el Excel: %s', r->>'texto'));
  end loop;

  if v_sin > 0 then
    return format('%s material(es) sin artículo del catálogo: se guarda el texto y no se descuenta del almacén', v_sin);
  end if;
  return null;
end $$;

-- -----------------------------------------------------------------------------
-- 4 — Las dos ramas que ya existían, con su nombre propio
--
-- Se separan de `sync_aplicar_celda` sin cambiarles una línea de lo que hacen:
-- lo único que cambia es que ahora las llama el que reparte por entidad.
-- -----------------------------------------------------------------------------

create or replace function public.sync_celda_de_articulo(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campo text := p->>'campo';
  v_clave text := p->>'clave';
  v_valor text := p->>'valor';
  v_item  uuid;
  v_ya    numeric;
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
    select coalesce(sum(qty), 0) into v_ya
      from stock_movements where stock_item_id = v_item and kind = 'compra';
    if v_valor is null or v_valor = '' then return null; end if;
    if v_valor::numeric - v_ya = 0 then return null; end if;
    insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user, source, note)
    values (gen_random_uuid(), v_item, (v_valor::numeric - v_ya)::int, 'compra',
            now(), null, 'sharepoint',
            format('Cuadre con «Total Comprado» del Excel: la hoja dice %s y la base tenía %s', v_valor, v_ya));
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

create or replace function public.sync_celda_de_sala(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campo   text := p->>'campo';
  v_clave   text := p->>'clave';
  v_valor   text := p->>'valor';
  v_room    uuid;
  v_tipo    text;
  v_sub     text;
  v_type_id uuid;
begin
  select id into v_room from rooms where short_ref = v_clave;
  if v_room is null then
    return format('la matrícula «%s» no existe', v_clave);
  end if;

  if v_campo = 'sala.code' then
    if v_valor is null or btrim(v_valor) = '' then return 'el código de la sala no puede quedar vacío'; end if;
    if exists (select 1 from rooms r
                where r.zone_id = (select zone_id from rooms where id = v_room)
                  and r.id <> v_room and r.code = v_valor) then
      return format('ya hay otra sala «%s» en la misma planta', v_valor);
    end if;
    update rooms set code = v_valor where id = v_room;
    return null;
  end if;

  if v_campo = 'rooms.projector_hours' then
    update rooms set projector_hours = nullif(v_valor, '')::int where id = v_room;
    return null;
  end if;

  if v_campo = 'rooms.lamp_pct' then
    update rooms set lamp_pct = nullif(v_valor, '')::numeric where id = v_room;
    return null;
  end if;

  if v_campo = 'rooms.botonera_estado' then
    update rooms set botonera_estado = nullif(btrim(coalesce(v_valor, '')), '') where id = v_room;
    return null;
  end if;

  if v_campo like 'capacidad:%' then
    v_sub := split_part(v_campo, ':', 2);
    update rooms
       set capabilities = capabilities || jsonb_build_object(v_sub, coalesce(v_valor, 'false')::boolean)
     where id = v_room;
    return null;
  end if;

  if v_campo in ('edificio', 'zona') then
    return public.sync_mover_sala(v_room, v_campo, v_valor);
  end if;

  if v_campo like 'equipo:%' then
    v_tipo := split_part(v_campo, ':', 2);
    v_sub  := split_part(v_campo, ':', 3);
    v_type_id := public.asset_type_id(v_tipo);
    if v_type_id is null then
      return format('«%s» no está en el catálogo de equipos', v_tipo);
    end if;
    return public.sync_aplicar_equipo(v_room, v_type_id, v_sub, v_valor);
  end if;

  if v_campo = 'microfono' then
    if v_valor is null or btrim(v_valor) = '' then return null; end if;
    if upper(v_valor) in ('SI', 'SÍ', 'S') then
      update rooms set capabilities = capabilities || '{"microfono":true}'::jsonb where id = v_room;
      return null;
    end if;
    if upper(v_valor) in ('NO', 'N') then
      update rooms set capabilities = capabilities || '{"microfono":false}'::jsonb where id = v_room;
      return null;
    end if;
    update rooms set capabilities = capabilities || '{"microfono":true}'::jsonb where id = v_room;
    return public.sync_aplicar_equipo(
      v_room, public.asset_type_id('Micrófono'),
      case when v_valor ~ '\d' then 'serial' else 'model' end,
      v_valor
    );
  end if;

  if v_campo = 'revision.ultima' then
    return public.sync_revision_desde_el_excel(v_room, nullif(v_valor, '')::date, null);
  end if;
  if v_campo = 'revision.notas' then
    return public.sync_revision_desde_el_excel(v_room, null, v_valor);
  end if;

  return format('«%s» no se aplica desde el Excel', v_campo);
end $$;

-- -----------------------------------------------------------------------------
-- 5 — La instantánea también apunta a qué entidad es
-- -----------------------------------------------------------------------------

comment on column sync_celdas.entidad is
  'De qué habla la fila: room, incident o stock_item. Lo dice el plan, porque el nombre del campo no basta: «sala.code» es el código del aula en la hoja de estado y el aula de un parte en la de material.';

revoke all on function public.sync_celda_de_incidencia(jsonb) from public;
revoke all on function public.sync_celda_de_articulo(jsonb) from public;
revoke all on function public.sync_celda_de_sala(jsonb) from public;
revoke all on function public.sync_material_del_parte(uuid, jsonb) from public;
