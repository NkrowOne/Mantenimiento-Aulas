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
--
-- -----------------------------------------------------------------------------
-- Y va DETRÁS de `20260730000700_ficha_de_revision.sql`, que es lo que hace que
-- las dos mitades se lean como una.
--
-- Esta migración se escribió a la vez que la de la ficha, en otra rama, y las dos
-- crearon una vista con el mismo nombre: `inspection_check_detail`. Aplicadas en
-- cualquier orden, la segunda pisaba a la primera y dejaba a media aplicación
-- pidiendo columnas que ya no existían — el fallo más caro de diagnosticar que
-- hay, porque el despliegue va bien y la pantalla se rompe.
--
-- Así que aquí las dos se juntan en una sola definición, superset de las dos
-- (§8), y el listado de revisiones aprende lo que esta migración añade: que una
-- visita corregida no son dos revisiones (§7). La numeración también cambió —el
-- `20260730000400` con el que nació lo ocupa ya la retirada de equipos en
-- `main`—, que es lo que comprueba `npm run check:migraciones`.
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

-- Dos revisiones seguidas con incidencia. Sobre las vigentes: si no, la
-- corrección que dice «en realidad estaba bien» seguiría contando como la mala
-- que reemplaza, y el aviso saldría precisamente por el error ya corregido.
create or replace view alerts_repeat_offenders as
with ranked as (
  select
    i.room_id,
    i.overall,
    row_number() over (partition by i.room_id order by i.occurred_at desc) as rn
  from inspections_vigentes i
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

-- Convertir texto a uuid sin que una clave rara tumbe la vista entera. El
-- `substring` de una clave de comprobación es un uuid por construcción, pero
-- basta una fila importada a mano para que el cast reviente y con él toda la
-- consulta.
create or replace function public.uuid_o_nulo(t text)
returns uuid language plpgsql immutable strict parallel safe as $$
begin
  return t::uuid;
exception when others then
  return null;
end;
$$;

comment on function public.uuid_o_nulo(text) is
  'El uuid que representa ese texto, o NULL si no representa ninguno. Para castear claves de comprobación sin que una fila mal formada rompa la vista.';

-- -----------------------------------------------------------------------------
-- 7 — Y el listado de revisiones aprende que una visita corregida es UNA
--
-- `inspection_overview` la creó la migración anterior para la ficha de cada
-- revisión y para el listado completo. Aquí se le añade la cadena de
-- correcciones, y no es cosmético: sin ella, corregir la revisión del martes
-- pondría DOS filas del martes en la misma lista, con resultados distintos y sin
-- decir cuál vale. O sea el problema que esta migración viene a resolver,
-- trasladado a la pantalla.
--
-- Con estas columnas, cada pantalla decide: la ficha del aula agrupa las
-- versiones en una tarjeta por visita, y el listado marca la corregida y enseña
-- quién la corrigió. Y son una sola vista y no dos —había una `room_inspections`
-- que contaba lo mismo para la ficha del aula— porque dos vistas que cuentan
-- fallos y fotos de la misma tabla acaban contándolos distinto: basta que alguien
-- arregle un `filter` en una de ellas.
--
-- `create or replace` no sabe insertar columnas en medio, así que se recrea. Y
-- las columnas nuevas van al final, que es donde `replace` las admitiría: el
-- orden no lo usa nadie —PostgREST devuelve objetos con nombre— pero mantenerlo
-- estable evita que un `select *` de un script cambie de forma.
-- -----------------------------------------------------------------------------

drop view if exists room_inspections;
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
  -- Reloj del dispositivo: cuándo se revisó el aula de verdad. Una corrección
  -- conserva el de la visita que corrige, y de ahí que la lista se ordene por él.
  ins.occurred_at,
  -- Reloj del servidor: cuándo llegó. La diferencia entre los dos es «esto se
  -- hizo en un sótano sin cobertura».
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
  coalesce(c.fallos_detalle, '[]'::jsonb) as fallos_detalle,

  -- La cadena de correcciones, hacia atrás y hacia delante.
  ins.corrects,
  ins.corrected_at,
  -- De qué día era la visita que corrige. Coinciden salvo que alguien corrigiera
  -- también la fecha, y por eso se dice en vez de suponerse.
  base.occurred_at  as corrige_occurred_at,
  sig.id            as corregida_por,
  sig.corrected_at  as corregida_at,
  sp.full_name      as corregida_por_quien,
  -- La última palabra sobre esa visita: nadie la ha corregido después.
  (sig.id is null)  as vigente
from inspections ins
join rooms r     on r.id = ins.room_id
join zones z     on z.id = r.zone_id
join buildings b on b.id = z.building_id
left join profiles p on p.id = ins.by_user
left join inspections base on base.id = ins.corrects
/*
 * Quién la corrigió, si alguien lo hizo. La más reciente de las correcciones
 * cerradas: dos personas pueden corregir la misma revisión sin cobertura —la
 * interfaz solo ofrece corregir la vigente, así que hacen falta dos dispositivos
 * a la vez— y entonces la que vale es la última.
 */
left join lateral (
  select cor.id, cor.corrected_at, cor.by_user
  from inspections cor
  where cor.corrects = ins.id and cor.status = 'completa'
  order by cor.corrected_at desc nulls last
  limit 1
) sig on true
left join profiles sp on sp.id = sig.by_user
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
  left join assets a on a.id = public.uuid_o_nulo(nullif(substring(ic.check_key from 7), ''))
                    and ic.check_key like 'asset:%'
  left join asset_types t  on t.id = a.asset_type_id
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
  'Una fila por revisión con su sala, sus recuentos, qué falló y su cadena de correcciones: el listado completo y la cabecera de cada ficha.';

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
--
-- Y es la vista que las dos ramas crearon con el mismo nombre, aquí ya fundida en
-- una: lo que necesita leer una revisión pasada desde la ficha del aula —el
-- aparato con su serie, la medida, la nota— más lo que necesita su ficha propia:
-- la incidencia que abrió cada fallo y cuántas veces había fallado eso antes. Una
-- definición, un vocabulario, y ninguna pantalla pidiendo columnas que otra
-- migración le quitó por debajo.
-- -----------------------------------------------------------------------------

-- Se recrea en vez de reemplazarse: `create or replace view` solo sabe añadir
-- columnas al final, y la definición de la migración anterior empezaba por otras.
drop view if exists inspection_check_detail;

create view inspection_check_detail as
select
  c.id,
  -- El mismo dato con el nombre que usa la ficha de la revisión. Dos nombres para
  -- una columna no es bonito, y aquí es lo menos malo: las dos ramas nacieron con
  -- el suyo, y renombrar de golpe convertiría este merge en una cacería de
  -- `c.id` por dos pantallas sin que ninguna de las dos ganara nada.
  c.id             as check_id,
  c.inspection_id,
  i.room_id,
  i.occurred_at,
  c.check_key,
  a.id             as asset_id,
  -- El nombre del aparato en ESTA sala, con el del tipo como respaldo —y siguiendo
  -- la fusión, si su tipo se absorbió en otro—. Antes era `a.label` a secas: un
  -- equipo sin etiqueta propia salía sin nombre y el cliente tenía que recomponerlo.
  coalesce(a.label, tm.name, t.name) as asset_label,
  coalesce(tm.name, t.name)          as asset_type,
  coalesce(tm.name, t.name)          as type_name,
  a.model,
  a.serial,
  a.status::text   as asset_status,
  c.result::text   as result,
  c.severity::text as severity,
  c.measure,
  c.measure_unit,
  nullif(c.note, '') as note,

  -- La incidencia que abrió esta comprobación. Se cruza por revisión Y por clave
  -- porque `opened_from_inspection_id` solo dice de qué revisión nació, no de qué
  -- fila: con cuatro equipos en falla habría cuatro candidatas.
  inc.id                     as incident_id,
  inc.title                  as incident_title,
  inc.state::text            as incident_state,
  inc.severity::text         as incident_severity,
  inc.external_ref           as incident_ref,
  inc.opened_at              as incident_opened_at,
  inc.resolved_at            as incident_resolved_at,
  nullif(inc.resolution, '') as incident_resolution,

  /*
   * Cuántas veces había fallado ESTO MISMO en ESTA sala antes de esta revisión.
   *
   * Con el número delante, «el proyector no da imagen» deja de ser un parte suelto
   * y pasa a ser la cuarta vez en seis meses, que es una avería distinta y se
   * arregla de otra manera. Se corta en `occurred_at`: la ficha de una revisión de
   * enero no puede contar lo que pasó en marzo.
   */
  coalesce(prev.veces, 0)    as fallos_previos,
  prev.ultimo                as fallo_previo_at
from inspection_checks c
join inspections i on i.id = c.inspection_id
left join assets a
  on c.check_key like 'asset:%'
 and a.id = public.uuid_o_nulo(nullif(substring(c.check_key from 7), ''))
left join asset_types t  on t.id = a.asset_type_id
left join asset_types tm on tm.id = t.merged_into
left join incidents inc
  on inc.opened_from_inspection_id = c.inspection_id
 and inc.check_key = c.check_key
left join lateral (
  select count(*)::int as veces, max(pi.opened_at) as ultimo
  from incidents pi
  where pi.room_id = i.room_id
    and pi.check_key = c.check_key
    and pi.opened_at < i.occurred_at
) prev on true;

alter view inspection_check_detail set (security_invoker = on);

comment on view inspection_check_detail is
  'Qué contestó una revisión en cada fila: el aparato con nombre, modelo y serie aunque hoy esté retirado, la incidencia que abrió y sus fallos previos.';

-- -----------------------------------------------------------------------------
-- 9 — La revisión llega entera, también la que se hizo sin cobertura
--
-- Esto no es parte de corregir: es un fallo que corregir deja al descubierto, y
-- que estaba tirando datos desde el primer día.
--
-- `escribir checks del borrador propio` exigía que la revisión estuviera EN
-- BORRADOR para poder escribir sus comprobaciones. Pero la cola de salida sube
-- las cosas en el orden de `ORDER` (outbox.ts): primero la revisión, después sus
-- comprobaciones. En una revisión hecha en un sótano —sin nada subido durante el
-- borrador— la fila que llega primero llega ya CERRADA, y todas sus
-- comprobaciones se estrellaban después contra la política con un 42501. La cola
-- marca cualquier 4xx como rechazado, así que el resultado era una revisión en el
-- servidor con cero comprobaciones y un aviso rojo en el iPad. Medido, no
-- supuesto: es la prueba 56.
--
-- Y en una revisión hecha con cobertura pasaba la versión leve del mismo
-- problema: al cerrar se reenvían todas las comprobaciones, las que ya habían
-- subido incluidas, y ese reenvío idéntico también se rechazaba. Los datos
-- estaban, pero el técnico veía «N sin enviar. Avisa a administración» después de
-- cada aula.
--
-- La corrección separa las dos cosas que la política mezclaba:
--
--   PERMISO      quién puede escribir las comprobaciones de una revisión: su
--                autor y el supervisor. Ya no depende del estado.
--   INMUTABILIDAD que lo escrito no se pueda cambiar. Eso pasa a un trigger, que
--                es donde ya vive la garantía equivalente de `inspections`.
--
-- El trigger deja pasar el reenvío idéntico —lo que produce una cola idempotente
-- por diseño— y para todo lo demás en cuanto la revisión está cerrada. Ojo a lo
-- que esto ENDURECE: hasta ahora un supervisor podía reescribir las
-- comprobaciones de una revisión cerrada aunque la fila de la revisión estuviera
-- congelada, o sea que la puerta de atrás estaba abierta justo por donde el
-- diseño decía que estaba cerrada. Ya no. Y ahora hay una salida legítima para
-- eso: corregir la revisión.
--
-- Nota del merge: `main` ya había atacado la primera mitad de esto por su cuenta,
-- en `20260730000600_checks_de_revision_cerrada.sql`, partiendo la política en
-- tres —una por operación— y dejando el INSERT sin depender del estado. Este
-- bloque va más lejos: mueve la inmutabilidad a un trigger y cierra la puerta que
-- allí quedaba abierta, la de un supervisor reescribiendo lo comprobado de una
-- revisión congelada.
--
-- Y por eso hay que BORRAR las tres de allí, no solo la vieja. En RLS varias
-- políticas del mismo comando se suman con OR: dejar puesta la de `main` que
-- permite el UPDATE al supervisor anularía en la práctica el endurecimiento de
-- abajo, y peor aún, lo haría sin que nada lo dijera. Las políticas se leen de una
-- en una; el permiso efectivo es la unión, y eso no se ve leyendo un fichero.
-- -----------------------------------------------------------------------------

drop policy if exists "escribir checks del borrador propio" on inspection_checks;
drop policy if exists "insertar checks de revision propia" on inspection_checks;
drop policy if exists "editar checks del borrador propio" on inspection_checks;
drop policy if exists "borrar checks del borrador propio" on inspection_checks;

drop policy if exists "escribir las comprobaciones de la revisión propia" on inspection_checks;
create policy "escribir las comprobaciones de la revisión propia" on inspection_checks
  for insert to authenticated
  with check (
    exists (
      select 1 from inspections i
      where i.id = inspection_id
        and (i.by_user = (select auth.uid()) or public.is_supervisor())
    )
  );

drop policy if exists "reenviar las comprobaciones de la revisión propia" on inspection_checks;
create policy "reenviar las comprobaciones de la revisión propia" on inspection_checks
  for update to authenticated
  using (
    exists (
      select 1 from inspections i
      where i.id = inspection_id
        and (i.by_user = (select auth.uid()) or public.is_supervisor())
    )
  )
  with check (
    exists (
      select 1 from inspections i
      where i.id = inspection_id
        and (i.by_user = (select auth.uid()) or public.is_supervisor())
    )
  );

-- Borrar sí sigue atado al borrador: quitar una fila de una revisión cerrada no
-- es un reenvío ni una corrección, es hacerla desaparecer.
drop policy if exists "borrar comprobaciones del borrador propio" on inspection_checks;
create policy "borrar comprobaciones del borrador propio" on inspection_checks
  for delete to authenticated
  using (
    exists (
      select 1 from inspections i
      where i.id = inspection_id
        and i.status = 'borrador'
        and (i.by_user = (select auth.uid()) or public.is_supervisor())
    )
  );

create or replace function public.freeze_checks_of_completed()
returns trigger language plpgsql as $$
declare
  cerrada boolean;
  fila    inspection_checks;
begin
  fila := coalesce(new, old);

  select i.status = 'completa' into cerrada
    from inspections i where i.id = fila.inspection_id;

  -- Mientras la revisión sea un borrador, sus comprobaciones se tocan sin más:
  -- es literalmente lo que hace el formulario a cada toque.
  if not cerrada then return coalesce(new, old); end if;

  if public.auth_role() = 'admin' then return coalesce(new, old); end if;

  -- El reenvío idéntico de la cola de salida. Es lo que ocurre al cerrar la
  -- revisión —se manda todo otra vez, a propósito, como última oportunidad— y
  -- también cuando una respuesta se pierde y el reintento repite la fila.
  if tg_op = 'UPDATE' and new is not distinct from old then
    return new;
  end if;

  raise exception 'Las comprobaciones de una revisión cerrada no se cambian (revisión %)', fila.inspection_id
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists inspection_checks_freeze on inspection_checks;
create trigger inspection_checks_freeze
  before update or delete on inspection_checks
  for each row execute function public.freeze_checks_of_completed();

notify pgrst, 'reload schema';
