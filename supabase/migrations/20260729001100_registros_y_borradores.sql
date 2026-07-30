-- =============================================================================
-- Los tres tipos de registro, y el borrador que solo necesita la sala
--
-- El prototipo aprobado tiene una pieza que aquí nunca llegó: la ficha de sala
-- deja registrar SIN que nada haya fallado, y con tres tipos distintos.
--
--   incidencia  — algo está roto.
--   solicitud   — «instalar cámara y micrófono». Trabajo pedido, NO un fallo.
--                 No debe penalizar a la sala, o las mejor atendidas saldrían
--                 como las peores solo por estar bien atendidas, y el ranking
--                 acabaría premiando no registrar nada.
--   observacion — «soporte del altavoz izquierdo flojo», «pizarra abombada».
--                 Hoy eso vive en una columna de texto libre del Excel y no se
--                 le sigue la pista. Pesa mucho menos que una avería.
--
-- Y el estado `borrador` (que añade la migración anterior), que es lo que
-- permite guardar de pie en un pasillo aportando únicamente la sala. Lo demás se
-- completa después desde la bandeja. Sin un sitio donde se acumule lo aplazado,
-- «lo relleno luego» acaba siendo «no se rellenó nunca» — que es exactamente el
-- problema del Excel del que se venía huyendo.
-- =============================================================================

create type incident_kind as enum ('incidencia', 'solicitud', 'observacion');

alter table incidents
  add column kind incident_kind not null default 'incidencia';

-- Un borrador todavía puede no tener título: basta la sala. La restricción de
-- abajo es la que impide que salga de borrador sin él.
alter table incidents
  alter column title drop not null;

-- Salir de borrador exige título; el código de ticket sigue siendo opcional,
-- porque una observación no genera ticket externo en ningún sitio.
alter table incidents
  add constraint incidents_borrador_o_con_titulo
  check (state = 'borrador' or (title is not null and length(btrim(title)) > 0));

-- -----------------------------------------------------------------------------
-- El permiso que lo habría bloqueado en silencio
--
-- «personal abre incidencias» exigía `state = 'abierta'` en su `with check`, así
-- que insertar un borrador habría fallado con un 42501 que el técnico vería como
-- «rechazado» y nada más. Se sustituye por la versión que admite los dos estados
-- de entrada; los demás —en curso, resuelta— siguen siendo de supervisor.
-- -----------------------------------------------------------------------------
drop policy "personal abre incidencias" on incidents;

drop policy if exists "personal abre incidencias" on incidents;
create policy "personal abre incidencias" on incidents
  for insert to authenticated
  with check (public.is_staff() and state in ('abierta', 'borrador'));

/*
 * Y poder terminar el propio borrador.
 *
 * Sin esto se podía crear el borrador y no completarlo nunca: la única política
 * de UPDATE era «supervisor gestiona incidencias». La bandeja existe justamente
 * para que quien lo abrió lo despache luego desde el escritorio, así que tiene
 * que poder hacerlo.
 *
 * El `using` acota lo que puede tocar a sus propios borradores; el `with check`
 * le deja sacarlo de borrador pero no darlo por resuelto — cerrar sigue siendo
 * de supervisor.
 */
drop policy if exists "tecnico completa su borrador" on incidents;
create policy "tecnico completa su borrador" on incidents
  for update to authenticated
  using (public.is_staff() and opened_by = (select auth.uid()) and state = 'borrador')
  with check (opened_by = (select auth.uid()) and state in ('borrador', 'abierta'));

-- La bandeja busca por autor y estado, y el orden es por antigüedad: las más
-- viejas primero, que son las que corren peligro de no completarse nunca.
create index incidents_borradores_idx on incidents(opened_by, state, opened_at);

-- -----------------------------------------------------------------------------
-- Lo que la ficha de sala necesita saber, resuelto por el servidor
--
-- La ficha muestra el historial de una sala mezclando revisiones e incidencias
-- en una sola línea de tiempo. Hacerlo en el cliente obligaría a bajarse el
-- histórico entero de las dos tablas para pintar diez filas de una sala.
-- -----------------------------------------------------------------------------
create view room_timeline as
select
  i.room_id,
  i.opened_at                         as at,
  case i.kind
    when 'solicitud'   then 'solicitud'
    when 'observacion' then 'observacion'
    else 'incidencia'
  end                                  as kind,
  coalesce(i.title, '(sin describir)') as title,
  i.external_ref                       as ref,
  p.full_name                          as who,
  i.state::text                        as state
from incidents i
left join profiles p on p.id = i.opened_by

union all

select
  ins.room_id,
  ins.occurred_at as at,
  case ins.overall when 'ok' then 'revision_ok' else 'revision_ko' end as kind,
  case ins.overall
    when 'ok' then 'Revisión completa sin incidencias'
    else 'Revisión con incidencias'
  end             as title,
  null            as ref,
  p.full_name     as who,
  ins.status::text as state
from inspections ins
left join profiles p on p.id = ins.by_user
where ins.status = 'completa';

alter view room_timeline set (security_invoker = on);

notify pgrst, 'reload schema';
