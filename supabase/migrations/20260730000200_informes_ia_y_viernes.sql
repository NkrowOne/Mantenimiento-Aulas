-- =============================================================================
-- Informes: el automático pasa al viernes, se pueden pedir a medida y el
-- análisis lo redacta una IA
--
-- Tres cosas, y la primera es un fallo que llevaba ahí desde el principio.
--
-- 1. EL INFORME PROGRAMADO NO PODÍA EJECUTARSE. `request_report` empieza
--    exigiendo `is_supervisor()`, que lee el rol del JWT y, si no hay, del
--    perfil de `auth.uid()`. Un trabajo de `pg_cron` no tiene ni JWT ni
--    `auth.uid()`: `auth_role()` devuelve 'none' y la función abortaba con
--    «Solo un supervisor puede pedir un informe». Cada mañana, en el registro
--    de `cron.job_run_details` y en ningún otro sitio. Un informe que nadie
--    echa de menos porque nunca ha existido.
--
--    Se separa en dos: el envío al worker en una función interna, sin
--    comprobación de rol porque nadie de fuera puede ejecutarla, y
--    `request_report` como la puerta para las personas, que sigue exigiendo
--    supervisor. El cron entra por la interna.
--
-- 2. EL HORARIO. El automático era diario a las 07:00 y semanal los lunes. Pasa
--    a ser uno: el viernes a las 07:00, con la semana de trabajo entera. El
--    diario y el de a medida siguen existiendo, pero se piden a mano.
--
-- 3. LOS PARÁMETROS. `params` ya existía en la tabla `reports` y no se rellenaba
--    nunca. Ahora viaja: qué secciones, qué comparación, si se quiere análisis
--    con IA y para quién está escrito.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Ajustes de la IA
--
-- La clave puede vivir en dos sitios y el orden importa: el worker mira primero
-- `GEMINI_API_KEY` de su entorno y solo si no está, esta tabla. El entorno es lo
-- que se usa en un despliegue serio; esto es para poder activar la IA desde la
-- propia aplicación sin reconstruir el contenedor, que es la diferencia entre
-- «lo hago ahora» y «se lo pido a sistemas».
--
-- `app_config` ya está cerrada a administradores por RLS. Se accede además por
-- dos funciones —una que dice si hay clave sin decir cuál, otra que la escribe—
-- para que la pantalla de informes no necesite leer la tabla.
-- -----------------------------------------------------------------------------

insert into app_config (key, value) values
  ('ia_api_key',  ''),
  ('ia_modelo',   'gemini-3.6-flash'),
  ('ia_thinking', 'high')
on conflict (key) do nothing;

comment on table app_config is
  'Configuración del despliegue. Contiene secretos (token del worker, clave de la IA): solo administradores, y se lee por funciones cuando hace falta desde la aplicación.';

-- -----------------------------------------------------------------------------
-- El envío al worker, en una sola pieza
--
-- SIN `security definer` a propósito. La única cosa que la ejecuta es el cron,
-- que corre como superusuario y no necesita permisos prestados; y
-- `request_report`, que sí es definer y por tanto la llama ya como `postgres`.
-- Para todos los demás está revocada, y aunque no lo estuviera se quedaría en
-- el primer `select` sobre `app_config`, que es de administradores.
--
-- Sin comprobación de rol dentro, y es deliberado: esta función no es una puerta,
-- es la tubería que hay detrás. La puerta es `request_report`.
-- -----------------------------------------------------------------------------
create or replace function public.enviar_informe(
  p_kind   text,
  p_start  date,
  p_end    date,
  p_params jsonb,
  p_user   uuid
)
returns bigint
language plpgsql
set search_path = public
as $$
declare
  worker_url text;
  worker_tok text;
  request_id bigint;
  cuerpo     jsonb;
begin
  select value into worker_url from app_config where key = 'reports_worker_url';
  select value into worker_tok from app_config where key = 'reports_worker_token';

  if worker_url is null or worker_url = '' then
    raise exception 'No hay URL del worker de informes en app_config'
      using hint = 'insert into app_config (key, value) values (''reports_worker_url'', ''http://reports-worker:8080/generate'')';
  end if;

  cuerpo := jsonb_build_object('kind', p_kind);
  if p_start is not null then
    cuerpo := cuerpo || jsonb_build_object('start', p_start::text, 'end', p_end::text);
  end if;
  if p_params is not null and p_params <> '{}'::jsonb then
    cuerpo := cuerpo || jsonb_build_object('params', p_params);
  end if;
  -- Quién lo pidió. El worker lo guarda en `reports.generated_by` y lo imprime
  -- en la portada: un documento que alguien va a citar dice a petición de quién
  -- se emitió. En el automático del viernes va nulo, y el pie lo dice.
  if p_user is not null then
    cuerpo := cuerpo || jsonb_build_object('solicitado_por', p_user::text);
  end if;

  select net.http_post(
    url     := worker_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || worker_tok),
    body    := cuerpo
  ) into request_id;

  return request_id;
end;
$$;

-- El `alter default privileges` del bootstrap concede execute a `anon` y
-- `authenticated` en TODA función nueva. Aquí eso sería abrir la tubería.
revoke all on function public.enviar_informe(text, date, date, jsonb, uuid)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- La puerta para las personas
--
-- Se sustituye la de tres argumentos por una de cuatro. No se puede añadir
-- `p_params` con valor por defecto y dejar la vieja: las dos serían candidatas
-- para una llamada de tres argumentos y Postgres contestaría «function is not
-- unique» a todo el mundo.
-- -----------------------------------------------------------------------------
drop function if exists public.request_report(text, date, date);

create or replace function public.request_report(
  kind     text,
  p_start  date default null,
  p_end    date default null,
  p_params jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  s text;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor puede pedir un informe'
      using errcode = 'insufficient_privilege';
  end if;

  if kind not in ('diario', 'semanal', 'personalizado') then
    raise exception 'Tipo de informe no válido: %', kind
      using errcode = 'invalid_parameter_value';
  end if;

  if kind = 'personalizado' and (p_start is null or p_end is null) then
    raise exception 'Un informe a medida necesita fecha de inicio y de fin'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_start is not null and p_end is not null then
    if p_end < p_start then
      raise exception 'La fecha final es anterior a la inicial'
        using errcode = 'invalid_parameter_value';
    end if;
    -- Un rango de años haría que el worker cargase el histórico entero.
    if p_end - p_start > 366 then
      raise exception 'El periodo no puede superar un año'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  /*
   * Validación de `params`: la FORMA, no el catálogo.
   *
   * Se comprueba que sea un objeto, que las secciones sean una lista corta de
   * cadenas cortas y que los textos libres no sean un ensayo. Lo que NO se hace
   * aquí es exigir que cada nombre de sección exista, y es una decisión: ese
   * catálogo vive en el worker, y si se validara en los dos sitios, estrenar una
   * sección nueva exigiría una migración además de un despliegue. El worker
   * ignora lo que no conoce, que es el comportamiento correcto durante los
   * minutos en que el front y el worker van a distinta versión.
   */
  p_params := coalesce(p_params, '{}'::jsonb);
  if jsonb_typeof(p_params) <> 'object' then
    raise exception 'Los parámetros del informe deben ser un objeto'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_params ? 'secciones' then
    if jsonb_typeof(p_params->'secciones') <> 'array'
       or jsonb_array_length(p_params->'secciones') > 20 then
      raise exception 'La lista de secciones no es válida'
        using errcode = 'invalid_parameter_value';
    end if;
    for s in select jsonb_array_elements_text(p_params->'secciones') loop
      if length(s) > 24 or s !~ '^[a-z_]+$' then
        raise exception 'Nombre de sección no válido: %', s
          using errcode = 'invalid_parameter_value';
      end if;
    end loop;
  end if;

  if p_params ? 'audiencia'
     and p_params->>'audiencia' not in ('direccion', 'equipo') then
    raise exception 'Audiencia no válida: %', p_params->>'audiencia'
      using errcode = 'invalid_parameter_value';
  end if;

  if length(coalesce(p_params->>'enfoque', '')) > 400
     or length(coalesce(p_params->>'nota', '')) > 300 then
    raise exception 'El texto libre del informe es demasiado largo'
      using errcode = 'invalid_parameter_value';
  end if;

  return public.enviar_informe(kind, p_start, p_end, p_params, auth.uid());
end;
$$;

revoke execute on function public.request_report(text, date, date, jsonb) from public, anon;
grant execute on function public.request_report(text, date, date, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- El informe automático del viernes
--
-- La guardia de la hora no es paranoia: `pg_cron` interpreta sus horarios en
-- `cron.timezone`, que el compose fija en Europe/Madrid pero que en un Postgres
-- gestionado suele quedarse en GMT. Con una sola entrada a las 07:00 el informe
-- saldría a las 08:00 o a las 09:00 según el mes y según la plataforma.
--
-- Así que se programan tres disparos —05:00, 06:00 y 07:00— y la función
-- comprueba qué hora es DE VERDAD en Madrid. Exactamente uno de los tres cae a
-- las 07:00 peninsulares en cualquiera de las dos configuraciones y en los dos
-- horarios del año; los otros dos salen sin hacer nada. Es más barato que
-- explicarle a alguien por qué en invierno el informe llega a las nueve.
-- -----------------------------------------------------------------------------
create or replace function public.informe_semanal_programado()
returns bigint
language plpgsql
set search_path = public
as $$
declare
  hora int := extract(hour from now() at time zone 'Europe/Madrid');
begin
  if hora <> 7 then
    return null;
  end if;
  return public.enviar_informe('semanal', null, null, '{}'::jsonb, null);
end;
$$;

revoke all on function public.informe_semanal_programado() from public, anon, authenticated;

do $$
begin
  -- El diario deja de ser automático. Sigue existiendo como tipo y se puede
  -- pedir a mano desde la pantalla de informes; lo que se retira es el correo de
  -- las siete de cada mañana, que nadie pidió y que además nunca llegó a salir.
  perform cron.unschedule('informe-diario');
exception when others then
  raise notice 'No había un trabajo «informe-diario» que retirar';
end $$;

do $$
begin
  perform cron.schedule(
    'informe-semanal',
    '0 5,6,7 * * 5',
    $c$select public.informe_semanal_programado()$c$
  );
  raise notice 'Informe semanal programado: viernes a las 07:00 de Madrid';
exception when others then
  raise notice 'Sin pg_cron: programa el informe semanal con el cron del sistema';
end $$;

-- -----------------------------------------------------------------------------
-- Estado de la IA, sin enseñar la clave
--
-- La pantalla de informes necesita saber tres cosas: si hay clave, con qué
-- modelo se está trabajando y qué redactó el último informe. Ninguna de las tres
-- es la clave, y por eso esto es una función y no un `select` sobre `app_config`
-- —que además está cerrada a administradores, y quien pide informes es un
-- supervisor—.
--
-- `configurada` habla solo de la clave guardada en la base. El worker puede
-- tener la suya en el entorno y esto no lo sabe, así que se devuelve también lo
-- que hizo el último informe: eso es la verdad observada, no la suposición.
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

  select params->>'analisis' as analisis,
         (params->>'ia')::boolean as ia,
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
    'ultimo_informe',  ultimo.generated_at
  );
end;
$$;

revoke execute on function public.ia_estado() from public, anon;
grant execute on function public.ia_estado() to authenticated;

-- -----------------------------------------------------------------------------
-- Guardar la configuración de la IA. Solo administradores.
--
-- `p_clave` distingue tres casos y hacen falta los tres: nulo deja la clave como
-- está —para poder cambiar solo el modelo—, cadena vacía la borra y apaga la IA,
-- y cualquier otra cosa la sustituye.
-- -----------------------------------------------------------------------------
create or replace function public.ia_configurar(
  p_clave    text default null,
  p_modelo   text default null,
  p_thinking text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede configurar la IA'
      using errcode = 'insufficient_privilege';
  end if;

  if p_clave is not null then
    -- Sin recortar a un tamaño concreto: las claves de Google han cambiado de
    -- longitud dos veces. Lo que se comprueba es que sea plausible y de una
    -- sola línea, para que no entre aquí un archivo pegado por error.
    if p_clave <> '' and (length(p_clave) < 20 or p_clave ~ '\s') then
      raise exception 'Esa clave no tiene forma de clave de API'
        using errcode = 'invalid_parameter_value';
    end if;
    update app_config set value = btrim(p_clave) where key = 'ia_api_key';
  end if;

  if p_modelo is not null then
    if p_modelo !~ '^[a-z0-9.\-]{3,60}$' then
      raise exception 'Nombre de modelo no válido: %', p_modelo
        using errcode = 'invalid_parameter_value';
    end if;
    update app_config set value = p_modelo where key = 'ia_modelo';
  end if;

  if p_thinking is not null then
    if p_thinking not in ('minimal', 'low', 'medium', 'high') then
      raise exception 'Nivel de razonamiento no válido: %', p_thinking
        using errcode = 'invalid_parameter_value';
    end if;
    update app_config set value = p_thinking where key = 'ia_thinking';
  end if;

  return public.ia_estado();
end;
$$;

revoke execute on function public.ia_configurar(text, text, text) from public, anon;
grant execute on function public.ia_configurar(text, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Que la pantalla pueda leer el archivo con su procedencia
--
-- `reports` ya tenía política de lectura para el personal. Lo que faltaba era
-- que `params` significase algo: ahora trae qué secciones salieron y quién
-- redactó el análisis, y la lista de informes lo enseña sin abrir el PDF.
-- -----------------------------------------------------------------------------
comment on column reports.params is
  'Cómo se hizo el informe: secciones incluidas, si el análisis lo redactó la IA y con qué modelo. No es lo que se pidió, es lo que salió.';

notify pgrst, 'reload schema';
