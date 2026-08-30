-- =============================================================================
-- La vuelta: que lo corregido en el Excel entre en la base, en una transacción
--
-- La migración de agosto puso las cuatro tablas de la sincronización y la
-- instantánea, y `fusion.ts` puso el motor que decide celda a celda quién manda.
-- Faltaba lo que las une, y no era poco: **nadie las usaba**. Un `grep` sobre
-- `src/` no encontraba una sola línea que escribiera en `sync_celdas`, así que
-- la parte de la sincronización que va del Excel hacia la base existía en el
-- diseño y en las pruebas, y no en la aplicación.
--
-- Va como función de base de datos y no como una tanda de llamadas desde el
-- navegador por una razón que no es de estilo: **una pasada es atómica o no
-- sirve**. Aplicar 300 celdas por PostgREST son 300 peticiones sin transacción
-- que las envuelva; si la número 180 falla —un número de serie que choca con el
-- índice único, la red— la base se queda a medias y, peor, la instantánea se
-- queda a medias con ella. A partir de ahí la fusión compara contra un
-- antepasado que no corresponde a ningún estado que haya existido nunca, y
-- empieza a dar por cambiado lo que nadie tocó.
--
-- Cinco decisiones que van dentro y conviene leer antes de discutirlas:
--
-- **Todo lo que entra se marca `source = 'sharepoint'` y `by_user = NULL`.** El
-- Excel no dice quién hizo cada cosa. Atribuírselo a quien pulsó el botón
-- falsearía la trazabilidad que sostiene el resto de la aplicación: el informe
-- diría que Ana revisó 40 aulas el martes porque Ana fue quien subió el fichero.
--
-- **Un cambio de edificio o de planta mueve la sala; no renombra el edificio.**
-- Es la diferencia entre «esta aula está ahora en el CRAI» y «el edificio H se
-- llama ahora CRAI», y una celda no puede distinguirlas: el nombre del edificio
-- vive en 39 filas y que cambie en una sola significa que alguien editó esa
-- fila. Si el edificio de destino no existe, va a cuarentena — crear un edificio
-- a partir de una errata tecleada en una celda es exactamente el fallo que la
-- hoja lleva ya cinco veces (`EDIFICO E`).
--
-- **Un número de serie que ya está en otra aula no se escribe.** Hay índice
-- único sobre `assets.serial` y el libro trae 14 repetidos. Sin esta guarda la
-- pasada entera revienta por una fila; con ella, esa fila va a cuarentena y las
-- otras 275 entran.
--
-- **Una fecha de revisión escrita en el Excel crea una revisión sin autor**, y
-- solo si no hay ya una de ese día o posterior. Es lo que hizo el importador con
-- el histórico, y lo que impide que teclear una fecha vieja en la hoja borre una
-- revisión hecha con el móvil.
--
-- **La instantánea se guarda al final y solo de lo que se aplicó.** Una celda en
-- conflicto no deja antepasado: si lo dejara, la pasada siguiente creería que el
-- conflicto se resolvió solo y ganaría el lado que no volviera a escribir.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — El fichero, aterrizado antes de interpretar nada
--
-- Idempotente por `(origen, sha256)`: subir dos veces el mismo libro devuelve el
-- mismo id y no duplica nada. Es lo que permite repetir una pasada que falló sin
-- pensárselo dos veces.
-- -----------------------------------------------------------------------------

create or replace function public.sync_registrar_fichero(
  p_origen text,
  p_nombre text,
  p_sha256 text,
  p_bytes  bigint,
  p_ctag   text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  insert into sync_ficheros (origen, nombre, sha256, bytes, ctag, subido_por)
  values (p_origen, p_nombre, p_sha256, p_bytes, p_ctag, auth.uid())
  on conflict (origen, sha256) do update set nombre = excluded.nombre
  returning id into v_id;

  return v_id;
end $$;

comment on function public.sync_registrar_fichero(text, text, text, bigint, text) is
  'Aterriza el .xlsx con su hash antes de interpretarlo. Repetir el mismo fichero devuelve el mismo id: una pasada fallida se puede repetir sin consecuencias.';

-- -----------------------------------------------------------------------------
-- 2 — Aplicar la pasada
--
-- Recibe el plan entero como un `jsonb` y lo aplica en una transacción. El plan
-- lo arma `src/domain/sincronizar.ts`; aquí no se decide nada, solo se escribe.
--
--   {
--     "fichero_id": 12,
--     "origen": "material_aulas",
--     "disparo": "manual",
--     "filas": [ {"hoja":"…","fila":2,"ref":"SALA-000087","contenido":{…}} ],
--     "hacia_la_base": [
--       {"hoja":"…","fila":2,"clave":"SALA-000087","campo":"rooms.lamp_pct",
--        "valor":0.86,"motivo":"solo cambió en el Excel"}
--     ],
--     "instantanea": [ {"hoja":"…","clave":"SALA-000087","columna":"G","valor":"0.86"} ],
--     "cuarentena": [ {"hoja":"…","fila":2,"clave":"…","campo":"…","crudo":"…","motivo":"…"} ],
--     "resumen": {"filas_leidas":295,"sin_cambios":6100,"hacia_el_excel":420,
--                 "conflictos":3,"descuadres":1,"altas":2}
--   }
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
begin
  if auth_role() not in ('admin', 'supervisor') then
    raise exception 'Solo un administrador o un supervisor puede aplicar una sincronización';
  end if;

  insert into sync_partes (origen, fichero_id, disparo, filas_leidas, sin_cambios,
                           hacia_la_base, hacia_el_excel, conflictos, descuadres, altas)
  values (
    v_origen, v_fichero_id, coalesce(p_plan->>'disparo', 'manual'),
    coalesce((p_plan#>>'{resumen,filas_leidas}')::int, 0),
    coalesce((p_plan#>>'{resumen,sin_cambios}')::int, 0),
    0,  -- se rellena al final con lo que de verdad entró, no con lo propuesto
    coalesce((p_plan#>>'{resumen,hacia_el_excel}')::int, 0),
    coalesce((p_plan#>>'{resumen,conflictos}')::int, 0),
    coalesce((p_plan#>>'{resumen,descuadres}')::int, 0),
    coalesce((p_plan#>>'{resumen,altas}')::int, 0)
  )
  returning id into v_parte_id;

  -- 2.1 — Las filas tal cual venían. Es lo que permite contestar «¿de dónde
  -- salió este dato?» seis meses después.
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

  -- 2.2 — Las celdas que ganó el Excel.
  for r in select * from jsonb_array_elements(coalesce(p_plan->'hacia_la_base', '[]'::jsonb)) loop
    v_motivo := public.sync_aplicar_celda(r);
    if v_motivo is null then
      v_aplicadas := v_aplicadas + 1;
      insert into import_fixes (source, row_ref, field, original, corrected, reason)
      values ('SharePoint', r->>'clave', r->>'campo', null, r->>'valor',
              coalesce(r->>'motivo', 'sincronización'));
    else
      v_rechazadas := v_rechazadas + 1;
      insert into import_quarantine (source, row_ref, raw, reason)
      values ('SharePoint', r->>'clave', r, v_motivo);
    end if;
  end loop;

  -- 2.3 — Lo que ya venía sucio del libro.
  for r in select * from jsonb_array_elements(coalesce(p_plan->'cuarentena', '[]'::jsonb)) loop
    insert into import_quarantine (source, row_ref, raw, reason)
    values ('SharePoint', r->>'clave', r, coalesce(r->>'motivo', 'no se puede leer'));
  end loop;

  -- 2.4 — La instantánea, al final y solo de lo que se aplicó. Va por matrícula
  -- y no por número de fila: entre dos pasadas alguien ordena la hoja y la 87
  -- pasa a ser la 214.
  for r in select * from jsonb_array_elements(coalesce(p_plan->'instantanea', '[]'::jsonb)) loop
    insert into sync_celdas (hoja, ref, columna, valor_base, entidad, entidad_id)
    values (r->>'hoja', r->>'clave', r->>'columna', r->>'valor',
            nullif(r->>'entidad', ''), nullif(r->>'entidad_id', '')::uuid)
    on conflict (hoja, ref, columna) do update
      set valor_base = excluded.valor_base, at = now();
  end loop;

  -- El parte cuenta lo que **entró**, no lo que se propuso. La diferencia entre
  -- las dos cifras es justo lo que hay que mirar, así que confundirlas sería
  -- esconder el único número que importa cuando algo va mal.
  update sync_partes
     set termino_at = now(),
         hacia_la_base = v_aplicadas
   where id = v_parte_id;

  return jsonb_build_object(
    'parte_id', v_parte_id,
    'aplicadas', v_aplicadas,
    'rechazadas', v_rechazadas
  );
end $$;

comment on function public.sync_aplicar(jsonb) is
  'Aplica una pasada entera en una transacción. Todo entra con source = sharepoint y by_user = NULL: el Excel no dice quién hizo cada cosa.';

-- -----------------------------------------------------------------------------
-- 3 — Una celda
--
-- Devuelve `null` si se aplicó y el motivo si no. No lanza excepción a
-- propósito: una fila mala no puede tumbar la pasada de las otras 275.
-- -----------------------------------------------------------------------------

create or replace function public.sync_aplicar_celda(p jsonb)
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
  v_asset   uuid;
  v_zone    uuid;
  v_item    uuid;
  v_ya      numeric;
begin
  -- --- El almacén, que se identifica por el id del artículo -------------------
  if v_campo like 'articulo.%' then
    begin
      v_item := v_clave::uuid;
    exception when others then
      return format('«%s» no es un artículo del almacén', v_clave);
    end;
    if not exists (select 1 from stock_items where id = v_item) then
      return format('el artículo %s ya no está en el catálogo', v_clave);
    end if;

    if v_campo = 'articulo.nombreAlternativo' then
      -- Una grafía más del mismo artículo. Nunca un renombrado: el nombre bueno
      -- lo decide una persona en el catálogo, no una celda de la hoja.
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
      -- La diferencia entre lo que dice la hoja y lo que suman las compras es
      -- una compra que nadie apuntó. Entra como movimiento con su fecha, que es
      -- la única forma de que el saldo siga siendo `sum(qty)`.
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

    return format('«%s» no se aplica en el almacén', v_campo);
  end if;

  -- --- Todo lo demás cuelga de una sala, por su matrícula ---------------------
  select id into v_room from rooms where short_ref = v_clave;
  if v_room is null then
    return format('la matrícula «%s» no existe', v_clave);
  end if;

  -- Campos directos de la sala.
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

  -- Capacidades: una clave del jsonb.
  if v_campo like 'capacidad:%' then
    v_sub := split_part(v_campo, ':', 2);
    update rooms
       set capabilities = capabilities || jsonb_build_object(v_sub, coalesce(v_valor, 'false')::boolean)
     where id = v_room;
    return null;
  end if;

  -- Mover de edificio o de planta. Nunca renombrar: ver la cabecera.
  if v_campo in ('edificio', 'zona') then
    return public.sync_mover_sala(v_room, v_campo, v_valor);
  end if;

  -- Equipos: `equipo:Proyector:serial`.
  if v_campo like 'equipo:%' then
    v_tipo := split_part(v_campo, ':', 2);
    v_sub  := split_part(v_campo, ':', 3);
    v_type_id := public.asset_type_id(v_tipo);
    if v_type_id is null then
      return format('«%s» no está en el catálogo de equipos', v_tipo);
    end if;
    return public.sync_aplicar_equipo(v_room, v_type_id, v_sub, v_valor);
  end if;

  -- El micrófono, que en la hoja es una columna y aquí son dos cosas.
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

  -- La fecha de revisión: crea una revisión sin autor si hace falta.
  if v_campo = 'revision.ultima' then
    return public.sync_revision_desde_el_excel(v_room, nullif(v_valor, '')::date, null);
  end if;
  if v_campo = 'revision.notas' then
    return public.sync_revision_desde_el_excel(v_room, null, v_valor);
  end if;

  return format('«%s» no se aplica desde el Excel', v_campo);
end $$;

comment on function public.sync_aplicar_celda(jsonb) is
  'Aplica una celda. Devuelve null si entró y el motivo si no: una fila mala no puede tumbar la pasada de las otras 275.';

-- -----------------------------------------------------------------------------
-- 4 — Mover una sala de edificio o de planta
-- -----------------------------------------------------------------------------

create or replace function public.sync_mover_sala(p_room uuid, p_campo text, p_valor text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_zone    uuid;
  v_edif    uuid;
  v_actual  uuid;
begin
  if p_valor is null or btrim(p_valor) = '' then return null; end if;

  select z.building_id into v_actual from rooms r join zones z on z.id = r.zone_id where r.id = p_room;

  if p_campo = 'edificio' then
    select b.id into v_edif from buildings b
     where b.active and (public.norm_text(b.name) = public.norm_text(p_valor)
                      or public.norm_text(b.code) = public.norm_text(p_valor));
    if v_edif is null then
      -- Crear un edificio a partir de una celda es exactamente el fallo que la
      -- hoja lleva cinco veces escrito (`EDIFICO E`).
      return format('«%s» no es ningún edificio del maestro: si es un edificio nuevo, hay que crearlo desde la aplicación', p_valor);
    end if;
    if v_edif = v_actual then return null; end if;

    -- Se mueve a la zona del mismo nombre dentro del edificio de destino; si no
    -- la hay, a la primera. Inventarse una planta con el nombre de la de origen
    -- crearía plantas fantasma en cada pasada.
    select z.id into v_zone from zones z
     where z.building_id = v_edif
       and public.norm_text(z.name) = public.norm_text(
             (select z2.name from rooms r join zones z2 on z2.id = r.zone_id where r.id = p_room))
     limit 1;
    if v_zone is null then
      select z.id into v_zone from zones z where z.building_id = v_edif
       order by z.sort_order, z.name limit 1;
    end if;
    if v_zone is null then
      return format('el edificio «%s» no tiene ninguna planta donde poner la sala', p_valor);
    end if;

    update rooms set zone_id = v_zone where id = p_room;
    return null;
  end if;

  -- La planta, dentro del edificio que ya tiene.
  select z.id into v_zone from zones z
   where z.building_id = v_actual and public.norm_text(z.name) = public.norm_text(p_valor)
   limit 1;
  if v_zone is null then
    return format('«%s» no es ninguna planta de este edificio', p_valor);
  end if;
  update rooms set zone_id = v_zone where id = p_room;
  return null;
end $$;

-- -----------------------------------------------------------------------------
-- 5 — Un equipo
--
-- El índice único sobre `assets.serial` es lo que obliga a comprobar antes de
-- escribir: el libro trae 14 series repetidas y sin la guarda la primera tumba
-- la pasada entera.
-- -----------------------------------------------------------------------------

create or replace function public.sync_aplicar_equipo(
  p_room uuid, p_type uuid, p_campo text, p_valor text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_asset uuid;
  v_otro  uuid;
begin
  if p_valor is null or btrim(p_valor) = '' then return null; end if;

  if p_campo = 'serial' then
    select id into v_otro from assets where serial = p_valor and room_id is distinct from p_room;
    if v_otro is not null then
      return format('el número de serie «%s» ya está en otra aula', p_valor);
    end if;
  end if;

  -- El equipo vivo de ese tipo en esa sala. Si hay varios, el más reciente, que
  -- es el que la hoja está enseñando.
  select id into v_asset from assets
   where room_id = p_room and asset_type_id = p_type and status = 'instalado'
   order by created_at desc limit 1;

  if v_asset is null then
    insert into assets (asset_type_id, room_id, serial, model, status)
    values (p_type, p_room,
            case when p_campo = 'serial' then p_valor else null end,
            case when p_campo = 'model'  then p_valor else null end,
            'instalado')
    returning id into v_asset;

    insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
    values (gen_random_uuid(), v_asset, p_room, 'alta', now(), null,
            jsonb_build_object('source', 'sharepoint'));
    return null;
  end if;

  if p_campo = 'serial' then
    update assets set serial = p_valor where id = v_asset;
  else
    update assets set model = p_valor where id = v_asset;
  end if;
  return null;
end $$;

-- -----------------------------------------------------------------------------
-- 6 — Una revisión escrita en el Excel
--
-- Crea una revisión sin autor con la fecha de la celda, y **solo si no hay ya
-- una de ese día o posterior**. Sin esa condición, teclear una fecha vieja en la
-- hoja añadiría una revisión por detrás de la que se hizo con el móvil y
-- desordenaría el historial que alimenta la columna «Fecha Revisión Anterior».
-- -----------------------------------------------------------------------------

create or replace function public.sync_revision_desde_el_excel(
  p_room uuid, p_fecha date, p_notas text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_fecha is not null then
    if exists (
      select 1 from inspections
       where room_id = p_room and status = 'completa' and occurred_at::date >= p_fecha
    ) then
      return null; -- Ya hay una igual o más nueva: la del Excel no aporta nada.
    end if;

    insert into inspections (id, room_id, by_user, occurred_at, status, overall, notes, source)
    values (gen_random_uuid(), p_room, null, p_fecha::timestamptz, 'completa', 'ok', p_notas, 'sharepoint');
    return null;
  end if;

  -- Solo notas: van a la última revisión que trajo el propio Excel. Escribirlas
  -- encima de una revisión hecha en la aplicación sería poner en boca de un
  -- técnico algo que no dijo.
  select id into v_id from inspections
   where room_id = p_room and source = 'sharepoint'
   order by occurred_at desc limit 1;

  if v_id is null then
    insert into inspections (id, room_id, by_user, occurred_at, status, overall, notes, source)
    values (gen_random_uuid(), p_room, null, now(), 'completa', 'ok', p_notas, 'sharepoint');
    return null;
  end if;

  update inspections set notes = p_notas where id = v_id;
  return null;
end $$;

-- -----------------------------------------------------------------------------
-- 7 — Leer la instantánea de vuelta
--
-- La pasada siguiente necesita el antepasado de cada celda, y necesita poder
-- pedirlo de golpe: 295 filas por 24 columnas son 7.000 celdas, y preguntarlas
-- de una en una por PostgREST no es una opción.
-- -----------------------------------------------------------------------------

create or replace function public.sync_instantanea(p_hoja text)
returns table (ref text, columna text, valor_base text)
language sql
stable
security definer
set search_path = public
as $$
  select ref, columna, valor_base from sync_celdas where hoja = p_hoja
$$;

comment on function public.sync_instantanea(text) is
  'El antepasado de cada celda de una hoja, de golpe. La fusión a tres bandas no puede pedirlas de una en una.';

-- -----------------------------------------------------------------------------
-- 8 — Permisos
--
-- Leer el parte lo puede hacer cualquiera con sesión —es lo que sale en la
-- pantalla de administración—; aplicar, solo quien manda. La comprobación de
-- rol va **dentro** de `sync_aplicar` además de aquí: una función
-- `security definer` que no comprueba el rol es una puerta abierta.
-- -----------------------------------------------------------------------------

revoke all on function public.sync_aplicar(jsonb) from public;
revoke all on function public.sync_aplicar_celda(jsonb) from public;
revoke all on function public.sync_aplicar_equipo(uuid, uuid, text, text) from public;
revoke all on function public.sync_mover_sala(uuid, text, text) from public;
revoke all on function public.sync_revision_desde_el_excel(uuid, date, text) from public;
revoke all on function public.sync_registrar_fichero(text, text, text, bigint, text) from public;

grant execute on function public.sync_aplicar(jsonb) to authenticated;
grant execute on function public.sync_registrar_fichero(text, text, text, bigint, text) to authenticated;
grant execute on function public.sync_instantanea(text) to authenticated;
