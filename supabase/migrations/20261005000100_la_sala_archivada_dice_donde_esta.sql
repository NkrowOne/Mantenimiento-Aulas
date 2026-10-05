-- =============================================================================
-- La sala archivada dice dónde está
-- =============================================================================
--
-- `create_room` compara el código contra TODAS las salas de la planta, también
-- las archivadas (`active = false`). Es lo correcto: el `unique (zone_id, code)`
-- no mira `active`, así que el insert fallaría igual. Pero el aviso era el
-- mismo —«Ya hay una sala 1.2 en esa planta»— y la sala no aparece en ninguna
-- lista, porque `room_overview` filtra por `r.active`. Quien lo lee busca la
-- sala, no la encuentra y no sabe qué hacer.
--
-- Ahora, si la que choca está archivada, el aviso lo dice y dice dónde
-- reactivarla. Solo cambia el mensaje: nada se crea ni se reactiva solo.
-- `create or replace` conserva el `grant execute` y el `comment`.

create or replace function public.create_room(
  p_building uuid,
  p_zone     text,
  p_code     text,
  p_name     text,
  p_kind     room_kind default 'aula'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_zone uuid;
  v_room uuid;
  v_activo boolean;
  v_choque_activo boolean;
  v_zone_name text := btrim(coalesce(p_zone, ''));
  v_code text := btrim(coalesce(p_code, ''));
  v_name text := btrim(coalesce(p_name, ''));
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador da de alta salas'
      using errcode = 'insufficient_privilege';
  end if;
  if v_code = '' then
    raise exception 'La sala necesita un código';
  end if;

  select active into v_activo from buildings where id = p_building;
  if not found then
    raise exception 'Ese edificio no existe';
  end if;
  if not v_activo then
    raise exception 'Ese edificio está en la papelera. Restáuralo antes de añadirle salas.';
  end if;

  if v_zone_name = '' then
    v_zone_name := 'SIN ZONA';
  end if;
  if v_name = '' then
    v_name := v_code;
  end if;

  select id into v_zone
    from zones
   where building_id = p_building
     and public.norm_text(name) = public.norm_text(v_zone_name);

  if v_zone is null then
    insert into zones (building_id, name, sort_order)
    select p_building, v_zone_name, coalesce(max(sort_order), 0) + 10
      from zones where building_id = p_building
    returning id into v_zone;
  end if;

  -- `bool_or` da true si alguna de las que chocan está viva, false si todas
  -- están archivadas y null si no choca ninguna.
  select bool_or(active) into v_choque_activo
    from rooms
   where zone_id = v_zone
     and public.norm_text(code) = public.norm_text(v_code);

  if v_choque_activo then
    raise exception 'Ya hay una sala % en esa planta', v_code;
  end if;
  if v_choque_activo is not null then
    raise exception 'La sala % de esa planta está archivada. Reactívala en Más › Datos › Maestro › Salas archivadas.', v_code;
  end if;

  insert into rooms (zone_id, code, name, kind)
  values (v_zone, v_code, v_name, p_kind)
  returning id into v_room;

  return v_room;
end;
$$;
