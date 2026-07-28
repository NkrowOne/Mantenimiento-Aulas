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
