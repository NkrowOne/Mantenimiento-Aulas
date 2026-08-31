-- =============================================================================
-- Las horas del proyector llegan a la sala también al cerrar la revisión
--
-- La migración 300 puso un disparador sobre `inspection_checks` para que la
-- lectura de horas de la revisión más reciente llegue a `rooms.projector_hours`.
-- La idea era la correcta y el enganche, el que no se dispara nunca en el camino
-- de verdad, porque la cola de salida sube las cosas **en este orden a
-- propósito**:
--
--   1. la revisión, forzada a `borrador` —lo hace `esperandoSusChecks`, en
--      `outbox.ts`: mientras le falten comprobaciones por subir, la fila no se
--      cierra arriba, para que el servidor no vea nunca media revisión cerrada;
--   2. sus comprobaciones, que es cuando el disparador salta… y se encuentra la
--      revisión en `borrador`, así que no hace nada y devuelve la fila;
--   3. la revisión otra vez, ya `completa` — y aquí no había disparador ninguno.
--
-- Resultado: el técnico apunta 4.200 horas con el móvil, la revisión se cierra,
-- y `rooms.projector_hours` sigue con el número que dejó la importación. La
-- columna F del Excel enseña ese número viejo y encima gana las comparaciones,
-- porque es una columna `medida` y la fecha que la acompaña es la de la revisión
-- **nueva**: la hoja acaba afirmando que la revisión de ayer midió lo de hace un
-- año.
--
-- Se arregla enganchando también donde cierra, y sacando la copia a una función
-- que usan los dos: la regla de «solo si es la revisión más reciente de esa
-- sala» tiene que ser la misma por los dos caminos, y dos copias de una regla
-- son dos reglas dentro de un mes.
-- =============================================================================

/**
 * Copia a la sala la lectura de horas de una revisión, si le toca.
 *
 * Le toca si la revisión está completa y no hay otra completa posterior en la
 * misma sala: una revisión antigua que entra tarde —el móvil estuvo sin
 * cobertura una semana— no puede hacer que la sala retroceda a 3.900 horas
 * cuando ya se apuntaron 4.200.
 */
create or replace function public.horas_de_la_revision(p_inspection uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room  uuid;
  v_fecha timestamptz;
  v_horas int;
begin
  select i.room_id, i.occurred_at into v_room, v_fecha
    from inspections i
   where i.id = p_inspection and i.status = 'completa';

  if v_room is null then return; end if;

  if exists (
    select 1 from inspections i
     where i.room_id = v_room and i.status = 'completa' and i.occurred_at > v_fecha
  ) then
    return;
  end if;

  select c.measure::int into v_horas
    from inspection_checks c
   where c.inspection_id = p_inspection
     and c.measure is not null
     and c.measure_unit = 'h'
   limit 1;

  if v_horas is null then return; end if;

  update rooms set projector_hours = v_horas where id = v_room;
end $$;

comment on function public.horas_de_la_revision(uuid) is
  'Copia a rooms.projector_hours la lectura de horas de una revisión, si es la más reciente de su sala. La llaman los dos disparadores: la regla de cuál manda tiene que ser una sola.';

revoke all on function public.horas_de_la_revision(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Los dos enganches
-- -----------------------------------------------------------------------------

create or replace function public.horas_a_la_sala()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Este es el camino de la corrección: una comprobación que se rehace cuando la
  -- revisión ya estaba cerrada. En el camino normal la revisión todavía está en
  -- borrador cuando llega esto, y quien copia es el disparador de `inspections`.
  if new.measure is not null and new.measure_unit = 'h' then
    perform public.horas_de_la_revision(new.inspection_id);
  end if;
  return new;
end $$;

comment on function public.horas_a_la_sala() is
  'Cuando se corrige la lectura de una revisión ya cerrada. El cierre normal va por el disparador de inspections: la cola sube las comprobaciones antes que el cierre.';

revoke all on function public.horas_a_la_sala() from public, anon, authenticated;

create or replace function public.horas_al_cerrar_la_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'completa' then
    perform public.horas_de_la_revision(new.id);
  end if;
  return new;
end $$;

comment on function public.horas_al_cerrar_la_revision() is
  'El enganche que faltaba. La cola sube la revisión en borrador, luego sus comprobaciones y luego el cierre: sin esto, la lectura de horas no llegaba nunca a la sala.';

revoke all on function public.horas_al_cerrar_la_revision() from public, anon, authenticated;

drop trigger if exists inspections_horas_a_la_sala on inspections;
create trigger inspections_horas_a_la_sala
  after insert or update of status, occurred_at on inspections
  for each row execute function public.horas_al_cerrar_la_revision();

-- -----------------------------------------------------------------------------
-- Y una vez, para las que ya están cerradas y nunca llegaron a copiarse
-- -----------------------------------------------------------------------------

do $$
declare r record;
begin
  for r in
    select distinct on (i.room_id) i.id
      from inspections i
      join inspection_checks c on c.inspection_id = i.id
     where i.status = 'completa' and c.measure is not null and c.measure_unit = 'h'
     order by i.room_id, i.occurred_at desc
  loop
    perform public.horas_de_la_revision(r.id);
  end loop;
end $$;
