-- Prueba de humo de RLS y del congelado append-only.
-- Se ejecuta contra el clúster de verificación: `npm run db:verify`.
--
-- Cada bloque afirma un comportamiento que, si se rompe, rompe una promesa
-- concreta del diseño. No comprueba que el SQL compile: comprueba que deniega.

\set ON_ERROR_STOP on
\pset pager off

-- Dos usuarios de prueba con roles distintos.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'tecnico@test.local'),
  ('22222222-2222-4222-8222-222222222222', 'super@test.local')
on conflict do nothing;

update profiles set role = 'tecnico'    where id = '11111111-1111-4111-8111-111111111111';
update profiles set role = 'supervisor' where id = '22222222-2222-4222-8222-222222222222';

-- Ayudante: se mete en la piel de un usuario como lo haría PostgREST.
create or replace function test_as(uid uuid, role_name text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid::text, 'app_role', role_name)::text, true);
  execute 'set local role authenticated';
end $$;

\echo ''
\echo '=== 1. Un técnico puede crear su propia revisión ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  insert into inspections (id, room_id, by_user, occurred_at, status)
  select '33333333-3333-4333-8333-333333333331', id,
         '11111111-1111-4111-8111-111111111111', now(), 'borrador'
  from rooms limit 1;
  select 'OK: borrador creado' as resultado;
commit;

\echo ''
\echo '=== 2. Un técnico NO puede crear una revisión a nombre de otro ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  savepoint s;
  do $$
  begin
    insert into inspections (id, room_id, by_user, occurred_at, status)
    select '33333333-3333-4333-8333-333333333332', id,
           '22222222-2222-4222-8222-222222222222', now(), 'borrador'
    from rooms limit 1;
    raise exception 'FALLO: se permitió suplantar a otro usuario';
  exception when insufficient_privilege then
    raise notice 'OK: RLS bloqueó la suplantación';
  end $$;
  rollback to savepoint s;
rollback;

\echo ''
\echo '=== 3. Una revisión COMPLETA es inmutable (dos capas) ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  update inspections set status = 'completa', overall = 'ok'
  where id = '33333333-3333-4333-8333-333333333331';

  -- Capa 1 — RLS: la política del técnico solo alcanza filas en 'borrador',
  -- así que la fila deja de existir para él. No lanza error: no afecta a nada.
  savepoint s1;
  do $$
  declare n int;
  begin
    update inspections set notes = 'intento del propio técnico'
    where id = '33333333-3333-4333-8333-333333333331';
    get diagnostics n = row_count;
    if n > 0 then raise exception 'FALLO: el técnico editó su revisión completa'; end if;
    raise notice 'OK: RLS dejó la revisión fuera del alcance del técnico';
  end $$;
  rollback to savepoint s1;

  -- Capa 2 — el trigger: un supervisor SÍ alcanza la fila por RLS, y aun así
  -- el congelado tiene que pararle. Es la capa que hace que el histórico valga
  -- como registro de auditoría y no solo como convención.
  savepoint s2;
  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');
  do $$
  begin
    update inspections set notes = 'intento del supervisor'
    where id = '33333333-3333-4333-8333-333333333331';
    raise exception 'FALLO: el supervisor editó una revisión completa';
  exception when check_violation then
    raise notice 'OK: el trigger congeló la revisión';
  end $$;
  rollback to savepoint s2;
commit;

\echo ''
\echo '=== 4. Un técnico NO puede cerrar una incidencia ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  savepoint s;
  do $$
  declare n int;
  begin
    update incidents set state = 'resuelta', resolved_at = now()
    where state <> 'resuelta';
    get diagnostics n = row_count;
    if n > 0 then
      raise exception 'FALLO: un técnico cerró % incidencias', n;
    end if;
    raise notice 'OK: RLS no dejó cerrar ninguna incidencia';
  exception when insufficient_privilege then
    raise notice 'OK: RLS bloqueó el cierre';
  end $$;
  rollback to savepoint s;
rollback;

\echo ''
\echo '=== 5. Un supervisor SÍ puede cerrar una incidencia ==='
begin;
  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');
  update incidents set state = 'resuelta', resolved_at = now()
  where state <> 'resuelta';
  select 'OK: cerradas ' || count(*) || ' incidencias' as resultado
  from incidents where state = 'resuelta';
rollback;

\echo ''
\echo '=== 6. Un técnico NO puede inventar una compra de almacén ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  savepoint s;
  do $$
  begin
    insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user)
    select '44444444-4444-4444-8444-444444444441', id, 100, 'compra', now(),
           '11111111-1111-4111-8111-111111111111'
    from stock_items limit 1;
    raise exception 'FALLO: un técnico registró una compra';
  exception when insufficient_privilege then
    raise notice 'OK: RLS bloqueó la compra';
  end $$;
  rollback to savepoint s;

  -- Pero sí puede descontar lo que gasta en el aula.
  insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user)
  select '44444444-4444-4444-8444-444444444442', id, -1, 'consumo', now(),
         '11111111-1111-4111-8111-111111111111'
  from stock_items limit 1;
  select 'OK: el consumo sí se permite' as resultado;
rollback;

\echo ''
\echo '=== 7. La auditoría registra quién renombró una sala ==='
begin;
  select test_as('22222222-2222-4222-8222-222222222222', 'admin');
  update rooms set name = name || ' (renombrada)'
  where id = (select id from rooms order by code limit 1);
  reset role;
  select case when count(*) = 1 then 'OK: auditado con autor'
              else 'FALLO: ' || count(*) || ' filas de auditoría' end as resultado
  from audit_log
  where table_name = 'rooms' and op = 'UPDATE'
    and by_user = '22222222-2222-4222-8222-222222222222';
rollback;

\echo ''
\echo '=== 8. El stock es una suma, no un campo editable ==='
select case
  when count(*) = 0 then 'OK: ningún artículo con saldo negativo'
  else 'ATENCIÓN: ' || count(*) || ' artículos en negativo'
end as resultado
from stock_levels where on_hand < 0;

\echo ''
\echo '=== 9. Los buckets existen y son privados ==='
select case
  when count(*) = 2 and bool_and(not public) then 'OK: fotos y reports, ambos privados'
  else 'FALLO: ' || count(*) || ' buckets, públicos: ' ||
       coalesce((select string_agg(id, ',') from storage.buckets where public), 'ninguno')
end as resultado
from storage.buckets where id in ('fotos', 'reports');

\echo ''
\echo '=== 10. Un técnico puede subir una foto pero NO borrarla ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');

  insert into storage.objects (bucket_id, name, owner)
  values ('fotos', 'inspection/x/y.jpg', '11111111-1111-4111-8111-111111111111');
  select 'OK: la subida se permite' as resultado;

  -- Sin política de DELETE, RLS filtra la fila: no borra nada y no lanza error.
  -- Es justo lo que queremos: una foto de incidencia es prueba, no un borrador.
  savepoint s;
  do $$
  declare n int;
  begin
    delete from storage.objects where bucket_id = 'fotos';
    get diagnostics n = row_count;
    if n > 0 then raise exception 'FALLO: se borraron % fotos', n; end if;
    raise notice 'OK: RLS impide borrar fotos';
  exception when insufficient_privilege then
    raise notice 'OK: RLS bloqueó el borrado';
  end $$;
  rollback to savepoint s;
rollback;

\echo ''
\echo '=== 11. Un técnico NO puede escribir en el bucket de informes ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  savepoint s;
  do $$
  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('reports', 'diario/falso.pdf', '11111111-1111-4111-8111-111111111111');
    raise exception 'FALLO: un técnico escribió un informe';
  exception when insufficient_privilege then
    raise notice 'OK: RLS reservó los informes al worker';
  end $$;
  rollback to savepoint s;
rollback;

-- ─────────────────────────────────────────────────────────────────────────
-- Pruebas de exposición pública.
--
-- Con la API en Internet, RLS deja de ser una segunda capa y pasa a ser LA
-- capa: cualquiera puede llamar a PostgREST. Estas dos comprueban que quien
-- no ha iniciado sesión, o ha iniciado sesión pero no tiene rol, no ve
-- absolutamente nada.
-- ─────────────────────────────────────────────────────────────────────────

\echo ''
\echo '=== 12. Un anónimo de Internet no ve NADA ==='
begin;
  -- Así llega una petición sin token: rol anon y sin claims.
  set local role anon;
  select set_config('request.jwt.claims', '', true);

  select case
    when (select count(*) from rooms)      = 0
     and (select count(*) from incidents)  = 0
     and (select count(*) from profiles)   = 0
     and (select count(*) from inspections) = 0
    then 'OK: 0 salas, 0 incidencias, 0 perfiles, 0 revisiones'
    else 'FALLO: un anónimo ve ' || (select count(*) from rooms) || ' salas y ' ||
         (select count(*) from incidents) || ' incidencias'
  end as resultado;

  -- Y POR LAS VISTAS, que es por donde se escapaba.
  --
  -- Esta comprobación no existía y por eso la de arriba daba falsa confianza:
  -- una vista sin `security_invoker` se ejecuta con los privilegios de su
  -- propietario, así que la RLS de las tablas de debajo no se aplicaba. Un
  -- anónimo leía las 276 salas y el almacén entero por `/rest/v1/room_overview`.
  select case
    when (select count(*) from room_overview)          = 0
     and (select count(*) from stock_levels)           = 0
     and (select count(*) from alerts_lamp_low)        = 0
     and (select count(*) from alerts_stale_incidents) = 0
     and (select count(*) from alerts_overdue_rooms)   = 0
     and (select count(*) from incidents_by_building)  = 0
    then 'OK: tampoco por las vistas'
    else 'FALLO: fuga por vistas — ' ||
         (select count(*) from room_overview) || ' salas en room_overview, ' ||
         (select count(*) from stock_levels) || ' artículos en stock_levels'
  end as resultado;
rollback;

\echo ''
\echo '=== 13. Un usuario autenticado SIN rol tampoco ve nada ==='
begin;
  -- Es el caso de una cuenta desactivada, o de alguien cuyo perfil no existe:
  -- el hook le pone app_role = 'none'.
  select test_as('99999999-9999-4999-8999-999999999999', 'none');

  select case
    when (select count(*) from rooms)     = 0
     and (select count(*) from incidents) = 0
    then 'OK: sin rol no se ve nada'
    else 'FALLO: ve ' || (select count(*) from rooms) || ' salas'
  end as resultado;
rollback;

\echo ''
\echo '=== 14. Un técnico da de alta un tipo de equipo, pero SIN confirmar ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');

  -- El caso real: está en un aula, encuentra un aparato que no está en el
  -- catálogo y lo apunta. Si esto no funciona, no lo apunta.
  insert into asset_types (id, name) values
    ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'Cañón corto de prueba');

  select case
    when (select confirmed from asset_types where id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa') = false
    then 'OK: el tipo entra sin confirmar'
    else 'FALLO: ha entrado ya confirmado'
  end as resultado;
rollback;

\echo ''
\echo '=== 15. Un técnico NO puede autoconfirmarse un tipo ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  savepoint s;

  -- Ni colándolo en el alta...
  do $$
  begin
    insert into asset_types (id, name, confirmed) values
      ('bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', 'Tipo colado', true);
    raise exception 'FALLO: ha podido crear un tipo ya confirmado';
  exception when insufficient_privilege then
    raise notice 'OK: RLS impidió crear un tipo confirmado';
  end $$;
  rollback to savepoint s;

  -- ...ni llamando a la función del coordinador.
  do $$
  begin
    perform public.confirm_asset_type(public.asset_type_id('Proyector'));
    raise exception 'FALLO: un técnico ha confirmado un tipo';
  exception when raise_exception then
    if sqlerrm like 'FALLO%' then raise; end if;
    raise notice 'OK: confirm_asset_type rechazó al técnico';
  end $$;
  rollback to savepoint s;
rollback;

\echo ''
\echo '=== 16. El coordinador confirma, corrige y fusiona ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  insert into asset_types (id, name) values
    ('cccccccc-1111-4111-8111-cccccccccccc', 'Amplificador raro');

  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');

  select public.confirm_asset_type('cccccccc-1111-4111-8111-cccccccccccc');

  -- Corregir a otra palabra: el nombre viejo tiene que quedarse de alias, o
  -- quien lo teclee mañana creará un duplicado en vez de encontrar este.
  select public.rename_asset_type('cccccccc-1111-4111-8111-cccccccccccc', 'Amplificador de sala');

  select case
    when (select name from asset_types where id = 'cccccccc-1111-4111-8111-cccccccccccc')
         = 'Amplificador de sala'
     and (select 'Amplificador raro' = any(aliases) from asset_types
           where id = 'cccccccc-1111-4111-8111-cccccccccccc')
     and public.asset_type_id('Amplificador raro') = 'cccccccc-1111-4111-8111-cccccccccccc'
    then 'OK: renombrado, y el nombre viejo sigue encontrándolo'
    else 'FALLO: el renombrado no conservó el nombre anterior'
  end as resultado;

  -- Corregir solo la tilde NO debe dejar un alias redundante: la búsqueda ya
  -- normaliza, así que «Canon» encontraría «Cañón» sin ayuda.
  select public.rename_asset_type('cccccccc-1111-4111-8111-cccccccccccc', 'Amplificador de salá');

  select case
    when (select cardinality(aliases) from asset_types
           where id = 'cccccccc-1111-4111-8111-cccccccccccc') = 1
    then 'OK: una corrección de tilde no añade alias de más'
    else 'FALLO: se acumuló un alias que la normalización ya cubría'
  end as resultado;

  -- Fusionar mueve los equipos y hace que el nombre absorbido resuelva al bueno.
  select public.merge_asset_type(
    'cccccccc-1111-4111-8111-cccccccccccc',
    public.asset_type_id('Proyector'));

  select case
    when (select merged_into from asset_types where id = 'cccccccc-1111-4111-8111-cccccccccccc')
         = public.asset_type_id('Proyector')
     and public.asset_type_id('Amplificador raro') = public.asset_type_id('Proyector')
    then 'OK: fusionado, y el nombre absorbido ya resuelve a Proyector'
    else 'FALLO: la fusión no redirigió el nombre'
  end as resultado;
rollback;

\echo ''
\echo '=== 17. Dos equipos con la misma etiqueta en una sala: imposible ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  savepoint s;

  -- Es lo que hace legible una incidencia: si hay dos «Pantalla 2», el parte
  -- no dice cuál de las dos falla.
  do $$
  begin
    insert into assets (asset_type_id, room_id, label)
    select a.asset_type_id, a.room_id, a.label
      from assets a
     where a.room_id is not null and a.label is not null and a.status <> 'retirado'
     limit 1;
    raise exception 'FALLO: ha entrado una etiqueta duplicada en la misma sala';
  exception when unique_violation then
    raise notice 'OK: el índice impidió la etiqueta duplicada';
  end $$;
  rollback to savepoint s;
rollback;

\echo ''
\echo '=== 18. El mismo nombre de tipo no puede entrar dos veces ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  savepoint s;

  -- Aquí la defensa es del servidor. La del cliente es el id derivado del
  -- nombre, que hace que las dos altas sean literalmente la misma fila.
  do $$
  begin
    insert into asset_types (id, name) values
      ('dddddddd-1111-4111-8111-dddddddddddd', 'PROYECTOR');
    raise exception 'FALLO: ha entrado un segundo «Proyector»';
  exception when unique_violation then
    raise notice 'OK: el índice normalizado bloqueó el duplicado de grafía';
  end $$;
  rollback to savepoint s;
rollback;

\echo ''
\echo '=== 19. Un renombrado no puede dejar un alias ambiguo ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  -- «Canon» ya es alias de Proyector en el catálogo base.
  insert into asset_types (id, name) values
    ('eeeeeeee-1111-4111-8111-eeeeeeeeeeee', 'Canon');

  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');
  select public.rename_asset_type('eeeeeeee-1111-4111-8111-eeeeeeeeeeee', 'Proyector de repuesto');

  select case
    when not (select 'Canon' = any(aliases) from asset_types
               where id = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee')
     and public.asset_type_id('Canon') = public.asset_type_id('Proyector')
    then 'OK: no se robó el alias; «Canon» sigue siendo Proyector'
    else 'FALLO: «Canon» quedó apuntando a dos tipos'
  end as resultado;
rollback;

\echo ''
\echo '=== 20. Un anónimo no puede disparar el worker de informes ==='
begin;
  set local role anon;
  select set_config('request.jwt.claims', '', true);
  savepoint s;

  -- `request_report` es `security definer` y el `alter default privileges` del
  -- bootstrap concede execute a anon en TODA función nueva. Sin comprobación de
  -- rol dentro, cualquiera desde Internet generaba informes en bucle.
  do $$
  begin
    perform public.request_report('diario');
    raise exception 'FALLO: un anónimo ha disparado request_report';
  exception when insufficient_privilege then
    raise notice 'OK: request_report rechazó al anónimo';
  end $$;
  rollback to savepoint s;

  do $$
  begin
    perform public.link_tickets_by_ref();
    raise exception 'FALLO: un anónimo ha ejecutado link_tickets_by_ref';
  exception when insufficient_privilege then
    raise notice 'OK: link_tickets_by_ref rechazó al anónimo';
  end $$;
  rollback to savepoint s;
rollback;

\echo ''
\echo '=== 21. Un técnico tampoco pide informes ni enlaza tickets ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  savepoint s;

  do $$
  begin
    perform public.request_report('diario');
    raise exception 'FALLO: un técnico ha disparado request_report';
  exception when insufficient_privilege then
    raise notice 'OK: pedir informes es cosa del supervisor';
  end $$;
  rollback to savepoint s;
rollback;

\echo ''
\echo '=== 22. Renombrar o fusionar un tipo de equipo queda auditado ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  insert into asset_types (id, name) values
    ('ffffffff-1111-4111-8111-ffffffffffff', 'Trasto de prueba');

  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');
  select public.rename_asset_type('ffffffff-1111-4111-8111-ffffffffffff', 'Trasto corregido');

  -- Es la única decisión con consecuencias sobre el inventario —fusionar
  -- repunta equipos— que no dejaba rastro de autor.
  select case
    when exists (
      select 1 from audit_log
       where table_name = 'asset_types'
         and row_id = 'ffffffff-1111-4111-8111-ffffffffffff'
         and op = 'UPDATE'
         and by_user = '22222222-2222-4222-8222-222222222222'
    )
    then 'OK: el renombrado queda auditado con autor'
    else 'FALLO: el catálogo se modifica sin dejar rastro'
  end as resultado;
rollback;

\echo ''
\echo '=== 23. Un informe emitido dos veces no duplica la fila ==='
begin;
  -- El worker inserta con `on conflict do nothing`, pero no había ninguna
  -- restricción única con la que chocar: cada ejecución añadía una fila más
  -- apuntando al mismo PDF.
  insert into reports (kind, period_start, period_end, storage_path, content_hash)
  values ('diario', '2026-07-28', '2026-07-28', 'diario/x.pdf', 'abc123')
  on conflict do nothing;

  insert into reports (kind, period_start, period_end, storage_path, content_hash)
  values ('diario', '2026-07-28', '2026-07-28', 'diario/x.pdf', 'abc123')
  on conflict do nothing;

  select case
    when (select count(*) from reports
           where kind='diario' and period_start='2026-07-28' and content_hash='abc123') = 1
    then 'OK: la segunda emisión no duplica'
    else 'FALLO: ' || (select count(*) from reports
                        where kind='diario' and content_hash='abc123') || ' filas iguales'
  end as resultado;
rollback;

\echo ''
\echo '=== 24. Un consumo de almacén no puede ser positivo ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  savepoint s;

  -- `material_consumption_ranking` calcula sum(-qty): un consumo positivo
  -- habría producido consumos negativos en el informe.
  do $$
  begin
    insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user)
    select gen_random_uuid(), id, 5, 'consumo', now(),
           '11111111-1111-4111-8111-111111111111'
      from stock_items limit 1;
    raise exception 'FALLO: se ha registrado un consumo positivo';
  exception when check_violation then
    raise notice 'OK: la restricción impide un consumo positivo';
  end $$;
  rollback to savepoint s;
rollback;

\echo ''
\echo '=== 25. …pero el técnico SÍ sigue viendo las vistas ==='
begin;
  -- La cara opuesta de la 12. Poner `security_invoker` en las vistas cierra la
  -- fuga, y también podría haber cerrado la aplicación: el panel y la lista de
  -- salas leen de `room_overview` y de `stock_levels`.
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');

  select case
    when (select count(*) from room_overview) > 0
     and (select count(*) from stock_levels) > 0
     and (select count(*) from alerts_overdue_rooms) > 0
    then 'OK: el personal sigue leyendo las vistas con normalidad'
    else 'FALLO: security_invoker ha dejado sin datos a la aplicación — ' ||
         (select count(*) from room_overview) || ' salas, ' ||
         (select count(*) from stock_levels) || ' artículos'
  end as resultado;
rollback;

\echo ''
\echo '=== 26. El informe a medida exige y valida su rango de fechas ==='
begin;
  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');
  savepoint s;

  -- La pantalla recogía «Desde» y «Hasta» y los tiraba: la función solo tenía
  -- `kind`. Se pedía marzo y llegaba un PDF con los datos de ayer.
  do $$
  begin
    perform public.request_report('personalizado');
    raise exception 'FALLO: un informe a medida sin fechas ha pasado';
  exception when invalid_parameter_value then
    raise notice 'OK: un informe a medida sin fechas se rechaza';
  end $$;
  rollback to savepoint s;

  do $$
  begin
    perform public.request_report('personalizado', '2026-03-31', '2026-03-01');
    raise exception 'FALLO: se ha aceptado un rango al revés';
  exception when invalid_parameter_value then
    raise notice 'OK: la fecha final anterior a la inicial se rechaza';
  end $$;
  rollback to savepoint s;

  do $$
  begin
    perform public.request_report('personalizado', '2020-01-01', '2026-01-01');
    raise exception 'FALLO: se ha aceptado un rango de seis años';
  exception when invalid_parameter_value then
    raise notice 'OK: un periodo mayor de un año se rechaza';
  end $$;
  rollback to savepoint s;
rollback;

\echo ''
\echo '=== 27. Los límites del día son medianoche de Madrid, no de UTC ==='
begin;
  -- El caso que motivó todo esto. En verano Madrid va dos horas por delante de
  -- UTC: una revisión de las 00:30 del 15 de julio son las 22:30 del 14 en UTC.
  -- Comparando contra la zona de la sesión caía en el informe del día anterior.
  select case
    when public.dia_local('2026-07-15 00:30:00+02'::timestamptz) = date '2026-07-15'
     and public.dia_local('2026-07-15 23:30:00+02'::timestamptz) = date '2026-07-15'
    then 'OK: la madrugada y la noche del 15 pertenecen al 15'
    else 'FALLO: ' || public.dia_local('2026-07-15 00:30:00+02'::timestamptz)
  end as resultado;

  -- Y el cambio de hora: en enero el desfase es de una hora, no de dos.
  select case
    when public.inicio_del_dia(date '2026-07-15') = '2026-07-14 22:00:00+00'::timestamptz
     and public.inicio_del_dia(date '2026-01-15') = '2026-01-14 23:00:00+00'::timestamptz
    then 'OK: el desfase sigue al horario de verano y de invierno'
    else 'FALLO: verano ' || public.inicio_del_dia(date '2026-07-15')
                || ' / invierno ' || public.inicio_del_dia(date '2026-01-15')
  end as resultado;

  -- El rango completo de un día, tal y como lo usa el worker.
  select case
    when public.inicio_del_dia(date '2026-07-16') - public.inicio_del_dia(date '2026-07-15')
         = interval '24 hours'
    then 'OK: un día normal dura 24 horas'
    else 'FALLO: el día mide ' ||
         (public.inicio_del_dia(date '2026-07-16') - public.inicio_del_dia(date '2026-07-15'))
  end as resultado;

  -- El domingo del cambio de hora de marzo dura 23. Si esto diera 24, el rango
  -- se solaparía con el día siguiente.
  select case
    when public.inicio_del_dia(date '2026-03-30') - public.inicio_del_dia(date '2026-03-29')
         = interval '23 hours'
    then 'OK: el domingo del cambio de hora dura 23'
    else 'FALLO: mide ' ||
         (public.inicio_del_dia(date '2026-03-30') - public.inicio_del_dia(date '2026-03-29'))
  end as resultado;
rollback;

\echo ''
\echo '=== 28. Una incidencia de madrugada cuenta en su mes de Madrid ==='
begin;
  -- `date_trunc` sobre un timestamptz trunca en la zona de la sesión: el 1 de
  -- marzo a las 00:30 de Madrid son las 23:30 del 28 de febrero en UTC, y la
  -- incidencia se contaba en febrero.
  insert into incidents (id, title, severity, state, opened_at, source)
  values ('aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', 'Prueba de mes',
          'media', 'abierta', '2026-03-01 00:30:00+01', 'app');

  select case
    when exists (select 1 from incidents_by_month
                  where month = '2026-03'
                    and total >= 1)
    then 'OK: la incidencia de las 00:30 del 1 de marzo cuenta en marzo'
    else 'FALLO: se ha contado en otro mes'
  end as resultado;
rollback;
