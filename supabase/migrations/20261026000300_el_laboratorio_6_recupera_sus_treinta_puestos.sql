-- reejecutable: si
--
-- Todo lo que hace está condicionado a que haya equipos retirados POR UNA
-- FUSIÓN y todavía retirados. La primera pasada los devuelve a `instalado`; la
-- segunda no encuentra ninguno y sale sin tocar una fila. Hace falta decirlo
-- porque la deducción automática rechaza cualquier `do` de nivel raíz.
-- =============================================================================
-- El laboratorio de informática 6 recupera sus treinta puestos
--
-- Están los treinta encima de la mesa, enchufados, y la base dice que no
-- existen. Lo que pasó, en orden:
--
--   1. `20260922000500` les puso el nombre que tienen ahora: «Puesto 1» …
--      «Puesto 30», que es lo que alguien necesita saber para ir a arreglar uno
--      —a qué mesa— y no «Ideacentre 17», que no dice nada.
--   2. La bandeja de duplicados agrupa por **etiqueta base**, o sea por el
--      nombre sin el número de cola. Treinta «Puesto N» son, para esa consulta,
--      treinta veces el mismo nombre: propuso veintinueve duplicados del
--      primero.
--   3. Alguien fue pulsando «Fusionar», que es exactamente lo que la pantalla
--      le estaba pidiendo que hiciera. Cada fusión retiró un puesto y le dejó
--      su «Retirado en una fusión de duplicados» en el histórico.
--
-- Ninguno de los tres pasos fue un descuido. Lo que faltaba era mirar el número
-- de serie, y eso se arregla en `20261026000200`, que es lo que impide que esto
-- vuelva a pasar en la siguiente aula numerada. Esta migración arregla el daño
-- ya hecho, que aquella no toca.
--
-- Tres cosas, y las tres se ven en el papel:
--
--  - **Vuelven a estar instalados.** El `status` y, sobre todo, un `alta` en el
--    histórico: la hoja de inventario deja de contarlos como baja justo por ese
--    evento (`20261026000100`), así que sin él volverían a la pantalla y
--    seguirían sin salir en el PDF de la sala, que es por donde se vio esto.
--
--  - **La fecha de alta es la de verdad: el 22 de octubre de 2026**, el día que
--    se instalaron en el aula. Es el dato que da la persona que estuvo allí, y
--    es mejor que las dos fechas que tenía la base —la de la importación del
--    libro y la del día en que se arregla esto—, que no son ninguna de las dos
--    el día en que ese ordenador llegó a esa mesa. Se le pone a los treinta,
--    también al que se quedó vivo: llegaron juntos.
--
--  - **Y se vuelven a numerar del 1 al 30.** La fusión le devolvía al equipo
--    bueno la etiqueta base, así que el aula se quedó con un «Puesto» a secas y
--    un hueco en la numeración. Se rehace con el mismo criterio de
--    `20260922000500` —por número de serie— para que los dos repartos
--    coincidan y nadie tenga que explicar por qué el mapa del aula cambió.
--
-- Lo que NO se hace: borrar la baja de la fusión. Sigue en `asset_events`, se
-- sigue leyendo en el histórico de la sala y cuenta lo que pasó. Un inventario
-- de solo altas y sin errores no es un inventario, es un folleto.
-- =============================================================================

do $puestos$
declare
  -- El día que se instalaron, a una hora de trabajo: a las 00:00 la fecha se
  -- lee como el día anterior en cuanto alguien mira el papel desde otro huso.
  v_instalacion constant timestamptz := timestamptz '2026-10-22 09:00+02';
  v_sala uuid;
  v_vueltos int := 0;
  v_renumerados int := 0;
begin
  /*
   * La sala, para el segundo criterio de abajo. Se busca por el nombre y por el
   * edificio, y si no aparece no pasa nada: el criterio bueno es el tipo de
   * equipo, que no depende de cómo esté escrito el nombre del aula en el libro.
   */
  select r.id
    into v_sala
    from rooms r
    join zones z     on z.id = r.zone_id
    join buildings b on b.id = z.building_id
   where (public.norm_text(b.code) = 'E' or public.norm_text(b.name) = 'EDIFICIO E')
     and public.norm_text(r.name) like '%LABORATORIO%INFORMATICA%6%'
   order by r.code
   limit 1;

  /*
   * Los que vuelven: retirados por una fusión —lo dice el `fusionado_en` que
   * escribe `fusionar_equipo_duplicado`, no el estado a secas— y que son
   * ordenadores del aula.
   *
   * Dos criterios y no uno. El primero, el tipo, es el que identifica de verdad
   * a estas treinta máquinas: los Ideacentre son los puestos de los alumnos y
   * están todos en esa sala. El segundo cubre el caso de que el tipo se haya
   * renombrado o fusionado por el camino: cualquier ordenador de ESA sala
   * retirado por una fusión está mal retirado igual.
   *
   * `greatest` con la última baja es la cautela que hace que esto funcione
   * también si alguna fusión fuera posterior al 22 de octubre: el alta tiene que
   * ir por delante de la baja que deshace, o la hoja seguiría leyendo la baja.
   */
  create temporary table puestos_que_vuelven on commit drop as
  select a.id,
         a.room_id,
         greatest(
           v_instalacion,
           (select max(e.occurred_at) + interval '1 minute'
              from asset_events e
             where e.asset_id = a.id and e.kind = 'baja')
         ) as alta
    from assets a
    join asset_types t       on t.id = a.asset_type_id
    left join asset_types tf on tf.id = t.merged_into
   where a.status = 'retirado'
     and a.room_id is not null
     and (
       public.norm_text(coalesce(tf.name, t.name)) = public.norm_text('Ordenador Lenovo Ideacentre')
       or (
         v_sala is not null
         and a.room_id = v_sala
         and public.norm_text(coalesce(tf.name, t.name)) like '%ORDENADOR%'
       )
     )
     and exists (
       select 1 from asset_events e
        where e.asset_id = a.id
          and e.kind = 'baja'
          and e.meta ->> 'fusionado_en' is not null
     );

  select count(*) into v_vueltos from puestos_que_vuelven;

  if v_vueltos = 0 then
    raise notice 'Laboratorio 6: ningún puesto retirado por una fusión. Nada que devolver.';
    return;
  end if;

  update assets a
     set status     = 'instalado',
         created_at = v_instalacion
    from puestos_que_vuelven p
   where a.id = p.id;

  insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
  select gen_random_uuid(), p.id, p.room_id, 'alta', p.alta, null,
         jsonb_build_object(
           'nota', 'Vuelve al inventario: la fusión de duplicados que lo retiró era un error. Son treinta puestos distintos, no treinta copias del mismo.',
           'instalado_el', to_char(v_instalacion, 'YYYY-MM-DD'))
    from puestos_que_vuelven p;

  /*
   * El alta de los que vuelven es la del día de la instalación, y la del que se
   * quedó vivo también: los treinta llegaron el mismo día.
   */
  update assets a
     set created_at = v_instalacion
    from asset_types t
    left join asset_types tf on tf.id = t.merged_into
   where t.id = a.asset_type_id
     and a.status <> 'retirado'
     and a.room_id in (select distinct room_id from puestos_que_vuelven)
     and public.norm_text(coalesce(tf.name, t.name)) = public.norm_text('Ordenador Lenovo Ideacentre')
     and a.created_at is distinct from v_instalacion;

  /*
   * Y la numeración, del 1 al 30 y sin huecos.
   *
   * Va en dos pasadas por el índice único de etiquetas: una sola sentencia que
   * permute «Puesto 2» y «Puesto 3» choca contra sí misma, y `assets_label_libre`
   * —que está para no perder el trabajo de nadie— lo resolvería renombrando en
   * silencio a «Puesto 31». Primero se apartan a un nombre que no puede chocar
   * con nada, y después se ponen los definitivos.
   */
  create temporary table puestos_numerados on commit drop as
  select a.id,
         'Puesto ' || row_number() over (
           partition by a.room_id
           order by a.serial nulls last, a.created_at, a.id
         ) as etiqueta
    from assets a
    join asset_types t       on t.id = a.asset_type_id
    left join asset_types tf on tf.id = t.merged_into
   where a.status <> 'retirado'
     and a.room_id in (select distinct room_id from puestos_que_vuelven)
     and public.norm_text(coalesce(tf.name, t.name)) = public.norm_text('Ordenador Lenovo Ideacentre');

  update assets a
     set label = 'renumerando ' || a.id
    from puestos_numerados n
   where a.id = n.id
     and a.label is distinct from n.etiqueta;

  update assets a
     set label = n.etiqueta
    from puestos_numerados n
   where a.id = n.id
     and a.label is distinct from n.etiqueta;
  get diagnostics v_renumerados = row_count;

  raise notice 'Laboratorio 6: % puestos devueltos al inventario con alta del 22/10/2026, % renumerados.',
    v_vueltos, v_renumerados;
end
$puestos$;

notify pgrst, 'reload schema';
