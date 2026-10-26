-- reejecutable: si
--
-- Solo toca lo que lleva exactamente la fecha equivocada, y después de
-- corregirlo ya no la lleva nada: la segunda pasada no encuentra ni una fila.
-- =============================================================================
-- Los puestos del laboratorio 6 se instalaron el 22 de septiembre, no el 22 de
-- octubre
--
-- `20261026000400` les puso de alta el 22/10/2026 porque fue la fecha que se
-- dio. La buena es el 22/09/2026: la corrigió la misma persona que estuvo allí.
--
-- Se corrigen las dos cosas que llevaban la fecha:
--
--  - El alta que la migración escribió en el histórico, que se reconoce por su
--    `instalado_el`. Sigue yendo por delante de la baja de la fusión —con un
--    minuto de margen si la baja fuera posterior al 22/09—, porque es esa
--    precedencia la que hace que la hoja deje de leerlos como baja.
--  - La fecha de alta de los ordenadores, solo de los que llevan EXACTAMENTE el
--    instante que puso la migración —22/10/2026 09:00— y en las aulas de esas
--    altas. Una fecha así no la escribe nadie a mano, así que no se toca nada
--    que no viniera de ahí.
--
-- Corregir el evento en vez de añadir otro es a propósito: no es una segunda
-- cosa que pasara en el aula, es la misma alta con la fecha mal copiada.
-- =============================================================================

do $fecha$
declare
  v_mal  constant timestamptz := timestamptz '2026-10-22 09:00+02';
  v_bien constant timestamptz := timestamptz '2026-09-22 09:00+02';
  v_eventos int := 0;
  v_equipos int := 0;
begin
  update asset_events e
     set occurred_at = greatest(
           v_bien,
           (select max(b.occurred_at) + interval '1 minute'
              from asset_events b
             where b.asset_id = e.asset_id and b.kind = 'baja')
         ),
         meta = e.meta || jsonb_build_object('instalado_el', to_char(v_bien, 'YYYY-MM-DD'))
   where e.kind = 'alta'
     and e.meta ->> 'instalado_el' = to_char(v_mal, 'YYYY-MM-DD');
  get diagnostics v_eventos = row_count;

  update assets a
     set created_at = v_bien
   where a.created_at = v_mal
     and a.room_id in (
       select distinct e.room_id
         from asset_events e
        where e.kind = 'alta'
          and e.meta ->> 'instalado_el' = to_char(v_bien, 'YYYY-MM-DD')
     );
  get diagnostics v_equipos = row_count;

  raise notice 'Laboratorio 6: alta corregida al 22/09/2026 en % equipos (% apuntes del histórico).',
    v_equipos, v_eventos;
end
$fecha$;

notify pgrst, 'reload schema';
