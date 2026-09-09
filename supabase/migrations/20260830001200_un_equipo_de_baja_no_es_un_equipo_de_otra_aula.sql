-- =============================================================================
-- Un equipo dado de baja no es «un equipo de otra aula»
--
-- `sync_aplicar_equipo` comprueba que el número de serie que trae la hoja no sea
-- ya de otro equipo antes de escribirlo, y hace bien: `assets_serial_idx` es
-- único sobre `serial`, con equipo de baja o sin él. Lo que no hacía era mirar
-- **en qué estado** está ese otro equipo, y de ahí salen dos casos que la hoja
-- no podía arreglar nunca:
--
-- **En la misma aula, el equipo está de baja.** La comprobación no salta —el
-- aula es la misma— pero después no se encuentra ningún equipo `instalado` de
-- ese tipo, así que se da de alta uno nuevo… con un número de serie que ya
-- existe. Lo para el índice único y la celda se rechaza con «duplicate key
-- value violates unique constraint», que no le dice nada a nadie. Es el caso de
-- un proyector que se retiró y se volvió a poner: la hoja tiene razón, y no
-- había forma de dársela. Ahora se reactiva el que ya está ahí, que es
-- exactamente lo que la hoja está diciendo, y queda su apunte en el historial.
--
-- **En otra aula, el equipo está de baja.** Ahí la hoja **no** puede tener razón
-- sola: el equipo se dio de baja en un sitio y aparece en otro, y traerlo de
-- vuelta es una decisión con historial —cuándo se movió, quién lo movió— que no
-- cabe en una celda. Se sigue rechazando, pero diciendo lo que pasa de verdad y
-- qué hay que hacer, en vez de «ya está en otra aula», que era falso: no está en
-- ninguna aula, está retirado.
-- =============================================================================

create or replace function public.sync_aplicar_equipo(
  p_room uuid, p_type uuid, p_campo text, p_valor text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_asset  uuid;
  v_otro   uuid;
  v_donde  uuid;
  v_estado asset_status;
begin
  if p_valor is null or btrim(p_valor) = '' then return null; end if;

  if p_campo = 'serial' then
    select id, room_id, status into v_otro, v_donde, v_estado
      from assets where serial = p_valor limit 1;

    if v_otro is not null and v_donde is distinct from p_room then
      if v_estado = 'instalado' then
        return format('el número de serie «%s» ya está en otra aula', p_valor);
      end if;
      return format(
        'el número de serie «%s» es de un equipo dado de baja: traerlo a esta aula se hace desde la aplicación, que es donde queda apuntado el traslado',
        p_valor);
    end if;

    -- Mismo aula y de baja: la hoja dice que sigue puesto, y la hoja es la que
    -- mira el aula. Se reactiva ese, no se da de alta otro con su número.
    if v_otro is not null and v_estado <> 'instalado' then
      update assets set status = 'instalado' where id = v_otro;
      insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
      values (gen_random_uuid(), v_otro, p_room, 'alta', now(), null,
              jsonb_build_object('source', 'sharepoint', 'nota', 'estaba de baja y la hoja lo sigue contando en esta aula'));
      v_asset := v_otro;
    end if;
  end if;

  -- El equipo vivo de ese tipo en esa sala. Si hay varios, el más reciente, que
  -- es el que la hoja está enseñando.
  if v_asset is null then
    select id into v_asset from assets
     where room_id = p_room and asset_type_id = p_type and status = 'instalado'
     order by created_at desc limit 1;
  end if;

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

comment on function public.sync_aplicar_equipo(uuid, uuid, text, text) is
  'Escribe el número de serie o el modelo que la hoja enseña de un tipo de equipo en un aula. Un equipo de baja en la misma aula se reactiva —es lo que la hoja está diciendo—; uno de baja en otra no se mueve desde una celda, y se dice por qué.';

revoke all on function public.sync_aplicar_equipo(uuid, uuid, text, text) from public, anon, authenticated;
