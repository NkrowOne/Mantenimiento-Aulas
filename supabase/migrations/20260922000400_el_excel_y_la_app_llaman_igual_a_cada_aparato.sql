-- =============================================================================
-- El Excel y la aplicación llaman igual a cada aparato
--
-- reejecutable: si — todo lo que hace está condicionado a que el tipo absorbido
-- siga vivo (`merged_into is null`). En cuanto una fusión está hecha, la
-- segunda pasada no encuentra nada que fusionar y no toca nada. Se comprueba
-- además en la prueba: aplicada dos veces seguidas deja el mismo resultado.
--
-- La hoja de estado y la aplicación nombraban lo mismo de dos maneras, y por
-- eso la pasada del 22/09 pedía dar de alta equipos que ya existían:
--
--     «Equipo nuevo en la sala 1.1: TV — la hoja dice n.º de serie
--      04204654NB y la sala no tiene ningún tv en la aplicación»
--
-- La sala sí lo tenía. Lo tenía como «Pantalla», que es como lo llama la
-- aplicación desde la importación, mientras la columna del libro se llama
-- «S/N TV» y escribe en un tipo llamado «TV». Dos tipos, el mismo aparato, y
-- el número de serie repartido entre los dos: buscar por serie encuentra uno
-- de los dos y el histórico del otro no aparece.
--
-- La equivalencia la confirmó quien mantiene el libro, aparato por aparato:
--
--   columna del libro   qué es                        tipo de la aplicación
--   ------------------  ----------------------------  ---------------------
--   S/N TV              la pantalla grande del aula    «Pantalla» (367)
--                       (NEC E657Q, 201 series)
--   S/N Monitor         la pantalla del PC             ninguno todavía
--                       (75 series)
--   S/N Ordenador       el Tiny PC                     «Ordenador Tiny» (301)
--                       (ThinkCentre M70Q, 58 series)
--
-- Sobrevive el nombre del libro —«TV», «Monitor», «Ordenador»—, que es la
-- decisión de quien lo mantiene: el libro es lo que se mira y lo que se sube a
-- SharePoint, así que sus cabeceras y la aplicación dicen lo mismo. El nombre
-- absorbido no se pierde: `merge_asset_type` lo deja de ALIAS, así que quien
-- escriba «Pantalla» en un parte sigue encontrando el tipo.
--
-- Lo que NO se toca, y es a propósito:
--
--  - «Monitor Atril» (38). La pantalla del PC no está en la aplicación —lo
--    dijo quien mantiene el libro—, así que el monitor del atril es otra cosa
--    y fusionarlo metería 38 aparatos en el tipo equivocado.
--  - «Ordenador Lenovo Ideacentre» (30). Es un ordenador, pero no es el Tiny,
--    y la columna del libro es la del Tiny. Si algún día esas 30 salas tienen
--    que caber en «S/N Ordenador», se fusiona entonces y con la pregunta hecha.
--  - «Pantalla Proyector» (2) y «Pantalla de proyección». Son la tela donde
--    proyecta el cañón, no una pantalla encendida. Que compartan la palabra
--    «Pantalla» es justo la trampa que este fichero tiene que esquivar.
-- =============================================================================

do $unificar$
declare
  v_destino uuid;
  v_origen  uuid;
  v_n       integer := 0;
begin
  /*
   * Una por una y con el nombre exacto, no con un `like`.
   *
   * `like 'Pantalla%'` se llevaría por delante «Pantalla Proyector», que es la
   * tela del cañón. Aquí la lista es corta y la escribe quien sabe lo que hay
   * detrás de cada nombre; un patrón la haría más corta y mucho más peligrosa.
   *
   * Los numerados sí van por patrón, pero abajo y con el nombre base delante:
   * «Pantalla 2» es una segunda pantalla de la misma sala, no otro aparato.
   */
  for v_destino, v_origen in
    select d.id, o.id
      from (values ('TV', 'Pantalla'), ('Ordenador', 'Ordenador Tiny')) as p(destino, origen)
      join asset_types d on public.norm_text(d.name) = public.norm_text(p.destino)
                        and d.merged_into is null
      join asset_types o on public.norm_text(o.name) = public.norm_text(p.origen)
                        and o.merged_into is null
     where d.id <> o.id
  loop
    /*
     * El cuerpo de `merge_asset_type`, copiado y sin su guarda.
     *
     * No se le llama porque exige `is_supervisor()` y una migración corre sin
     * sesión: la guarda protege la API, no el despliegue. Copiar es la misma
     * decisión que se tomó con `create_room` en `sync_alta`, y por lo mismo.
     */
    update assets      set asset_type_id = v_destino where asset_type_id = v_origen;
    update stock_items set asset_type_id = v_destino where asset_type_id = v_origen;

    -- El equipamiento por defecto viaja igual. Si el destino ya tenía uno en el
    -- mismo ámbito, el del absorbido sobra: hay índice único y manda el que ya
    -- estaba.
    delete from asset_defaults d
     where d.asset_type_id = v_origen
       and exists (select 1 from asset_defaults o
                    where o.asset_type_id = v_destino
                      and o.building_id is not distinct from d.building_id);
    update asset_defaults set asset_type_id = v_destino where asset_type_id = v_origen;

    -- El nombre absorbido queda de alias: quien escriba «Pantalla» en un parte
    -- sigue encontrando el tipo. Es lo que hace que esto no rompa nada escrito.
    update asset_types
       set aliases = array(select distinct unnest(
             aliases || (select name from asset_types where id = v_origen)
                     || (select aliases from asset_types where id = v_origen)))
     where id = v_destino;

    update asset_types set merged_into = v_destino where id = v_origen;

    -- Y lo que en la sala ponía «Pantalla» pasa a poner «TV».
    perform public.relabel_assets_of_type(
      v_destino,
      (select name from asset_types where id = v_origen),
      (select name from asset_types where id = v_destino));

    v_n := v_n + 1;
  end loop;

  if v_n > 0 then
    raise notice 'Tipos de equipo unificados con el nombre del libro: %.', v_n;
  end if;
end
$unificar$;

/*
 * Y los numerados, que existen y son el mismo aparato repetido.
 *
 * «Pantalla 2» es la segunda pantalla de una sala que tiene dos, no un aparato
 * distinto. Un tipo por cada repetición es lo que impide contar cuántas
 * pantallas hay en el campus, y lo que hace que la segunda no cruce nunca con
 * la columna del libro.
 *
 * Después de esto, una sala con dos pantallas tiene DOS equipos del tipo «TV»,
 * que es como el resto del inventario ya representa lo repetido —`Proyector 2`
 * entra aquí por la misma puerta—.
 *
 * Va aparte y detrás del bloque de arriba a propósito: primero se resuelve el
 * nombre base y solo después lo que cuelga de él, para que «Pantalla 2» acabe
 * en «TV» y no en un «Pantalla» que ya está fusionado.
 */
do $numerados$
declare
  v_destino uuid;
  v_origen  uuid;
  v_nombre  text;
  v_n       integer := 0;
begin
  for v_destino, v_origen, v_nombre in
    select d.id, o.id, o.name
      from (values ('TV', 'Pantalla'), ('TV', 'TV'),
                   ('Ordenador', 'Ordenador Tiny'), ('Ordenador', 'Ordenador'),
                   ('Monitor', 'Monitor'), ('Proyector', 'Proyector'),
                   ('Cámara', 'Cámara')) as p(destino, base)
      join asset_types d on public.norm_text(d.name) = public.norm_text(p.destino)
                        and d.merged_into is null
      -- `<base> <n>`: el nombre base, un espacio y solo dígitos detrás.
      join asset_types o on o.merged_into is null
                        and public.norm_text(o.name) ~
                            ('^' || public.norm_text(p.base) || ' [0-9]{1,2}$')
     where d.id <> o.id
  loop
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

    perform public.relabel_assets_of_type(
      v_destino, v_nombre, (select name from asset_types where id = v_destino));

    v_n := v_n + 1;
  end loop;

  if v_n > 0 then
    raise notice 'Tipos numerados recogidos en su tipo base: %.', v_n;
  end if;
end
$numerados$;

notify pgrst, 'reload schema';
