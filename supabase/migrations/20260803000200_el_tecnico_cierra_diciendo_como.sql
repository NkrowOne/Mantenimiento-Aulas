-- =============================================================================
-- El técnico cierra su incidencia, y para cerrarla tiene que decir qué ha hecho
--
-- Hasta aquí la regla era «los técnicos las abren; cerrarlas es cosa de
-- supervisores», y el efecto real no era el que se buscaba. Quien cambia el
-- cable en el −2.1 es el técnico; quien lo sabe, también. El supervisor cierra
-- desde el escritorio un parte cuya reparación no ha visto, así que o pregunta
-- —y entonces la información viaja por WhatsApp, que es de donde se venía
-- huyendo— o cierra a ciegas. Mientras tanto la avería arreglada sigue contando
-- días abierta y ensuciando el recuento de la sala.
--
-- Se abre, y se abre CON UNA CONDICIÓN: para cerrar hay que escribir qué se ha
-- hecho. Ese texto es lo que sustituye a la firma del supervisor. Sin él, la
-- fila diría «resuelta» y nada más, que es justo lo que hacía inútil el cierre
-- de antes — `resolution` era una columna que la aplicación nunca rellenaba, así
-- que el histórico contaba la avería y no la reparación.
--
-- CÓMO, y esto importa tanto como el qué:
--
--   - **La tabla no se abre.** `incidents` sigue teniendo la misma política de
--     UPDATE de siempre —solo supervisor— y la prueba 4 de `rls-test.sql` sigue
--     comprobándolo. Un técnico no puede tocar una incidencia a mano: no puede
--     cambiarle el título, ni la gravedad, ni la sala, ni reabrir lo cerrado.
--   - **Se abre UNA transición, por una puerta con nombre.** Esta función, y
--     solo hace dos cosas: pasar a «en curso» y cerrar con su texto. Todo lo
--     demás sigue donde estaba.
--   - **Y deja firma.** `resolved_by` es quien llama, no un genérico: quien
--     cierra queda escrito, que es la contrapartida de poder cerrar.
--
-- La aplicación la llama por la cola de salida, así que el cierre se hace
-- delante del aparato —sin cobertura— y sube después.
-- =============================================================================

/**
 * Lo mínimo que se acepta como «qué se ha hecho».
 *
 * Tres caracteres no son una descripción, y no pretenden serlo: son el suelo que
 * impide cerrar con un punto o con una equis. Lo que de verdad empuja a escribir
 * algo útil es la pantalla, que ofrece el motivo de un toque y pide el detalle
 * al lado. Aquí solo se garantiza que el campo no llegue vacío disfrazado.
 */

create or replace function public.avanzar_incidencia(
  p_id        uuid,
  p_estado    incident_state,
  p_resolucion text default null
)
returns incidents
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v      incidents;
  v_texto text := nullif(btrim(coalesce(p_resolucion, '')), '');
begin
  if not public.is_staff() then
    raise exception 'Solo el personal puede cambiar el estado de una incidencia'
      using errcode = 'insufficient_privilege';
  end if;

  -- Reabrir no entra: eso es revisar la decisión de otro, y sigue siendo un
  -- UPDATE de supervisor. Aquí solo se avanza.
  if p_estado not in ('en_curso', 'resuelta') then
    raise exception 'Desde aquí solo se puede empezar o cerrar una incidencia (se pidió «%»)', p_estado
      using errcode = 'check_violation';
  end if;

  select * into v from incidents where id = p_id for update;

  -- `check_violation` y no un código de «no existe»: PostgREST traduce lo que no
  -- conoce a un 500, y un 500 la cola lo reintenta para siempre. Esto no se
  -- arregla reintentando.
  if not found then
    raise exception 'Esa incidencia no existe (id=%)', p_id
      using errcode = 'check_violation';
  end if;

  -- Un borrador es una incidencia a medio escribir: se completa desde su
  -- bandeja, no se cierra. Cerrarlo dejaría una fila resuelta sin título.
  if v.state = 'borrador' then
    raise exception 'Un borrador se completa desde la bandeja de Incidencias, no se cierra (id=%)', p_id
      using errcode = 'check_violation';
  end if;

  if p_estado = 'resuelta' then
    if v_texto is null or length(v_texto) < 3 then
      raise exception 'Para cerrar una incidencia hay que escribir qué se ha hecho (id=%)', p_id
        using errcode = 'check_violation';
    end if;

    -- Idempotente: el reenvío de un cierre cuya respuesta se perdió no es un
    -- error, y no puede pisar ni la fecha ni la firma del cierre de verdad.
    -- Es la misma lección que `yaEstabaCerrada()` en la cola de salida.
    if v.state = 'resuelta' then
      return v;
    end if;

    update incidents
       set state       = 'resuelta',
           resolved_at = now(),
           resolved_by = (select auth.uid()),
           resolution  = v_texto
     where id = p_id
    returning * into v;

    return v;
  end if;

  -- Empezar solo tiene sentido sobre lo que está abierto. Sobre lo demás no es
  -- un error: es una orden que ya no aplica, y devolver la fila tal cual evita
  -- que un reenvío devuelva a «en curso» algo ya cerrado.
  if v.state <> 'abierta' then
    return v;
  end if;

  update incidents set state = 'en_curso' where id = p_id returning * into v;
  return v;
end;
$fn$;

comment on function public.avanzar_incidencia(uuid, incident_state, text) is
  'La única puerta por la que el personal —técnicos incluidos— empieza y cierra una incidencia. Cerrar exige escribir qué se ha hecho y firma con quien llama. La tabla sigue cerrada a UPDATE para todo el que no sea supervisor.';

revoke all on function public.avanzar_incidencia(uuid, incident_state, text) from public, anon;
grant execute on function public.avanzar_incidencia(uuid, incident_state, text) to authenticated;

notify pgrst, 'reload schema';
