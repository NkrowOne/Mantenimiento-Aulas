-- =============================================================================
-- Corregir una revisión, en vez de repetirla
--
-- Lo que faltaba, dicho como lo dice quien lo sufre: «me he equivocado en la
-- revisión de esta mañana y la única forma de arreglarlo es hacer otra». Con 276
-- aulas por ronda, eso son veinte revisiones nuevas al mes que no son visitas
-- nuevas: son la misma visita apuntada varias veces. Y cada una cuenta en el
-- panel, cuenta en la fiabilidad de la sala, cuenta en el informe del viernes y
-- mueve la fecha de «última revisión» — así que la aplicación acaba diciendo que
-- el aula se revisó cuatro veces el martes.
--
-- LA DECISIÓN DE FONDO: una corrección **no modifica** la revisión anterior.
-- Nace como una fila nueva que apunta a ella (`corrects`) y la REEMPLAZA a
-- efectos de todo lo que se cuenta. La original se queda intacta, legible y
-- fechada, que es lo que hace que el histórico siga valiendo como registro de
-- auditoría: nadie puede reescribir lo que dijo, solo decir algo distinto encima
-- y dejar constancia de las dos cosas.
--
-- Eso es también lo que permite que el congelado siga en pie tal cual. El
-- trigger `inspections_freeze` no se toca: una revisión cerrada sigue siendo
-- inmutable para todo el mundo salvo un administrador. Corregir no es editar.
--
-- Y la corrección **conserva `occurred_at`**, la fecha de la visita. Es la pieza
-- que resuelve el problema del enunciado: el aula se revisó el martes, aunque el
-- error se arreglara el jueves. Sin eso, corregir una revisión de hace tres
-- meses la traería a hoy y el aula aparecería como recién revisada por haber
-- corregido una errata. Cuándo se corrigió va aparte, en `corrected_at`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — Las dos columnas
-- -----------------------------------------------------------------------------

alter table inspections
  add column if not exists corrects      uuid references inspections(id) on delete restrict,
  add column if not exists corrected_at  timestamptz;

comment on column inspections.corrects is
  'A qué revisión reemplaza esta. NULL en una revisión normal. La original no se modifica nunca: se queda como estaba y esta pasa a ser la vigente.';

comment on column inspections.corrected_at is
  'Cuándo se hizo la corrección. Separado de `occurred_at`, que sigue siendo la fecha de la visita al aula.';

-- `on delete restrict` y no `set null`: si la original desapareciera, la
-- corrección quedaría flotando sin decir qué corrige y el histórico contaría la
-- misma visita dos veces. En la práctica no se borran revisiones —archivar una
-- sala ya lo comprueba—, y esto es la garantía de que sigue siendo así.

alter table inspections
  drop constraint if exists inspections_correccion_fechada;
alter table inspections
  add constraint inspections_correccion_fechada
  check ((corrects is null) = (corrected_at is null));

-- La consulta que se hace en todas las vistas de abajo es «¿hay alguna
-- corrección que apunte a esta revisión?». Sin índice es un recorrido de la
-- tabla por cada fila de `room_overview`, o sea 276 veces por descarga.
create index if not exists inspections_corrects_idx
  on inspections(corrects) where corrects is not null;

-- Y el de la otra pregunta que hace la ficha por cada revisión que enseña:
-- «¿cuántas incidencias abrió esta?». Sin él es un recorrido de `incidents` por
-- fila de `room_inspections`, y `incidents_room_idx` no sirve porque la columna
-- por la que se busca es otra.
create index if not exists incidents_desde_revision_idx
  on incidents(opened_from_inspection_id) where opened_from_inspection_id is not null;

-- -----------------------------------------------------------------------------
-- 2 — Lo que una corrección tiene que cumplir
--
-- Se valida en la base y no solo en el cliente porque las tres reglas son de las
-- que rompen los números en silencio: una corrección de otra sala metería una
-- revisión ajena en el recuento de la sala, una corrección de un borrador
-- reemplazaría algo que nunca se cerró, y una que se corrija a sí misma dejaría
-- una revisión que se tapa sola y desaparece de todos los listados.
-- -----------------------------------------------------------------------------

create or replace function public.validar_correccion()
returns trigger language plpgsql as $$
declare
  base inspections;
begin
  -- A qué revisión corrige se decide al crearla y no se cambia después. Es lo
  -- que hace imposible un ciclo: la fila a la que apunta ya existía, y su propia
  -- cadena está cerrada desde que se insertó.
  --
  -- El `if` va anidado y no como un `and` en una sola condición: PL/pgSQL manda
  -- la expresión entera a evaluar con las variables sustituidas, así que no hay
  -- cortocircuito y `old.corrects` en un INSERT —donde OLD no existe— revienta
  -- con «record "old" is not assigned yet». Es decir, dejaría de poderse crear
  -- una revisión.
  if tg_op = 'UPDATE' then
    if new.corrects is distinct from old.corrects then
      raise exception 'Una corrección no puede cambiar a qué revisión corrige (id=%)', new.id
        using errcode = 'check_violation';
    end if;
  end if;

  if new.corrects is null then
    return new;
  end if;

  if new.corrects = new.id then
    raise exception 'Una revisión no se corrige a sí misma (id=%)', new.id
      using errcode = 'check_violation';
  end if;

  select * into base from inspections where id = new.corrects;

  -- La clave ajena diría lo mismo, pero lo diría después y con un mensaje que no
  -- explica nada. Los errores de la cola de salida los acaba leyendo un técnico
  -- en la pantalla de pendientes.
  if not found then
    raise exception 'La revisión que se pretende corregir no existe (id=%)', new.corrects
      using errcode = 'foreign_key_violation';
  end if;

  if base.status <> 'completa' then
    raise exception 'Solo se corrige una revisión cerrada; esa sigue en borrador (id=%)', base.id
      using errcode = 'check_violation';
  end if;

  if base.room_id <> new.room_id then
    raise exception 'Una corrección pertenece a la misma sala que la revisión que corrige (id=%)', new.id
      using errcode = 'check_violation';
  end if;

  /*
   * Y conserva la fecha de la visita.
   *
   * Es LA invariante de todo esto —el aula se revisó el día que se revisó— y
   * hasta aquí solo la cumplía el cliente. Escrita únicamente en el cliente, un
   * dispositivo con el reloj mal puesto, una versión antigua de la aplicación o
   * cualquier cosa que entre por la API bastaría para mover la fecha de «última
   * revisión» de la sala corrigiendo una errata: la aula saldría revisada hoy sin
   * que nadie haya entrado en ella, y el número que decide qué se revisa mañana
   * dejaría de ser cierto.
   *
   * Se corrige en vez de rechazarse porque el trigger es `before` y porque no hay
   * nada que decidir: la fecha correcta se sabe, es la de la revisión que se
   * corrige. Rechazar solo convertiría un desajuste de relojes en una entrada
   * rechazada en la cola de alguien.
   */
  new.occurred_at := base.occurred_at;

  return new;
end;
$$;

drop trigger if exists inspections_correccion on inspections;
create trigger inspections_correccion
  before insert or update on inspections
  for each row execute function public.validar_correccion();

-- -----------------------------------------------------------------------------
-- 3 — Quién puede corregir
--
-- Cualquiera del equipo, y no solo quien la firmó. El caso real es el compañero
-- que abre el aula al día siguiente y ve que la revisión de ayer dice que el
-- proyector va bien: si solo pudiera corregirla su autor, la única salida sería
-- —otra vez— una revisión nueva.
--
-- Es seguro porque corregir no borra nada: la original sigue ahí con su fecha y
-- su firma, y la corrección lleva la de quien la hizo. Nadie puede cambiar lo
-- que otro dijo; solo añadir lo que vio encima, y las dos versiones se leen.
--
-- No hace falta política nueva: `tecnico crea sus revisiones` ya permite el
-- INSERT con `by_user = auth.uid()`, y `tecnico edita su borrador` deja
-- cerrarla. Se documenta aquí porque la ausencia de una política es
-- indistinguible de un olvido.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 4 — Las revisiones que cuentan
--
-- Una sola vista, y de ella cuelga todo lo demás. Vigente = cerrada y sin una
-- corrección encima.
--
-- Que se define por «no existe quien la corrija» y no recorriendo la cadena
-- hacia adelante es a propósito: la definición recursiva obligaría a resolver el
-- árbol entero de revisiones para contestar por una sala, y esto se consulta 276
-- veces en cada descarga del maestro.
--
-- El caso que esta definición no cubre —dos personas corrigiendo la MISMA
-- revisión sin cobertura, que deja dos vigentes— se resuelve contando visitas y
-- no filas: `count(distinct coalesce(corrects, id))`. Las dos correcciones
-- apuntan a la misma original, así que la visita se cuenta una vez. Y la
-- interfaz solo ofrece corregir la versión vigente, con lo que hacen falta dos
-- dispositivos a la vez para llegar ahí.
--
-- Lo que ese recuento agrupa es **un eslabón, no la cadena entera**, y conviene
-- que quede dicho: si a esas dos correcciones simultáneas alguien corrige después
-- una de ellas, las dos vigentes que quedan ya no comparten padre y la visita se
-- cuenta dos veces. Hace falta una bifurcación Y una corrección encima de ella,
-- o sea dos dispositivos a la vez y un tercer intento después; cerrarlo del todo
-- pide guardar la raíz de la cadena en su propia columna, y no parece que ese
-- caso lo justifique todavía.
-- -----------------------------------------------------------------------------

create or replace view inspections_vigentes as
select i.*
from inspections i
where i.status = 'completa'
  and not exists (
    select 1 from inspections c
    where c.corrects = i.id and c.status = 'completa'
  );

alter view inspections_vigentes set (security_invoker = on);

comment on view inspections_vigentes is
  'Las revisiones cerradas que no han sido corregidas: la última palabra sobre cada visita. Todo lo que cuenta revisiones cuenta aquí.';

-- -----------------------------------------------------------------------------
-- 5 — Y las vistas que contaban revisiones pasan a contar visitas
-- -----------------------------------------------------------------------------

-- La sala: cuándo se revisó de verdad, y cómo salió la versión que vale. El
-- desempate por `corrected_at` solo importa en el caso de las dos correcciones
-- simultáneas: gana la última, que es la única respuesta defendible.
create or replace view room_overview as
select
  r.id                as room_id,
  r.code              as room_code,
  r.name              as room_name,
  r.kind,
  r.capabilities,
  r.projector_hours,
  r.lamp_pct,
  z.id                as zone_id,
  z.name              as zone_name,
  b.id                as building_id,
  b.code              as building_code,
  b.name              as building_name,
  b.sort_order        as building_order,
  z.sort_order        as zone_order,
  li.occurred_at      as last_inspection_at,
  li.overall          as last_inspection_overall,
  coalesce(oi.open_count, 0)::int as open_incidents,
  r.short_ref,
  lv.occurred_at      as last_inventory_at
from rooms r
join zones z     on z.id = r.zone_id
join buildings b on b.id = z.building_id
left join lateral (
  select i.occurred_at, i.overall
  from inspections_vigentes i
  where i.room_id = r.id
  order by i.occurred_at desc, i.corrected_at desc nulls first
  limit 1
) li on true
left join lateral (
  select v.occurred_at
  from room_inventories v
  where v.room_id = r.id
  order by v.occurred_at desc
  limit 1
) lv on true
left join lateral (
  select count(*) as open_count
  from incidents inc
  where inc.room_id = r.id and inc.state not in ('resuelta', 'borrador')
) oi on true
where r.active;

alter view room_overview set (security_invoker = on);

-- La fiabilidad: `revisiones` es el contexto que decide si el índice significa
-- algo («con cuántos registros estoy hablando»). Contando correcciones, un aula
-- con una revisión corregida tres veces parecería tener cuatro visitas y el
-- número se daría por fiable sin serlo.
create or replace view room_reliability as
with penalizacion as (
  select
    i.room_id,
    case i.kind
      when 'incidencia'  then 1.0
      when 'observacion' then 0.25
      else 0.0                      -- solicitud: trabajo pedido, no un fallo
    end
    * case i.severity when 'alta' then 3.0 when 'media' then 2.0 else 1.0 end
    * greatest(
        0.0,
        1.0 - extract(epoch from (now() - i.opened_at)) / (365 * 86400)
      ) as puntos,
    i.kind
  from incidents i
  where i.state <> 'borrador'
    and i.opened_at > now() - interval '1 year'
),
agregado as (
  select
    room_id,
    coalesce(sum(puntos), 0)                                  as puntos,
    count(*) filter (where kind = 'incidencia')::int          as incidencias,
    count(*) filter (where kind = 'observacion')::int         as observaciones,
    count(*) filter (where kind = 'solicitud')::int           as solicitudes
  from penalizacion
  group by room_id
),
revisiones as (
  select room_id, count(distinct coalesce(corrects, id))::int as n
  from inspections_vigentes
  where occurred_at > now() - interval '1 year'
  group by room_id
)
select
  r.id                                                        as room_id,
  greatest(0, 100 - round(coalesce(a.puntos, 0) * 6))::int     as score,
  coalesce(a.incidencias, 0)                                  as incidencias,
  coalesce(a.observaciones, 0)                                as observaciones,
  coalesce(a.solicitudes, 0)                                  as solicitudes,
  coalesce(v.n, 0)                                            as revisiones,
  (coalesce(v.n, 0) + coalesce(a.incidencias, 0) + coalesce(a.observaciones, 0)) >= 3
                                                              as hay_datos
from rooms r
left join agregado a  on a.room_id = r.id
left join revisiones v on v.room_id = r.id
where r.active;

alter view room_reliability set (security_invoker = on);

-- Y de paso, la otra alerta que cuenta mal, que no es de correcciones pero se ve
-- desde el mismo azulejo del panel y confunde la misma pregunta («¿cuántas
-- incidencias hay?»).
--
-- `alerts_stale_incidents` cuenta como avería estancada cualquier fila que no
-- esté resuelta, y eso mete dentro dos cosas que no lo son: los **borradores**
-- —que la pestaña de Incidencias esconde a propósito, así que el supervisor iba
-- a buscarlos y no estaban— y las **observaciones** importadas del Excel, que son
-- notas de seguimiento y llevan abiertas desde 2025 por definición. Con 283
-- incidencias importadas eso pintaba el panel en rojo por trabajo que nadie tiene
-- que hacer, que es la forma más rápida de que un aviso deje de mirarse.
--
-- Y el título va con red: un borrador puede no tenerlo —basta la sala para
-- guardar— y el panel lo pintaba tal cual, así que la lista de estancadas tenía
-- un renglón con el contador de días en rojo y nada al lado.
create or replace view alerts_stale_incidents as
select
  i.id,
  coalesce(i.title, '(sin describir)') as title,
  i.severity,
  i.opened_at,
  i.state,
  ro.building_code, ro.room_code, ro.room_name,
  extract(day from now() - i.opened_at)::int as days_open
from incidents i
left join room_overview ro on ro.room_id = i.room_id
where i.state not in ('resuelta', 'borrador')
  and i.kind <> 'observacion'
  and i.opened_at < now() - interval '7 days'
order by i.opened_at asc;

alter view alerts_stale_incidents set (security_invoker = on);

-- Dos revisiones seguidas con incidencia. Sobre las vigentes: si no, la
-- corrección que dice «en realidad estaba bien» seguiría contando como la mala
-- que reemplaza, y el aviso saldría precisamente por el error ya corregido.
-- Y se numera por VISITA, no por fila: en el caso raro de dos correcciones
-- simultáneas de la misma revisión hay dos vigentes con la misma fecha, y
-- numerando filas la primera y la segunda serían la misma visita — el aviso
-- saltaría con una sola revisión mala en vez de con dos seguidas.
create or replace view alerts_repeat_offenders as
with por_visita as (
  select distinct on (i.room_id, coalesce(i.corrects, i.id))
    i.room_id, i.overall, i.occurred_at
  from inspections_vigentes i
  order by i.room_id, coalesce(i.corrects, i.id), i.corrected_at desc nulls last
),
ranked as (
  select
    room_id,
    overall,
    row_number() over (partition by room_id order by occurred_at desc) as rn
  from por_visita
)
select ro.room_id, ro.building_code, ro.room_code, ro.room_name
from ranked r1
join ranked r2 on r2.room_id = r1.room_id and r2.rn = 2
join room_overview ro on ro.room_id = r1.room_id
where r1.rn = 1
  and r1.overall = 'con_incidencias'
  and r2.overall = 'con_incidencias';

alter view alerts_repeat_offenders set (security_invoker = on);

-- -----------------------------------------------------------------------------
-- 6 — La línea de tiempo enseña la versión que vale
--
-- Se reescribe entera porque una vista no se puede parchear por trozos. Lo único
-- que cambia es la rama de las revisiones: sale de `inspections_vigentes` —así la
-- corregida no aparece dos veces— y una corrección se marca como tal en
-- `subkind`, que es la palabra que la lista ya sabe pintar al lado del título.
-- -----------------------------------------------------------------------------

create or replace view room_timeline as
with eventos as (

-- Incidencias, solicitudes y observaciones: la apertura --------------------
select
  i.id                                  as ref_id,
  case i.kind
    when 'solicitud'   then 'solicitud'
    when 'observacion' then 'observacion'
    else 'incidencia'
  end                                   as kind,
  i.state::text                         as subkind,
  i.room_id,
  i.opened_at                           as at,
  coalesce(i.title, '(sin describir)')  as title,
  nullif(i.description, '')             as detail,
  null::int                             as qty,
  i.opened_by                           as by_user,
  i.external_ref                        as ref,
  i.state::text                         as state
from incidents i

union all

-- …y el cierre, como fila propia.
select
  i.id,
  'incidencia',
  'resuelta',
  i.room_id,
  i.resolved_at,
  'Resuelta: ' || coalesce(i.title, '(sin describir)'),
  nullif(i.resolution, ''),
  null::int,
  i.resolved_by,
  i.external_ref,
  'resuelta'
from incidents i
where i.resolved_at is not null and i.kind = 'incidencia'

union all

-- Revisiones ----------------------------------------------------------------
select
  ins.id,
  case ins.overall when 'ok' then 'revision_ok' else 'revision_ko' end,
  -- La palabra que distingue una revisión de una corrección. `status` aquí es
  -- siempre 'completa' —la vista solo trae cerradas— así que no se pierde nada.
  case when ins.corrects is null then ins.status::text else 'corregida' end,
  ins.room_id,
  ins.occurred_at,
  case ins.overall
    when 'ok' then 'Revisión completa sin incidencias'
    else 'Revisión con incidencias'
  end,
  nullif(ins.notes, ''),
  null::int,
  ins.by_user,
  null,
  ins.status::text
from inspections_vigentes ins

union all

-- Material ------------------------------------------------------------------
select
  sm.id,
  'material',
  sm.kind::text,
  sm.room_id,
  sm.occurred_at,
  si.name,
  nullif(sm.note, ''),
  sm.qty,
  sm.by_user,
  null,
  sm.kind::text
from stock_movements sm
join stock_items si on si.id = sm.stock_item_id
where sm.room_id is not null

union all

-- Equipos: el alta ----------------------------------------------------------
select
  a.id,
  'equipo',
  'alta',
  a.room_id,
  a.created_at,
  coalesce(a.label, t.name, 'Equipo'),
  nullif(concat_ws(' · ', a.model, a.serial), ''),
  null::int,
  a.created_by,
  a.serial,
  a.status::text
from assets a
left join asset_types t on t.id = a.asset_type_id
where a.room_id is not null and a.created_by is not null

union all

-- Equipos: lo que les pasa después ------------------------------------------
select
  ae.id,
  'equipo',
  ae.kind::text,
  coalesce(ae.room_id, a.room_id),
  ae.occurred_at,
  coalesce(a.label, t.name, 'Equipo'),
  nullif(ae.meta ->> 'nota', ''),
  null::int,
  ae.by_user,
  a.serial,
  ae.kind::text
from asset_events ae
join assets a on a.id = ae.asset_id
left join asset_types t on t.id = a.asset_type_id
where coalesce(ae.room_id, a.room_id) is not null

union all

-- El levantamiento ----------------------------------------------------------
select
  v.id,
  'inventario',
  'levantamiento',
  v.room_id,
  v.occurred_at,
  'Inventario confirmado',
  coalesce(nullif(v.note, ''), v.asset_count || ' equipos en la sala'),
  null::int,
  v.by_user,
  null,
  'levantamiento'
from room_inventories v

)
select
  e.ref_id,
  e.kind,
  e.subkind,
  e.room_id,
  e.at,
  e.title,
  e.detail,
  e.qty,
  e.by_user,
  e.ref,
  e.state,
  p.full_name as who,
  r.code      as room_code,
  r.name      as room_name,
  z.building_id,
  b.code      as building_code
from eventos e
join rooms r     on r.id = e.room_id
join zones z     on z.id = r.zone_id
join buildings b on b.id = z.building_id
left join profiles p on p.id = e.by_user;

alter view room_timeline set (security_invoker = on);

-- -----------------------------------------------------------------------------
-- 7 — Lo que la ficha de la sala necesita para poder preguntar hacia atrás
--
-- «Qué se comprobó aquel día, qué se apuntó, qué fotos hay y quién lo firmó.»
-- Hasta ahora eso estaba guardado y no se leía en ningún sitio: la nota de la
-- revisión vivía en `inspections.notes`, las fotos en un bucket privado que
-- ninguna pantalla abría, y el resultado por equipo dentro de
-- `inspection_checks`, alcanzable únicamente por quien supiera escribir SQL.
--
-- Va en el servidor y no en el cliente por lo de siempre: resuelve los nombres
-- —quién firmó, cómo se llama el aparato— con un `join` en vez de con cinco
-- consultas, y cuenta fotos, fallos e incidencias sin bajarse las filas.
-- -----------------------------------------------------------------------------

create or replace view room_inspections as
select
  i.id,
  i.room_id,
  i.occurred_at,
  i.recorded_at,
  i.overall::text                     as overall,
  i.notes,
  i.by_user,
  p.full_name                         as who,
  i.corrects,
  i.corrected_at,
  -- De qué fecha era la visita que corrige. La corrección conserva
  -- `occurred_at`, así que coinciden salvo que alguien corrigiera también el día.
  base.occurred_at                    as corrige_occurred_at,
  sig.id                              as corregida_por,
  sig.corrected_at                    as corregida_at,
  sp.full_name                        as corregida_por_quien,
  (sig.id is null)                    as vigente,
  coalesce(k.total, 0)                as comprobaciones,
  coalesce(k.fallos, 0)               as fallos,
  coalesce(k.no_aplica, 0)            as no_aplica,
  coalesce(f.fotos, 0)                as fotos,
  coalesce(inc.abiertas, 0)           as incidencias
from inspections i
left join profiles p on p.id = i.by_user
left join inspections base on base.id = i.corrects
left join lateral (
  select c.id, c.corrected_at, c.by_user
  from inspections c
  where c.corrects = i.id and c.status = 'completa'
  order by c.corrected_at desc nulls last
  limit 1
) sig on true
left join profiles sp on sp.id = sig.by_user
left join lateral (
  select
    count(*)::int                                            as total,
    count(*) filter (where c.result = 'incidencia')::int     as fallos,
    count(*) filter (where c.result = 'na')::int             as no_aplica
  from inspection_checks c
  where c.inspection_id = i.id
) k on true
left join lateral (
  select count(*)::int as fotos
  from attachments a
  where a.entity_type = 'inspection' and a.entity_id = i.id
) f on true
left join lateral (
  select count(*)::int as abiertas
  from incidents x
  where x.opened_from_inspection_id = i.id and x.state <> 'borrador'
) inc on true
where i.status = 'completa';

alter view room_inspections set (security_invoker = on);

comment on view room_inspections is
  'Las revisiones cerradas de una sala con su resumen: quién, cómo salió, cuántos fallos, cuántas fotos y si alguien la corrigió después.';

-- -----------------------------------------------------------------------------
-- 8 — Y el detalle: qué dijo la revisión de cada aparato
--
-- El identificador de un aparato es lo único que el cliente NO puede traducir a
-- un nombre: el espejo local solo guarda los equipos vivos, así que una revisión
-- de hace un año que hablaba de un proyector ya retirado se leería como
-- `asset:018f2c…`. Aquí sale con su etiqueta, su modelo y su número de serie.
--
-- El vocabulario fijo —«Red»— se queda en el cliente, que ya lo tiene y ya sabe
-- traducir también las comprobaciones de antes del inventario. Cada uno resuelve
-- lo que solo él sabe.
-- -----------------------------------------------------------------------------

-- Convertir texto a uuid sin que una clave rara tumbe la vista entera. El
-- `substring` de una clave de comprobación es un uuid por construcción, pero
-- basta una fila importada a mano para que el cast reviente y con él toda la
-- consulta.
--
-- Comprueba la forma y luego castea, **sin bloque de excepciones**, y eso no es
-- una cuestión de estilo: capturar la excepción abre una subtransacción, y una
-- subtransacción está prohibida dentro de un plan paralelo. Con la tabla de
-- comprobaciones a tamaño de un curso —200.000 filas, 21 MB— el planificador
-- reparte `inspection_check_detail` entre dos trabajadores y la función que estaba
-- ahí para que una clave rara no rompiera la vista era justo la que la rompía:
-- Postgres aborta la consulta diciendo que no se puede abrir una subtransacción
-- dentro de una operación paralela, y el aviso no menciona ni la vista ni el
-- paralelismo.
--
-- (El mensaje exacto no se copia aquí, ni de ejemplo: el servidor registra estas
-- migraciones enteras en su log, así que un texto que imite un fallo reaparece en
-- cualquier búsqueda que se haga sobre ese log después. Ya costó una vuelta de
-- diagnóstico en este proyecto, y está contado en `20260730000600`.)
--
-- No salía con un rol normal por casualidad —la RLS mete `auth_role()`, que es
-- `parallel unsafe`, y eso serializaba el plan—, así que aparecía únicamente
-- desde el worker de informes y desde `psql`, que se saltan la RLS. Medido, no
-- supuesto.
create or replace function public.uuid_o_nulo(t text)
returns uuid language sql immutable strict parallel safe as $$
  select case
    when t ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then t::uuid
  end
$$;

comment on function public.uuid_o_nulo(text) is
  'El uuid que representa ese texto, o NULL si no representa ninguno. Para castear claves de comprobación sin que una fila mal formada rompa la vista.';

create or replace view inspection_check_detail as
select
  c.id,
  c.inspection_id,
  i.room_id,
  c.check_key,
  a.id             as asset_id,
  a.label          as asset_label,
  t.name           as asset_type,
  a.model,
  a.serial,
  a.status::text   as asset_status,
  c.result::text   as result,
  c.severity::text as severity,
  c.measure,
  c.measure_unit,
  c.note
from inspection_checks c
join inspections i on i.id = c.inspection_id
left join assets a
  on c.check_key like 'asset:%'
 and a.id = public.uuid_o_nulo(nullif(substring(c.check_key from 7), ''))
left join asset_types t on t.id = a.asset_type_id;

alter view inspection_check_detail set (security_invoker = on);

comment on view inspection_check_detail is
  'Qué contestó una revisión en cada fila, con el aparato resuelto a nombre, modelo y serie aunque hoy esté retirado.';

notify pgrst, 'reload schema';
