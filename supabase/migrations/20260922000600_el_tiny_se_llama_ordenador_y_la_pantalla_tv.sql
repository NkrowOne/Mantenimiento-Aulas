-- reejecutable: si
--
-- Su bloque `do` mira cómo está la base antes de cada paso y no hace nada si ya
-- está hecho: si el tipo de origen ya no existe —porque se renombró o se
-- fusionó— no hay nada que renombrar ni que fusionar. Hace falta declararlo
-- porque la deducción automática rechaza cualquier `do` de nivel raíz.
-- =============================================================================
-- El Tiny se llama «Ordenador» y la Pantalla se llama «TV»
--
-- `20260922000400` iba a hacer esto y NO hizo nada. Se desplegó, se aplicó sin
-- error, y la pasada siguiente seguía pidiendo dar de alta ordenadores que la
-- sala tenía:
--
--     «Equipo nuevo en la sala 1.6 (ED. O): Ordenador — la hoja dice n.º de
--      serie GM02EGK1 y la sala no tiene ningún ordenador en la aplicación»
--
-- La sala tiene ese GM02EGK1 exacto. Lo tiene como «Ordenador Tiny».
--
-- El fallo: aquella migración solo sabía FUSIONAR, y una fusión necesita dos
-- tipos —el que se absorbe y el que sobrevive—. `Ordenador` y `TV` son nombres
-- del maestro de ejemplo; los tipos de producción los creó el importador del
-- Excel, y ahí lo que hay es «Ordenador Tiny» y «Pantalla». Sin destino, el
-- bucle no encontró ninguna pareja, no fusionó nada y no dijo ni una palabra.
--
-- Un no-op silencioso es la peor forma de fallar: el despliegue sale verde, el
-- esquema cuadra, y el problema sigue donde estaba. De ahí las dos decisiones
-- de este fichero:
--
--  1. RENOMBRAR cuando no hay destino, que es lo que hacía falta desde el
--     principio: el Tiny no tiene que fusionarse con nada, tiene que llamarse
--     «Ordenador». Y fusionar solo si el nombre de destino ya está cogido.
--  2. DECIR SIEMPRE lo que ha pasado con cada pareja, incluido «no había nada
--     que hacer». Si el mensaje no aparece en el arranque, es que este fichero
--     no ha corrido, y eso también es un dato.
--
-- Lo que NO se toca, y va dicho porque es la mitad del sentido de esto:
-- «Monitor». En el libro esa columna es la pantalla del PC, y es el único
-- nombre de los tres que ya significaba lo mismo en los dos sitios. Se queda
-- para que siga distinguiéndose de la pantalla grande del aula, que es la que
-- pasa a llamarse «TV» en las dos.
-- =============================================================================

do $nombres$
declare
  p          record;
  v_origen   uuid;
  v_nombre   text;
  v_destino  uuid;
begin
  for p in
    select * from (values ('Ordenador Tiny', 'Ordenador'),
                          ('Pantalla',       'TV')) as v(origen, destino)
  loop
    select id, name into v_origen, v_nombre
      from asset_types
     where public.norm_text(name) = public.norm_text(p.origen)
       and merged_into is null;

    if v_origen is null then
      raise notice '«%»: no existe o ya está resuelto. Nada que hacer.', p.origen;
      continue;
    end if;

    select id into v_destino
      from asset_types
     where public.norm_text(name) = public.norm_text(p.destino)
       and merged_into is null
       and id <> v_origen;

    if v_destino is null then
      /*
       * Nadie ocupa el nombre: se renombra, que es lo que se quería.
       *
       * Sin `rename_asset_type` por lo de siempre —exige `is_supervisor()` y
       * una migración corre sin sesión—, pero sí con lo que esa función hace
       * además del `update`: dejar el nombre viejo de alias. Con 301 máquinas
       * llamadas «Tiny» por todo el campus, esa palabra se va a escribir en
       * algún parte.
       */
      update asset_types
         set aliases = array(select distinct unnest(aliases || v_nombre)),
             name = p.destino
       where id = v_origen;

      -- Y las etiquetas de las salas, que decían el nombre viejo.
      perform public.relabel_assets_of_type(v_origen, v_nombre, p.destino);

      raise notice '«%» pasa a llamarse «%». El nombre viejo queda de alias.', v_nombre, p.destino;
      continue;
    end if;

    /*
     * El nombre ya está cogido: entonces sí es una fusión, y el que sobrevive
     * es el del libro. Es el cuerpo de `merge_asset_type` sin su guarda, igual
     * que en `20260922000400`.
     */
    update assets      set asset_type_id = v_destino where asset_type_id = v_origen;
    update stock_items set asset_type_id = v_destino where asset_type_id = v_origen;

    delete from asset_defaults d
     where d.asset_type_id = v_origen
       and exists (select 1 from asset_defaults o
                    where o.asset_type_id = v_destino
                      and o.building_id is not distinct from d.building_id);
    update asset_defaults set asset_type_id = v_destino where asset_type_id = v_origen;

    update asset_types
       set aliases = array(select distinct unnest(
             aliases || v_nombre || (select aliases from asset_types where id = v_origen)))
     where id = v_destino;

    update asset_types set merged_into = v_destino where id = v_origen;

    perform public.relabel_assets_of_type(v_destino, v_nombre, p.destino);

    raise notice '«%» se fusiona en «%», que ya existía. El nombre viejo queda de alias.', v_nombre, p.destino;
  end loop;
end
$nombres$;

notify pgrst, 'reload schema';
