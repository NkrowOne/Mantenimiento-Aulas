-- Dentro del aula, el número de serie manda
--
-- `sync_aplicar_equipo` sabe qué hacer con un número de serie que ya está en
-- OTRA aula —lo rechaza y dice por qué— y con uno que está en ESTA aula sobre un
-- equipo de baja —lo reactiva, porque es lo que la hoja está diciendo—. Le falta
-- el tercer caso, y es el que se va a dar de verdad: el número está en esta aula,
-- sobre un equipo instalado, pero **de otro tipo**.
--
-- Ahí ninguna de las dos ramas entra, la búsqueda por (aula, tipo, instalado) no
-- encuentra nada, y se cae en el `insert into assets` del final con un número que
-- ya existe. `assets_serial_idx` es único GLOBAL, así que la celda se rechaza con
-- «duplicate key value violates unique constraint "assets_serial_idx"» — que es
-- exactamente el mensaje ilegible que la migración `20260830001200` vino a quitar
-- del otro caso. Y como una celda rechazada no deja antepasado, se vuelve a
-- proponer en cada pasada, con `veces` subiendo en cuarentena, para siempre.
--
-- Este caso no es hipotético: lo dejó escrito la migración `20260830000100` al
-- separar `TV` y `Monitor` de `Pantalla`. Dice, literalmente, que «lo que hoy es
-- `Pantalla` se queda como está **hasta que la sincronización lo reconozca por su
-- número de serie** en una columna o en la otra». Ese reconocimiento es esto: en
-- una base cargada antes de aquella separación, los números de `S/N TV` y
-- `S/N Monitor` viven sobre equipos que siguen siendo `Pantalla`, y la hoja los
-- va a reclamar como TV y como Monitor.
--
-- Qué se hace: **adoptar el equipo y reclasificarlo, pero solo si el tipo que hoy
-- tiene es aquel del que el suyo se separó.** Cualquier otro choque se rechaza
-- diciendo qué equipo lleva ese número y de qué tipo es.
--
-- La diferencia importa. Reclasificar un `Pantalla` a `TV` no cambia nada del
-- mundo real: es deshacer una fusión que el catálogo hizo y luego revocó, y el
-- libro es quien sabe en qué columna va cada aparato. Reclasificar un `Cámara` a
-- `TV` porque alguien se equivocó de columna sí cambia el mundo, y en silencio.

-- -----------------------------------------------------------------------------
-- 1 — De qué tipo se separó cada tipo
-- -----------------------------------------------------------------------------

/*
 * Hace falta una columna porque la señal se borró.
 *
 * `20260830000100` resucita el `TV` que estaba fundido dentro de `Pantalla`
 * poniéndole `merged_into = null` (línea 76), que es lo correcto —vuelve a ser un
 * tipo de pleno derecho— pero deja el sistema sin ninguna forma de saber que
 * antes fue parte de otro. `Monitor` se da de alta nuevo y nunca lo tuvo.
 * `asset_types` tampoco está en la lista de tablas que audita
 * `20260728000300_auth_rls.sql:331`, así que no hay rastro por ningún lado.
 *
 * Lo que sí se sabe es lo que aquella migración separó, porque está en su código.
 * Se escribe aquí en vez de dejarlo adivinado, y queda un sitio donde apuntar la
 * próxima separación en vez de tener que volver a inventarse la señal.
 */
alter table asset_types
  add column if not exists separado_de uuid references asset_types(id) on delete set null;

comment on column asset_types.separado_de is
  'El tipo del que este se separó, cuando antes estuvo fundido dentro de él. Lo usa la sincronización para reconocer un equipo por su número de serie cuando el libro lo reclama con el nombre nuevo y la base lo tiene con el viejo. NULL = este tipo nunca fue parte de otro.';

do $$
declare
  v_pantalla uuid;
begin
  select id into v_pantalla
    from asset_types
   where public.norm_text(name) = public.norm_text('Pantalla') and merged_into is null;

  -- En una instalación limpia `Pantalla` no existe: no hubo fusión, no hay nada
  -- que apuntar, y la regla de abajo no se dispara nunca. Es el mismo `return`
  -- temprano que hace `20260830000100`.
  if v_pantalla is null then return; end if;

  update asset_types
     set separado_de = v_pantalla
   where separado_de is null
     and id <> v_pantalla
     and public.norm_text(name) in (public.norm_text('TV'), public.norm_text('Monitor'));
end $$;

-- -----------------------------------------------------------------------------
-- 2 — El tercer caso
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
  v_asset   uuid;
  v_otro    uuid;
  v_donde   uuid;
  v_estado  asset_status;
  v_tipo    uuid;
  v_origen  uuid;
  v_nombre  text;
  v_mio     text;
begin
  if p_valor is null or btrim(p_valor) = '' then return null; end if;

  if p_campo = 'serial' then
    select id, room_id, status, asset_type_id
      into v_otro, v_donde, v_estado, v_tipo
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

    /*
     * Mismo aula, instalado, y de otro tipo. Es el caso que faltaba.
     *
     * Se adopta solo si el tipo que la hoja pide se separó del que el equipo
     * tiene: entonces es el mismo aparato con el nombre que le corresponde, y
     * dárselo es terminar la separación que `20260830000100` dejó a medias.
     *
     * Si no, se rechaza DICIENDO QUÉ PASA. Es la diferencia entre «duplicate key
     * value violates unique constraint "assets_serial_idx"» y una frase con la
     * que alguien puede ir al maestro y arreglarlo.
     */
    if v_otro is not null and v_estado = 'instalado' and v_tipo is distinct from p_type then
      select separado_de into v_origen from asset_types where id = p_type;

      if v_origen is not null and v_origen = v_tipo then
        update assets set asset_type_id = p_type where id = v_otro;
        insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
        values (gen_random_uuid(), v_otro, p_room, 'sustitucion', now(), null,
                jsonb_build_object(
                  'source', 'sharepoint',
                  'nota', 'el libro lo reclama en su columna: se le devuelve el tipo del que estaba fundido',
                  'tipo_antes', (select name from asset_types where id = v_tipo),
                  'tipo_ahora', (select name from asset_types where id = p_type)));
        v_asset := v_otro;
      else
        select name into v_nombre from asset_types where id = v_tipo;
        select name into v_mio    from asset_types where id = p_type;
        return format(
          'el número de serie «%s» ya está en esta aula, pero puesto en un «%s» y no en un «%s». Si es el mismo aparato, cámbiale el tipo desde la aplicación; si son dos, corrige el número en la hoja',
          p_valor, coalesce(v_nombre, '?'), coalesce(v_mio, '?'));
      end if;
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

  /*
   * El `update` del número también puede chocar, y por el mismo sitio: el aula
   * ya tiene un equipo de este tipo sin número, y el número que trae la hoja es
   * de otro aparato de la misma aula. Sin esto salía otra vez el `duplicate key`.
   */
  if p_campo = 'serial' then
    if exists (select 1 from assets where serial = p_valor and id <> v_asset) then
      return format(
        'el número de serie «%s» ya es de otro equipo: dos aparatos no pueden llevar el mismo',
        p_valor);
    end if;
    update assets set serial = p_valor where id = v_asset;
  else
    update assets set model = p_valor where id = v_asset;
  end if;
  return null;
end $$;

comment on function public.sync_aplicar_equipo(uuid, uuid, text, text) is
  'Escribe el número de serie o el modelo que la hoja enseña de un tipo de equipo en un aula. Dentro del aula el número de serie es la identidad: un equipo de baja se reactiva, y uno instalado bajo el tipo del que este se separó se adopta y se reclasifica. Cualquier otro choque se rechaza diciendo qué equipo lleva ese número y de qué tipo es, en vez del error crudo del índice.';

revoke all on function public.sync_aplicar_equipo(uuid, uuid, text, text) from public, anon, authenticated;
