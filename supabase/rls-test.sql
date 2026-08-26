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

  -- Pero sí puede descontar lo que gasta en el aula. El artículo se elige entre
  -- los que tienen existencias: desde que el saldo no puede quedar en negativo,
  -- «el primero que salga» falla si resulta ser uno de los que están a cero.
  insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user)
  select '44444444-4444-4444-8444-444444444442', stock_item_id, -1, 'consumo', now(),
         '11111111-1111-4111-8111-111111111111'
  from stock_levels order by on_hand desc limit 1;
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
\echo '=== 8. Las existencias no pueden quedar en negativo ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  savepoint s;

  -- Que el saldo sea una suma impide teclear una cifra a mano, que es de donde
  -- salían los negativos de la hoja Bolsa. No impedía restar más de lo que hay:
  -- con el botón `−` de la pantalla, un artículo a cero se quedaba en −1.
  do $$
  declare v_item uuid; v_saldo int;
  begin
    select stock_item_id, on_hand into v_item, v_saldo
      from stock_levels order by on_hand desc limit 1;

    insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user)
    values (gen_random_uuid(), v_item, -(v_saldo + 1), 'consumo', now(),
            '11111111-1111-4111-8111-111111111111');
    raise exception 'FALLO: el almacén se ha quedado en negativo';
  exception when check_violation then
    raise notice 'OK: no se puede gastar más de lo que hay';
  end $$;
  rollback to savepoint s;

  -- Pero el saldo que ya está descuadrado tiene que poder cuadrarse: si no, un
  -- almacén en negativo se quedaría sin forma de salir de ahí.
  select 'OK: quedan ' || count(*) || ' artículos en negativo' as resultado
  from stock_levels where on_hand < 0;
rollback;

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
\echo '=== 17. Dos equipos con la misma etiqueta en una sala: se recoloca, no se rechaza ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');

  -- La regla no cambia: si hay dos «Pantalla 2», el parte no dice cuál de las
  -- dos falla. Lo que cambia es quién la hace cumplir.
  --
  -- Antes la hacía cumplir el índice único a base de 409, y eso convertía un
  -- espejo de minutos —el técnico calcula la etiqueta con lo que su iPad sabe—
  -- en una fila atascada para siempre en la cola de salida, con un mensaje que
  -- el técnico no puede atender y administración tampoco: la fila está en el
  -- dispositivo de otra persona. Ahora la hace cumplir el servidor, que es el
  -- único que ve la sala entera, dándole el siguiente número libre.
  select a.id as original, a.room_id as sala, a.label as etiqueta
    from assets a
   where a.room_id is not null and a.label is not null and a.status <> 'retirado'
   limit 1 \gset

  insert into assets (id, asset_type_id, room_id, label, created_by)
  select 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', a.asset_type_id, a.room_id, a.label,
         '11111111-1111-4111-8111-111111111111'
    from assets a where a.id = :'original';

  select case
    when (select label from assets where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1')
         is distinct from :'etiqueta'
     and not exists (
       select 1 from assets
        where room_id = :'sala' and label is not null and status <> 'retirado'
        group by public.norm_text(label) having count(*) > 1)
    then 'OK: «' || :'etiqueta' || '» chocaba y ha entrado como «' ||
         (select label from assets where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1') ||
         '», sin duplicados en la sala'
    else 'FALLO: la etiqueta duplicada no se ha recolocado'
  end as resultado;
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

\echo ''
\echo '=== 29. Un movimiento de almacén no se corrige, se contrapone ==='
begin;
  -- Era la única tabla con consecuencias económicas que se podía reescribir, y
  -- además la única que no estaba auditada: se podía cambiar una cifra sin
  -- dejar rastro de quién ni de qué decía antes. Ahora la frenan dos capas, y
  -- fallan distinto a propósito.

  -- Capa 1 — RLS. Sin política de UPDATE la fila ni siquiera es visible para
  -- escribir: el `update` no da error, no toca nada. Comprobarlo con una
  -- excepción habría sido comprobar lo que no pasa.
  select test_as('33333333-3333-4333-8333-333333333333', 'supervisor');
  savepoint s;
  update stock_movements set qty = qty + 100;
  select case
    when (select count(*) from stock_movements where qty > 90) = 0
    then 'OK: RLS no deja reescribir ningún movimiento'
    else 'FALLO: un supervisor ha reescrito ' ||
         (select count(*) from stock_movements where qty > 90) || ' asientos'
  end as resultado;
  rollback to savepoint s;
  reset role;

  -- Capa 2 — el disparador, para quien se salta la RLS (service-role, o quien
  -- entra por psql). Aquí sí tiene que doler.
  savepoint s2;
  do $$
  declare v_mov uuid;
  begin
    select id into v_mov from stock_movements limit 1;
    update stock_movements set qty = qty + 100 where id = v_mov;
    raise exception 'FALLO: se ha reescrito un asiento del almacén';
  exception when check_violation then
    raise notice 'OK: el disparador tampoco lo deja pasar por debajo de la RLS';
  end $$;
  rollback to savepoint s2;

  do $$
  declare v_mov uuid;
  begin
    select id into v_mov from stock_movements limit 1;
    delete from stock_movements where id = v_mov;
    raise exception 'FALLO: se ha borrado un asiento del almacén';
  exception when check_violation then
    raise notice 'OK: tampoco se borra';
  end $$;
rollback;

\echo '=== 30. El consumo del histórico llegó al almacén con su destino ==='
begin;
  -- El Excel traía el material usado en cada incidencia y no salía de ahí: no
  -- había ni un movimiento de tipo `consumo`, así que el top de material del
  -- informe diario salía en blanco.
  select case
    when (select count(*) from stock_movements where kind = 'consumo') = 0
      then 'ATENCIÓN: el almacén no registra ningún consumo'
    when (select count(*) from stock_movements
           where kind = 'consumo' and incident_id is null) > 0
      then 'ATENCIÓN: hay consumos sin incidencia'
    else 'OK: ' || (select count(*) from stock_movements where kind = 'consumo') ||
         ' consumos, todos con incidencia y ' ||
         (select count(*) from stock_movements where kind = 'consumo' and room_id is not null) ||
         ' con sala'
  end as resultado;
rollback;

\echo ''
\echo '=== 31. El histórico de una sala se lee entero y con una sola consulta ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');

  -- `room_timeline` une cinco tablas con `security_invoker`, así que basta con
  -- que UNA de ellas tenga la RLS mal puesta para que el histórico salga
  -- truncado sin ningún error: la lista simplemente enseñaría menos cosas.
  select case
    when (select count(distinct kind) from room_timeline) >= 3  -- revision_ok, incidencia, material…
    then 'OK: el técnico ve ' || (select count(*) from room_timeline) || ' entradas de ' ||
         (select count(distinct kind) from room_timeline) || ' familias'
    else 'FALLO: el técnico solo ve las familias ' ||
         coalesce((select string_agg(distinct kind, ', ') from room_timeline), 'ninguna')
  end as resultado;
rollback;

\echo ''
\echo '=== 32. Un anónimo NO ve el histórico ==='
begin;
  set local role anon;
  select set_config('request.jwt.claims', '', true);
  select case
    when (select count(*) from room_timeline) = 0
    then 'OK: sin token, el histórico está vacío'
    else 'FALLO: ' || (select count(*) from room_timeline) || ' entradas legibles desde Internet'
  end as resultado;
rollback;

\echo ''
\echo '=== 33. Cada artículo de almacén que es un equipo sabe de qué tipo ==='
begin;
  -- Sin este puente, dar de alta un proyector en un aula no puede descontar
  -- nada del almacén: son dos mundos que no se tocan.
  select case
    when (select count(*) from stock_items where asset_type_id is not null) >= 10
    then 'OK: ' || (select count(*) from stock_items where asset_type_id is not null) ||
         ' artículos enlazados con su tipo de equipo'
    else 'ATENCIÓN: solo ' || (select count(*) from stock_items where asset_type_id is not null) ||
         ' artículos enlazados'
  end as resultado;
rollback;

\echo ''
\echo '=== 34. El técnico levanta inventario, y ese acto no se reescribe ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  savepoint s;

  -- Es quien está en el aula, así que tiene que poder decir «esto es todo lo
  -- que hay». Sin esto, las 41 salas sin equipos se quedan pendientes para
  -- siempre y el aviso se convierte en ruido.
  insert into room_inventories (id, room_id, by_user, occurred_at, asset_count)
  select gen_random_uuid(), id, '11111111-1111-4111-8111-111111111111', now(), 3
    from rooms limit 1;

  select case
    when (select count(*) from room_overview where last_inventory_at is not null) = 1
    then 'OK: la sala deja de estar pendiente'
    else 'FALLO: el levantamiento no llega a room_overview'
  end as resultado;

  -- Pero no puede firmarlo en nombre de otro.
  do $$
  begin
    insert into room_inventories (id, room_id, by_user, occurred_at, asset_count)
    select gen_random_uuid(), id, '22222222-2222-4222-8222-222222222222', now(), 0
      from rooms limit 1;
    raise exception 'FALLO: ha firmado un levantamiento en nombre de otro';
  exception when insufficient_privilege then
    raise notice 'OK: solo puede firmar lo suyo';
  end $$;
  rollback to savepoint s;
rollback;

\echo ''
\echo '=== 35. El levantamiento sale en el histórico de la sala ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  insert into room_inventories (id, room_id, by_user, occurred_at, asset_count)
  select gen_random_uuid(), id, '11111111-1111-4111-8111-111111111111', now(), 5
    from rooms limit 1;

  select case
    when (select count(*) from room_timeline where kind = 'inventario') = 1
    then 'OK: «' || (select title from room_timeline where kind = 'inventario') || '» · ' ||
         (select detail from room_timeline where kind = 'inventario')
    else 'FALLO: el levantamiento no aparece en el histórico'
  end as resultado;
rollback;

-- =============================================================================
-- El panel de administración
--
-- A partir de aquí hace falta un tercer usuario: `is_admin()` no es
-- `is_supervisor()`, y toda la diferencia entre las dos está en quién puede
-- tocar el maestro.
-- =============================================================================

insert into auth.users (id, email) values
  ('44444444-4444-4444-8444-444444444444', 'admin@test.local')
on conflict do nothing;

update profiles set role = 'admin' where id = '44444444-4444-4444-8444-444444444444';

\echo ''
\echo '=== 36. Un equipo apuntado desde el aula nace sin validar ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  savepoint s;

  insert into assets (id, asset_type_id, room_id, label, created_by)
  select '55555555-5555-4555-8555-555555555551',
         public.asset_type_id('Proyector'),
         id,
         'Proyector de prueba',
         '11111111-1111-4111-8111-111111111111'
    from rooms limit 1;

  select case
    when not (select confirmed from assets where id = '55555555-5555-4555-8555-555555555551')
    then 'OK: el equipo entra sin validar'
    else 'FALLO: se ha dado por bueno solo'
  end as resultado;

  -- Y no puede darse el visto bueno a sí mismo. La política de UPDATE tiene que
  -- seguir dejándole corregir la etiqueta —es su trabajo— así que quien lo
  -- impide es el disparador, no la RLS: la columna simplemente no se mueve.
  update assets
     set confirmed = true, label = 'Proyector corregido'
   where id = '55555555-5555-4555-8555-555555555551';

  select case
    when not (select confirmed from assets where id = '55555555-5555-4555-8555-555555555551')
     and (select label from assets where id = '55555555-5555-4555-8555-555555555551') = 'Proyector corregido'
    then 'OK: la corrección pasa y la validación no'
    else 'FALLO: el técnico se ha autovalidado un equipo'
  end as resultado;

  do $$
  begin
    perform public.confirm_assets(array['55555555-5555-4555-8555-555555555551'::uuid]);
    raise exception 'FALLO: confirm_assets aceptó a un técnico';
  exception when insufficient_privilege then
    raise notice 'OK: confirm_assets rechazó al técnico';
  end $$;
  rollback to savepoint s;
rollback;

\echo ''
\echo '=== 37. Agrupar tipos renombra el equipo en TODAS las salas ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');

  -- Tres formas de escribir el mismo micrófono, como llegan de verdad.
  insert into asset_types (id, name) values
    ('66666666-6666-4666-8666-666666666661', 'Jabra'),
    ('66666666-6666-4666-8666-666666666662', 'Mic Jabra'),
    ('66666666-6666-4666-8666-666666666663', 'Micro jabra');

  insert into assets (asset_type_id, room_id, label, created_by)
  select t.id, r.id, t.name, '11111111-1111-4111-8111-111111111111'
    from asset_types t
    cross join (select id from rooms order by created_at limit 2) r
   where t.id in ('66666666-6666-4666-8666-666666666661',
                  '66666666-6666-4666-8666-666666666662',
                  '66666666-6666-4666-8666-666666666663');

  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');

  select case
    when public.group_asset_types(
           array['66666666-6666-4666-8666-666666666661',
                 '66666666-6666-4666-8666-666666666662',
                 '66666666-6666-4666-8666-666666666663']::uuid[],
           '66666666-6666-4666-8666-666666666661',
           'Micrófono Jabra') = 2
    then 'OK: dos tipos absorbidos'
    else 'FALLO: la agrupación no absorbió lo que debía'
  end as resultado;

  -- Lo que se lee en el aula es la etiqueta del equipo, no el nombre del tipo:
  -- si esta parte no viaja, el renombrado global no ha renombrado nada.
  select case
    when (select count(*) from assets
           where asset_type_id = '66666666-6666-4666-8666-666666666661'
             and public.norm_text(label) like 'MICROFONO JABRA%') = 6
    then 'OK: las 6 etiquetas de las dos salas dicen ya «Micrófono Jabra»'
    else 'FALLO: quedan etiquetas con el nombre viejo: ' ||
         coalesce((select string_agg(distinct label, ', ') from assets
                    where asset_type_id = '66666666-6666-4666-8666-666666666661'
                      and public.norm_text(label) not like 'MICROFONO JABRA%'), 'ninguna')
  end as resultado;

  -- Y ninguna sala se ha quedado con dos equipos llamados igual, que es lo que
  -- haría un renombrado a lo bruto contra el índice único.
  select case
    when not exists (
      select 1 from assets where room_id is not null and label is not null and status <> 'retirado'
       group by room_id, public.norm_text(label) having count(*) > 1)
    then 'OK: ni una etiqueta duplicada tras la agrupación'
    else 'FALLO: hay etiquetas repetidas dentro de una sala'
  end as resultado;

  select case
    when (select name from asset_types where id = public.asset_type_id('mic jabra')) = 'Micrófono Jabra'
    then 'OK: quien escriba «mic jabra» sigue encontrándolo'
    else 'FALLO: el nombre absorbido dejó de resolver'
  end as resultado;
rollback;

\echo ''
\echo '=== 38. El equipamiento por defecto: el del edificio manda sobre el global ==='
begin;
  select test_as('44444444-4444-4444-8444-444444444444', 'admin');
  select id as ed from buildings order by sort_order limit 1 \gset

  select public.set_asset_default(public.asset_type_id('Pantalla'), null, 1) is not null as g1 \gset
  select public.set_asset_default(public.asset_type_id('Pantalla'), :'ed', 2) is not null as g2 \gset

  -- Declarar dos veces lo mismo corrige la cantidad, no revienta: el ámbito lo
  -- protegen dos índices únicos parciales y `on conflict` no sabe inferirlos.
  select case
    when (select count(*) from asset_defaults) = 2
     and (select qty from asset_defaults where building_id = :'ed') = 2
    then 'OK: un defecto global y uno de edificio, sin duplicar'
    else 'FALLO: el ámbito no se respeta'
  end as resultado;

  select public.apply_asset_defaults(:'ed') as creados \gset
  select case
    when (select public.apply_asset_defaults(:'ed')) = 0
    then 'OK: ' || :'creados' || ' equipos creados, y la segunda pasada no duplica ninguno'
    else 'FALLO: aplicar dos veces vuelve a crear equipos'
  end as resultado;

  -- Dos pantallas en cada sala del edificio: ha ganado el defecto del edificio.
  select case
    when not exists (
      select 1 from rooms r join zones z on z.id = r.zone_id
       where z.building_id = :'ed' and r.active
         and (select count(*) from assets a
               where a.room_id = r.id
                 and a.asset_type_id = public.asset_type_id('Pantalla')
                 and a.status <> 'retirado') < 2)
    then 'OK: todas las salas del edificio llegan a las dos pantallas'
    else 'FALLO: alguna sala se quedó con el defecto global'
  end as resultado;

  -- Y lo que materializa una máquina no acaba en la bandeja del coordinador.
  select case
    when not exists (select 1 from assets where created_by is null and not confirmed)
    then 'OK: el equipamiento por defecto nace validado'
    else 'FALLO: ' || (select count(*) from assets where created_by is null and not confirmed) ||
         ' equipos del maestro esperando visto bueno'
  end as resultado;

  do $$
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', '11111111-1111-4111-8111-111111111111', 'app_role', 'tecnico')::text, true);
    perform public.apply_asset_defaults(null);
    raise exception 'FALLO: un técnico aplicó el equipamiento por defecto';
  exception when insufficient_privilege then
    raise notice 'OK: aplicar el equipamiento por defecto es cosa del administrador';
  end $$;
rollback;

\echo ''
\echo '=== 39. Solo el administrador da de alta salas y edificios ==='
begin;
  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');
  do $$
  begin
    perform public.create_building('ZZ', 'Edificio de prueba');
    raise exception 'FALLO: un supervisor creó un edificio';
  exception when insufficient_privilege then
    raise notice 'OK: ni siquiera el supervisor toca el maestro';
  end $$;
rollback;

begin;
  select test_as('44444444-4444-4444-8444-444444444444', 'admin');

  -- Un defecto declarado antes de crear la sala: lo que se comprueba es que la
  -- sala nueva NACE con él, sin que nadie tenga que acordarse de aplicarlo.
  select public.set_asset_default(public.asset_type_id('Proyector'), null, 1) is not null as d \gset

  select public.create_building('ZZ', 'Edificio de prueba') as ed \gset
  select public.create_room(:'ed', '1ª Planta', '1.1', '', 'aula') as sala \gset

  select case
    when (select short_ref from rooms where id = :'sala') like 'SALA-%'
     and (select count(*) from assets where room_id = :'sala') = 1
     and (select label from assets where room_id = :'sala') = 'Proyector'
    then 'OK: la sala nueva nace con matrícula ' ||
         (select short_ref from rooms where id = :'sala') || ' y con su proyector'
    else 'FALLO: la sala nueva ha nacido incompleta'
  end as resultado;

  -- La misma planta escrita de otra forma no crea una planta nueva.
  select public.create_room(:'ed', '1ª PLANTA', '1.2', 'Aula grande') as sala2 \gset
  select case
    when (select count(*) from zones where building_id = :'ed') = 1
    then 'OK: «1ª Planta» y «1ª PLANTA» son la misma planta'
    else 'FALLO: la zona se ha duplicado por la grafía'
  end as resultado;

  -- Aquí se afirmaba que dar de baja un edificio con salas dentro reventaba.
  -- Desde `20260806000100` no revienta: lo archiva. Es el mismo contrato que
  -- `delete_room` ya tenía —el servidor decide entre borrar y archivar, y dice
  -- cuál de las dos ha hecho— y lo que se comprueba es justo eso: que el
  -- edificio sale de la lista de trabajo SIN que sus salas se enteren, porque
  -- restaurarlo tiene que devolver exactamente lo que había.
  --
  -- En su propia sentencia, por lo mismo que en el bloque 40: dentro de un
  -- único `select`, lo que escriba la función no lo ven las subconsultas de al
  -- lado y la comprobación mediría el estado de antes.
  select public.delete_building(:'ed') as baja \gset

  select case
    when :'baja' = 'archivado'
     and (select count(*) from room_overview where building_id = :'ed') = 0
     and (select count(*) from rooms r join zones z on z.id = r.zone_id
           where z.building_id = :'ed' and r.active) = 2
    then 'OK: el edificio sale de la lista de trabajo con sus salas intactas'
    else 'FALLO: la baja del edificio no ha archivado'
  end as resultado;
rollback;

\echo ''
\echo '=== 40. Dar de baja una sala con histórico la archiva, no la borra ==='
begin;
  select test_as('44444444-4444-4444-8444-444444444444', 'admin');
  select id as sala from rooms where active order by created_at limit 1 \gset

  insert into inspections (id, room_id, by_user, occurred_at, status, overall)
  values ('77777777-7777-4777-8777-777777777771', :'sala',
          '44444444-4444-4444-8444-444444444444', now(), 'completa', 'ok');

  -- La baja va en su propia sentencia: dentro de un mismo `select`, lo que
  -- escriba la función no lo ven las subconsultas de al lado —comparten
  -- instantánea— y la comprobación mediría el estado de antes.
  select public.delete_room(:'sala') as baja \gset

  select case
    when :'baja' = 'archivada'
     and (select count(*) from room_overview where room_id = :'sala') = 0
     and (select count(*) from archived_rooms where room_id = :'sala') = 1
     -- Por id y no por recuento: la sala puede arrastrar revisiones del seed, y
     -- lo que se afirma es que la baja no se llevó por delante ninguna.
     and exists (select 1 from inspections where id = '77777777-7777-4777-8777-777777777771')
    then 'OK: fuera de la lista de trabajo y con su revisión intacta'
    else 'FALLO: la baja no ha archivado la sala'
  end as resultado;

  select public.restore_room(:'sala');
  select case
    when (select count(*) from room_overview where room_id = :'sala') = 1
    then 'OK: y se puede deshacer'
    else 'FALLO: la sala no vuelve'
  end as resultado;

  do $$
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', '11111111-1111-4111-8111-111111111111', 'app_role', 'tecnico')::text, true);
    perform public.delete_room((select id from rooms limit 1));
    raise exception 'FALLO: un técnico dio de baja una sala';
  exception when insufficient_privilege then
    raise notice 'OK: dar de baja una sala es cosa del administrador';
  end $$;
rollback;

\echo ''
\echo '=== 41. La tubería del informe no la abre nadie de fuera ==='
begin;
  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');
  -- `enviar_informe` no comprueba roles porque no tiene que ser alcanzable: lo
  -- que la protege es el permiso. Si algún día alguien la vuelve a conceder sin
  -- darse cuenta —el `alter default privileges` del bootstrap lo hace con cada
  -- función nueva—, esta prueba se pone en rojo.
  do $$
  begin
    perform public.enviar_informe('semanal', null, null, '{}'::jsonb, null);
    raise exception 'FALLO: un supervisor ha podido llamar a la tubería interna';
  exception when insufficient_privilege then
    raise notice 'OK: enviar_informe está revocada para authenticated';
  end $$;

  do $$
  begin
    perform public.informe_semanal_programado();
    raise exception 'FALLO: se ha podido disparar el informe programado a mano';
  exception when insufficient_privilege then
    raise notice 'OK: el trabajo del viernes solo lo ejecuta el cron';
  end $$;
rollback;

\echo ''
\echo '=== 42. Los parámetros del informe se validan antes de salir ==='
begin;
  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');
  savepoint s;

  do $$
  begin
    perform public.request_report('semanal', null, null,
      jsonb_build_object('secciones', jsonb_build_array('resumen; drop table rooms')));
    raise exception 'FALLO: ha pasado un nombre de sección con SQL dentro';
  exception when invalid_parameter_value then
    raise notice 'OK: el nombre de sección raro se rechaza';
  end $$;
  rollback to savepoint s;

  do $$
  begin
    perform public.request_report('semanal', null, null,
      jsonb_build_object('audiencia', 'quien sea'));
    raise exception 'FALLO: ha pasado una audiencia inventada';
  exception when invalid_parameter_value then
    raise notice 'OK: la audiencia se valida contra la lista';
  end $$;
  rollback to savepoint s;

  do $$
  begin
    perform public.request_report('semanal', null, null,
      jsonb_build_object('enfoque', repeat('x', 500)));
    raise exception 'FALLO: ha pasado un enfoque de 500 caracteres';
  exception when invalid_parameter_value then
    raise notice 'OK: el texto libre tiene tope';
  end $$;
  rollback to savepoint s;

  do $$
  begin
    perform public.request_report('semanal', null, null, '"soy una cadena"'::jsonb);
    raise exception 'FALLO: ha pasado un params que no es un objeto';
  exception when invalid_parameter_value then
    raise notice 'OK: params tiene que ser un objeto';
  end $$;
  rollback to savepoint s;
rollback;

\echo ''
\echo '=== 43. El estado de la IA no devuelve la clave ==='
begin;
  -- La clave la guarda un administrador; el estado lo consulta el supervisor.
  select test_as('22222222-2222-4222-8222-222222222222', 'admin');
  select public.ia_configurar('AIzaSyDEMOdemoDEMOdemoDEMOdemo123456', 'gemini-3.6-flash', 'high');

  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');
  select case
    when (public.ia_estado()->>'clave_guardada')::boolean
     and public.ia_estado()::text not like '%AIzaSy%'
    then 'OK: dice que hay clave y no la enseña'
    else 'FALLO: ' || public.ia_estado()::text
  end as resultado;

  -- Un supervisor consulta el estado; configurar es de administrador, porque lo
  -- que se guarda ahí es un secreto que se paga por uso.
  do $$
  begin
    perform public.ia_configurar('AIzaSyOTRAotraOTRAotraOTRAotra9876');
    raise exception 'FALLO: un supervisor ha cambiado la clave de la IA';
  exception when insufficient_privilege then
    raise notice 'OK: solo un administrador configura la IA';
  end $$;
rollback;

\echo ''
\echo '=== 44. Un técnico no ve ni toca la configuración de la IA ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  do $$
  begin
    perform public.ia_estado();
    raise exception 'FALLO: un técnico ha leído el estado de la IA';
  exception when insufficient_privilege then
    raise notice 'OK: el estado de la IA es de supervisor para arriba';
  end $$;

  select case
    when (select count(*) from app_config) = 0
    then 'OK: app_config sigue invisible para un técnico'
    else 'FALLO: un técnico lee app_config'
  end as resultado;
rollback;

\echo '=== 45. Un equipo que falla en la revisión abre incidencia, y sigue abierta ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select id as sala from rooms where active order by created_at limit 1 \gset
  select id as equipo from assets where room_id = :'sala' limit 1 \gset

  -- La revisión, en el mismo orden que la hace el dispositivo: nace borrador,
  -- se le escriben las comprobaciones y se cierra al final. Al revés no se
  -- puede, y a propósito: a una revisión cerrada no se le añaden filas.
  insert into inspections (id, room_id, by_user, occurred_at, status)
  values ('77777777-7777-4777-8777-777777777781', :'sala',
          '11111111-1111-4111-8111-111111111111', now(), 'borrador');

  insert into inspection_checks (id, inspection_id, check_key, result, severity, note)
  values ('77777777-7777-4777-8777-777777777782',
          '77777777-7777-4777-8777-777777777781',
          'asset:' || :'equipo', 'incidencia', 'alta', 'No da imagen');

  update inspections set status = 'completa', overall = 'con_incidencias'
   where id = '77777777-7777-4777-8777-777777777781';

  -- Y la incidencia que abre el cliente al cerrarla. Lo que se afirma es que el
  -- TÉCNICO puede insertarla: si la política se lo negara, el fallo se quedaría
  -- para siempre dentro de la revisión, que es el problema que esto arregla.
  insert into incidents (id, room_id, asset_id, opened_from_inspection_id, check_key,
                         title, description, severity, state, kind, opened_at, opened_by)
  values ('77777777-7777-4777-8777-777777777783', :'sala', :'equipo',
          '77777777-7777-4777-8777-777777777781', 'asset:' || :'equipo',
          'Proyector: No da imagen', 'No da imagen', 'alta', 'abierta', 'incidencia',
          now(), '11111111-1111-4111-8111-111111111111');

  select case
    when (select count(*) from incidents
           where opened_from_inspection_id = '77777777-7777-4777-8777-777777777781'
             and state = 'abierta' and asset_id = :'equipo') = 1
     -- Y cuenta en la sala: el recuento de la ficha sale de aquí.
     and (select open_incidents from room_overview where room_id = :'sala') >= 1
    then 'OK: la avería sale de la revisión y cuenta en la sala'
    else 'FALLO: el fallo del equipo no llegó a ser incidencia'
  end as resultado;

  -- Y no la cierra quien la abrió: cerrar sigue siendo del supervisor, que es
  -- lo que hace que «hasta que se solucione» signifique algo.
  do $$
  begin
    update incidents set state = 'resuelta', resolved_at = now()
     where id = '77777777-7777-4777-8777-777777777783';
    if found then raise exception 'FALLO: el técnico cerró su propia incidencia'; end if;
    raise notice 'OK: sigue abierta hasta que la cierre un supervisor';
  end $$;

  -- El técnico ve la suya en la lista de trabajo, y la observación de la
  -- revisión NO está ahí: vive en `inspections.notes`.
  select case
    when (select count(*) from incidents
           where id = '77777777-7777-4777-8777-777777777783'
             and kind = 'incidencia') = 1
    then 'OK: entra como incidencia, no como observación'
    else 'FALLO: la avería no entró como incidencia'
  end as resultado;
rollback;

\echo ''
\echo '=== 46. La observación de una revisión se lee en la ficha, no en Incidencias ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select id as sala from rooms where active order by created_at limit 1 \gset

  insert into inspections (id, room_id, by_user, occurred_at, status, overall, notes)
  values ('77777777-7777-4777-8777-777777777791', :'sala',
          '11111111-1111-4111-8111-111111111111', now(), 'completa', 'ok',
          'El mando aparece en el cajón de la mesa');

  select case
    -- La ficha la pide así: revisiones de esta sala que traen nota.
    when (select count(*) from room_timeline
           where room_id = :'sala' and kind in ('revision_ok', 'revision_ko')
             and detail = 'El mando aparece en el cajón de la mesa') = 1
     -- Y no ha nacido ninguna incidencia por escribirla.
     and (select count(*) from incidents
           where opened_from_inspection_id = '77777777-7777-4777-8777-777777777791') = 0
    then 'OK: la observación se consulta en la sala y no abre nada'
    else 'FALLO: la observación no se puede consultar, o abrió una incidencia'
  end as resultado;
rollback;

\echo ''
\echo '=== 47. Sacar un equipo de una sala es una solicitud, no un toque ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  savepoint s;

  -- Un equipo cuyo tipo SÍ tiene artículo de almacén: es el caso que importa,
  -- porque es el que tiene que acabar sumando una unidad.
  select a.id as equipo, a.room_id as sala
    from assets a
    join stock_items si on si.asset_type_id = a.asset_type_id and si.active
   where a.room_id is not null and a.status <> 'retirado'
   limit 1 \gset

  insert into asset_removals (id, asset_id, room_id, destino, reason, requested_at, requested_by)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', :'equipo', :'sala', 'almacen',
          'Sobra en el aula', now(), '11111111-1111-4111-8111-111111111111');

  select case
    when (select status from assets where id = :'equipo') <> 'retirado'
     and (select count(*) from asset_removal_queue where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1') = 1
    then 'OK: pedida, y el equipo sigue en la sala mientras tanto'
    else 'FALLO: la solicitud ha retirado el equipo por su cuenta'
  end as resultado;

  -- No puede firmarla en nombre de otro, ni colarla ya aprobada.
  do $$
  begin
    insert into asset_removals (id, asset_id, room_id, destino, requested_at, requested_by, state)
    select gen_random_uuid(), a.id, a.room_id, 'baja', now(),
           '11111111-1111-4111-8111-111111111111', 'aprobada'
      from assets a where a.room_id is not null and a.status <> 'retirado' limit 1;
    raise exception 'FALLO: se coló una retirada ya aprobada';
  exception when insufficient_privilege then
    raise notice 'OK: RLS no deja autoaprobarse una retirada';
  end $$;

  -- Ni autorizarla.
  do $$
  begin
    perform public.decide_asset_removal('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', true, null);
    raise exception 'FALLO: un técnico autorizó su propia retirada';
  exception when insufficient_privilege then
    raise notice 'OK: autorizar es cosa del coordinador';
  end $$;
  rollback to savepoint s;
rollback;

\echo ''
\echo '=== 48. Autorizada al almacén: el equipo sale y la unidad entra ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select a.id as equipo, a.room_id as sala
    from assets a
    join stock_items si on si.asset_type_id = a.asset_type_id and si.active
   where a.room_id is not null and a.status <> 'retirado'
   limit 1 \gset
  select si.id as item
    from assets a join stock_items si on si.asset_type_id = a.asset_type_id and si.active
   where a.id = :'equipo' limit 1 \gset
  select on_hand as antes from stock_levels where stock_item_id = :'item' \gset

  insert into asset_removals (id, asset_id, room_id, destino, requested_at, requested_by)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', :'equipo', :'sala', 'almacen', now(),
          '11111111-1111-4111-8111-111111111111');

  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');
  -- En su propia sentencia: dentro de un mismo `select`, lo que escriba la
  -- función no lo ven las subconsultas de al lado.
  select public.decide_asset_removal('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', true, 'De acuerdo') as fin \gset

  select case
    when :'fin' = 'almacen'
     and (select status from assets where id = :'equipo') = 'retirado'
     and (select room_id from assets where id = :'equipo') is null
     and (select on_hand from stock_levels where stock_item_id = :'item') = :'antes'::int + 1
    then 'OK: fuera del aula y ' || :'antes' || ' → ' ||
         (select on_hand from stock_levels where stock_item_id = :'item') || ' en el almacén'
    else 'FALLO: la retirada al almacén no ha cuadrado'
  end as resultado;

  -- Y la baja queda en el histórico de LA SALA, aunque el equipo ya no tenga
  -- sala: por eso la solicitud se guarda su `room_id`.
  select case
    when (select count(*) from room_timeline
           where room_id = :'sala' and kind = 'equipo' and subkind = 'baja') >= 1
    then 'OK: la baja se lee en el histórico de la sala'
    else 'FALLO: la baja no aparece en ninguna sala'
  end as resultado;

  -- Y no se puede decidir dos veces: la segunda ingresaría otra unidad.
  do $$
  begin
    perform public.decide_asset_removal('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', true, null);
    raise exception 'FALLO: se autorizó dos veces la misma retirada';
  exception when others then
    if sqlerrm like 'FALLO%' then raise; end if;
    raise notice 'OK: %', sqlerrm;
  end $$;
rollback;

\echo ''
\echo '=== 49. Dos retiradas vivas del mismo equipo: imposible ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select id as equipo, room_id as sala from assets
   where room_id is not null and status <> 'retirado' limit 1 \gset

  insert into asset_removals (id, asset_id, room_id, destino, requested_at, requested_by)
  values (gen_random_uuid(), :'equipo', :'sala', 'baja', now(),
          '11111111-1111-4111-8111-111111111111');

  -- Dos técnicos pidiendo lo mismo la misma mañana retirarían dos veces el
  -- mismo aparato y, con destino almacén, ingresarían dos unidades que no hay.
  do $$
  declare v_a uuid; v_r uuid;
  begin
    select id, room_id into v_a, v_r from assets
     where room_id is not null and status <> 'retirado' limit 1;
    insert into asset_removals (id, asset_id, room_id, destino, requested_at, requested_by)
    values (gen_random_uuid(), v_a, v_r, 'almacen', now(),
            '11111111-1111-4111-8111-111111111111');
    raise exception 'FALLO: dos retiradas vivas para el mismo equipo';
  exception when unique_violation then
    raise notice 'OK: el índice deja una sola solicitud viva por equipo';
  end $$;
rollback;

\echo ''
\echo '=== 50. Lo que no se autoriza se borra de la sala ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select id as sala from rooms where active limit 1 \gset

  insert into assets (id, asset_type_id, room_id, label, created_by)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', public.asset_type_id('Proyector'),
          :'sala', 'Proyector que no está', '11111111-1111-4111-8111-111111111111');

  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');
  select public.reject_asset('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1') as fin \gset

  select case
    when :'fin' = 'borrado'
     and (select count(*) from assets where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1') = 0
     and exists (select 1 from audit_log
                  where table_name = 'assets' and op = 'DELETE'
                    and (old_data ->> 'id') = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
                    and by_user is not null)
    then 'OK: borrado de la sala, y con quién lo descartó en la auditoría'
    else 'FALLO: el rechazo no ha borrado el equipo'
  end as resultado;
rollback;

\echo ''
\echo '=== 51. …pero no se borra lo que ya se firmó, ni lo ya validado ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select id as sala from rooms where active limit 1 \gset

  insert into assets (id, asset_type_id, room_id, label, created_by)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', public.asset_type_id('Pantalla'),
          :'sala', 'Pantalla ya revisada', '11111111-1111-4111-8111-111111111111');
  insert into inspections (id, room_id, by_user, occurred_at, status)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbba', :'sala',
          '11111111-1111-4111-8111-111111111111', now(), 'borrador');
  insert into inspection_checks (id, inspection_id, check_key, result)
  values (gen_random_uuid(), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbba',
          'asset:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'ok');

  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');
  select public.reject_asset('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2') as fin \gset

  select case
    when :'fin' = 'retirado'
     and (select status from assets where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2') = 'retirado'
    then 'OK: con una revisión detrás se retira en vez de borrarse'
    else 'FALLO: se ha borrado un equipo que una revisión ya había comprobado'
  end as resultado;

  -- Y un equipo ya validado no sale por esta puerta: para eso está la solicitud.
  do $$
  declare v_id uuid;
  begin
    select id into v_id from assets where confirmed and room_id is not null limit 1;
    perform public.reject_asset(v_id);
    raise exception 'FALLO: descartó un equipo ya validado';
  exception when others then
    if sqlerrm like 'FALLO%' then raise; end if;
    raise notice 'OK: %', sqlerrm;
  end $$;
rollback;

\echo ''
\echo '=== 52. Corregir una revisión no crea una visita nueva ==='
begin;
  -- Una sala sin revisiones previas: es la única forma de afirmar algo sobre
  -- «la última revisión» sin que la conteste el histórico importado.
  select id as sala from rooms r
   where r.active and not exists (select 1 from inspections i where i.room_id = r.id)
   order by r.code limit 1 \gset

  -- La revisión original la firma el SUPERVISOR: corregir lo de un compañero es
  -- el caso que trae a nadie a esta pantalla, y tiene que funcionar.
  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');
  insert into inspections (id, room_id, by_user, occurred_at, status)
  values ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', :'sala',
          '22222222-2222-4222-8222-222222222222', now() - interval '3 days', 'borrador');
  insert into inspection_checks (id, inspection_id, check_key, result, severity, note)
  values (gen_random_uuid(), 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'red', 'incidencia',
          'alta', 'la red no va');
  update inspections set status = 'completa', overall = 'con_incidencias',
         notes = 'lo apunté mal'
   where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';

  -- Y la corrige un técnico, conservando la fecha de la visita.
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  insert into inspections (id, room_id, by_user, occurred_at, status, corrects, corrected_at)
  values ('cccccccc-cccc-4ccc-8ccc-ccccccccccc2', :'sala',
          '11111111-1111-4111-8111-111111111111',
          (select occurred_at from inspections where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'),
          'borrador', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', now());
  insert into inspection_checks (id, inspection_id, check_key, result)
  values (gen_random_uuid(), 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2', 'red', 'ok');
  update inspections set status = 'completa', overall = 'ok',
         notes = 'la red iba bien: me equivoqué de aula'
   where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';

  select case
    when (select count(*) from room_timeline
           where room_id = :'sala' and kind in ('revision_ok', 'revision_ko')) = 1
     and (select count(*) from room_timeline
           where ref_id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1') = 0
     and (select subkind from room_timeline
           where ref_id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2') = 'corregida'
    then 'OK: dos filas, una sola visita, y marcada como corregida'
    else 'FALLO: la corrección se cuenta como una revisión más'
  end as resultado;

  -- La sala no aparece revisada hoy por haber corregido una revisión de hace
  -- tres días, y lo que se lee de ella es la versión que vale.
  select case
    when (select last_inspection_at from room_overview where room_id = :'sala')
         = (select occurred_at from inspections where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1')
     and (select last_inspection_overall from room_overview where room_id = :'sala')::text = 'ok'
    then 'OK: la fecha es la de la visita y el resultado el de la corrección'
    else 'FALLO: la corrección ha movido la última revisión de la sala'
  end as resultado;

  -- Y para la fiabilidad de la sala ha habido UNA revisión, no dos. Es el
  -- número que decide si el índice significa algo: contando correcciones, un aula
  -- con una visita corregida tres veces parecería tener cuatro.
  select case
    when (select revisiones from room_reliability where room_id = :'sala') = 1
    then 'OK: la fiabilidad cuenta una visita, no dos filas'
    else 'FALLO: la corrección cuenta como otra revisión en la fiabilidad'
  end as resultado;

  -- Y la ficha la lee entera: quién, cómo salió y quién la corrigió.
  select case
    when (select vigente from room_inspections where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2')
     and not (select vigente from room_inspections where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1')
     and (select corregida_por from room_inspections where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1')
         = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'
     and (select fallos from room_inspections where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1') = 1
     and (select fallos from room_inspections where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2') = 0
    then 'OK: las dos versiones se leen, y se sabe cuál manda'
    else 'FALLO: la ficha no distingue la versión vigente'
  end as resultado;
rollback;

\echo ''
\echo '=== 53. La revisión corregida sigue intacta y congelada ==='
begin;
  select id as sala from rooms where active limit 1 \gset
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');

  insert into inspections (id, room_id, by_user, occurred_at, status, notes)
  values ('cccccccc-cccc-4ccc-8ccc-ccccccccccd1', :'sala',
          '11111111-1111-4111-8111-111111111111', now() - interval '1 day', 'borrador',
          'lo que dije aquel día');
  update inspections set status = 'completa', overall = 'con_incidencias'
   where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccd1';

  insert into inspections (id, room_id, by_user, occurred_at, status, overall, corrects, corrected_at)
  values ('cccccccc-cccc-4ccc-8ccc-ccccccccccd2', :'sala',
          '11111111-1111-4111-8111-111111111111', now() - interval '1 day', 'completa', 'ok',
          'cccccccc-cccc-4ccc-8ccc-ccccccccccd1', now());

  -- Corregir es añadir, no editar: el texto original se queda donde estaba.
  select case
    when (select notes from inspections where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccd1')
         = 'lo que dije aquel día'
     and (select overall from inspections
           where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccd1')::text = 'con_incidencias'
    then 'OK: la original conserva su texto y su resultado'
    else 'FALLO: la corrección ha reescrito la revisión anterior'
  end as resultado;

  -- Y el congelado sigue en pie para todo el mundo: una corrección no es una
  -- puerta trasera para editar lo que ya se cerró.
  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');
  do $$
  begin
    update inspections set notes = 'por la puerta de atrás'
     where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccd1';
    raise exception 'FALLO: se editó una revisión completa';
  exception when check_violation then
    raise notice 'OK: el congelado sigue parando la edición directa';
  end $$;
rollback;

\echo ''
\echo '=== 54. Lo que una corrección no puede ser ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select id as sala from rooms where active order by code limit 1 \gset
  select id as otra from rooms where active and id <> :'sala' order by code limit 1 \gset

  insert into inspections (id, room_id, by_user, occurred_at, status, overall)
  values ('cccccccc-cccc-4ccc-8ccc-cccccccccce1', :'sala',
          '11111111-1111-4111-8111-111111111111', now(), 'completa', 'ok');
  insert into inspections (id, room_id, by_user, occurred_at, status)
  values ('cccccccc-cccc-4ccc-8ccc-cccccccccce2', :'sala',
          '11111111-1111-4111-8111-111111111111', now(), 'borrador');

  -- De otra sala: metería una revisión ajena en el recuento de la sala.
  savepoint s1;
  do $$
  declare v_otra uuid;
  begin
    select id into v_otra from rooms where active and id <> (
      select room_id from inspections where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccce1'
    ) order by code limit 1;
    insert into inspections (id, room_id, by_user, occurred_at, status, corrects, corrected_at)
    values (gen_random_uuid(), v_otra, '11111111-1111-4111-8111-111111111111', now(),
            'borrador', 'cccccccc-cccc-4ccc-8ccc-cccccccccce1', now());
    raise exception 'FALLO: se corrigió la revisión de otra sala';
  exception when check_violation then
    raise notice 'OK: una corrección es de la misma sala';
  end $$;
  rollback to savepoint s1;

  -- De un borrador: reemplazaría algo que nunca se cerró.
  savepoint s2;
  do $$
  begin
    insert into inspections (id, room_id, by_user, occurred_at, status, corrects, corrected_at)
    select gen_random_uuid(), room_id, '11111111-1111-4111-8111-111111111111', now(),
           'borrador', 'cccccccc-cccc-4ccc-8ccc-cccccccccce2', now()
      from inspections where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccce2';
    raise exception 'FALLO: se corrigió un borrador';
  exception when check_violation then
    raise notice 'OK: solo se corrige lo que está cerrado';
  end $$;
  rollback to savepoint s2;

  -- Sin fecha de corrección: la restricción impide una corrección sin decir cuándo.
  savepoint s3;
  do $$
  begin
    insert into inspections (id, room_id, by_user, occurred_at, status, corrects)
    select gen_random_uuid(), room_id, '11111111-1111-4111-8111-111111111111', now(),
           'borrador', 'cccccccc-cccc-4ccc-8ccc-cccccccccce1'
      from inspections where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccce1';
    raise exception 'FALLO: una corrección sin fecha de corrección';
  exception when check_violation then
    raise notice 'OK: una corrección dice cuándo se hizo';
  end $$;
  rollback to savepoint s3;

  -- Y a qué revisión corrige no se cambia después: es lo que cierra la puerta a
  -- una cadena que se muerda la cola.
  savepoint s4;
  insert into inspections (id, room_id, by_user, occurred_at, status, corrects, corrected_at)
  select 'cccccccc-cccc-4ccc-8ccc-cccccccccce3', room_id,
         '11111111-1111-4111-8111-111111111111', now(), 'borrador',
         'cccccccc-cccc-4ccc-8ccc-cccccccccce1', now()
    from inspections where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccce1';
  do $$
  begin
    update inspections set corrects = null
     where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccce3';
    raise exception 'FALLO: una corrección cambió de objetivo';
  exception when check_violation then
    raise notice 'OK: a qué revisión corrige se decide al crearla';
  end $$;
  rollback to savepoint s4;
rollback;

\echo ''
\echo '=== 55. El detalle de una revisión se lee con el aparato por su nombre ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select id as equipo, room_id as sala from assets
   where room_id is not null and status <> 'retirado' and label is not null limit 1 \gset

  -- Las comprobaciones se escriben mientras la revisión es borrador, que es la
  -- única ventana en que su autor puede tocarlas: después queda congelada.
  insert into inspections (id, room_id, by_user, occurred_at, status)
  values ('cccccccc-cccc-4ccc-8ccc-ccccccccccf1', :'sala',
          '11111111-1111-4111-8111-111111111111', now(), 'borrador');
  insert into inspection_checks (id, inspection_id, check_key, result, severity, measure, measure_unit)
  values (gen_random_uuid(), 'cccccccc-cccc-4ccc-8ccc-ccccccccccf1',
          'asset:' || :'equipo', 'incidencia', 'media', 1900, 'h'),
         (gen_random_uuid(), 'cccccccc-cccc-4ccc-8ccc-ccccccccccf1', 'red', 'ok', null, 94.3, 'Mbps'),
         -- Y una clave mal formada, como la que puede traer una importación: no
         -- puede tumbar la vista entera.
         (gen_random_uuid(), 'cccccccc-cccc-4ccc-8ccc-ccccccccccf1',
          'asset:esto-no-es-un-uuid', 'na', null, null, null);
  update inspections set status = 'completa', overall = 'con_incidencias'
   where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccf1';

  -- La etiqueta del aparato es lo único que el dispositivo no puede resolver de
  -- un equipo retirado: tiene que venir de aquí.
  select case
    when (select asset_label from inspection_check_detail
           where inspection_id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccf1'
             and asset_id = :'equipo')
         = (select label from assets where id = :'equipo')
     and (select measure from inspection_check_detail
           where inspection_id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccf1'
             and check_key = 'red') = 94.3
     and (select asset_id from inspection_check_detail
           where inspection_id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccf1'
             and check_key = 'red') is null
    then 'OK: el aparato sale con su nombre y la medida con su unidad'
    else 'FALLO: el detalle de la revisión no se puede leer'
  end as resultado;

  select case
    when (select count(*) from inspection_check_detail
           where inspection_id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccf1') = 3
    then 'OK: la fila con la clave rara se lee igual, sin aparato'
    else 'FALLO: una clave mal formada rompe el detalle'
  end as resultado;
rollback;


\echo ''
\echo '=== 56. La revisión hecha sin cobertura llega ENTERA ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select id as sala from rooms where active limit 1 \gset

  -- El orden real de la cola de salida (`ORDER`, en outbox.ts): primero la
  -- revisión, después sus comprobaciones. En un sótano no se subió el borrador,
  -- así que la fila que llega primero llega ya cerrada.
  insert into inspections (id, room_id, by_user, occurred_at, status, overall)
  values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', :'sala',
          '11111111-1111-4111-8111-111111111111', now(), 'completa', 'ok');

  insert into inspection_checks (id, inspection_id, check_key, result)
  values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeec1',
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', 'red', 'ok');

  select case
    when (select count(*) from inspection_checks
           where inspection_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1') = 1
    then 'OK: las comprobaciones de una revisión sin cobertura no se pierden'
    else 'FALLO: la revisión llegó al servidor sin lo que se comprobó'
  end as resultado;

  -- Y el reenvío que hace la cola al cerrar: sobre una revisión cerrada va con
  -- «no pises lo que ya está», así que no puede volver rojo el indicador.
  do $$
  begin
    insert into inspection_checks (id, inspection_id, check_key, result)
    values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeec1',
            'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', 'red', 'ok')
    on conflict (id) do nothing;
    raise notice 'OK: el reenvío de la cola pasa sin ruido';
  exception when others then
    raise exception 'FALLO: el reenvío de la cola se rechaza (%)', sqlerrm;
  end $$;
rollback;

\echo ''
\echo '=== 57. El cierre de una revisión pisa el borrador que ya subió ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select id as sala from rooms where active limit 1 \gset

  -- El borrador sube en cuanto hay red…
  insert into inspections (id, room_id, by_user, occurred_at, status, notes)
  values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2', :'sala',
          '11111111-1111-4111-8111-111111111111', now(), 'borrador', 'lo que vi');

  -- …y al cerrar, la cola manda la MISMA fila con `completa`. Ese envío tiene que
  -- pisar el borrador: si no, la revisión se queda en borrador en el servidor y no
  -- existe para nadie —ni en el histórico, ni en la fiabilidad, ni en el informe—.
  insert into inspections (id, room_id, by_user, occurred_at, status, overall, notes)
  select id, room_id, by_user, occurred_at, 'completa', 'ok', notes
    from inspections where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2'
  on conflict (id) do update
    set status = excluded.status, overall = excluded.overall, notes = excluded.notes;

  select case
    when (select status from inspections
           where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2')::text = 'completa'
    then 'OK: el cierre pisa el borrador que ya estaba arriba'
    else 'FALLO: la revisión se queda en borrador en el servidor'
  end as resultado;

  -- Y a partir de ahí queda fuera de su alcance: el reintento del cierre —cuando
  -- la respuesta se pierde— choca aquí a propósito, y lo reconcilia el cliente
  -- preguntando si ya está cerrada (ver `yaEstabaCerrada` en outbox.ts). La base
  -- no abre la puerta, que es lo que mantiene las dos capas de la prueba 3.
  do $$
  declare n int;
  begin
    update inspections set notes = 'otra cosa'
     where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';
    get diagnostics n = row_count;
    if n > 0 then raise exception 'FALLO: se reescribió una revisión cerrada'; end if;
    raise notice 'OK: cerrada, queda fuera del alcance del técnico';
  end $$;
rollback;

\echo '=== 58. Las comprobaciones de otro no se tocan ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select id as sala from rooms where active limit 1 \gset
  insert into inspections (id, room_id, by_user, occurred_at, status)
  values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3', :'sala',
          '11111111-1111-4111-8111-111111111111', now(), 'borrador');

  -- Otro técnico, con el mismo rol, no escribe en la revisión de un compañero:
  -- el permiso es del autor, no del oficio.
  select test_as('33333333-3333-4333-8333-333333333339', 'tecnico');
  do $$
  begin
    insert into inspection_checks (id, inspection_id, check_key, result)
    values (gen_random_uuid(), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3', 'red', 'ok');
    raise exception 'FALLO: un técnico escribió en la revisión de otro';
  exception when insufficient_privilege then
    raise notice 'OK: las comprobaciones son de quien firma la revisión';
  end $$;
rollback;

\echo ''
\echo '=== 59. Un choque de etiqueta se recoloca Y deja rastro ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select id as sala from rooms where active limit 1 \gset
  select id as tipo from asset_types where merged_into is null limit 1 \gset

  -- El primero se queda su nombre. El segundo —el espejo desactualizado de otro
  -- iPad, o dos técnicos en la misma ronda— llega chocando.
  insert into assets (id, asset_type_id, room_id, label, status, created_by)
  values ('dddddddd-dddd-4ddd-8ddd-ddddddddd001', :'tipo', :'sala',
          'Monitor Prueba', 'instalado', '11111111-1111-4111-8111-111111111111');
  insert into assets (id, asset_type_id, room_id, label, status, created_by)
  values ('dddddddd-dddd-4ddd-8ddd-ddddddddd002', :'tipo', :'sala',
          'Monitor Prueba', 'instalado', '11111111-1111-4111-8111-111111111111');

  select case
    when (select label from assets where id = 'dddddddd-dddd-4ddd-8ddd-ddddddddd002')
         = 'Monitor Prueba 2'
    then 'OK: el aparato no se pierde, se recoloca'
    else 'FALLO: el choque no se recolocó'
  end as resultado;

  -- Y el rastro existe, con el par entero: es la materia prima de la bandeja.
  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');
  select case
    when exists (
      select 1 from asset_label_conflicts
       where asset_id = 'dddddddd-dddd-4ddd-8ddd-ddddddddd002'
         and choco_con = 'dddddddd-dddd-4ddd-8ddd-ddddddddd001'
         and pedida = 'Monitor Prueba' and asignada = 'Monitor Prueba 2'
         and not resolved)
    then 'OK: el choque queda apuntado con el par identificado'
    else 'FALLO: el renombrado no dejó rastro'
  end as resultado;

  -- Un técnico no lee la bitácora: es una bandeja de coordinación.
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select case
    when (select count(*) from asset_label_conflicts) = 0
    then 'OK: la bitácora de choques es de supervisor para arriba'
    else 'FALLO: un técnico lee los choques'
  end as resultado;
rollback;

\echo ''
\echo '=== 60. Fusionar un duplicado no pierde nada: ni serie, ni incidencias, ni histórico ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select id as sala from rooms where active limit 1 \gset
  select id as tipo from asset_types where merged_into is null limit 1 \gset

  -- El fantasma antiguo sin serie, y el re-alta del técnico que sí la apuntó.
  insert into assets (id, asset_type_id, room_id, label, status, created_by)
  values ('dddddddd-dddd-4ddd-8ddd-ddddddddd003', :'tipo', :'sala',
          'Tele Prueba', 'instalado', '11111111-1111-4111-8111-111111111111');
  insert into assets (id, asset_type_id, room_id, label, serial, model, status, created_by)
  values ('dddddddd-dddd-4ddd-8ddd-ddddddddd004', :'tipo', :'sala',
          'Tele Prueba', 'SN-FUSION-1', 'X-200', 'instalado',
          '11111111-1111-4111-8111-111111111111');

  -- Una revisión llegó a comprobar el duplicado, y una avería le apunta.
  insert into inspections (id, room_id, by_user, occurred_at, status)
  values ('dddddddd-dddd-4ddd-8ddd-ddddddddd005', :'sala',
          '11111111-1111-4111-8111-111111111111', now(), 'borrador');
  insert into inspection_checks (id, inspection_id, check_key, result)
  values (gen_random_uuid(), 'dddddddd-dddd-4ddd-8ddd-ddddddddd005',
          'asset:dddddddd-dddd-4ddd-8ddd-ddddddddd004', 'incidencia');
  insert into incidents (id, room_id, asset_id, title, severity, state, kind, opened_at, opened_by)
  values ('dddddddd-dddd-4ddd-8ddd-ddddddddd006', :'sala',
          'dddddddd-dddd-4ddd-8ddd-ddddddddd004', 'Tele Prueba: no enciende',
          'media', 'abierta', 'incidencia', now(), '11111111-1111-4111-8111-111111111111');

  -- Fusionar es de coordinador; un técnico se queda en la puerta.
  savepoint s;
  do $$
  begin
    perform public.fusionar_equipo_duplicado(
      'dddddddd-dddd-4ddd-8ddd-ddddddddd004', 'dddddddd-dddd-4ddd-8ddd-ddddddddd003');
    raise exception 'FALLO: un técnico fusionó equipos';
  exception when insufficient_privilege then
    raise notice 'OK: fusionar es cosa del coordinador';
  end $$;
  rollback to savepoint s;

  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');

  -- La bandeja propone el par antes de tocar nada.
  select case
    when exists (
      select 1 from public.auditoria_duplicados()
       where dup_id = 'dddddddd-dddd-4ddd-8ddd-ddddddddd004'
         and bueno_id = 'dddddddd-dddd-4ddd-8ddd-ddddddddd003'
         and choque_registrado)
    then 'OK: la auditoría propone el par con su choque registrado'
    else 'FALLO: la auditoría no ve el par'
  end as resultado;

  select public.fusionar_equipo_duplicado(
    'dddddddd-dddd-4ddd-8ddd-ddddddddd004',
    'dddddddd-dddd-4ddd-8ddd-ddddddddd003') as etiqueta_final \gset

  select case
    when (select status from assets where id = 'dddddddd-dddd-4ddd-8ddd-ddddddddd004')::text
         = 'retirado'
     and (select serial from assets where id = 'dddddddd-dddd-4ddd-8ddd-ddddddddd003')
         = 'SN-FUSION-1'
     and (select model from assets where id = 'dddddddd-dddd-4ddd-8ddd-ddddddddd003')
         = 'X-200'
    then 'OK: retirado sin borrar, y la serie y el modelo viajan al que se queda'
    else 'FALLO: la fusión perdió datos del duplicado'
  end as resultado;

  select case
    when (select asset_id from incidents where id = 'dddddddd-dddd-4ddd-8ddd-ddddddddd006')
         = 'dddddddd-dddd-4ddd-8ddd-ddddddddd003'
    then 'OK: la avería sigue al aparato físico'
    else 'FALLO: la incidencia se quedó apuntando al retirado'
  end as resultado;

  -- La revisión de aquel día se sigue leyendo entera, con el aparato por su
  -- nombre y diciendo que hoy está retirado. Es la razón de retirar y no borrar.
  select case
    when exists (
      select 1 from inspection_check_detail
       where inspection_id = 'dddddddd-dddd-4ddd-8ddd-ddddddddd005'
         and asset_label = 'Tele Prueba 2'
         and asset_status = 'retirado')
    then 'OK: el histórico de la revisión se lee entero tras la fusión'
    else 'FALLO: la comprobación del duplicado quedó sin nombre'
  end as resultado;

  -- Y el rastro del choque queda cerrado: ya lo miró alguien.
  select case
    when not exists (
      select 1 from asset_label_conflicts
       where asset_id = 'dddddddd-dddd-4ddd-8ddd-ddddddddd004' and not resolved)
    then 'OK: el choque queda resuelto con la fusión'
    else 'FALLO: el choque sigue vivo tras fusionar'
  end as resultado;
rollback;

\echo ''
\echo '=== 61. La fusión inversa recupera la etiqueta base, y descartar calla la bandeja ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select id as sala from rooms where active limit 1 \gset
  select id as tipo from asset_types where merged_into is null limit 1 \gset

  -- Esta vez el que vale es el nuevo: el fantasma viejo no tiene nada dentro.
  insert into assets (id, asset_type_id, room_id, label, status, created_by)
  values ('dddddddd-dddd-4ddd-8ddd-ddddddddd007', :'tipo', :'sala',
          'Atril Prueba', 'instalado', '11111111-1111-4111-8111-111111111111');
  insert into assets (id, asset_type_id, room_id, label, serial, status, created_by)
  values ('dddddddd-dddd-4ddd-8ddd-ddddddddd008', :'tipo', :'sala',
          'Atril Prueba', 'SN-FUSION-2', 'instalado',
          '11111111-1111-4111-8111-111111111111');

  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');

  -- Se retira el viejo y se queda el nuevo, que hereda la etiqueta base:
  -- el «Atril Prueba 2» vuelve a llamarse «Atril Prueba».
  select public.fusionar_equipo_duplicado(
    'dddddddd-dddd-4ddd-8ddd-ddddddddd007',
    'dddddddd-dddd-4ddd-8ddd-ddddddddd008') as etiqueta_final \gset

  select case
    when :'etiqueta_final' = 'Atril Prueba'
     and (select label from assets where id = 'dddddddd-dddd-4ddd-8ddd-ddddddddd008')
         = 'Atril Prueba'
    then 'OK: el que se queda recupera la etiqueta base'
    else 'FALLO: el superviviente se quedó con el sufijo'
  end as resultado;

  -- Y un par legítimo se descarta: dos aparatos de verdad no son un duplicado.
  insert into assets (id, asset_type_id, room_id, label, status)
  select 'dddddddd-dddd-4ddd-8ddd-ddddddddd009', :'tipo', :'sala',
         public.next_asset_label(:'sala', 'Atril Prueba'), 'instalado';

  select public.descartar_duplicado(
    'dddddddd-dddd-4ddd-8ddd-ddddddddd009',
    'dddddddd-dddd-4ddd-8ddd-ddddddddd008');

  select case
    when not exists (
      select 1 from public.auditoria_duplicados()
       where dup_id = 'dddddddd-dddd-4ddd-8ddd-ddddddddd009')
    then 'OK: el par descartado no vuelve a proponerse'
    else 'FALLO: la bandeja sigue proponiendo un par ya revisado'
  end as resultado;

  -- El resumen es de coordinación, como la bandeja.
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  do $$
  begin
    perform public.auditoria_inventario();
    raise exception 'FALLO: un técnico leyó la auditoría';
  exception when insufficient_privilege then
    raise notice 'OK: la auditoría es de supervisor para arriba';
  end $$;
rollback;

\echo ''
\echo '=== 62. Una observación abierta no enciende la insignia de la sala ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select id as sala from rooms where active order by created_at limit 1 \gset
  select open_incidents as antes from room_overview where room_id = :'sala' \gset

  -- Una nota de seguimiento del histórico: abierta por definición y para siempre.
  insert into incidents (id, room_id, title, severity, state, kind, opened_at, opened_by)
  values ('dddddddd-dddd-4ddd-8ddd-ddddddddd010', :'sala',
          'El mando aparece en el cajón', 'baja', 'abierta', 'observacion',
          now() - interval '300 days', '11111111-1111-4111-8111-111111111111');

  select case
    when (select open_incidents from room_overview where room_id = :'sala') = :'antes'
    then 'OK: la nota no cuenta como incidencia abierta de la sala'
    else 'FALLO: la insignia de la sala cuenta observaciones'
  end as resultado;

  -- Y una solicitud SÍ cuenta: es trabajo pedido y está en la pestaña.
  insert into incidents (id, room_id, title, severity, state, kind, opened_at, opened_by)
  values ('dddddddd-dddd-4ddd-8ddd-ddddddddd011', :'sala',
          'Instalar cámara', 'media', 'abierta', 'solicitud',
          now(), '11111111-1111-4111-8111-111111111111');

  select case
    when (select open_incidents from room_overview where room_id = :'sala') = :'antes' + 1
    then 'OK: la solicitud sí cuenta como trabajo pendiente'
    else 'FALLO: la solicitud no cuenta en la insignia'
  end as resultado;
rollback;

\echo ''
\echo '=== 63. El estado de los informes se puede preguntar, y contesta también sin pg_net ==='
begin;
  -- Un técnico no lo consulta: es una pantalla de coordinación.
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  do $$
  begin
    perform public.estado_de_informes();
    raise exception 'FALLO: un técnico leyó el estado de los informes';
  exception when insufficient_privilege then
    raise notice 'OK: el estado de los informes es de supervisor para arriba';
  end $$;

  -- Y el supervisor recibe la foto entera SIN que la función reviente en un
  -- clúster sin pg_net ni pg_cron — que es exactamente este arnés. La gracia
  -- del diagnóstico es contestar «pg_net no está instalado» en vez de morirse.
  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');
  select case
    when (public.estado_de_informes() -> 'pg_net' ->> 'instalado') = 'false'
     and jsonb_typeof(public.estado_de_informes() -> 'informes') = 'array'
    then 'OK: sin pg_net lo dice, y el resto de la foto llega igual'
    else 'FALLO: el diagnóstico no sabe contar un clúster sin extensiones'
  end as resultado;

  -- Y pedir un informe sin pg_net falla CON EXPLICACIÓN, no con un error de
  -- esquema: es la diferencia entre arreglarlo y perseguirlo por los logs.
  do $$
  begin
    perform public.request_report('semanal');
    raise exception 'FALLO: request_report fingió funcionar sin pg_net';
  exception when others then
    if sqlerrm like '%pg_net no está instalada%' then
      raise notice 'OK: sin pg_net, pedir un informe explica qué falta';
    else
      raise exception 'FALLO: el error no orienta (%)', sqlerrm;
    end if;
  end $$;
rollback;

\echo ''
\echo '=== 64. Una incidencia sin sala se rescata: sala puesta, alias aprendido, cuarentena cerrada ==='
begin;
  -- Rescatar es de coordinación; un técnico se queda en la puerta.
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  do $$
  begin
    perform public.incidencias_sin_sala();
    raise exception 'FALLO: un técnico listó las incidencias sin sala';
  exception when insufficient_privilege then
    raise notice 'OK: el rescate es de supervisor para arriba';
  end $$;

  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');

  -- Una huérfana real del seed, con su texto de aula de la cuarentena delante.
  select incidencia as huerfana, coalesce(aula_original, '(sin aula)') as aula
    from public.incidencias_sin_sala() limit 1 \gset
  select id as sala from rooms where active order by created_at limit 1 \gset

  select case
    when :'huerfana' <> ''
    then 'OK: la lista trae huérfanas del seed con su aula original'
    else 'FALLO: el seed tiene huérfanas y la lista no ve ninguna'
  end as resultado;

  select public.asignar_sala_a_incidencia(
    :'huerfana', :'sala', 'Aula De Prueba Rescate') as etiqueta \gset

  select case
    when (select room_id from incidents where id = :'huerfana') = :'sala'
    then 'OK: la incidencia recupera su sala (' || :'etiqueta' || ')'
    else 'FALLO: la incidencia sigue sin sala'
  end as resultado;

  -- El alias queda aprendido: la próxima importación resolverá ese texto sola.
  select case
    when exists (
      select 1 from room_aliases
       where room_id = :'sala'
         and alias_norm = public.norm_text('Aula De Prueba Rescate'))
    then 'OK: el texto original queda de alias de la sala'
    else 'FALLO: el alias no se aprendió'
  end as resultado;

  -- Y ya no vuelve a proponerse.
  select case
    when not exists (
      select 1 from public.incidencias_sin_sala() s where s.incidencia = :'huerfana')
    then 'OK: la rescatada sale de la lista de huérfanas'
    else 'FALLO: la lista sigue proponiendo una incidencia ya asignada'
  end as resultado;

  -- Una que ya tiene sala no se «rescata»: mover de sala es otra operación.
  do $$
  declare v uuid;
  begin
    select id into v from incidents where room_id is not null limit 1;
    perform public.asignar_sala_a_incidencia(v, (select id from rooms limit 1), null);
    raise exception 'FALLO: se reasignó una incidencia que ya tenía sala';
  exception when others then
    if sqlerrm like '%ya tiene sala%' then
      raise notice 'OK: una incidencia con sala no se toca por este camino';
    else
      raise exception 'FALLO: el error no es el esperado (%)', sqlerrm;
    end if;
  end $$;
rollback;

\echo ''
\echo '=== 65. Un fallo de revisión sin incidencia acaba abriendo una — sin duplicar ni resucitar ==='
begin;
  -- El rescate es interno: lo ejecutan la migración y el cron, no la API.
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  do $$
  begin
    perform public.abrir_incidencias_de_revisiones();
    raise exception 'FALLO: un técnico ejecutó el rescate de fallos';
  exception when insufficient_privilege then
    raise notice 'OK: el rescate no se puede invocar desde la API';
  end $$;
  reset role;

  -- Primera pasada en seco: si el seed trae sus propios fallos enterrados, se
  -- barren ahora para que las cuentas de abajo sean solo las de esta prueba.
  select public.abrir_incidencias_de_revisiones() as barrido \gset
  select :barrido as fallos_del_seed_barridos;

  -- Una sala virgen —sin revisiones ni incidencias vivas— para no pisar seed.
  \set sala ''
  select r.id as sala from rooms r
   where r.active
     and not exists (select 1 from inspections x where x.room_id = r.id)
     and not exists (select 1 from incidents i where i.room_id = r.id and i.state <> 'resuelta')
   order by r.created_at desc limit 1 \gset
  select case when :'sala' <> ''
    then 'OK: hay una sala virgen para la prueba'
    else 'FALLO: no queda ninguna sala sin revisiones ni incidencias en el seed'
  end as resultado;

  -- La visita de ayer, cerrada por una app que aún no sabía abrir incidencias:
  -- dos equipos y la red en «Falla», y ni una fila en incidents.
  insert into asset_types (id, name) values
    ('aaaaaaaa-0000-4000-8000-00000000006a', 'Tipo De Prueba 65');
  insert into assets (id, asset_type_id, room_id, label) values
    ('aaaaaaaa-0000-4000-8000-00000000006b', 'aaaaaaaa-0000-4000-8000-00000000006a', :'sala', 'HDMI Amarillo De Prueba'),
    ('aaaaaaaa-0000-4000-8000-00000000006c', 'aaaaaaaa-0000-4000-8000-00000000006a', :'sala', 'Proyector De Prueba');
  insert into inspections (id, room_id, by_user, occurred_at, recorded_at, status, overall)
  values ('aaaaaaaa-0000-4000-8000-00000000006d', :'sala',
          '11111111-1111-4111-8111-111111111111',
          now() - interval '1 day', now() - interval '2 hours',
          'completa', 'con_incidencias');
  insert into inspection_checks (id, inspection_id, check_key, result, severity, note) values
    (gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-00000000006d',
     'asset:aaaaaaaa-0000-4000-8000-00000000006b', 'incidencia', 'baja',
     e'Falta señalar el HDMI de la segunda entrada\ny revisar la funda'),
    (gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-00000000006d',
     'asset:aaaaaaaa-0000-4000-8000-00000000006c', 'incidencia', null, null),
    (gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-00000000006d', 'red', 'incidencia', 'alta',
     'No hay conexión en el puesto'),
    (gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-00000000006d', 'sonido', 'ok', null, null);

  select public.abrir_incidencias_de_revisiones() as creadas \gset
  select case when :creadas = 3
    then 'OK: los tres fallos abren sus tres incidencias (y el «Correcto», ninguna)'
    else 'FALLO: se esperaban 3 incidencias y salieron ' || :creadas
  end as resultado;

  select case
    when (select title from incidents
           where check_key = 'asset:aaaaaaaa-0000-4000-8000-00000000006b')
       = 'HDMI Amarillo De Prueba: Falta señalar el HDMI de la segunda entrada'
    then 'OK: el título lleva el equipo y la primera línea de la nota'
    else 'FALLO: el título no es el esperado'
  end as resultado;

  select case
    when (select title || ' · ' || severity || ' · ' || state from incidents
           where asset_id = 'aaaaaaaa-0000-4000-8000-00000000006c')
       = 'Proyector De Prueba: fallo detectado en la revisión · media · abierta'
    then 'OK: sin nota se explica solo, y sin gravedad se queda en media'
    else 'FALLO: la incidencia sin nota no salió como se esperaba'
  end as resultado;

  select case
    when (select opened_at = now() - interval '1 day'
              and opened_from_inspection_id = 'aaaaaaaa-0000-4000-8000-00000000006d'
              and opened_by = '11111111-1111-4111-8111-111111111111'
            from incidents where room_id = :'sala' and check_key = 'red')
    then 'OK: la incidencia hereda la fecha, la revisión y el autor de la visita'
    else 'FALLO: la incidencia no apunta a la visita de la que salió'
  end as resultado;

  select public.abrir_incidencias_de_revisiones() as segunda \gset
  select case when :segunda = 0
    then 'OK: la segunda pasada no duplica nada'
    else 'FALLO: la segunda pasada abrió ' || :segunda || ' incidencias de más'
  end as resultado;

  -- Se resuelve la de la red (hace 6 horas) y el rescate no la resucita: la
  -- resolución es posterior a la visita, así que aquello quedó zanjado.
  update incidents set state = 'resuelta',
         resolved_at = now() - interval '6 hours', resolution = 'Cable repuesto'
   where room_id = :'sala' and check_key = 'red';
  select public.abrir_incidencias_de_revisiones() as tercera \gset
  select case when :tercera = 0
    then 'OK: lo resuelto después de la visita se queda resuelto'
    else 'FALLO: el rescate resucitó una incidencia ya resuelta'
  end as resultado;

  -- Pero un fallo visto DESPUÉS de resolver es una avería nueva: la visita de
  -- hace 3 horas vuelve a marcar la red y eso sí abre otra.
  insert into inspections (id, room_id, by_user, occurred_at, recorded_at, status, overall)
  values ('aaaaaaaa-0000-4000-8000-00000000006e', :'sala',
          '11111111-1111-4111-8111-111111111111',
          now() - interval '3 hours', now() - interval '2 hours',
          'completa', 'con_incidencias');
  insert into inspection_checks (id, inspection_id, check_key, result, severity, note)
  values (gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-00000000006e', 'red', 'incidencia', 'media', null);
  select public.abrir_incidencias_de_revisiones() as cuarta \gset
  select case when :cuarta = 1
    then 'OK: un fallo visto después de resolver abre una incidencia nueva'
    else 'FALLO: el fallo nuevo tras la resolución no abrió nada (' || :cuarta || ')'
  end as resultado;

  -- La corrección manda: se corrige esa visita diciendo que la red estaba
  -- bien, y su incidencia se resuelve con fecha ANTERIOR a la visita — si el
  -- rescate mirase la revisión corregida en vez de la corrección, esa marca
  -- de resolución no lo pararía y volvería a abrirla.
  update incidents set state = 'resuelta',
         resolved_at = now() - interval '4 hours', resolution = 'Falsa alarma'
   where room_id = :'sala' and check_key = 'red' and state <> 'resuelta';
  insert into inspections (id, room_id, by_user, occurred_at, recorded_at, status, overall,
                           corrects, corrected_at)
  values ('aaaaaaaa-0000-4000-8000-00000000006f', :'sala',
          '11111111-1111-4111-8111-111111111111',
          now() - interval '3 hours', now() - interval '2 hours',
          'completa', 'ok',
          'aaaaaaaa-0000-4000-8000-00000000006e', now() - interval '90 minutes');
  insert into inspection_checks (id, inspection_id, check_key, result)
  values (gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-00000000006f', 'red', 'ok');
  select public.abrir_incidencias_de_revisiones() as quinta \gset
  select case when :quinta = 0
    then 'OK: la corrección manda — el fallo corregido no abre nada'
    else 'FALLO: el rescate leyó la revisión corregida en vez de la corrección'
  end as resultado;

  -- Lo recién subido espera su hora: la incidencia puede venir de camino en la
  -- cola del dispositivo. Y un equipo retirado ya no abre nada: su avería se
  -- fue con él.
  insert into assets (id, asset_type_id, room_id, label) values
    ('aaaaaaaa-0000-4000-8000-000000000070', 'aaaaaaaa-0000-4000-8000-00000000006a', :'sala', 'Atril De Prueba');
  insert into inspections (id, room_id, by_user, occurred_at, recorded_at, status, overall)
  values ('aaaaaaaa-0000-4000-8000-000000000071', :'sala',
          '11111111-1111-4111-8111-111111111111',
          now() - interval '30 minutes', now(), 'completa', 'con_incidencias');
  insert into inspection_checks (id, inspection_id, check_key, result, severity)
  values (gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-000000000071',
          'asset:aaaaaaaa-0000-4000-8000-000000000070', 'incidencia', 'media');
  select public.abrir_incidencias_de_revisiones() as sexta \gset
  select case when :sexta = 0
    then 'OK: la revisión recién subida espera su hora'
    else 'FALLO: el rescate no esperó a que la cola del dispositivo entregara'
  end as resultado;

  -- El reloj de madurez se adelanta con credenciales de admin: una revisión
  -- completa es inmutable para cualquier otro rol, también desde aquí.
  select set_config('request.jwt.claims',
    json_build_object('sub', '44444444-4444-4444-8444-444444444444',
                      'app_role', 'admin')::text, true);
  update inspections set recorded_at = now() - interval '2 hours'
   where id = 'aaaaaaaa-0000-4000-8000-000000000071';
  update assets set status = 'retirado'
   where id = 'aaaaaaaa-0000-4000-8000-000000000070';
  select public.abrir_incidencias_de_revisiones() as septima \gset
  select case when :septima = 0
    then 'OK: el fallo de un equipo retirado se fue con él'
    else 'FALLO: se abrió una incidencia para un equipo que ya no está'
  end as resultado;
rollback;

\echo ''
\echo '=== 66. Ninguna incidencia vive en el futuro: el año 2296 no vuelve ==='
begin;
  -- El caso real: «27-03-296» del Excel convertido a 2296 encabezando el
  -- Historial. El importador ya no adivina y la migración corrigió lo escrito;
  -- esto vigila que ninguna de las dos puertas se vuelva a abrir.
  select case
    when not exists (
      select 1 from incidents
       where extract(year from opened_at)   > extract(year from now()) + 1
          or extract(year from resolved_at) > extract(year from now()) + 1)
    then 'OK: ni una incidencia abierta o resuelta más allá del año que viene'
    else 'FALLO: hay incidencias fechadas en un futuro imposible'
  end as resultado;

  -- Y las dos del CRAI dicen lo que el Excel quiso decir: resueltas el mismo
  -- día de 2026 en que se abrieron.
  select case
    when (select count(*) from incidents
           where external_ref in ('I260325_0039', 'I260327_0006')
             and resolved_at::date = opened_at::date
             and extract(year from resolved_at) = 2026) = 2
    then 'OK: las dos incidencias del CRAI vuelven al 27 de marzo de 2026'
    else 'FALLO: las incidencias de la errata «27-03-296» siguen mal fechadas'
  end as resultado;
rollback;

\echo ''
\echo '=== 67. Archivar un edificio limpia la vista y se deshace entero ==='
begin;
  select test_as('44444444-4444-4444-8444-444444444444', 'admin');

  select public.create_building('ZY', 'Edificio de la papelera') as ed \gset
  select public.create_room(:'ed', 'PLANTA BAJA', '0.1', 'Aula de prueba') as sala \gset
  select public.create_room(:'ed', '1ª PLANTA',   '1.1', 'Otra aula')      as sala2 \gset

  insert into inspections (id, room_id, by_user, occurred_at, status, overall)
  values ('77777777-7777-4777-8777-777777777767', :'sala',
          '44444444-4444-4444-8444-444444444444', now(), 'completa', 'ok');

  select public.delete_building(:'ed') as baja \gset

  -- Las tres cosas a la vez, porque las tres juntas son la promesa: desaparece
  -- de la lista de trabajo (y por tanto de la descarga a los 23 iPads), aparece
  -- en la papelera, y sus salas siguen ahí debajo con `active = true`.
  select case
    when :'baja' = 'archivado'
     and (select count(*) from room_overview      where building_id = :'ed') = 0
     and (select count(*) from archived_buildings where building_id = :'ed') = 1
     and (select count(*) from archived_rooms
           where building_id = :'ed' and motivo = 'edificio') = 2
    then 'OK: fuera de la lista de trabajo y entero en la papelera'
    else 'FALLO: archivar el edificio no ha limpiado la vista'
  end as resultado;

  -- Por id: lo que se afirma es que la baja no se llevó por delante el
  -- histórico, que es la razón entera de archivar en vez de borrar.
  select case
    when exists (select 1 from inspections where id = '77777777-7777-4777-8777-777777777767')
     and (select revisiones from archived_buildings where building_id = :'ed') = 1
     and (select salas      from archived_buildings where building_id = :'ed') = 2
    then 'OK: la papelera dice cuántas salas y cuántas revisiones se recuperan'
    else 'FALLO: se ha perdido histórico al archivar, o el recuento miente'
  end as resultado;

  -- Y una sala de un edificio archivado no se reactiva sola: volvería a
  -- `room_overview` por la puerta de `r.active` y la seguiría escondiendo el
  -- `b.active`, o sea, no volvería a ninguna parte.
  do $$
  declare v_sala uuid;
  begin
    select r.id into v_sala from rooms r
      join zones z on z.id = r.zone_id
      join buildings b on b.id = z.building_id
     where not b.active limit 1;
    perform public.restore_room(v_sala);
    raise exception 'FALLO: reactivó una sala de un edificio archivado';
  exception when others then
    if sqlerrm like 'FALLO%' then raise; end if;
    raise notice 'OK: %', sqlerrm;
  end $$;

  select public.restore_building(:'ed');
  select case
    when (select count(*) from room_overview where building_id = :'ed') = 2
     and (select count(*) from archived_rooms where building_id = :'ed') = 0
    then 'OK: y se deshace entero, con sus dos salas'
    else 'FALLO: restaurar el edificio no lo ha devuelto como estaba'
  end as resultado;

  -- El otro lado del trato: sin nada que conservar no hay papelera que valga.
  -- Se borra de verdad y su código —`unique` global— vuelve a quedar libre.
  select public.create_building('ZW', 'Edificio recién tecleado') as vacio \gset
  select public.delete_building(:'vacio') as baja2 \gset
  select case
    when :'baja2' = 'borrado'
     and not exists (select 1 from buildings where id = :'vacio')
     and not exists (select 1 from archived_buildings where building_id = :'vacio')
    then 'OK: la errata de hace un minuto se borra, no se guarda'
    else 'FALLO: un edificio vacío ha acabado en la papelera'
  end as resultado;

  -- Y el código liberado se puede volver a usar, que es para lo que se libera.
  select case
    when public.create_building('ZW', 'Este sí') is not null
    then 'OK: el código de un edificio borrado vuelve a estar libre'
    else 'FALLO: el código no se liberó'
  end as resultado;
rollback;

\echo ''
\echo '=== 68. Renombrar conserva la matrícula y deja rastro ==='
begin;
  select test_as('44444444-4444-4444-8444-444444444444', 'admin');

  select public.create_building('ZX', 'Edificio de nomenclatura') as ed \gset
  select public.create_room(:'ed', 'PLANTA BAJA', '0.1', 'Aula pequeña') as sala \gset
  select public.create_room(:'ed', '1ª PLANTA',   '1.1', 'Aula grande')  as otra \gset
  select short_ref as matricula from rooms where id = :'sala' \gset

  select public.rename_room(:'sala', '0.9', 'Aula pequeña') as r1 \gset

  -- La matrícula va grabada en la placa atornillada a la puerta y el QR
  -- codifica el UUID, no el código: renombrar no puede invalidar una placa.
  -- Y el código viejo se queda de alias con la forma cualificada «0.1 ZX», que
  -- es la que produce `splitIncidentKey`; sin ella la siguiente importación de
  -- Excel dejaría de resolver esta sala y caería en `import_quarantine`.
  select case
    when :'r1' = 'renombrada'
     and (select short_ref from rooms where id = :'sala') = :'matricula'
     and exists (select 1 from room_aliases
                  where room_id = :'sala'
                    and alias_norm = public.norm_text('0.1 ZX'))
    then 'OK: la placa sigue valiendo y el código viejo queda de alias'
    else 'FALLO: renombrar rompió la matrícula o no dejó rastro'
  end as resultado;

  -- Renombrar una sala a su propio código no es un duplicado de sí misma: es lo
  -- que pasa cada vez que alguien abre el formulario solo para tocar el nombre.
  select public.rename_room(:'sala', '0.9', 'Aula pequeña reformada') as r1b \gset
  select case
    when :'r1b' = 'renombrada'
     and (select name from rooms where id = :'sala') = 'Aula pequeña reformada'
    then 'OK: tocar solo el nombre no choca con el código de la propia sala'
    else 'FALLO: la sala chocó consigo misma'
  end as resultado;

  -- Y el choque de verdad se mide normalizado, más estricto que el
  -- `unique (zone_id, code)`, que distingue `1.1` de `1.1 ` pero también `a1`
  -- de `A1` y dejaría entrar dos salas que en la lista se leen igual.
  do $$
  declare v_sala uuid;
  begin
    select r.id into v_sala from rooms r join zones z on z.id = r.zone_id
      join buildings b on b.id = z.building_id
     where b.code = 'ZX' and r.code = '0.9';
    perform public.rename_room(v_sala, '1.1', 'Colisión', '1ª PLANTA');
    raise exception 'FALLO: dos salas con el mismo código en la misma planta';
  exception when others then
    if sqlerrm like 'FALLO%' then raise; end if;
    raise notice 'OK: %', sqlerrm;
  end $$;

  select public.rename_room(:'sala', '0.9', 'Aula pequeña reformada', '1ª PLANTA') as r2 \gset
  select case
    when :'r2' = 'movida'
     and (select z.name from rooms r join zones z on z.id = r.zone_id
           where r.id = :'sala') = '1ª PLANTA'
     and not exists (select 1 from zones
                      where building_id = :'ed' and name = 'PLANTA BAJA')
    then 'OK: el aula cambia de planta y la que se queda vacía desaparece'
    else 'FALLO: mover de planta no ha dejado las zonas como debía'
  end as resultado;

  -- Dos plantas que son la misma escritas de formas que `norm_text` no une.
  -- Escribir en una el nombre de la otra las fusiona, y lo dice.
  select public.create_room(:'ed', 'SOTANO',    '-1.1', 'Almacén')  as s1 \gset
  select public.create_room(:'ed', 'PLANTA -1', '-1.2', 'Trastero') as s2 \gset
  select id as zsotano from zones where building_id = :'ed' and name = 'SOTANO' \gset
  select id as zmenos1 from zones where building_id = :'ed' and name = 'PLANTA -1' \gset

  select public.rename_zone(:'zsotano', 'PLANTA -1') as r3 \gset
  select case
    when :'r3' = 'fusionada'
     and (select zone_id from rooms where id = :'s1') = :'zmenos1'
     and not exists (select 1 from zones where id = :'zsotano')
    then 'OK: dos plantas que eran la misma se juntan sin violar el único de nombre'
    else 'FALLO: la fusión de plantas no ha movido las aulas'
  end as resultado;

  -- Corregir la grafía no es fusionar aunque el nombre nuevo normalice igual
  -- que el viejo: la planta de destino sería ella misma, y el `delete from
  -- zones` de la fusión se llevaría por delante la planta que se quería
  -- arreglar con todas sus aulas dentro.
  select public.rename_zone(:'zmenos1', 'planta  -1') as r4 \gset
  select case
    when :'r4' = 'renombrada'
     and (select name from zones where id = :'zmenos1') = 'planta  -1'
     and (select count(*) from rooms where zone_id = :'zmenos1') = 2
    then 'OK: arreglar la grafía deja la planta donde estaba, con sus aulas'
    else 'FALLO: corregir la grafía se ha comido la planta'
  end as resultado;

  -- El signo menos de presentación (U+2212) no entra en la columna `code`: es
  -- el que rompe `roomMatches`, `cleanRoomRef`, `splitIncidentKey` y el cruce
  -- con `room_aliases`, y llega solo con que alguien pegue lo que ve en
  -- pantalla dentro del campo editable.
  select public.rename_room(:'s2', '−1.7', 'Trastero') as r5 \gset
  select case
    when (select code from rooms where id = :'s2') = '-1.7'
    then 'OK: el signo menos de pantalla no llega a la base'
    else 'FALLO: se ha guardado un U+2212 en el código'
  end as resultado;

  -- Y un renombrado con el código de otro edificio se rechaza con una frase, no
  -- con la violación del único.
  do $$
  begin
    perform public.rename_building((select id from buildings where code = 'ZX'), 'H', 'Robado');
    raise exception 'FALLO: dos edificios con el código H';
  exception when others then
    if sqlerrm like 'FALLO%' then raise; end if;
    raise notice 'OK: %', sqlerrm;
  end $$;

  -- Renombrar el edificio deja a TODAS sus salas la referencia vieja de alias.
  select public.rename_building(:'ed', 'ZXB', 'Edificio de nomenclatura') as r6 \gset
  select case
    when (select code from buildings where id = :'ed') = 'ZXB'
     and exists (select 1 from room_aliases
                  where room_id = :'sala' and alias_norm = public.norm_text('0.9 ZX'))
    then 'OK: al cambiar el código del edificio, el histórico sigue cruzando'
    else 'FALLO: renombrar el edificio dejó las referencias viejas sin resolver'
  end as resultado;
rollback;

\echo ''
\echo '=== 69. Solo el administrador toca la nomenclatura ==='
begin;
  -- Las cinco puertas nuevas, contra los dos roles que no son admin. El
  -- `errcode` importa tanto como la denegación: el cliente distingue
  -- `insufficient_privilege` de un error de validación para saber si enseñar
  -- «no tienes permiso» o el mensaje del servidor tal cual.
  do $$
  declare
    v_sala uuid;
    v_zona uuid;
    v_ed   uuid;
    v_rol  text;
    v_uid  text;
  begin
    select r.id, r.zone_id, z.building_id
      into v_sala, v_zona, v_ed
      from rooms r join zones z on z.id = r.zone_id
     where r.active
     order by r.created_at
     limit 1;

    foreach v_rol in array array['tecnico', 'supervisor'] loop
      v_uid := case v_rol
                 when 'tecnico' then '11111111-1111-4111-8111-111111111111'
                 else                '22222222-2222-4222-8222-222222222222'
               end;
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_uid, 'app_role', v_rol)::text, true);

      begin
        perform public.rename_building(v_ed, 'XX', 'Robado');
        raise exception 'FALLO: un % ha renombrado un edificio', v_rol;
      exception when insufficient_privilege then
        raise notice 'OK: un % no renombra edificios', v_rol;
      end;

      begin
        perform public.rename_room(v_sala, 'X.1', 'Robada');
        raise exception 'FALLO: un % ha renombrado una sala', v_rol;
      exception when insufficient_privilege then
        raise notice 'OK: un % no renombra salas', v_rol;
      end;

      begin
        perform public.rename_zone(v_zona, 'PLANTA ROBADA');
        raise exception 'FALLO: un % ha renombrado una planta', v_rol;
      exception when insufficient_privilege then
        raise notice 'OK: un % no renombra plantas', v_rol;
      end;

      begin
        perform public.delete_building(v_ed);
        raise exception 'FALLO: un % ha dado de baja un edificio', v_rol;
      exception when insufficient_privilege then
        raise notice 'OK: un % no da de baja edificios', v_rol;
      end;

      begin
        perform public.restore_building(v_ed);
        raise exception 'FALLO: un % ha restaurado un edificio', v_rol;
      exception when insufficient_privilege then
        raise notice 'OK: un % no restaura edificios', v_rol;
      end;
    end loop;
  end $$;
rollback;

\echo ''
\echo '=== 70. La papelera no promete una vuelta que no ocurre ==='
begin;
  select test_as('44444444-4444-4444-8444-444444444444', 'admin');

  -- El caso mixto, que es el que la vista contaba mal: una sala archivada A
  -- MANO dentro de un edificio que se archiva después. Salía marcada como
  -- «edificio» —el mismo motivo que sus vecinas vivas— y el panel pinta para ese
  -- valor «Se restaura con su edificio», que es falso: `restore_building` no
  -- toca `rooms` a propósito, así que esa sala no vuelve. Reaparecía luego en la
  -- misma lista como «sala», contradiciendo lo que acababa de decir.
  select public.create_building('ZP', 'Edificio de papelera mixta') as ed \gset
  select public.create_room(:'ed', 'PLANTA BAJA', '0.1', 'Aula que vuelve') as viva \gset
  select public.create_room(:'ed', 'PLANTA BAJA', '0.2', 'Aula de baja')    as manual \gset

  -- Con histórico, que es lo que hace que `delete_room` archive en vez de
  -- borrar: sin él no habría sala archivada de la que hablar.
  insert into inspections (id, room_id, by_user, occurred_at, status, overall)
  values ('77777777-7777-4777-8777-777777777770', :'manual',
          '44444444-4444-4444-8444-444444444444', now(), 'completa', 'ok');
  select public.delete_room(:'manual') as baja \gset

  select public.delete_building(:'ed') as baja_ed \gset

  select case
    when :'baja' = 'archivada'
     and :'baja_ed' = 'archivado'
     and (select motivo from archived_rooms where room_id = :'viva')   = 'edificio'
     and (select motivo from archived_rooms where room_id = :'manual') = 'sala-y-edificio'
     -- Y el recuento del edificio cuenta solo la que vuelve, que ahora concuerda
     -- con lo que dice la lista en vez de contradecirla.
     and (select salas from archived_buildings where building_id = :'ed') = 1
    then 'OK: la papelera distingue la que vuelve de la que se queda'
    else 'FALLO: la sala archivada a mano se hace pasar por sala de edificio archivado'
  end as resultado;

  -- Y cada etiqueta dice la verdad: restaurar devuelve una y deja la otra donde
  -- estaba, ahora sí reactivable por su cuenta.
  select public.restore_building(:'ed');
  select case
    when     exists (select 1 from room_overview where room_id = :'viva')
     and not exists (select 1 from room_overview where room_id = :'manual')
     and (select motivo from archived_rooms where room_id = :'manual') = 'sala'
    then 'OK: vuelve la que decía que volvía, y la otra queda reactivable'
    else 'FALLO: restaurar el edificio no ha hecho lo que decía la papelera'
  end as resultado;
rollback;

\echo ''
\echo '=== 71. Fusionar no puede llevar salas a la papelera ==='
begin;
  select test_as('44444444-4444-4444-8444-444444444444', 'admin');

  select public.create_building('ZQ', 'Edificio provisional') as origen  \gset
  select public.create_building('ZR', 'Edificio bueno')       as destino \gset
  select public.create_room(:'origen',  '1ª PLANTA',   '1.1', 'Aula que viajaría') as sala  \gset
  select public.create_room(:'destino', 'PLANTA BAJA', '0.1', 'Aula del bueno')    as ancla \gset

  -- El escenario real: A tiene la lista de destinos cacheada en su iPad y B
  -- archiva el edificio desde el suyo. El filtro del desplegable vive en el
  -- cliente y esa caché no la invalida nadie desde otro dispositivo.
  select public.delete_building(:'destino');

  do $$
  declare v_origen uuid; v_destino uuid;
  begin
    select id into v_origen  from buildings where code = 'ZQ';
    select id into v_destino from buildings where code = 'ZR';
    begin
      perform public.merge_building(v_origen, v_destino);
      raise exception 'FALLO: fusionó hacia un edificio de la papelera';
    exception when others then
      if sqlerrm like 'FALLO%' then raise; end if;
      raise notice 'OK: %', sqlerrm;
    end;
  end $$;

  -- Y el rechazo no deja nada a medias: la fusión borra el edificio de origen al
  -- final, así que un error a mitad del bucle habría dejado unas zonas movidas y
  -- otras no, sin nada que restaurar.
  select case
    when exists (select 1 from buildings where id = :'origen')
     and (select count(*) from room_overview where building_id = :'origen') = 1
    then 'OK: el origen sigue entero después del intento'
    else 'FALLO: la fusión rechazada dejó algo movido'
  end as resultado;

  -- El otro lado, igual de desprotegido: sacar un edificio de la papelera por la
  -- puerta de atrás, sin pasar por «Restaurar» y borrándolo por el camino.
  select public.restore_building(:'destino');
  select public.delete_building(:'origen');

  do $$
  declare v_origen uuid; v_destino uuid;
  begin
    select id into v_origen  from buildings where code = 'ZQ';
    select id into v_destino from buildings where code = 'ZR';
    begin
      perform public.merge_building(v_origen, v_destino);
      raise exception 'FALLO: fusionó desde un edificio de la papelera';
    exception when others then
      if sqlerrm like 'FALLO%' then raise; end if;
      raise notice 'OK: %', sqlerrm;
    end;
  end $$;

  select case
    when exists (select 1 from archived_buildings where building_id = :'origen')
     and (select count(*) from archived_rooms
           where building_id = :'origen' and room_id = :'sala') = 1
    then 'OK: el edificio archivado se queda en la papelera con lo suyo'
    else 'FALLO: la fusión ha vaciado un edificio archivado'
  end as resultado;
rollback;

\echo ''
\echo '=== 72. Cerrar una avería desde el aula: explicando, firmado y sin puerta trasera ==='
begin;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select id as sala from rooms where active order by created_at limit 1 \gset

  insert into incidents (id, room_id, title, description, severity, state, kind,
                         opened_at, opened_by)
  values ('77777777-7777-4777-8777-777777777791', :'sala',
          'Proyector: no da imagen', 'No da imagen', 'alta', 'abierta', 'incidencia',
          now() - interval '3 days', '11111111-1111-4111-8111-111111111111');

  -- 1 — El cierre normal: lo firma quien lo arregló y cierra la incidencia con
  -- su explicación dentro. Esta es la puerta que antes no existía; sin ella, la
  -- avería la cerraba un supervisor desde un escritorio, sin decir qué se hizo.
  insert into incident_resolutions (id, incident_id, resolution, resolved_at, resolved_by)
  values (gen_random_uuid(), '77777777-7777-4777-8777-777777777791',
          'Cambiado el cable HDMI de la mesa; ya da imagen.', now(),
          '11111111-1111-4111-8111-111111111111');

  select case
    when (select count(*) from incidents
           where id = '77777777-7777-4777-8777-777777777791'
             and state = 'resuelta'
             and resolution = 'Cambiado el cable HDMI de la mesa; ya da imagen.'
             and resolved_by = '11111111-1111-4111-8111-111111111111'
             and resolved_at is not null) = 1
    then 'OK: la avería queda cerrada, explicada y firmada por el técnico'
    else 'FALLO: el cierre desde el aula no ha cerrado la incidencia'
  end as resultado;

  -- 2 — Un cierre mudo no entra. Es toda la razón de ser de esta tabla: cerrar
  -- sin decir qué se hizo deja el histórico de la sala igual de ciego que antes.
  savepoint s1;
  do $$
  begin
    insert into incident_resolutions (id, incident_id, resolution, resolved_at, resolved_by)
    values (gen_random_uuid(), '77777777-7777-4777-8777-777777777791', '   ', now(),
            '11111111-1111-4111-8111-111111111111');
    raise exception 'FALLO: se aceptó un cierre sin explicación';
  exception when check_violation then
    raise notice 'OK: un cierre sin explicación no entra';
  end $$;
  rollback to savepoint s1;

  -- 3 — Ni un cierre firmado en nombre de otro. Sin esto, «quién lo resolvió»
  -- sería un campo del formulario en vez de un dato.
  savepoint s2;
  do $$
  begin
    insert into incident_resolutions (id, incident_id, resolution, resolved_at, resolved_by)
    values (gen_random_uuid(), '77777777-7777-4777-8777-777777777791',
            'Lo arregló otro, dice este', now(),
            '22222222-2222-4222-8222-222222222222');
    raise exception 'FALLO: se firmó un cierre en nombre de otro';
  exception when insufficient_privilege then
    raise notice 'OK: RLS bloqueó la suplantación en el cierre';
  end $$;
  rollback to savepoint s2;

  -- 4 — El segundo cierre no reescribe el primero. Pasa de verdad: dos técnicos
  -- sin cobertura, o el mismo reintentando. La fila nueva se guarda —es lo que
  -- alguien escribió— y la incidencia conserva el cierre que ya tenía.
  insert into incident_resolutions (id, incident_id, resolution, resolved_at, resolved_by)
  values (gen_random_uuid(), '77777777-7777-4777-8777-777777777791',
          'Esto llega tarde y no debe pisar nada', now(),
          '11111111-1111-4111-8111-111111111111');

  select case
    when (select resolution from incidents where id = '77777777-7777-4777-8777-777777777791')
         = 'Cambiado el cable HDMI de la mesa; ya da imagen.'
     and (select count(*) from incident_resolutions
           where incident_id = '77777777-7777-4777-8777-777777777791') = 2
    then 'OK: el cierre repetido se guarda y no reescribe el que ya estaba'
    else 'FALLO: un cierre posterior ha pisado la resolución original'
  end as resultado;

  -- 5 — Y un cierre escrito no se reescribe ni se borra: es un asiento, como un
  -- movimiento de almacén o una foto.
  savepoint s3;
  do $$
  declare n int;
  begin
    update incident_resolutions set resolution = 'otra cosa'
     where incident_id = '77777777-7777-4777-8777-777777777791';
    get diagnostics n = row_count;
    if n > 0 then
      raise exception 'FALLO: se reescribieron % cierres', n;
    end if;
    delete from incident_resolutions
     where incident_id = '77777777-7777-4777-8777-777777777791';
    get diagnostics n = row_count;
    if n > 0 then
      raise exception 'FALLO: se borraron % cierres', n;
    end if;
    raise notice 'OK: los cierres no se reescriben ni se borran';
  exception when insufficient_privilege then
    raise notice 'OK: RLS bloqueó reescribir o borrar un cierre';
  end $$;
  rollback to savepoint s3;

  -- 6 — Y la puerta de siempre sigue cerrada: el UPDATE directo sobre
  -- `incidents` no se le abre a nadie por haber añadido esta tabla (prueba 4).
  savepoint s4;
  do $$
  declare n int;
  begin
    update incidents set state = 'abierta', resolution = null
     where id = '77777777-7777-4777-8777-777777777791';
    get diagnostics n = row_count;
    if n > 0 then
      raise exception 'FALLO: un técnico reabrió % incidencias a mano', n;
    end if;
    raise notice 'OK: reabrir a mano sigue siendo cosa de un supervisor';
  exception when insufficient_privilege then
    raise notice 'OK: RLS bloqueó el UPDATE directo';
  end $$;
  rollback to savepoint s4;
rollback;

\echo ''
\echo '=== 73. Las tablas de la sincronización no las lee cualquiera ==='
--
-- Lo que aterriza la sincronización es el libro entero, con columnas que en la
-- hoja no ve todo el mundo, y la instantánea es lo que decide quién gana cada
-- celda de la pasada siguiente. Poder escribirla desde un cliente sería poder
-- decidir a posteriori quién ganó.
begin;
  -- Material de prueba: un fichero aterrizado, su instantánea y un choque.
  insert into sync_ficheros (id, origen, nombre, sha256, bytes)
    values (9001, 'material_aulas', 'Material_Aulas.xlsx', 'deadbeef', 1234);
  insert into sync_filas (fichero_id, hoja, fila, ref, contenido, sha256)
    values (9001, 'Estado Aulas', 2, 'SALA-000001', '{"Serie":"X1"}'::jsonb, 'cafe');
  insert into sync_celdas (hoja, ref, columna, valor_base)
    values ('Estado Aulas', 'SALA-000001', 'Serie', 'X1');
  insert into import_quarantine (source, row_ref, raw, reason)
    values ('sharepoint:material_aulas', 'SALA-000001',
            '{"Serie":"X1"}'::jsonb, 'los dos lados cambiaron');

  savepoint s1;
  select test_as('11111111-1111-4111-8111-111111111111', 'tecnico');
  select case
    when (select count(*) from sync_celdas) = 0
     and (select count(*) from sync_filas) = 0
     and (select count(*) from sync_choques) = 0
    then 'OK: un técnico no ve el libro aterrizado ni la instantánea'
    else 'FALLO: la sincronización deja sus datos a la vista de cualquiera'
  end as resultado;
  rollback to savepoint s1;

  -- La vista tiene `security_invoker`: sin él consultaría con los permisos de
  -- quien la creó y se saltaría la RLS de `import_quarantine` entera.
  savepoint s2;
  select test_as('22222222-2222-4222-8222-222222222222', 'supervisor');
  select case
    when (select count(*) from sync_choques) = 0
     and (select count(*) from sync_partes) = 0
    then 'OK: ni un supervisor ve los choques por la puerta de la vista'
    else 'FALLO: sync_choques se salta la RLS de import_quarantine'
  end as resultado;
  rollback to savepoint s2;

  savepoint s3;
  select test_as('44444444-4444-4444-8444-444444444444', 'admin');
  select case
    when (select count(*) from sync_celdas) = 1
     and (select count(*) from sync_choques) = 1
    then 'OK: el administrador sí, que es quien resuelve los choques'
    else 'FALLO: el administrador no puede mirar lo que tiene que resolver'
  end as resultado;

  -- Y nadie escribe la instantánea desde la API: eso es del worker, que va con
  -- service-role y no pasa por aquí.
  do $$
  declare n int;
  begin
    insert into sync_celdas (hoja, ref, columna, valor_base)
      values ('Estado Aulas', 'SALA-000001', 'Serie', 'INVENTADO');
    get diagnostics n = row_count;
    if n > 0 then
      raise exception 'FALLO: se escribieron % celdas de la instantánea desde la API', n;
    end if;
  exception when insufficient_privilege then
    raise notice 'OK: RLS bloqueó escribir la instantánea desde la API';
  end $$;
  rollback to savepoint s3;
rollback;

\echo ''
\echo '=== 74. Los tres datos de Espacios rechazan lo imposible ==='
--
-- Un aula de 0 m² o de 4.000 asientos es un dedo que resbaló en la hoja. Se
-- rechaza en la puerta: después ya nadie recuerda cuál era el valor bueno.
begin;
  do $$
  declare r uuid;
  begin
    select id into r from rooms limit 1;

    begin
      update rooms set area_m2 = 0 where id = r;
      raise exception 'FALLO: un aula de 0 m² entró';
    exception when check_violation then
      raise notice 'OK: 0 m² no es una superficie';
    end;

    begin
      update rooms set seats = 4000 where id = r;
      raise exception 'FALLO: un aula de 4.000 asientos entró';
    exception when check_violation then
      raise notice 'OK: 4.000 asientos no es una capacidad';
    end;

    update rooms set area_m2 = 62.5, seats = 40, space_code = '11A002' where id = r;
    raise notice 'OK: los valores razonables entran';
  end $$;

  -- Y un código de espacio no se repite: si aparece dos veces es que el libro
  -- tiene un error, y vale más que la base lo diga a que lo repita en silencio.
  do $$
  declare a uuid; b uuid;
  begin
    select id into a from rooms order by short_ref limit 1;
    select id into b from rooms order by short_ref offset 1 limit 1;
    update rooms set space_code = '11A999' where id = a;
    begin
      update rooms set space_code = '11A999' where id = b;
      raise exception 'FALLO: dos salas con el mismo código de espacio';
    exception when unique_violation then
      raise notice 'OK: un código de espacio identifica un espacio';
    end;
  end $$;
rollback;
