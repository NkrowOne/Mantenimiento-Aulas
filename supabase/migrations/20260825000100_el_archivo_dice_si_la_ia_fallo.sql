-- -----------------------------------------------------------------------------
-- Que se sepa si la IA redactó o falló
--
-- Hasta ahora, `params->>'ia'` valía `false` en dos casos que no se parecen en
-- nada: el informe que se pidió sin IA a propósito —salió como se quería— y el
-- que la pidió y no la tuvo —salió a medias y nadie se enteró—. Los dos se leían
-- igual en el archivo y en la tarjeta de arriba, así que una clave caducada
-- podía pasar semanas dando informes peores sin que nada lo dijera.
--
-- La aplicación ya guarda `ia_pedida` y `aviso_ia` en `params` desde este mismo
-- cambio; aquí solo se devuelven, para que la tarjeta pueda decir «el último
-- pidió IA y no la tuvo, y este es el motivo» sin abrir el documento.
--
-- No hay nada que migrar: los informes anteriores no traen esas claves y salen
-- como `null`, que es exactamente lo que consta de ellos. Inventarles un valor
-- sería afirmar algo que nadie registró.
-- -----------------------------------------------------------------------------

create or replace function public.ia_estado()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clave text;
  ultimo record;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor puede consultar el estado de la IA'
      using errcode = 'insufficient_privilege';
  end if;

  select btrim(value) into clave from app_config where key = 'ia_api_key';

  select params->>'analisis'          as analisis,
         (params->>'ia')::boolean     as ia,
         (params->>'ia_pedida')::boolean as pidio_ia,
         nullif(btrim(coalesce(params->>'aviso_ia', '')), '') as aviso,
         generated_at
    into ultimo
    from reports
   where params ? 'analisis'
   order by generated_at desc
   limit 1;

  return jsonb_build_object(
    -- Solo si hay clave o no. Su valor no sale de aquí ni recortado: media clave
    -- en una pantalla sigue siendo media clave en el registro de un navegador.
    'clave_guardada', coalesce(length(clave) > 0, false),
    'modelo',   coalesce((select value from app_config where key = 'ia_modelo'), 'gemini-3.6-flash'),
    'thinking', coalesce((select value from app_config where key = 'ia_thinking'), 'high'),
    'ultimo_analisis', ultimo.analisis,
    'ultimo_con_ia',   coalesce(ultimo.ia, false),
    -- Las dos nuevas. `ultimo_pidio_ia` va sin `coalesce` a propósito: `null`
    -- significa «de ese informe no consta», y no es lo mismo que «no se pidió».
    'ultimo_pidio_ia', ultimo.pidio_ia,
    'ultimo_aviso',    ultimo.aviso,
    'ultimo_informe',  ultimo.generated_at
  );
end;
$$;

revoke execute on function public.ia_estado() from public, anon;
grant execute on function public.ia_estado() to authenticated;
