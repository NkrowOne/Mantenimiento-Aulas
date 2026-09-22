-- reejecutable: si
-- =============================================================================
-- Un parte que no es de ninguna sala a propósito no va a la cuarentena
--
-- `sync_alta` apunta en la cuarentena, con el motivo «No se pudo identificar la
-- sala», todo parte que entra sin sala. Tenía sentido cuando entrar sin sala
-- era siempre un fallo: alguien escribió un aula que el maestro no reconoce y
-- hay que colocarla.
--
-- Pero desde que la hoja de partes admite un aula que dice «ninguna» —«Varias
-- aulas», «Almacén», «Sin aula»— y desde que la pantalla de dudas tiene el
-- botón «No es de ninguna sala», hay partes que entran sin sala **porque no la
-- tienen**: las regularizaciones de almacén son el caso de todos los meses. Esos
-- no se pueden resolver desde «Incidencias sin sala», porque su único gesto es
-- elegir una sala del maestro y aquí no hay ninguna que elegir. Se quedan en la
-- bandeja para siempre y el montón crece en cada sincronización.
--
-- Así que el cliente dice cuál de los dos casos es —lo sabe: o el aula decía
-- «ninguna», o alguien lo contestó— y aquí solo se apunta lo que de verdad hay
-- que colocar. El motivo se conserva palabra por palabra: es el que la pantalla
-- «Incidencias sin sala» reconoce, y cambiarlo dejaría fuera a las 34 que ya
-- están esperando.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — La marca, en el propio parte
--
-- Sin ella, quitar la fila de la cuarentena solo movía el problema de sitio:
-- «Incidencias sin sala» lista todo parte con `room_id is null`, así que las
-- regularizaciones de almacén seguirían ahí pidiendo una sala que no tienen, y
-- esa bandeja tampoco sabría cerrarlas.
-- -----------------------------------------------------------------------------

alter table incidents add column if not exists sin_sala boolean not null default false;

comment on column incidents.sin_sala is
  'El parte no es de ninguna sala y se sabe: una regularización de almacén, un aula que dice «Varias aulas». No es lo mismo que no haber podido identificarla, y por eso no sale en «Incidencias sin sala» ni en la cuarentena.';

-- Y la bandeja deja de pedirlas.
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
     and not i.sin_sala
     and i.source in ('import', 'sharepoint')
   order by i.opened_at desc;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2 — Y el alta la escribe
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
  -- «No es de ninguna sala», dicho a propósito: no hay nada que resolver.
  v_sin_sala boolean := coalesce((p->>'sin_sala')::boolean, false);
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

    -- Que no es de ninguna sala y se sabe: ni cuarentena ni bandeja.
    if v_sin_sala then
      update incidents set sin_sala = true where id = v_id;
    end if;

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

    -- Sin sala y sin saber cuál, el texto del aula se guarda donde «Incidencias
    -- sin sala» lo busca: en la cuarentena, con el motivo que esa pantalla
    -- reconoce. Así un parte que entró sin aula se puede colocar después.
    --
    -- Sin sala A PROPÓSITO, no: no hay nada que colocar, y esa bandeja solo
    -- sabe ofrecer salas del maestro. Apuntarlo era dejar una fila que nadie
    -- puede cerrar, una por regularización y en cada pasada.
    if v_room is null and not v_sin_sala then
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
  'Da de alta un parte, un artículo o un ordenador de repuesto que el libro tiene y la aplicación no, deja el antepasado de la fila bajo su clave nueva y devuelve esa clave. El número del parte lo pone la base. Un parte anterior al arranque del recuento entra sin mover el almacén. Un parte que no es de ninguna sala a propósito («Varias aulas», «Almacén») entra sin sala y NO va a la cuarentena: no hay nada que resolver.';

revoke all on function public.sync_alta(jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';
