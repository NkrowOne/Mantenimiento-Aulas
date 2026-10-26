-- reejecutable: si
--
-- Todo lo que hace está condicionado a que haya equipos retirados POR UNA
-- FUSIÓN y todavía retirados. La primera pasada los devuelve; la segunda no
-- encuentra ninguno y sale sin tocar una fila. Hace falta decirlo porque la
-- deducción automática rechaza cualquier `do` de nivel raíz.
-- =============================================================================
-- Los puestos del laboratorio 6 vuelven siguiendo la fusión, no el nombre
--
-- `20261026000300` tenía que devolverlos y el PDF de la sala siguió saliendo
-- con un solo ordenador, el «Puesto 30». Buscaba a los retirados por lo que se
-- LLAMAN: el tipo «Ordenador Lenovo Ideacentre», o un tipo con «ordenador» en
-- el nombre dentro de un aula cuyo nombre dijera «laboratorio informática 6».
-- Son dos apuestas sobre cómo está escrita la base, y basta con perder las dos:
-- que los retirados conserven el tipo con el que se apuntaron —el cambio de
-- tipo que llegó después solo movió a los vivos— y que el aula se llame en la
-- base de otra manera. Entonces la migración dice «nada que devolver», con
-- toda la razón, y no devuelve nada.
--
-- Lo que no depende de cómo se llame nada es la propia fusión: cada retirado
-- guarda en su baja `fusionado_en`, el equipo que se quedó con su identidad.
-- Se sigue esa cadena —A se fundió en B, B en el Puesto 30— hasta el equipo que
-- sigue vivo, y vuelve todo lo que acaba en un ordenador del aula. Un micrófono
-- duplicado que se fundió en otro micrófono no acaba en un ordenador, y se
-- queda donde está, que es donde tiene que estar.
--
-- Y también vuelve, como antes, lo retirado por una fusión cuyo propio tipo es
-- el del ordenador: es el caso en que la cadena no lleva a nada vivo.
--
-- Tres cosas cambian respecto a `20261026000300`:
--
--  - **No se renumera.** Aquella numeraba por número de serie, y estos equipos
--    no tienen serie: el orden habría salido de la fecha de alta y del `id`, o
--    sea al azar, y el «Puesto 7» del papel ya no sería el de la séptima mesa.
--    Cada uno vuelve con el nombre que tenía. Si choca con uno vivo, el
--    disparador le da el siguiente número libre, como a cualquier alta.
--
--  - **No se vuelven a proponer como duplicados.** Treinta «Puesto N» sin serie
--    son exactamente lo que la bandeja confunde, y nada impedía que alguien los
--    volviera a fundir mañana pulsando el mismo botón. Cada uno queda
--    descartado de la bandeja —la misma marca que deja «Son dos aparatos»—, y
--    los choques de nombre que dejara la vuelta, resueltos.
--
--  - **La fecha de alta sigue siendo el 22 de octubre de 2026**, el día que se
--    instalaron, para los que vuelven y para los ordenadores que ya estaban
--    vivos en esas aulas.
--
-- `20261026000300` se queda sin efecto en las bases que no la hayan aplicado
-- todavía —ver su cabecera—, para que no renumere al azar antes de que corra
-- ésta. En las que ya la aplicaron no hizo nada, que es por lo que existe ésta.
-- =============================================================================

do $puestos$
declare
  v_instalacion constant timestamptz := timestamptz '2026-10-22 09:00+02';
  v_ordenador text := public.norm_text('Ordenador Lenovo Ideacentre');
  v_vueltos int := 0;
  v_descartados int := 0;
begin
  create temporary table puestos_que_vuelven on commit drop as
  with recursive
  -- Cada equipo retirado por una fusión, con el equipo en el que se fundió. La
  -- baja más reciente: un equipo puede haber vuelto y haberse fundido otra vez.
  fusiones as (
    select distinct on (e.asset_id)
           e.asset_id                        as id,
           (e.meta ->> 'fusionado_en')::uuid as en
      from asset_events e
      join assets a on a.id = e.asset_id
     where e.kind = 'baja'
       and e.meta ->> 'fusionado_en' is not null
       and a.status = 'retirado'
     order by e.asset_id, e.occurred_at desc, e.recorded_at desc
  ),
  -- La cadena, salto a salto. El tope es por si alguna vez hubiera un ciclo:
  -- con la regla de la fusión no puede haberlo, pero un bucle aquí colgaría el
  -- despliegue entero.
  cadena as (
    select f.id, f.en as destino, 1 as salto from fusiones f
    union all
    select c.id, f.en, c.salto + 1
      from cadena c
      join fusiones f on f.id = c.destino
     where c.salto < 100
  ),
  -- Donde acaba: el primer destino que no es a su vez un retirado por fusión.
  final as (
    select distinct on (c.id) c.id, c.destino
      from cadena c
     where not exists (select 1 from fusiones f where f.id = c.destino)
     order by c.id, c.salto desc
  ),
  candidatos as (
    -- Acaba en un ordenador vivo.
    select fi.id
      from final fi
      join assets vivo         on vivo.id = fi.destino
      join asset_types t       on t.id = vivo.asset_type_id
      left join asset_types tf on tf.id = t.merged_into
     where vivo.status <> 'retirado'
       and public.norm_text(coalesce(tf.name, t.name)) = v_ordenador
    union
    -- O es un ordenador él mismo.
    select f.id
      from fusiones f
      join assets a            on a.id = f.id
      join asset_types t       on t.id = a.asset_type_id
      left join asset_types tf on tf.id = t.merged_into
     where public.norm_text(coalesce(tf.name, t.name)) = v_ordenador
  )
  select a.id,
         a.room_id,
         greatest(
           v_instalacion,
           (select max(e.occurred_at) + interval '1 minute'
              from asset_events e
             where e.asset_id = a.id and e.kind = 'baja')
         ) as alta
    from candidatos c
    join assets a on a.id = c.id
   where a.room_id is not null;

  select count(*) into v_vueltos from puestos_que_vuelven;

  if v_vueltos = 0 then
    raise notice 'Laboratorio 6: ningún ordenador retirado por una fusión. Nada que devolver.';
    return;
  end if;

  -- De vuelta, con su nombre. El disparador de etiquetas solo actúa si choca.
  update assets a
     set status     = 'instalado',
         created_at = v_instalacion
    from puestos_que_vuelven p
   where a.id = p.id;

  -- El alta en el histórico: es lo que hace que la hoja deje de leerlos como
  -- baja (`20261026000100`). Sin ella volverían a la pantalla y no al papel.
  insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
  select gen_random_uuid(), p.id, p.room_id, 'alta', p.alta, null,
         jsonb_build_object(
           'nota', 'Vuelve al inventario: la fusión de duplicados que lo retiró era un error. Son puestos distintos, no copias del mismo.',
           'instalado_el', to_char(v_instalacion, 'YYYY-MM-DD'))
    from puestos_que_vuelven p;

  -- Los que ya estaban vivos en esas aulas llegaron el mismo día.
  update assets a
     set created_at = v_instalacion
    from asset_types t
    left join asset_types tf on tf.id = t.merged_into
   where t.id = a.asset_type_id
     and a.status <> 'retirado'
     and a.room_id in (select distinct room_id from puestos_que_vuelven)
     and public.norm_text(coalesce(tf.name, t.name)) = v_ordenador
     and a.created_at is distinct from v_instalacion;

  /*
   * Y que la bandeja no los vuelva a proponer.
   *
   * La marca es la de «Son dos aparatos»: un `descartado` por equipo, que es lo
   * que `auditoria_duplicados` mira para no enseñar un par. Va para los que
   * vuelven y para los ordenadores vivos de la misma aula, porque cualquiera de
   * ellos puede salir como «duplicado» del otro.
   */
  insert into asset_label_conflicts
    (room_id, asset_id, choco_con, pedida, asignada, op, resolved, resolved_by, resolved_at)
  select a.room_id, a.id, null, null, null, 'descartado', true, null, now()
    from assets a
    join asset_types t       on t.id = a.asset_type_id
    left join asset_types tf on tf.id = t.merged_into
   where a.status <> 'retirado'
     and a.room_id in (select distinct room_id from puestos_que_vuelven)
     and (
       a.id in (select id from puestos_que_vuelven)
       or public.norm_text(coalesce(tf.name, t.name)) = v_ordenador
     )
     and not exists (
       select 1 from asset_label_conflicts x
        where x.asset_id = a.id and x.op = 'descartado'
     );
  get diagnostics v_descartados = row_count;

  -- Los choques de nombre que haya apuntado la vuelta, cerrados: ya los ha
  -- decidido esta migración.
  update asset_label_conflicts
     set resolved = true, resolved_at = now()
   where not resolved
     and asset_id in (select id from puestos_que_vuelven);

  raise notice 'Laboratorio 6: % ordenadores devueltos al inventario con alta del 22/10/2026; % fuera de la bandeja de duplicados.',
    v_vueltos, v_descartados;
end
$puestos$;

notify pgrst, 'reload schema';
