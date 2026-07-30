-- =============================================================================
-- La ficha de una revisión
--
-- Lo que faltaba: una revisión guardada **no se podía leer**. Quedaba una fila
-- en `inspections`, nueve en `inspection_checks`, sus fotos en `attachments` y
-- las incidencias que abrió en `incidents`, y ninguna pantalla juntaba nada de
-- eso. El histórico decía «Revisión con incidencias» y ahí terminaba el
-- conocimiento: no se sabía QUÉ había fallado, ni con qué gravedad, ni qué
-- escribió quien estuvo delante, ni si la foto que hizo llegó.
--
-- Dos vistas, y la frontera entre ellas es la de las dos preguntas que se hacen:
--
--   `inspection_overview`      — «¿qué revisiones hay?» Una fila por revisión,
--                                con su sala, su edificio, sus recuentos y un
--                                resumen de lo que falló. Es lo que pinta el
--                                listado completo, que filtra y pagina contra el
--                                servidor porque el histórico entero no cabe en
--                                el dispositivo.
--   `inspection_check_detail`  — «¿qué pasó en ESTA?» Una fila por comprobación,
--                                con el aparato al que apunta, la incidencia que
--                                abrió y cuántas veces había fallado antes.
--
-- Por qué el nombre del aparato se resuelve AQUÍ y el de las comprobaciones de
-- sala no: `asset:<uuid>` solo se puede traducir con la tabla `assets`, y el
-- dispositivo poda los equipos retirados —así que una revisión de hace un año
-- enseñaría `asset:1f2e…` en la mitad de sus filas—. En cambio «Red» y los
-- nombres antiguos («Pantallas», «Botonera») viven en `domain/types.ts` y de ahí
-- no se mueven: duplicar ese vocabulario en SQL es la vía directa a que la misma
-- comprobación se llame de dos maneras según la pantalla.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Los índices que las dos vistas necesitan
--
-- Ninguno existía porque hasta ahora nadie hacía estas dos preguntas: las
-- revisiones se leían siempre por sala, y las incidencias nunca por la revisión
-- de la que nacieron.
-- -----------------------------------------------------------------------------

-- El listado completo ordena por fecha en TODO el campus. Los índices que había
-- empiezan por `room_id` y por `by_user`, que no sirven para eso.
create index if not exists inspections_recientes_idx
  on inspections(occurred_at desc);

-- «¿Qué incidencias abrió esta revisión?» — una por ficha, y sin esto es un
-- recorrido de la tabla entera.
create index if not exists incidents_desde_revision_idx
  on incidents(opened_from_inspection_id)
  where opened_from_inspection_id is not null;

-- -----------------------------------------------------------------------------
-- inspection_overview — una fila por revisión, lista para listar
-- -----------------------------------------------------------------------------

drop view if exists inspection_overview;

create view inspection_overview as
select
  ins.id,
  ins.room_id,
  r.code            as room_code,
  r.name            as room_name,
  r.short_ref,
  z.id              as zone_id,
  z.name            as zone_name,
  b.id              as building_id,
  b.code            as building_code,
  b.name            as building_name,
  -- Reloj del dispositivo: cuándo se revisó el aula de verdad.
  ins.occurred_at,
  -- Reloj del servidor: cuándo llegó. Los dos, porque la diferencia entre ellos
  -- es «esto se hizo en un sótano sin cobertura», y eso explica por qué una
  -- revisión de ayer apareció esta mañana.
  ins.recorded_at,
  ins.status::text  as status,
  ins.overall::text as overall,
  nullif(ins.notes, '') as notes,
  ins.source,
  ins.by_user,
  p.full_name       as who,
  c.total,
  c.ok,
  c.fallos,
  c.na,
  f.fotos,
  g.incidencias,
  g.sin_resolver,
  /*
   * Qué falló, ya resuelto, para que el LISTADO lo diga sin abrir nada.
   *
   * Va como jsonb y no como texto ya montado a propósito: las comprobaciones de
   * sala («Red») y las antiguas («Pantallas») se nombran en el cliente, y una
   * cadena pegada aquí no se puede corregir allí — saldría `red` en minúscula en
   * mitad de una lista de nombres propios. Con la clave y la etiqueta por
   * separado, cada una se resuelve donde vive su vocabulario.
   */
  coalesce(c.fallos_detalle, '[]'::jsonb) as fallos_detalle
from inspections ins
join rooms r     on r.id = ins.room_id
join zones z     on z.id = r.zone_id
join buildings b on b.id = z.building_id
left join profiles p on p.id = ins.by_user
left join lateral (
  select
    count(*)::int                                          as total,
    count(*) filter (where ic.result = 'ok')::int           as ok,
    count(*) filter (where ic.result = 'incidencia')::int   as fallos,
    count(*) filter (where ic.result = 'na')::int           as na,
    jsonb_agg(
      jsonb_build_object(
        'key',   ic.check_key,
        'label', coalesce(a.label, tm.name, t.name)
      )
      order by ic.check_key
    ) filter (where ic.result = 'incidencia')               as fallos_detalle
  from inspection_checks ic
  -- El mismo enganche que abajo, y la misma razón para el patrón estricto: un
  -- `check_key` que no sea exactamente `asset:<uuid>` tiene que dar NULL, no
  -- reventar la vista al intentar convertirlo.
  left join assets a
    on a.id = (substring(lower(ic.check_key)
                 from '^asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'))::uuid
  left join asset_types t  on t.id = a.asset_type_id
  -- Y si el tipo se fusionó, el nombre bueno es el del que lo absorbió.
  left join asset_types tm on tm.id = t.merged_into
  where ic.inspection_id = ins.id
) c on true
left join lateral (
  select count(*)::int as fotos
  from attachments att
  where att.entity_type = 'inspection' and att.entity_id = ins.id
) f on true
left join lateral (
  select
    count(*)::int                                        as incidencias,
    count(*) filter (where i.state <> 'resuelta')::int    as sin_resolver
  from incidents i
  where i.opened_from_inspection_id = ins.id
) g on true;

alter view inspection_overview set (security_invoker = on);

comment on view inspection_overview is
  'Una fila por revisión con su sala, sus recuentos y qué falló: el listado completo de revisiones.';

-- -----------------------------------------------------------------------------
-- inspection_check_detail — una fila por comprobación
--
-- Aquí está la respuesta a «no sabemos lo que ha fallado»: cada fila trae el
-- aparato con su número de serie, la gravedad, la nota que escribió quien estuvo
-- delante, la incidencia que se abrió con ella y cuántas veces había fallado
-- eso mismo antes en esa sala.
-- -----------------------------------------------------------------------------

drop view if exists inspection_check_detail;

create view inspection_check_detail as
select
  ic.id                     as check_id,
  ic.inspection_id,
  ins.room_id,
  ins.occurred_at,
  ic.check_key,
  ic.result::text           as result,
  ic.severity::text         as severity,
  ic.measure,
  ic.measure_unit,
  nullif(ic.note, '')       as note,

  -- El aparato, si la fila es de un aparato. `label` es cómo se llama en ESA
  -- sala («Pantalla 2»); el tipo es el respaldo cuando nadie le puso nombre.
  a.id                      as asset_id,
  coalesce(a.label, tm.name, t.name) as asset_label,
  coalesce(tm.name, t.name)          as type_name,
  a.serial,
  a.model,
  a.status::text            as asset_status,

  -- La incidencia que abrió esta comprobación. Se cruza por revisión Y por
  -- clave porque `opened_from_inspection_id` solo dice de qué revisión nació,
  -- no de qué fila: con cuatro equipos en falla habría cuatro candidatas.
  inc.id                    as incident_id,
  inc.title                 as incident_title,
  inc.state::text           as incident_state,
  inc.severity::text        as incident_severity,
  inc.external_ref          as incident_ref,
  inc.opened_at             as incident_opened_at,
  inc.resolved_at           as incident_resolved_at,
  nullif(inc.resolution, '') as incident_resolution,

  /*
   * Y lo que convierte una lectura en un diagnóstico: cuántas veces había
   * fallado ESTO MISMO en ESTA sala antes de esta revisión.
   *
   * Con el número delante, «el proyector no da imagen» deja de ser un parte
   * suelto y pasa a ser la cuarta vez en seis meses, que es una avería distinta
   * y se arregla de otra manera. Se cuenta contra `incidents`, que es donde vive
   * el histórico, y se corta en `occurred_at`: la ficha de una revisión de enero
   * no puede contar lo que pasó en marzo.
   */
  coalesce(prev.veces, 0)   as fallos_previos,
  prev.ultimo               as fallo_previo_at
from inspection_checks ic
join inspections ins on ins.id = ic.inspection_id
/*
 * `asset:<uuid>` → el aparato.
 *
 * El patrón exige un uuid completo antes de convertir, y no es celo: con un
 * `substring` laxo, un `check_key` raro —una clave antigua, una fila importada—
 * llegaría a `::uuid` como basura y tumbaría la vista entera, o sea la ficha de
 * todas las revisiones, por una sola fila mal formada.
 */
left join assets a
  on a.id = (substring(lower(ic.check_key)
               from '^asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'))::uuid
left join asset_types t  on t.id = a.asset_type_id
left join asset_types tm on tm.id = t.merged_into
left join incidents inc
  on inc.opened_from_inspection_id = ic.inspection_id
 and inc.check_key = ic.check_key
left join lateral (
  select count(*)::int as veces, max(pi.opened_at) as ultimo
  from incidents pi
  where pi.room_id = ins.room_id
    and pi.check_key = ic.check_key
    and pi.opened_at < ins.occurred_at
) prev on true;

alter view inspection_check_detail set (security_invoker = on);

comment on view inspection_check_detail is
  'Una fila por comprobación de una revisión: el aparato, la nota, la incidencia que abrió y sus fallos previos.';

notify pgrst, 'reload schema';
