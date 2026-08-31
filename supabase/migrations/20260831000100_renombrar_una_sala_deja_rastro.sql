-- Renombrar una sala tiene que dejar rastro, y la fusión no puede borrarlo
--
-- El caso que lo destapó: las nueve aulas de sótano del CRAI. El libro las
-- escribe `1.1-` … `1.9-` —el menos detrás, una errata del original—, el
-- importador las creó así y les dejó el alias `1.1- CRAI`. Después alguien las
-- renombró en la aplicación a `-1.1` … `-1.9` y fusionó el CRAI con el T. Moro.
-- Desde entonces las nueve filas del libro no cruzaban con nada.
--
-- El alias seguía en la base y seguía apuntando a la sala correcta. Lo que ya no
-- servía era su forma: `room_aliases` guarda «<código viejo de sala> <CÓDIGO DEL
-- EDIFICIO>», con el código que el edificio tenía **aquel día**, y el cruce lo
-- recompone con el de hoy. Mientras el edificio no se mueva, las dos mitades
-- coinciden. En cuanto se fusiona, cada alias de cada sala absorbida queda
-- inalcanzable —no roto: inalcanzable, que no se ve—, y no hay en todo el
-- esquema un solo `update room_aliases` que los recualifique.
--
-- Esta migración tapa las tres fugas por las que se pierde un renombrado:
--
--  1. la fusión no recualificaba los alias de las salas que se llevaba;
--  2. `sync_celda_de_sala` —la vuelta del libro— renombra salas con un `update
--     rooms set code` a secas y no dejaba alias ninguno;
--  3. la fusión podía no dejar ni rastro en la auditoría, y sin ese rastro el
--     cruce ni siquiera sabe que el CRAI es hoy el T. Moro.
--
-- Y abre el canal que no depende de ningún texto: una vista sobre `audit_log`
-- con los renombrados ya filtrados, para que el cruce pueda preguntar «¿cómo se
-- llamaba antes esta sala?» sin bajarse la auditoría entera a un iPad.

-- -----------------------------------------------------------------------------
-- 1 — La lápida de la fusión
-- -----------------------------------------------------------------------------

/*
 * `merge_building` borra el edificio de origen, y hasta ahora la fusión solo se
 * podía DEDUCIR: `equivalenciasDesdeAuditoria` la infiere del salto de
 * `zones.building_id` que deja el bucle. Pero ese salto solo ocurre en una de
 * las dos ramas. Si todas las plantas del origen chocan de nombre con las del
 * destino —y los nombres son genéricos: `PLANTA BAJA`, `1ª PLANTA` y `2ª PLANTA`
 * están en cinco edificios— la otra rama mueve las aulas y borra la planta sin
 * que ningún `building_id` cambie, y la fusión se vuelve invisible.
 *
 * Entonces no se genera la equivalencia, y no fallan solo las filas de las salas
 * renombradas: fallan TODAS las del edificio, con «no está en el maestro ni
 * consta que lo haya estado», que es exactamente lo contrario de lo que pasó.
 *
 * Se escribe a dónde fue, en vez de dejar que se adivine. La fila se borra en la
 * misma transacción, así que esto no lo lee ninguna consulta viva: existe para
 * que el `old_data` del `DELETE` que guarda la auditoría lleve el destino
 * dentro. El patrón ya está en la casa: `asset_types.merged_into`.
 */
alter table buildings
  add column if not exists merged_into uuid references buildings(id) on delete set null;

comment on column buildings.merged_into is
  'Solo lápida de auditoría: se escribe justo antes de borrar la fila en una fusión, para que el DELETE del audit_log diga a qué edificio fueron a parar sus salas. Ninguna consulta lo lee vivo.';

-- -----------------------------------------------------------------------------
-- 2 — La fusión, completa
-- -----------------------------------------------------------------------------

create or replace function public.merge_building(from_building uuid, into_building uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  z record;
  target_zone uuid;
  v_origen_vivo  boolean;
  v_destino_vivo boolean;
  v_from_code    text;
  v_into_code    text;
  v_salas        uuid[];
  v_choque       text;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede fusionar edificios'
      using errcode = 'insufficient_privilege';
  end if;

  if from_building = into_building then
    raise exception 'No se puede fusionar un edificio consigo mismo';
  end if;

  select active, code into v_origen_vivo, v_from_code from buildings where id = from_building;
  if not found then
    raise exception 'El edificio que quieres fusionar ya no existe';
  end if;

  select active, code into v_destino_vivo, v_into_code from buildings where id = into_building;
  if not found then
    raise exception 'El edificio de destino ya no existe';
  end if;

  -- El destino primero: es el caso que llega desde el desplegable con la caché
  -- vieja, y el que se lleva por delante las salas del origen.
  if not v_destino_vivo then
    raise exception 'Ese edificio está en la papelera. Restáuralo antes de fusionar nada con él.';
  end if;
  if not v_origen_vivo then
    raise exception 'El edificio de origen está en la papelera. Restáuralo antes de fusionarlo, o déjalo donde está.';
  end if;

  -- Las salas que se van a mover, apuntadas ANTES de moverlas: después ya no se
  -- puede saber cuáles vinieron del origen, y son justo las que tienen los alias
  -- que hay que recualificar.
  -- El alias de la tabla NO puede llamarse `z`: hay una variable `z record`
  -- declarada arriba, plpgsql resuelve el nombre a la variable antes que a la
  -- tabla, y la consulta revienta con «record "z" is not assigned yet».
  select coalesce(array_agg(r.id), '{}')
    into v_salas
    from rooms r
    join zones zorigen on zorigen.id = r.zone_id
   where zorigen.building_id = from_building;

  /*
   * El choque de códigos, comprobado ANTES de mover nada.
   *
   * Fusionar dos edificios que tengan los dos una `PLANTA BAJA` con un aula
   * `0.1` reventaba con el error crudo del índice `unique (zone_id, code)` a
   * mitad del bucle, con parte de las plantas ya movidas y la transacción
   * abortada. `rename_zone` sí lo comprueba y lo dice; esto no.
   */
  select string_agg(distinct format('«%s» en «%s»', ro.code, zo.name), ', ')
    into v_choque
    from rooms ro
    join zones zo on zo.id = ro.zone_id
    join zones zd on public.norm_text(zd.name) = public.norm_text(zo.name)
                 and zd.building_id = into_building
    join rooms rd on rd.zone_id = zd.id
                 and public.norm_text(rd.code) = public.norm_text(ro.code)
   where zo.building_id = from_building;

  if v_choque is not null then
    raise exception 'No se puede fusionar: las dos plantas con el mismo nombre tienen aulas con el mismo código (%). Renómbralas antes.', v_choque;
  end if;

  for z in select * from zones where building_id = from_building loop
    -- Por `norm_text` y no por igualdad exacta, como ya hacen `rename_zone` y
    -- `create_room`: con `=` a secas, «1ª PLANTA» y «1ª Planta» son dos plantas
    -- distintas y la fusión deja el edificio con la misma planta dos veces.
    select id into target_zone
    from zones
    where building_id = into_building
      and public.norm_text(name) = public.norm_text(z.name);

    if target_zone is null then
      update zones set building_id = into_building where id = z.id;
    else
      update rooms set zone_id = target_zone where zone_id = z.id;
      delete from zones where id = z.id;
    end if;
  end loop;

  /*
   * Los alias, recualificados con el código del edificio de hoy.
   *
   * Es la fuga que dejó las nueve aulas del CRAI sin cruzar. El alias viejo se
   * queda —no se borra nada: sigue siendo verdad que la sala se llamó así
   * cuando su edificio era el CRAI— y se añade la misma referencia con el
   * código nuevo, que es por la que van a preguntar el cruce y los partes.
   *
   * Por sufijo exacto y no con `like`: un código de edificio que llevara `_` o
   * `%` sería un comodín, y recualificaría alias de salas que no son.
   */
  insert into room_aliases (room_id, alias, alias_norm)
  select a.room_id, nuevo.txt, public.norm_text(nuevo.txt)
    from room_aliases a
    cross join lateral (
      select left(a.alias, length(a.alias) - length(v_from_code)) || v_into_code as txt
    ) nuevo
   where a.room_id = any(v_salas)
     and right(a.alias, length(v_from_code) + 1) = ' ' || v_from_code
  on conflict (alias_norm) do nothing;

  -- La lápida, antes del borrado y para que el borrado la lleve dentro.
  update buildings set merged_into = into_building where id = from_building;

  delete from buildings where id = from_building;
end;
$$;

comment on function public.merge_building(uuid, uuid) is
  'Fusiona un edificio provisional con el correcto. Rechaza los dos lados si están en la papelera, rechaza el choque de códigos de aula antes de mover nada, recualifica los alias de las salas que se lleva y deja apuntado en merged_into a dónde fueron.';

-- -----------------------------------------------------------------------------
-- 3 — Renombrar una sala deja alias, venga el renombrado de donde venga
-- -----------------------------------------------------------------------------

/*
 * Hasta ahora el alias lo dejaba `rename_room`, y solo `rename_room`.
 *
 * Pero no es el único camino que renombra una sala: `sync_celda_de_sala` —la
 * vuelta del libro, columna `C` de la hoja de estado sobre `rooms.code`— hace
 * un `update rooms set code` a secas, y ese renombrado no dejaba nada. El
 * histórico de partes que hablaba del código viejo se quedaba huérfano en
 * silencio, y la siguiente pasada del mismo libro ya no reconocía la fila que
 * ella misma había renombrado.
 *
 * Se pone donde no se puede esquivar. Un disparador sobre la tabla ve el cambio
 * lo haga quien lo haga —los dos caminos de hoy, los que se añadan mañana y un
 * `update` a mano en una consola— y no hay que acordarse de nada en cada sitio
 * nuevo. El `insert` de `rename_room` se queda donde está: con `on conflict do
 * nothing` a los dos lados, el segundo no hace daño.
 */
create or replace function public.alias_al_renombrar_sala()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.code is distinct from old.code and btrim(coalesce(old.code, '')) <> '' then
    -- Cualificado con el edificio, como todos: `alias_norm` es unique GLOBAL, y
    -- un `1.7` desnudo se quedaría con la referencia de los demás edificios.
    insert into room_aliases (room_id, alias, alias_norm)
    select new.id,
           old.code || ' ' || b.code,
           public.norm_text(old.code || ' ' || b.code)
      from zones z
      join buildings b on b.id = z.building_id
     where z.id = new.zone_id
    on conflict (alias_norm) do nothing;
  end if;
  return null;
end;
$$;

comment on function public.alias_al_renombrar_sala() is
  'Deja el código viejo de la sala como alias cualificado cada vez que cambia rooms.code, venga el cambio de rename_room, de la vuelta del Excel o de donde sea.';

drop trigger if exists rooms_alias_al_renombrar on rooms;
create trigger rooms_alias_al_renombrar
  after update of code on rooms
  for each row execute function public.alias_al_renombrar_sala();

-- -----------------------------------------------------------------------------
-- 4 — El historial de nomenclatura, ya filtrado
-- -----------------------------------------------------------------------------

/*
 * Lo que el cruce necesita saber de `audit_log`, y solo eso.
 *
 * La alternativa era que el navegador se bajara `audit_log` en crudo y filtrara
 * en memoria, y no vale: PostgREST no sabe comparar dos columnas entre sí —`old_data->>'code'
 * is distinct from new_data->>'code'` no es expresable— así que habría que
 * traerse TODAS las filas de `rooms`, que es la tabla más escrita del maestro:
 * cada lectura de horas de proyector deja una, y cada celda que vuelve del libro
 * deja otra, con `to_jsonb` de las quince columnas dentro. Eso son megas por
 * pasada, en un iPad, con la red del campus.
 *
 * Aquí el filtro se hace donde se puede hacer, y baja una fila por renombrado.
 *
 * `security_invoker`: la vista no puede enseñar más de lo que ya enseña
 * `audit_log`, cuya política es la del supervisor. Quien no pueda leer la
 * auditoría verá esto vacío, y el cruce ya sabe seguir sin ella —cruzará peor y
 * lo dirá, que es mejor que traducir con media verdad.
 */
create or replace view public.historial_de_nomenclatura
with (security_invoker = true) as
  -- Un edificio al que le cambió el código, el nombre, o los dos.
  select 'edificio'::text            as que,
         a.row_id                    as id,
         a.old_data->>'code'         as codigo_viejo,
         a.new_data->>'code'         as codigo_nuevo,
         a.old_data->>'name'         as nombre_viejo,
         a.new_data->>'name'         as nombre_nuevo,
         null::text                  as destino
    from audit_log a
   where a.table_name = 'buildings'
     and a.op = 'UPDATE'
     and (a.old_data->>'code' is distinct from a.new_data->>'code'
       or a.old_data->>'name' is distinct from a.new_data->>'name')

  union all

  -- Un edificio borrado: el código con el que murió, y a dónde fue si fue a algún
  -- sitio. `merged_into` solo lo llevan las fusiones hechas a partir de ahora.
  select 'edificio_borrado',
         a.row_id,
         a.old_data->>'code',
         null,
         a.old_data->>'name',
         null,
         a.old_data->>'merged_into'
    from audit_log a
   where a.table_name = 'buildings' and a.op = 'DELETE'

  union all

  -- Una planta que cambió de edificio: es el rastro que deja una fusión cuando
  -- la planta no choca de nombre con ninguna del destino.
  select 'fusion',
         a.old_data->>'building_id',
         null,
         null,
         null,
         null,
         a.new_data->>'building_id'
    from audit_log a
   where a.table_name = 'zones'
     and a.op = 'UPDATE'
     and a.old_data->>'building_id' is distinct from a.new_data->>'building_id'
     and a.old_data->>'building_id' is not null
     and a.new_data->>'building_id' is not null

  union all

  -- Una sala a la que le cambió el código. `id` es el de la sala, que no cambia
  -- ni al renombrarla, ni al moverla de planta, ni al fusionar su edificio: por
  -- eso esto vale donde el alias ya no vale.
  select 'sala',
         a.row_id,
         a.old_data->>'code',
         a.new_data->>'code',
         null,
         null,
         null
    from audit_log a
   where a.table_name = 'rooms'
     and a.op = 'UPDATE'
     and a.old_data->>'code' is distinct from a.new_data->>'code'
     and a.old_data->>'code' is not null;

comment on view public.historial_de_nomenclatura is
  'Los renombrados y las fusiones de audit_log, ya filtrados: una fila por cambio de nomenclatura en vez de la auditoría entera. La lee el cruce del Excel para traducir la nomenclatura vieja.';

grant select on public.historial_de_nomenclatura to authenticated;
