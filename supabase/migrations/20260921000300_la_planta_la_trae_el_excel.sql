-- =============================================================================
-- La planta la trae el Excel
--
-- Cuando el libro cambia el edificio de una sala y se ha elegido que mande el
-- Excel, la sala se muda en la aplicación: la celda del edificio llega a
-- `sync_mover_sala`. Hasta aquí esa función movía la sala al edificio nuevo y,
-- si allí no había una planta con el nombre de la suya, la dejaba en la primera
-- que hubiera. La planta de origen se perdía por el camino —las aulas DOT
-- entraban en el Edificio Central en «MÓDULO 1» en vez de en «AULAS DOT»— y la
-- pasada siguiente escribía «MÓDULO 1» en la hoja encima de lo que la persona
-- había puesto. Y una planta que la hoja nombra y el edificio no tiene («PLANTA
-- 2» en el edificio MSI) se rechazaba sin más.
--
-- El miedo de entonces era crear plantas fantasma en cada pasada. No pasa: la
-- planta se crea una vez y la pasada siguiente la encuentra. Lo que sí pasaba
-- era lo otro: la sala acababa en una planta que nadie había dicho, y la hoja
-- se reescribía sola. Así que la sala se lleva su planta al mudarse, y una
-- planta que la hoja nombra en un edificio que **sí** existe se crea. El
-- edificio sigue teniendo que existir: una errata de edificio («EDIFICO E») se
-- frena aquí igual que antes.
-- =============================================================================

create or replace function public.sync_mover_sala(p_room uuid, p_campo text, p_valor text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_zone        uuid;
  v_edif        uuid;
  v_actual      uuid;
  v_planta_hoy  text;
begin
  if p_valor is null or btrim(p_valor) = '' then return null; end if;

  select z.building_id, z.name into v_actual, v_planta_hoy
    from rooms r join zones z on z.id = r.zone_id
   where r.id = p_room;

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

    -- La sala se lleva su planta: la del mismo nombre en el edificio de
    -- destino y, si no la hay, se crea ahí con ese nombre. Así «AULAS DOT»
    -- sigue siendo «AULAS DOT» dentro del Edificio Central.
    select z.id into v_zone from zones z
     where z.building_id = v_edif
       and public.norm_text(z.name) = public.norm_text(v_planta_hoy)
     limit 1;
    if v_zone is null then
      insert into zones (building_id, name, sort_order)
      values (v_edif, v_planta_hoy,
              coalesce((select max(z.sort_order) from zones z where z.building_id = v_edif), 0) + 1)
      returning id into v_zone;
    end if;

    update rooms set zone_id = v_zone where id = p_room;
    return null;
  end if;

  -- La planta, dentro del edificio que ya tiene. Si no existe, se crea: el
  -- edificio existe, la hoja la nombra, y frenarla aquí dejaba la corrección
  -- rechazada en cada pasada.
  select z.id into v_zone from zones z
   where z.building_id = v_actual and public.norm_text(z.name) = public.norm_text(p_valor)
   limit 1;
  if v_zone is null then
    insert into zones (building_id, name, sort_order)
    values (v_actual, btrim(p_valor),
            coalesce((select max(z.sort_order) from zones z where z.building_id = v_actual), 0) + 1)
    returning id into v_zone;
  end if;
  update rooms set zone_id = v_zone where id = p_room;
  return null;
end $$;

comment on function public.sync_mover_sala(uuid, text, text) is
  'Muda una sala al edificio o a la planta que dice la celda del Excel. El edificio tiene que existir; la planta se lleva consigo al cambiar de edificio y se crea si el edificio no la tiene.';

revoke all on function public.sync_mover_sala(uuid, text, text) from public, anon, authenticated;
