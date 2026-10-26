-- reejecutable: si
--
-- Solo toca equipos retirados con la baja de la fusión. La primera pasada los
-- devuelve a `instalado`; la segunda ya no encuentra ninguno.
-- =============================================================================
-- Los puestos del laboratorio 6 vuelven por lo que dice la hoja impresa
--
-- Tercera vez, y esta sin suponer nada sobre la base.
--
-- `20261026000300` buscaba por el nombre del aula; `20261026000400`, por la
-- cadena de la fusión. Con una copia del laboratorio hecha a mano, y fundida con
-- la función de verdad, las dos los devuelven. En producción, ninguna: el PDF
-- con «Incluir equipos dados de baja» sigue enseñando los 29 puestos retirados.
-- O sea que la base de producción no es como la copia en algo que desde aquí no
-- se ve —un aula vaciada de la fila, una baja escrita de otra manera—, y otra
-- apuesta sobre ese algo podía fallar igual.
--
-- Así que esta no apuesta: devuelve exactamente las filas que la hoja impresa
-- enseña como retiradas en una fusión. Las lee de `inventory_sheet`, la misma
-- vista de la que sale el PDF:
--
--   estado «retirado» · tipo «Ordenador Lenovo Ideacentre» ·
--   motivo de la baja «Retirado en una fusión de duplicados»
--
-- Y les devuelve la sala que la hoja les pone. Si la fila del equipo la había
-- perdido —la hoja la saca entonces del histórico—, sin esto volverían a estar
-- «instalados» en ninguna parte.
--
-- Lo demás es como en `20261026000400`: con su nombre, alta del 22/09/2026 en
-- la fila y en el histórico, y fuera de la bandeja de duplicados para que nadie
-- los vuelva a fundir.
-- =============================================================================

do $puestos$
declare
  v_instalacion constant timestamptz := timestamptz '2026-09-22 09:00+02';
  v_ordenador text := public.norm_text('Ordenador Lenovo Ideacentre');
  v_vueltos int := 0;
  v_descartados int := 0;
begin
  create temporary table puestos_de_la_hoja on commit drop as
  select s.asset_id as id,
         s.room_id,
         greatest(
           v_instalacion,
           (select max(e.occurred_at) + interval '1 minute'
              from asset_events e
             where e.asset_id = s.asset_id and e.kind = 'baja')
         ) as alta
    from inventory_sheet s
   where s.status = 'retirado'
     and public.norm_text(s.type_name) = v_ordenador
     and s.baja_motivo = 'Retirado en una fusión de duplicados';

  select count(*) into v_vueltos from puestos_de_la_hoja;

  if v_vueltos = 0 then
    raise notice 'Laboratorio 6: la hoja no enseña ningún ordenador retirado en una fusión. Nada que devolver.';
    return;
  end if;

  update assets a
     set status     = 'instalado',
         room_id    = p.room_id,
         created_at = v_instalacion
    from puestos_de_la_hoja p
   where a.id = p.id;

  insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
  select gen_random_uuid(), p.id, p.room_id, 'alta', p.alta, null,
         jsonb_build_object(
           'nota', 'Vuelve al inventario: la fusión de duplicados que lo retiró era un error. Son puestos distintos, no copias del mismo.',
           'instalado_el', to_char(v_instalacion, 'YYYY-MM-DD'))
    from puestos_de_la_hoja p;

  -- Los ordenadores que ya estaban vivos en esas aulas llegaron el mismo día.
  update assets a
     set created_at = v_instalacion
    from asset_types t
    left join asset_types tf on tf.id = t.merged_into
   where t.id = a.asset_type_id
     and a.status <> 'retirado'
     and a.room_id in (select distinct room_id from puestos_de_la_hoja)
     and public.norm_text(coalesce(tf.name, t.name)) = v_ordenador
     and a.created_at is distinct from v_instalacion;

  -- Fuera de la bandeja de duplicados: la misma marca que «Son dos aparatos».
  insert into asset_label_conflicts
    (room_id, asset_id, choco_con, pedida, asignada, op, resolved, resolved_by, resolved_at)
  select a.room_id, a.id, null, null, null, 'descartado', true, null, now()
    from assets a
    join asset_types t       on t.id = a.asset_type_id
    left join asset_types tf on tf.id = t.merged_into
   where a.status <> 'retirado'
     and a.room_id in (select distinct room_id from puestos_de_la_hoja)
     and (
       a.id in (select id from puestos_de_la_hoja)
       or public.norm_text(coalesce(tf.name, t.name)) = v_ordenador
     )
     and not exists (
       select 1 from asset_label_conflicts x
        where x.asset_id = a.id and x.op = 'descartado'
     );
  get diagnostics v_descartados = row_count;

  update asset_label_conflicts
     set resolved = true, resolved_at = now()
   where not resolved
     and asset_id in (select id from puestos_de_la_hoja);

  raise notice 'Laboratorio 6: % ordenadores devueltos al inventario con alta del 22/09/2026; % fuera de la bandeja de duplicados.',
    v_vueltos, v_descartados;
end
$puestos$;

notify pgrst, 'reload schema';
