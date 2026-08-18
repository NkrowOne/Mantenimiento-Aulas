-- =============================================================================
-- Cerrar una avería desde el aula, diciendo qué se hizo
--
-- Hasta aquí, resolver era un botón de la pestaña de Incidencias que ponía
-- `state = 'resuelta'` y nada más. Dos cosas fallaban en eso, y las dos se ven
-- en el histórico de cualquier sala:
--
--  1. **No se cerraba donde se arregla.** Quien cambia el proyector está en el
--     aula, con la ficha abierta y —muchas veces— sin cobertura. Cerrar exigía
--     salir del edificio, encontrar la incidencia en una lista de 283 y
--     acordarse de cuál de las tres pantallas era. Lo que no se cierra en el
--     sitio se cierra tarde, mal o no se cierra.
--  2. **Se cerraba sin decir nada, y eso era un retroceso.** El Excel del que
--     se viene SÍ apuntaba qué se hizo: 276 de las 281 incidencias cerradas del
--     histórico importado traen su frase —«Se acude al aula, se revisa. Se
--     sustituye el cable Hdmi existente por uno nuevo»—. La columna
--     `resolution` está en el esquema desde el primer día justamente por eso, y
--     el botón de la aplicación no la pedía: cada avería cerrada desde la app
--     era una línea menos de ese registro, y la línea de tiempo de la sala
--     enseñaba «Resuelta: Proyector: no da imagen» sin una palabra más. Que es
--     justo lo que hace falta la próxima vez que ese proyector falle: si se le
--     cambió la lámpara en marzo, la avería de abril es otra cosa.
--
-- Esta migración abre la puerta que faltaba y le pone la condición que la hace
-- valer la pena: **se cierra explicando**.
--
-- -----------------------------------------------------------------------------
-- Por qué una tabla y no un UPDATE
--
-- Porque el cierre tiene que poder firmarse en un sótano. Todo lo que se
-- produce en el aula viaja por la cola de salida, y la cola solo sabe hacer una
-- cosa bien: **insertar una fila que ya nació con su identidad**. Un UPDATE
-- reintentado es un problema —«¿llegó el primero?»— y encima `incidents` no lo
-- acepta de un técnico; una fila nueva con id de cliente se reenvía las veces
-- que haga falta y la segunda no hace nada (`on conflict do nothing`).
--
-- Es además el mismo patrón que el resto del sistema: los movimientos de
-- almacén, los eventos de equipo y las revisiones son asientos, no campos que
-- se reescriben. Un cierre también es algo que pasó, con su autor, su hora y su
-- explicación, y queda legible aunque después se reabra.
--
-- -----------------------------------------------------------------------------
-- Y por qué ahora puede cerrar un técnico
--
-- La regla era «cualquiera del equipo abre, solo un supervisor cierra», y venía
-- de que cerrar era un toque sin coste: un botón que borra trabajo de la lista
-- sin dejar constancia de nada. Con la explicación obligatoria deja de serlo —
-- cerrar es escribir qué se hizo, firmado y con la hora—, y quien puede
-- escribirlo es quien tuvo el aparato delante.
--
-- El UPDATE directo sobre `incidents` sigue siendo de supervisor: la prueba 4
-- de `rls-test.sql` no se toca. La única puerta nueva es esta, y no deja pasar
-- un cierre mudo ni uno firmado en nombre de otro.
-- =============================================================================

create table incident_resolutions (
  -- uuid v7 del cliente: es también la clave de idempotencia de la cola.
  id          uuid primary key,
  incident_id uuid not null references incidents(id) on delete cascade,
  /*
   * Qué se hizo. Obligatoria, y esa es toda la pieza.
   *
   * El mínimo es «algo escrito» y no una longitud: el formulario ya exige un
   * texto con cuerpo, y ese es el sitio donde exigirlo — delante de la persona,
   * que puede corregirlo. Una regla más dura aquí abajo rechazaría el cierre
   * horas después, en una cola que se vacía sola cuando ya nadie mira, y
   * dejaría el trabajo hecho y la incidencia abierta.
   */
  resolution  text not null check (length(btrim(resolution)) > 0),
  -- El reloj del dispositivo: cuándo se arregló de verdad, aunque suba el lunes.
  resolved_at timestamptz not null,
  resolved_by uuid references profiles(id),
  -- Y el del servidor, para poder distinguir lo uno de lo otro.
  recorded_at timestamptz not null default now()
);

comment on table incident_resolutions is
  'Los cierres de incidencia, uno por fila y con su explicación. Se firma en el aula y sube por la cola.';

-- La ficha de una incidencia pide «sus cierres, el último primero».
create index incident_resolutions_incidencia_idx
  on incident_resolutions(incident_id, resolved_at desc);

-- -----------------------------------------------------------------------------
-- El cierre, aplicado a la incidencia
--
-- `security definer` porque el técnico no puede tocar `incidents` y aquí sí hay
-- que tocarla: es exactamente la puerta estrecha que se quería —una sola
-- operación, con su explicación dentro— en vez de abrirle el UPDATE entero.
--
-- Tres decisiones dentro:
--
--  - **Solo cierra lo que está abierto.** Un borrador no se resuelve —no es
--    todavía trabajo de nadie— y una incidencia ya resuelta se queda con su
--    primer cierre. Así el reenvío de una fila que ya llegó no reescribe nada.
--  - **No falla cuando no cierra.** La fila se guarda igual y queda legible.
--    Reventar aquí convertiría un reintento de la cola en un rechazo permanente
--    por algo que ya estaba hecho, que es el fallo que este proyecto se ha
--    comido tres veces.
--  - **La fecha no puede ser del futuro.** El reloj lo pone el dispositivo, y
--    un iPad mal puesto en hora encabezaría el Historial de la sala para
--    siempre (ya pasó, con el año 2296). La fila conserva lo que dijo el
--    dispositivo; lo que se copia a la incidencia va acotado a `now()`.
-- -----------------------------------------------------------------------------
create or replace function public.aplicar_resolucion_de_incidencia()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update incidents i
     set state       = 'resuelta',
         resolution  = new.resolution,
         resolved_at = least(greatest(new.resolved_at, i.opened_at), now()),
         resolved_by = new.resolved_by
   where i.id = new.incident_id
     and i.state in ('abierta', 'en_curso');

  return new;
end;
$$;

create trigger incident_resolutions_cierran
  after insert on incident_resolutions
  for each row execute function public.aplicar_resolucion_de_incidencia();

-- -----------------------------------------------------------------------------
-- Permisos
--
-- Insertar, y solo eso. No hay política de UPDATE ni de DELETE: un cierre
-- escrito no se reescribe, igual que un movimiento de almacén o una foto. Si
-- hiciera falta rectificar, se cierra otra vez —la fila nueva queda al lado de
-- la vieja— o lo deshace un supervisor sobre `incidents`, que sí puede.
-- -----------------------------------------------------------------------------
alter table incident_resolutions enable row level security;

drop policy if exists "personal lee cierres" on incident_resolutions;
create policy "personal lee cierres" on incident_resolutions
  for select to authenticated using (public.is_staff());

drop policy if exists "personal cierra explicando" on incident_resolutions;
create policy "personal cierra explicando" on incident_resolutions
  for insert to authenticated
  with check (
    public.is_staff()
    -- Firmado por quien lo escribe. Sin esto, cerrar en nombre de otro sería
    -- un campo del formulario.
    and resolved_by = (select auth.uid())
  );

notify pgrst, 'reload schema';
