-- =============================================================================
-- Por qué no sale el informe: la respuesta, en pantalla
--
-- El fallo real que motiva esto: en un despliegue, los informes NO se generaban
-- NUNCA — ni el semanal del viernes ni los pedidos a mano — y no había un solo
-- error visible en ninguna parte. La causa estaba fuera de la base: el
-- `command` del servicio de Postgres fijaba `shared_preload_libraries` con
-- pg_cron pero SIN pg_net, y pg_net sin precarga es una trampa perfecta: la
-- extensión se crea sin quejarse, `net.http_post()` devuelve un id como si
-- hubiera hecho algo, la petición se queda en `net.http_request_queue`… y el
-- proceso de fondo que la despacharía no existe. `request_report` «funciona»,
-- el cron «funciona», y el worker no recibe nada jamás.
--
-- El compose ya está corregido. Lo que esta migración añade es lo que faltó
-- durante todo ese tiempo: **poder verlo**. Un fallo de fontanería que solo se
-- diagnostica con psql es un fallo que vuelve; uno que la pantalla de Informes
-- explica con sus palabras se arregla en minutos.
--
-- Dos piezas:
--
--  1. `estado_de_informes()` — la tubería contada entera: si pg_net está y si
--     está DESPACHANDO su cola (que son dos cosas distintas, y la diferencia es
--     exactamente este fallo), las últimas respuestas que devolvió el worker
--     (un 401 aquí es «el token de app_config no coincide»), los trabajos de
--     cron con sus últimas ejecuciones, y los últimos informes emitidos.
--  2. `enviar_informe` aprende dos cosas: a fallar CLARO si pg_net no está
--     instalado —antes moría con un error de esquema que no orientaba a nadie—
--     y a esperar la respuesta el tiempo que el worker tarda de verdad. El
--     tope por defecto de pg_net son 5 segundos, y un informe con la redacción
--     de Gemini puede tardar más de un minuto: la ENTREGA no se perdía —la
--     petición ya había llegado y el worker terminaba igual— pero el registro
--     decía «timeout» sobre informes que sí se emitieron, que es veneno puro
--     para el diagnóstico de la pieza 1.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — La tubería, contada entera
--
-- Todos los accesos a `net.*` y `cron.*` van guardados con `to_regclass`: en un
-- Postgres sin las extensiones (el clúster de verificación, un gestionado sin
-- pg_net) la función tiene que CONTESTAR eso mismo, no reventar.
-- -----------------------------------------------------------------------------

create or replace function public.estado_de_informes()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pgnet     jsonb := jsonb_build_object('instalado', false);
  v_respuestas jsonb := '[]'::jsonb;
  v_cron      jsonb := '[]'::jsonb;
  v_corridas  jsonb := '[]'::jsonb;
  v_informes  jsonb := '[]'::jsonb;
  v_cola      bigint := 0;
  v_ultima    timestamptz;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor consulta el estado de los informes'
      using errcode = 'insufficient_privilege';
  end if;

  if to_regclass('net.http_request_queue') is not null then
    select count(*) into v_cola from net.http_request_queue;

    -- La cola no lleva fecha, así que la edad se mide por el otro lado: cuándo
    -- contestó algo por última vez. Cola con contenido y sin respuestas
    -- recientes = nadie está despachando, que es la firma de pg_net sin
    -- precargar en shared_preload_libraries.
    if to_regclass('net._http_response') is not null then
      select max(created) into v_ultima from net._http_response;
      select coalesce(jsonb_agg(r), '[]'::jsonb) into v_respuestas
        from (
          select status_code as codigo,
                 timed_out   as caduco,
                 left(coalesce(error_msg, ''), 200) as error,
                 created     as cuando
            from net._http_response
           order by created desc
           limit 5
        ) r;
    end if;

    v_pgnet := jsonb_build_object(
      'instalado', true,
      'en_cola', v_cola,
      'ultima_respuesta', v_ultima
    );
  end if;

  if to_regclass('cron.job') is not null then
    select coalesce(jsonb_agg(j), '[]'::jsonb) into v_cron
      from (
        select jobname as nombre, schedule as horario, active as activo
          from cron.job
         where jobname like 'informe-%'
         order by jobname
      ) j;

    if to_regclass('cron.job_run_details') is not null then
      select coalesce(jsonb_agg(d), '[]'::jsonb) into v_corridas
        from (
          select j.jobname as nombre,
                 d.status  as estado,
                 left(coalesce(d.return_message, ''), 200) as detalle,
                 d.start_time as cuando
            from cron.job_run_details d
            join cron.job j on j.jobid = d.jobid
           where j.jobname like 'informe-%'
           order by d.start_time desc
           limit 5
        ) d;
    end if;
  end if;

  select coalesce(jsonb_agg(i), '[]'::jsonb) into v_informes
    from (
      select kind, period_start, period_end, generated_at, storage_path
        from reports
       order by generated_at desc
       limit 5
    ) i;

  return jsonb_build_object(
    'pg_net', v_pgnet,
    'respuestas', v_respuestas,
    'cron', v_cron,
    'corridas', v_corridas,
    'informes', v_informes,
    -- El OTRO fallo con este mismo síntoma: un despliegue que no pasó por
    -- deploy.sh conserva el token de ejemplo en app_config, y cada llamada
    -- muere en un 401 que nadie ve. Se dice el hecho —es el de ejemplo, sí o
    -- no— y nunca el token: esto lo lee un supervisor y la clave es de admin.
    'token_de_ejemplo', exists (
      select 1 from app_config
       where key = 'reports_worker_token' and value = 'cambiame-en-produccion'
    )
  );
end;
$$;

comment on function public.estado_de_informes() is
  'La tubería de informes contada entera: pg_net y su cola, las últimas respuestas del worker, los trabajos de cron y los últimos informes emitidos. Para que «no sale el informe» tenga diagnóstico en pantalla.';

grant execute on function public.estado_de_informes() to authenticated;

-- -----------------------------------------------------------------------------
-- 1b — La cola muerta se vacía una vez
--
-- Todo lo que haya ahora mismo en la cola de pg_net son peticiones que nadie
-- despachó nunca: semanas de crons y de botones pulsados en balde. Si se dejan,
-- el primer arranque con la precarga corregida las dispara TODAS a la vez
-- contra el worker — decenas de WeasyPrint simultáneos en una máquina pequeña.
-- Se tiran: quien quiera el informe de esta semana lo pide y sale en el acto,
-- que es más de lo que esa cola hizo jamás. (Si la base se reinicia con la
-- corrección ANTES de aplicar esta migración, el mismo vaciado se puede hacer a
-- mano; las peticiones repetidas del mismo periodo, en todo caso, convergen en
-- un único PDF por el hash.)
-- -----------------------------------------------------------------------------

do $$
declare
  v_tiradas bigint;
begin
  if to_regclass('net.http_request_queue') is not null then
    delete from net.http_request_queue;
    get diagnostics v_tiradas = row_count;
    if v_tiradas > 0 then
      raise notice 'Vaciada la cola de pg_net: % petición(es) que nunca se despacharon', v_tiradas;
    end if;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 2 — La tubería falla claro y espera lo que hay que esperar
--
-- Idéntica a la de `20260730000200` salvo las dos lecciones de arriba: el aviso
-- explícito si pg_net no está instalado, y el tope de espera a la altura de lo
-- que el worker tarda de verdad en contestar.
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
  -- Sin pg_net no hay tubería, y decirlo con estas palabras es la diferencia
  -- entre arreglarlo y perseguir un «schema net does not exist» por los logs.
  if to_regclass('net.http_request_queue') is null then
    raise exception 'La extensión pg_net no está instalada: no se puede llamar al worker de informes'
      using hint = 'create extension pg_net; y comprueba que pg_net figura en shared_preload_libraries del servidor';
  end if;

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
    body    := cuerpo,
    -- El worker contesta cuando el PDF ya está: con la redacción de Gemini y
    -- su razonamiento alto, eso puede pasar del minuto. El tope por defecto de
    -- pg_net (5 s) no perdía la entrega, pero apuntaba «timeout» sobre
    -- informes que salieron bien — y un registro que miente inutiliza el
    -- diagnóstico entero.
    timeout_milliseconds := 120000
  ) into request_id;

  return request_id;
end;
$$;

-- La misma revocación que tenía: la puerta con permisos es `request_report`.
revoke all on function public.enviar_informe(text, date, date, jsonb, uuid)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
