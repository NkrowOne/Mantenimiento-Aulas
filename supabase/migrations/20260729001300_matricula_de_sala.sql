-- =============================================================================
-- La matrícula de la sala: una referencia corta, legible y ESTABLE
--
-- El identificador interno es un UUID, que es lo correcto para que renombrar una
-- sala no rompa nada. Pero un UUID no se dicta por teléfono, no se escribe en un
-- parte a mano y no se busca de memoria. Y el código de sala (`1.4`, `-2.1`) no
-- sirve como matrícula: se repite entre edificios y, sobre todo, **se puede
-- cambiar** — es una etiqueta, no una identidad.
--
-- De ahí `SALA-000087`: corta, dictable, y la única de las tres cosas que no
-- cambia nunca. Es lo que va grabado en la placa de la puerta junto al QR, y lo
-- que permite que un informe de enero siga siendo rastreable en junio aunque la
-- sala se haya renombrado por medio.
--
-- El QR, en cambio, codifica el UUID y no esto: escanear tiene que llevar a la
-- sala correcta aunque alguien reimprima las placas con otra numeración.
-- =============================================================================

create sequence if not exists room_ref_seq;

alter table rooms
  add column short_ref text unique;

-- Las que ya existen, por antigüedad: así los números bajos son las salas de
-- siempre y el orden significa algo, en vez de ser el que devolviera el planner.
with ordenadas as (
  select id, row_number() over (order by created_at, id) as n
  from rooms
)
update rooms r
set short_ref = 'SALA-' || lpad(o.n::text, 6, '0')
from ordenadas o
where o.id = r.id;

-- La secuencia arranca donde acabó el relleno, para que la siguiente sala siga
-- la serie en vez de chocar con una matrícula ya usada.
select setval('room_ref_seq', coalesce((select count(*) from rooms), 0) + 1, false);

create or replace function public.asignar_matricula_sala()
returns trigger language plpgsql as $$
begin
  if new.short_ref is null then
    new.short_ref := 'SALA-' || lpad(nextval('room_ref_seq')::text, 6, '0');
  end if;
  return new;
end;
$$;

create trigger rooms_matricula
  before insert on rooms
  for each row execute function public.asignar_matricula_sala();

-- A partir de aquí es obligatoria: una sala sin matrícula no se puede etiquetar,
-- y una placa es justo lo que hace falta para poder escanear al entrar.
alter table rooms
  alter column short_ref set not null;

/*
 * La matrícula tiene que viajar al dispositivo.
 *
 * `room_overview` es lo que baja `pullMaster()`, y la ficha y la hoja de
 * etiquetas se abren sin cobertura: una placa que no se puede imprimir porque
 * falta el dato en local no sirve para nada.
 *
 * `create or replace view` solo deja AÑADIR columnas al final y sin cambiar las
 * existentes, que es exactamente este caso.
 */
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
  r.short_ref
from rooms r
join zones z     on z.id = r.zone_id
join buildings b on b.id = z.building_id
left join lateral (
  select i.occurred_at, i.overall
  from inspections i
  where i.room_id = r.id and i.status = 'completa'
  order by i.occurred_at desc
  limit 1
) li on true
left join lateral (
  select count(*) as open_count
  from incidents inc
  -- Los borradores dejan de contar como incidencia abierta: una nota a medio
  -- escribir no es trabajo pendiente en la sala, y contarla pintaría de rojo
  -- salas donde no pasa nada. Tienen su propia bandeja.
  where inc.room_id = r.id and inc.state not in ('resuelta', 'borrador')
) oi on true
where r.active;

alter view room_overview set (security_invoker = on);

notify pgrst, 'reload schema';
