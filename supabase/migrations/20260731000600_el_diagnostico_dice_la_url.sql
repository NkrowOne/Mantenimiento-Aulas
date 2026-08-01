-- =============================================================================
-- El diagnóstico dice A QUIÉN está llamando
--
-- El caso real que lo pide: la pantalla decía «No se alcanza el worker:
-- Couldn't resolve host name» y quien la miraba no tenía forma de saber QUÉ
-- nombre no resolvía. La URL vivía en app_config —que es de administradores— y
-- el error de pg_net no la repite. Con la URL delante, ese error se explica
-- solo: «http://reports-worker:8080/generate» en una plataforma donde el
-- worker se llama de otra manera es el diagnóstico entero en una línea.
--
-- La URL no es un secreto —es un nombre de host interno— y quien la ve es un
-- supervisor autenticado. El token NO se devuelve: solo el hecho, que ya se
-- devolvía, de si sigue siendo el de ejemplo.
--
-- Es la misma `estado_de_informes()` de `20260731000400` más el campo
-- `worker_url`.
-- =============================================================================

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
    -- A quién llama la tubería. Con «Couldn't resolve host name» al lado de la
    -- URL concreta, el fallo se explica solo.
    'worker_url', (select value from app_config where key = 'reports_worker_url'),
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
