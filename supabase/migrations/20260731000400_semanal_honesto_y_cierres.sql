-- =============================================================================
-- El semanal del viernes deja de contar un día que no ha pasado, y dos cierres
--
-- Tres piezas pequeñas que dejó la auditoría adversarial del backend, cada una
-- con su motivo:
--
--  1. **El informe automático del viernes comparaba con trampa.** Sale a las
--     07:00 y cubría lunes→viernes: el viernes entra con una hora de madrugada
--     dentro, o sea vacío, y la comparación —«frente a la semana anterior»—
--     enfrentaba cuatro días trabajados contra cinco completos. Resultado: el
--     informe firmado decía «bajó la actividad» TODOS los viernes, por diseño.
--     Ahora el automático pide explícitamente lunes→jueves, y el periodo
--     anterior —mismo arranque en lunes, misma duración— vuelve a ser una
--     comparación de iguales. El título del PDF dice las fechas de verdad.
--
--  2. **`estado_de_informes()` quedaba ejecutable por `anon`.** El
--     `alter default privileges` del bootstrap concede execute a todo el mundo
--     en cada función nueva; la comprobación de rol interior ya paraba a los
--     anónimos, pero todas sus hermanas llevan además la revocación — dos
--     capas, como siempre, porque la próxima edición de la función solo
--     conservará la que esté escrita.
--
--  3. **Nadie «genera informes» a mano en la tabla.** La política de INSERT
--     para supervisores venía del primer esquema, cuando no estaba decidido
--     quién escribía en `reports`. Hoy el único que inserta es el worker, con
--     su conexión directa, y la política solo permitía una cosa: que un
--     supervisor fabricara por la API la fila de un informe que nadie emitió,
--     apuntando al PDF de otro. Un archivo en el que se puede insertar a mano
--     no es un archivo.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — El viernes a las 07:00, la semana que SÍ ha pasado
-- -----------------------------------------------------------------------------

create or replace function public.informe_semanal_programado()
returns bigint
language plpgsql
set search_path = public
as $$
declare
  hora  int  := extract(hour from now() at time zone 'Europe/Madrid');
  hoy   date := (now() at time zone 'Europe/Madrid')::date;
  lunes date := hoy - (extract(isodow from hoy)::int - 1);
begin
  -- La guardia de la hora, como estaba: tres disparos programados y solo el de
  -- las 07:00 de Madrid trabaja, en cualquier zona del servidor y del año.
  if hora <> 7 then
    return null;
  end if;

  -- Lunes → jueves, dicho con fechas. Sin ellas, el worker calcularía
  -- lunes→viernes y el viernes entraría vacío: cuatro días de trabajo
  -- comparados contra los cinco de la semana anterior, y el informe firmado
  -- «bajando» todos los viernes. El periodo anterior de un tramo que empieza
  -- en lunes es el mismo tramo de la semana anterior, así que la comparación
  -- vuelve a ser de iguales.
  return public.enviar_informe('semanal', lunes, lunes + 3, '{}'::jsonb, null);
end;
$$;

revoke all on function public.informe_semanal_programado() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2 — La revocación que le faltaba al diagnóstico
-- -----------------------------------------------------------------------------

revoke execute on function public.estado_de_informes() from public, anon;

-- -----------------------------------------------------------------------------
-- 3 — El archivo de informes solo lo escribe quien los emite
-- -----------------------------------------------------------------------------

drop policy if exists "supervisor genera informes" on reports;

-- -----------------------------------------------------------------------------
-- 4 — Cada petición de informe deja constancia propia
--
-- El hallazgo que cierra esto: el id que devuelve `net.http_post` no lo
-- guardaba nadie, y la única memoria del resultado —`net._http_response`— la
-- purga pg_net a las pocas horas. Un cron del viernes que fallara ya no tenía
-- rastro el lunes: `job_run_details` decía «succeeded» (encolar SÍ funcionó) y
-- no quedaba ni una fila que contara que el worker contestó 401 o no contestó.
--
-- Ahora cada envío se apunta aquí con su id, y el diagnóstico puede decir «tu
-- petición de las 10:02 devolvió 401» en vez de «no sé de qué me hablas». La
-- tabla es pequeña por construcción —una fila por informe pedido— y no se
-- purga: es exactamente el archivo de intentos que faltaba.
-- -----------------------------------------------------------------------------

create table if not exists report_requests (
  -- El id de pg_net: es la clave con la que se cruza la respuesta.
  id         bigint primary key,
  kind       text not null,
  p_start    date,
  p_end      date,
  pedido_por uuid references profiles(id),
  at         timestamptz not null default now()
);

comment on table report_requests is
  'Cada llamada al worker de informes, con el id de pg_net para poder cruzarla con su respuesta. Es la memoria que net._http_response no guarda.';

create index if not exists report_requests_at_idx on report_requests (at desc);

alter table report_requests enable row level security;

-- La escriben `request_report` (definer) y el cron (superusuario): no hace
-- falta política de INSERT. Leerla es cosa del mismo público que el diagnóstico.
drop policy if exists "supervisor lee peticiones de informe" on report_requests;
create policy "supervisor lee peticiones de informe" on report_requests
  for select to authenticated using (public.is_supervisor());

-- Y las respuestas de pg_net viven más que la pregunta de un lunes por un
-- viernes: el TTL de fábrica (6 horas) borraba el único código de error antes
-- de que nadie llegara a mirarlo.
do $$
begin
  if to_regclass('net.http_request_queue') is not null then
    execute format('alter database %I set pg_net.ttl to ''3 days''', current_database());
  end if;
exception when others then
  raise notice 'Sin permiso para fijar pg_net.ttl: las respuestas caducarán con el valor por defecto';
end $$;

-- La tubería, ahora apuntando cada envío. Idéntica a la de `20260731000300`
-- salvo el `insert` final.
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
  if p_user is not null then
    cuerpo := cuerpo || jsonb_build_object('solicitado_por', p_user::text);
  end if;

  select net.http_post(
    url     := worker_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || worker_tok),
    body    := cuerpo,
    timeout_milliseconds := 120000
  ) into request_id;

  -- La constancia. Con esto, un fallo posterior al encolado deja de ser
  -- invisible: la petición existe con su id aunque la respuesta caduque.
  insert into report_requests (id, kind, p_start, p_end, pedido_por)
  values (request_id, p_kind, p_start, p_end, p_user)
  on conflict (id) do nothing;

  return request_id;
end;
$$;

revoke all on function public.enviar_informe(text, date, date, jsonb, uuid)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5 — Y el diagnóstico cruza pregunta y respuesta
--
-- Igual que en `20260731000300`, más `peticiones`: los últimos envíos con el
-- código que devolvió cada uno — o el hecho, igual de elocuente, de que nadie
-- respondió. Y `token_de_ejemplo`, que ya estaba.
-- -----------------------------------------------------------------------------

create or replace function public.estado_de_informes()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pgnet      jsonb := jsonb_build_object('instalado', false);
  v_respuestas jsonb := '[]'::jsonb;
  v_peticiones jsonb := '[]'::jsonb;
  v_cron       jsonb := '[]'::jsonb;
  v_corridas   jsonb := '[]'::jsonb;
  v_informes   jsonb := '[]'::jsonb;
  v_cola       bigint := 0;
  v_ultima     timestamptz;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor consulta el estado de los informes'
      using errcode = 'insufficient_privilege';
  end if;

  if to_regclass('net.http_request_queue') is not null then
    select count(*) into v_cola from net.http_request_queue;

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

      -- Cada petición con su respuesta, si la respuesta sigue viva. La que no
      -- tiene ni código ni error con la cola vacía es la que se despachó y
      -- cuya respuesta ya caducó — o nunca llegó a despacharse.
      select coalesce(jsonb_agg(p), '[]'::jsonb) into v_peticiones
        from (
          select q.id,
                 q.kind,
                 q.at as cuando,
                 r.status_code as codigo,
                 coalesce(r.timed_out, false) as caduco,
                 left(coalesce(r.error_msg, ''), 200) as error,
                 (r.id is not null) as respondida
            from report_requests q
            left join net._http_response r on r.id = q.id
           order by q.at desc
           limit 5
        ) p;
    end if;

    v_pgnet := jsonb_build_object(
      'instalado', true,
      'en_cola', v_cola,
      'ultima_respuesta', v_ultima
    );
  else
    -- Sin pg_net no hay respuestas que cruzar, pero los intentos apuntados se
    -- enseñan igual: son la prueba de que alguien pidió y nada salió.
    select coalesce(jsonb_agg(p), '[]'::jsonb) into v_peticiones
      from (
        select q.id, q.kind, q.at as cuando,
               null::int as codigo, false as caduco, '' as error, false as respondida
          from report_requests q
         order by q.at desc
         limit 5
      ) p;
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
    'peticiones', v_peticiones,
    'cron', v_cron,
    'corridas', v_corridas,
    'informes', v_informes,
    'token_de_ejemplo', exists (
      select 1 from app_config
       where key = 'reports_worker_token' and value = 'cambiame-en-produccion'
    )
  );
end;
$$;

revoke execute on function public.estado_de_informes() from public, anon;
grant execute on function public.estado_de_informes() to authenticated;

notify pgrst, 'reload schema';
