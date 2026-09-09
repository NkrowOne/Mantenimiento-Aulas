-- =============================================================================
-- Lo que el libro tiene y la aplicación no: entra. Y los PCs de repuesto, por
-- número de serie.
--
-- Tres cosas, y las tres salen del mismo repaso al libro de septiembre:
--
-- -----------------------------------------------------------------------------
-- 1 — Un parte tecleado en el libro entra en la aplicación
--
-- Las cuatro últimas filas de «Material Instalado 2026» no llevan número: son
-- partes que el técnico apuntó en la hoja y nunca pasaron a la aplicación. La
-- sincronización los contaba como «sin cruzar» y los dejaba, para siempre —y
-- `sync_celda_de_incidencia` los rechazaba si se intentaba, porque solo sabe
-- corregir partes que existen—. Con dos caras que escriben, un registro que solo
-- admite altas por una de ellas no es un registro sincronizado.
--
-- `sync_alta` los crea. El número lo pone la base, como a todos los partes con
-- sesión (`poner_ref_incidencia`), y **se devuelve** para que la pasada lo
-- escriba en la fila: la pasada siguiente lo encontrará por él. Si la fila
-- traía número y está libre y bien formado, se respeta; si no, manda el de la
-- base y la fila se corrige.
--
-- Lo mismo para un artículo que la bolsa lista y el almacén no conoce.
--
-- -----------------------------------------------------------------------------
-- 2 — `stock_units`: un ordenador de repuesto es una unidad, no una cantidad
--
-- El almacén cuenta —«quedan 7 Ordenador Tiny M70Q»— y la hoja nueva «PCs STOCK
-- 2026» **nombra**: qué ordenador, con qué número de serie, está esperando en
-- el almacén. Hasta hoy la aplicación no tenía dónde guardar eso: un equipo
-- (`assets`) siempre es de un aula, y un artículo (`stock_items`) no lleva
-- número de serie. Entre los dos había un hueco, y la hoja lo ocupaba sola.
--
-- `stock_units` es ese hueco. Una fila por ordenador, con su artículo, marca,
-- modelo y número de serie, y una situación: `disponible` en el almacén,
-- `instalado` en un aula —con el equipo que se creó al instalarlo—, o `baja`.
-- Instalarlo (`stock_unit_instalar`) es lo que cierra el círculo: crea el
-- equipo en el aula con su número de serie, retira el que hubiera del mismo
-- tipo, descuenta la unidad del artículo del almacén y deja el rastro en
-- `asset_events` y `stock_movements`, que es de donde sale el informe.
--
-- -----------------------------------------------------------------------------
-- 3 — `sync_aplicar` devuelve lo que asignó
--
-- Hasta aquí una pasada devolvía tres números. Ahora devuelve también las altas
-- con la clave que la base les dio, porque el libro tiene que escribirla.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2a — La tabla
-- -----------------------------------------------------------------------------

create table if not exists stock_units (
  id            uuid primary key default gen_random_uuid(),
  -- El artículo del almacén al que pertenece, si se pudo casar: «Ordenador Tiny
  -- M710Q». Es lo que permite descontar la unidad de la bolsa al instalarla.
  stock_item_id uuid references stock_items(id) on delete set null,
  asset_type_id uuid references asset_types(id) on delete set null,
  -- Lo que la hoja dice en «Articulo / Material», tal cual.
  articulo      text not null,
  brand         text,
  model         text,
  serial        text not null,
  notes         text,
  status        text not null default 'disponible'
                check (status in ('disponible', 'instalado', 'baja')),
  -- Cuando está instalado: el equipo que es y el aula donde está.
  asset_id      uuid references assets(id) on delete set null,
  room_id       uuid references rooms(id) on delete set null,
  installed_at  timestamptz,
  retired_at    timestamptz,
  source        text not null default 'app',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- El número de serie va grabado en el aparato: dos filas con el mismo son la
-- misma unidad. Se compara sin espacios ni guiones, que es como se teclea mal.
create unique index if not exists stock_units_serial_idx
  on stock_units (upper(regexp_replace(serial, '[\s\-_./]', '', 'g')));
create index if not exists stock_units_status_idx on stock_units (status);

comment on table stock_units is
  'Ordenadores de repuesto del almacén, uno por número de serie. El almacén cuenta y esto nombra: cuál está disponible, cuál se instaló y dónde.';

alter table stock_units enable row level security;

drop policy if exists "personal lee las unidades" on stock_units;
create policy "personal lee las unidades" on stock_units
  for select to authenticated using (public.is_staff());

-- Se escribe solo por las funciones de abajo: instalar una unidad toca tres
-- tablas a la vez y hacerlo a medias desde una fila deja un ordenador en dos
-- sitios.

-- -----------------------------------------------------------------------------
-- 2b — Alta de una unidad
-- -----------------------------------------------------------------------------

/**
 * Da de alta un ordenador de repuesto. Idempotente por número de serie: si ya
 * existe, se le actualizan los datos que vengan y se devuelve su id.
 *
 *   p: {articulo, marca, modelo, serial, observaciones, source}
 *
 * El artículo del almacén se busca por nombre y alias, y también como
 * «<articulo> <modelo>» —la hoja dice «Ordenador Tiny» y «M710Q» en dos
 * columnas y la bolsa «Ordenador Tiny M710Q» en una—. Si el número de serie ya
 * es de un equipo instalado en un aula, la unidad nace ya `instalado` y
 * apuntando a él: es el mismo ordenador, y decir que está en el almacén sería
 * mentir.
 */
create or replace function public.stock_unit_alta(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_serial   text := btrim(coalesce(p->>'serial', ''));
  v_articulo text := btrim(coalesce(p->>'articulo', ''));
  v_modelo   text := nullif(btrim(coalesce(p->>'modelo', '')), '');
  v_marca    text := nullif(btrim(coalesce(p->>'marca', '')), '');
  v_notas    text := nullif(btrim(coalesce(p->>'observaciones', '')), '');
  v_item     uuid;
  v_tipo     uuid;
  v_id       uuid;
  v_asset    uuid;
  v_room     uuid;
  v_estado   asset_status;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor da de alta ordenadores de repuesto'
      using errcode = 'insufficient_privilege';
  end if;
  if v_serial = '' then
    raise exception 'Una unidad de almacén necesita número de serie';
  end if;
  if v_articulo = '' then v_articulo := 'Ordenador'; end if;

  -- El artículo del almacén: primero «artículo modelo», que es lo más concreto.
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

  select id into v_id from stock_units
   where upper(regexp_replace(serial, '[\s\-_./]', '', 'g'))
       = upper(regexp_replace(v_serial, '[\s\-_./]', '', 'g'));

  if v_id is not null then
    update stock_units
       set articulo      = v_articulo,
           brand         = coalesce(v_marca, brand),
           model         = coalesce(v_modelo, model),
           notes         = coalesce(v_notas, notes),
           stock_item_id = coalesce(stock_item_id, v_item),
           asset_type_id = coalesce(asset_type_id, v_tipo),
           updated_at    = now()
     where id = v_id;
    return v_id;
  end if;

  -- ¿Ya está puesto en un aula? Entonces no está en el almacén.
  select a.id, a.room_id, a.status into v_asset, v_room, v_estado
    from assets a where a.serial = v_serial limit 1;

  insert into stock_units (stock_item_id, asset_type_id, articulo, brand, model, serial, notes,
                           status, asset_id, room_id, installed_at, source)
  values (v_item, v_tipo, v_articulo, v_marca, v_modelo, v_serial, v_notas,
          case when v_asset is not null and v_estado = 'instalado' and v_room is not null
               then 'instalado' else 'disponible' end,
          case when v_asset is not null and v_estado = 'instalado' then v_asset else null end,
          case when v_asset is not null and v_estado = 'instalado' then v_room else null end,
          case when v_asset is not null and v_estado = 'instalado' then now() else null end,
          coalesce(nullif(p->>'source', ''), 'app'))
  returning id into v_id;

  return v_id;
end $$;

comment on function public.stock_unit_alta(jsonb) is
  'Da de alta un ordenador de repuesto por número de serie (idempotente). Casa el artículo del almacén por nombre o «artículo modelo», y si el número ya es de un equipo instalado nace instalado y apuntando a él.';

revoke all on function public.stock_unit_alta(jsonb) from public, anon;
grant execute on function public.stock_unit_alta(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 2c — Instalar una unidad en un aula
-- -----------------------------------------------------------------------------

/**
 * Lleva un ordenador del almacén a un aula. Devuelve el id del equipo creado.
 *
 * Es la operación que junta las tres tablas, y por eso es una función:
 *
 *   - se crea el equipo en el aula con su número de serie, marca y modelo;
 *   - el equipo que hubiera del mismo tipo en esa aula se retira, con un
 *     evento de sustitución que dice por cuál;
 *   - se descuenta una unidad del artículo del almacén, si la unidad tiene
 *     artículo y el almacén lo permite —si el saldo ya era cero no se tumba la
 *     instalación por eso: el ordenador está en el aula igual, y el descuadre
 *     se ve en el almacén, que es donde se arregla—;
 *   - y la unidad queda `instalado`, apuntando al equipo y al aula.
 *
 * Lo puede hacer el personal: son los técnicos los que ponen el ordenador.
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
      insert into stock_movements (id, stock_item_id, qty, kind, incident_id, room_id, occurred_at, by_user, source, note)
      values (gen_random_uuid(), v_u.stock_item_id, -1, 'consumo', p_incident, p_room, now(), v_yo, 'app',
              format('Ordenador de repuesto %s instalado', v_u.serial));
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
  'Lleva un ordenador de repuesto a un aula: crea el equipo con su número de serie, retira el que hubiera del mismo tipo, descuenta la unidad del almacén y deja la unidad como instalada.';

revoke all on function public.stock_unit_instalar(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.stock_unit_instalar(uuid, uuid, text, uuid) to authenticated;

/** Da de baja una unidad que no va a instalarse: estropeada, obsoleta, perdida. */
create or replace function public.stock_unit_baja(p_unit uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_estado text;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor da de baja ordenadores de repuesto'
      using errcode = 'insufficient_privilege';
  end if;
  select status into v_estado from stock_units where id = p_unit for update;
  if v_estado is null then raise exception 'Esa unidad no existe'; end if;
  if v_estado = 'instalado' then
    raise exception 'Esa unidad está instalada en un aula: retírala desde el aula';
  end if;
  update stock_units
     set status = 'baja', retired_at = now(), updated_at = now(),
         notes = case when p_note is null or btrim(p_note) = '' then notes
                      else concat_ws(' · ', notes, btrim(p_note)) end
   where id = p_unit;
end $$;

revoke all on function public.stock_unit_baja(uuid, text) from public, anon;
grant execute on function public.stock_unit_baja(uuid, text) to authenticated;

/**
 * Cuando el equipo de una unidad se retira desde el aula, la unidad lo sigue:
 * al almacén (`room_id` a null, que es lo que hace `decide_asset_removal` con
 * destino «almacén») vuelve a `disponible`; a la baja, `baja`.
 */
create or replace function public.stock_unit_sigue_al_equipo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'retirado' and old.status is distinct from 'retirado' then
    update stock_units
       set status = case when new.room_id is null then 'disponible' else 'baja' end,
           room_id = null,
           retired_at = case when new.room_id is null then null else now() end,
           updated_at = now()
     where asset_id = new.id and status = 'instalado';
  end if;
  return new;
end $$;

drop trigger if exists stock_unit_sigue_al_equipo on assets;
create trigger stock_unit_sigue_al_equipo
  after update of status on assets
  for each row execute function public.stock_unit_sigue_al_equipo();

revoke all on function public.stock_unit_sigue_al_equipo() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2d — Una celda de la hoja de PCs, de vuelta
-- -----------------------------------------------------------------------------

create or replace function public.sync_celda_de_unidad(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campo text := p->>'campo';
  v_clave text := p->>'clave';
  v_valor text := nullif(btrim(coalesce(p->>'valor', '')), '');
  v_id    uuid;
begin
  begin
    v_id := v_clave::uuid;
  exception when others then
    return format('«%s» no es una unidad del almacén', v_clave);
  end;
  if not exists (select 1 from stock_units where id = v_id) then
    return format('la unidad «%s» no está en la aplicación', v_clave);
  end if;

  case v_campo
    when 'unidad.articulo' then
      if v_valor is null then return null; end if;
      update stock_units set articulo = v_valor, updated_at = now() where id = v_id;
    when 'unidad.marca' then
      update stock_units set brand = v_valor, updated_at = now() where id = v_id;
    when 'unidad.modelo' then
      update stock_units set model = v_valor, updated_at = now() where id = v_id;
    when 'unidad.observaciones' then
      update stock_units set notes = v_valor, updated_at = now() where id = v_id;
    when 'unidad.serial' then
      -- El número de serie es la identidad: cambiarlo en la hoja es otra unidad.
      return 'el número de serie es la identidad de la unidad: para cambiarlo, da de baja esta y de alta la nueva';
    else
      return format('«%s» no se aplica a una unidad desde el Excel', v_campo);
  end case;
  return null;
end $$;

revoke all on function public.sync_celda_de_unidad(jsonb) from public, anon, authenticated;

create or replace function public.sync_aplicar_celda(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entidad text := coalesce(p->>'entidad', 'sala');
begin
  if v_entidad = 'articulo'   then return public.sync_celda_de_articulo(p);   end if;
  if v_entidad = 'incidencia' then return public.sync_celda_de_incidencia(p); end if;
  if v_entidad = 'unidad'     then return public.sync_celda_de_unidad(p);     end if;
  return public.sync_celda_de_sala(p);
end $$;

revoke all on function public.sync_aplicar_celda(jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 1 — Las altas: un parte, un artículo o una unidad que el libro tiene y la
--     aplicación no
-- -----------------------------------------------------------------------------

/**
 * Da de alta lo que la fila describe y devuelve la clave con la que la fila
 * se reconocerá a partir de ahora:
 *
 *   {"clave": "I260908_0003", "numero": "I260908_0003"}   un parte
 *   {"clave": "<uuid del artículo>"}                       un artículo
 *   {"clave": "<uuid de la unidad>"}                       una unidad
 *
 * Y deja en `sync_celdas` las celdas de la fila bajo esa clave: sin eso, la
 * pasada siguiente encontraría la fila con clave y sin antepasado y decidiría
 * «primera pasada: manda la app» sobre cada celda, deshaciendo lo que la fila
 * decía y acababa de entrar.
 *
 *   p: {hoja, fila, tipo, ..., celdas: {"A": "0.1 BC", "B": "2026-09-08", ...}}
 */
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
  'Da de alta un parte, un artículo o un ordenador de repuesto que el libro tiene y la aplicación no, deja el antepasado de la fila bajo su clave nueva y devuelve esa clave. El número del parte lo pone la base y se devuelve para escribirlo en la fila.';

revoke all on function public.sync_alta(jsonb) from public, anon, authenticated;

-- Y la bandeja de «Incidencias sin sala» ve también los partes que entraron
-- por la sincronización, no solo los del importador de la primera carga.
create or replace function public.incidencias_sin_sala()
returns table (
  incidencia uuid,
  ref text,
  titulo text,
  descripcion text,
  estado text,
  abierta_el timestamptz,
  aula_original text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor rescata incidencias sin sala'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select i.id,
         i.external_ref,
         coalesce(i.title, '(sin describir)'),
         i.description,
         i.state::text,
         i.opened_at,
         q.aula
    from incidents i
    left join lateral (
      select iq.raw->>'aula' as aula
        from import_quarantine iq
       where iq.reason = 'No se pudo identificar la sala'
         and (
           (nullif(i.external_ref, '') is not null and iq.raw->>'ref' = i.external_ref)
           or (nullif(i.external_ref, '') is null
               and iq.raw->>'problema' is not null
               and iq.raw->>'problema' in (i.title, i.description))
         )
       limit 1
    ) q on true
   where i.room_id is null
     and i.source in ('import', 'sharepoint')
   order by i.opened_at desc;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3 — `sync_aplicar`, con las altas y devolviéndolas
-- -----------------------------------------------------------------------------

create or replace function public.sync_aplicar(p_plan jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parte_id   bigint;
  v_fichero_id bigint := nullif(p_plan->>'fichero_id', '')::bigint;
  v_origen     text   := coalesce(p_plan->>'origen', 'material_aulas');
  v_aplicadas  int := 0;
  v_rechazadas int := 0;
  r            jsonb;
  v_motivo     text;
  v_rechazos   text[] := array[]::text[];
  v_huella     text;
  v_alta       jsonb;
  v_altas      jsonb := '[]'::jsonb;
begin
  if auth_role() <> 'admin' then
    raise exception 'Solo un administrador puede aplicar una sincronización';
  end if;

  insert into sync_partes (origen, fichero_id, disparo, filas_leidas, sin_cambios,
                           hacia_la_base, hacia_el_excel, conflictos, descuadres, altas)
  values (
    v_origen, v_fichero_id, coalesce(p_plan->>'disparo', 'manual'),
    coalesce((p_plan#>>'{resumen,filas_leidas}')::int, 0),
    coalesce((p_plan#>>'{resumen,sin_cambios}')::int, 0),
    0,
    coalesce((p_plan#>>'{resumen,hacia_el_excel}')::int, 0),
    coalesce((p_plan#>>'{resumen,conflictos}')::int, 0),
    coalesce((p_plan#>>'{resumen,descuadres}')::int, 0),
    coalesce((p_plan#>>'{resumen,altas}')::int, 0)
  )
  returning id into v_parte_id;

  if v_fichero_id is not null then
    for r in select * from jsonb_array_elements(coalesce(p_plan->'filas', '[]'::jsonb)) loop
      insert into sync_filas (fichero_id, hoja, fila, ref, contenido, sha256)
      values (
        v_fichero_id, r->>'hoja', (r->>'fila')::int, nullif(r->>'ref', ''),
        coalesce(r->'contenido', '{}'::jsonb),
        md5(coalesce(r->'contenido', '{}'::jsonb)::text)
      )
      on conflict (fichero_id, hoja, fila) do update
        set contenido = excluded.contenido, sha256 = excluded.sha256, ref = excluded.ref;
    end loop;
  end if;

  -- Las altas van antes que las celdas: un artículo nuevo tiene que existir
  -- antes de que el material de un parte lo descuente.
  for r in select * from jsonb_array_elements(coalesce(p_plan->'altas', '[]'::jsonb)) loop
    begin
      v_alta := public.sync_alta(r);
      v_aplicadas := v_aplicadas + 1;
      v_altas := v_altas || jsonb_build_object(
        'hoja', r->>'hoja', 'fila', (r->>'fila')::int, 'tipo', r->>'tipo',
        'clave', v_alta->>'clave', 'numero', v_alta->>'numero');
    exception when others then
      v_rechazadas := v_rechazadas + 1;
      begin
        perform public.cuarentena_apuntar(
          'SharePoint',
          format('%s fila %s', coalesce(r->>'hoja', '?'), coalesce(r->>'fila', '?')),
          r,
          format('el alta no entró: %s', sqlerrm)
        );
      exception when others then
        raise warning 'No se pudo apuntar en cuarentena el alta de % %: %', r->>'hoja', r->>'fila', sqlerrm;
      end;
    end;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_plan->'hacia_la_base', '[]'::jsonb)) loop
    begin
      v_motivo := public.sync_aplicar_celda(r);
    exception when others then
      v_motivo := format('la base lo rechazó: %s', sqlerrm);
    end;

    if v_motivo is null then
      v_aplicadas := v_aplicadas + 1;
      begin
        insert into import_fixes (source, row_ref, field, original, corrected, reason)
        values ('SharePoint', r->>'clave', r->>'campo', null, r->>'valor',
                coalesce(r->>'motivo', 'sincronización'));
      exception when others then
        raise warning 'No se pudo apuntar la corrección de % %: %', r->>'clave', r->>'campo', sqlerrm;
      end;
    else
      v_rechazadas := v_rechazadas + 1;

      if coalesce(r->>'columna', '') <> '' then
        v_rechazos := v_rechazos || format('%s|%s|%s', r->>'hoja', r->>'clave', r->>'columna');
      end if;

      begin
        perform public.cuarentena_apuntar(
          'SharePoint',
          format('%s %s', coalesce(r->>'clave', '?'), coalesce(r->>'campo', '')),
          r,
          v_motivo
        );
      exception when others then
        raise warning 'No se pudo apuntar en cuarentena % %: %', r->>'clave', r->>'campo', sqlerrm;
      end;
    end if;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_plan->'cuarentena', '[]'::jsonb)) loop
    begin
      perform public.cuarentena_apuntar(
        'SharePoint',
        format('%s %s', coalesce(r->>'clave', '?'), coalesce(r->>'campo', '')),
        r,
        coalesce(r->>'motivo', 'no se puede leer')
      );
    exception when others then
      raise warning 'No se pudo apuntar en cuarentena % %: %', r->>'clave', r->>'campo', sqlerrm;
    end;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_plan->'instantanea', '[]'::jsonb)) loop
    v_huella := format('%s|%s|%s', r->>'hoja', r->>'clave', r->>'columna');
    if v_huella = any (v_rechazos) then
      continue;
    end if;

    insert into sync_celdas (hoja, ref, columna, valor_base, entidad, entidad_id)
    values (r->>'hoja', r->>'clave', r->>'columna', r->>'valor',
            nullif(r->>'entidad', ''), nullif(r->>'entidad_id', '')::uuid)
    on conflict (hoja, ref, columna) do update
      set valor_base = excluded.valor_base, at = now();
  end loop;

  update sync_partes
     set termino_at = now(),
         hacia_la_base = v_aplicadas
   where id = v_parte_id;

  return jsonb_build_object(
    'parte_id', v_parte_id,
    'aplicadas', v_aplicadas,
    'rechazadas', v_rechazadas,
    'altas', v_altas
  );
end $$;

comment on function public.sync_aplicar(jsonb) is
  'Aplica una pasada entera en una transacción: primero las altas —partes, artículos y unidades que el libro tiene y la aplicación no—, luego las celdas. Devuelve las altas con la clave que la base les puso, para que el libro la escriba. Solo administradores.';

revoke all on function public.sync_aplicar(jsonb) from public, anon;
grant execute on function public.sync_aplicar(jsonb) to authenticated;

-- PostgREST cachea el esquema: sin esto, la tabla nueva no existe para la
-- aplicación hasta que alguien reinicie el servicio.
notify pgrst, 'reload schema';
