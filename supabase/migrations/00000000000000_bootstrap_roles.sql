-- =============================================================================
-- Arranque sobre un Postgres GESTIONADO (Railway, Neon, RDS, Cloud SQL…)
--
-- La imagen `supabase/postgres` no es Postgres a secas: crea un conjunto de
-- roles y esquemas que el resto de servicios dan por existentes. Un Postgres
-- gestionado normal no los tiene, y sin ellos la migración de RLS falla al
-- intentar dar permisos a `supabase_auth_admin`, y el login devuelve 500 sin
-- ninguna pista de por qué.
--
-- Esta migración va PRIMERA y es idempotente. Sobre la imagen oficial de
-- Supabase no hace nada: todo existe ya y cada bloque se salta solo.
--
-- ⚠️ ORDEN DE DESPLIEGUE sobre Postgres gestionado. `profiles` referencia
--    `auth.users`, y esa tabla la crea GoTrue con sus propias migraciones al
--    arrancar, no nosotros. La secuencia correcta es:
--
--      1. Aplicar SOLO este fichero (crea roles, esquemas y auth.uid()).
--      2. Arrancar GoTrue y esperar a que termine sus migraciones.
--      3. Aplicar el resto de migraciones.
--
--    Saltarse el paso 2 hace que la migración 100 falle con
--    «relation "auth.users" does not exist», que no dice en absoluto que el
--    problema sea de orden.
--
-- Lo que NO puede arreglar: si tu proveedor no ofrece `pg_cron` ni `pg_net`,
-- los informes hay que dispararlos desde fuera. Al final del fichero se
-- explica cómo.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Roles
--
-- `authenticator` es el rol con el que PostgREST se conecta, y va cambiando a
-- `anon` o `authenticated` según el JWT de cada petición. Por eso necesita
-- poder asumirlos, y por eso él mismo no debe tener permisos propios.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;

  -- `bypassrls` es lo que permite al worker de informes y a los scripts de
  -- administración leerlo todo. Es, en la práctica, el rol de root.
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute format(
      'create role authenticator login noinherit password %L',
      coalesce(current_setting('app.authenticator_password', true), 'cambiame')
    );
  end if;

  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute format(
      'create role supabase_auth_admin login noinherit createrole password %L',
      coalesce(current_setting('app.auth_admin_password', true), 'cambiame')
    );
  end if;

  if not exists (select 1 from pg_roles where rolname = 'supabase_storage_admin') then
    execute format(
      'create role supabase_storage_admin login noinherit createrole password %L',
      coalesce(current_setting('app.storage_admin_password', true), 'cambiame')
    );
  end if;
end $$;

grant anon, authenticated, service_role to authenticator;

-- -----------------------------------------------------------------------------
-- Esquemas que crean y pueblan los propios servicios
-- -----------------------------------------------------------------------------
-- `create schema ... authorization` comprueba el AUTHORIZATION **antes** que el
-- `if not exists`, así que sobre un Supabase ya montado —donde estos esquemas
-- existen y los posee su propio administrador— la sentencia moría con «must be
-- able to SET ROLE "supabase_auth_admin"» sin tener nada que crear. Y como la
-- migración va entera en una transacción, eso dejaba el despliegue sin esquema
-- y sin ninguna pista de que el problema fuera solo este renglón.
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'auth') then
    execute 'create schema auth authorization supabase_auth_admin';
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    execute 'create schema storage authorization supabase_storage_admin';
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'extensions') then
    execute 'create schema extensions';
  end if;
end $$;

-- Uno a uno y tolerando que nos digan que no: sobre un Postgres desnudo estos
-- esquemas los acabamos de crear y el permiso se da; sobre un Supabase ya
-- montado son de sus administradores y estos permisos vienen de serie, así que
-- lo que se recibe es un «permission denied» por algo que ya está hecho. Cada
-- uno en su bloque para que el que falle no impida los demás.
do $$
declare
  esquema text;
begin
  foreach esquema in array array['public', 'extensions', 'auth', 'storage'] loop
    begin
      execute format('grant usage on schema %I to anon, authenticated, service_role', esquema);
    exception when insufficient_privilege then
      raise notice 'sin permiso sobre el esquema %: es de otro rol y ya traerá los suyos', esquema;
    end;
  end loop;
end $$;

-- En Supabase estos permisos vienen de serie y RLS es quien restringe después.
-- Sin ellos, `authenticated` ni siquiera vería las tablas y todo fallaría por
-- el motivo equivocado: parecería un problema de políticas cuando es de GRANT.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Extensiones
--
-- Cada bloque va aparte para que la ausencia de una no impida instalar las
-- demás. Un proveedor gestionado suele permitir solo las de su lista blanca.
-- -----------------------------------------------------------------------------
do $$
begin
  create extension if not exists pgcrypto with schema extensions;
exception when others then
  -- Sin pgcrypto no hay gen_random_uuid() y el esquema no se puede crear.
  raise exception 'pgcrypto es imprescindible y tu proveedor no la permite: %', sqlerrm;
end $$;

do $$
begin
  create extension if not exists pgjwt with schema extensions;
exception when others then
  raise notice 'pgjwt no disponible (opcional: solo la usa Supabase Studio)';
end $$;

-- -----------------------------------------------------------------------------
-- auth.uid() y auth.jwt()
--
-- Las 16 políticas RLS del proyecto dependen de estas dos funciones. GoTrue no
-- las crea: las crea la imagen de Supabase. En un Postgres gestionado hay que
-- ponerlas a mano o RLS no compila.
--
-- Leen el JWT que PostgREST inyecta como variable de sesión en cada petición.
-- -----------------------------------------------------------------------------
-- Se crean solo si faltan, y por el mismo motivo que los esquemas: cuando ya
-- hay un Supabase, estas funciones existen y son de `supabase_auth_admin`. Un
-- `create or replace` desde otro rol no las mejora, falla con «must be owner of
-- function» y se lleva por delante toda la migración.
--
-- La existencia se pregunta al catálogo y no con `to_regprocedure`: resolver un
-- nombre exige `usage` sobre su esquema, y `auth` es justo el que aquí puede
-- estar vedado. Preguntarlo de la forma cómoda fallaba con «permission denied
-- for schema auth» al comprobar si hacía falta hacer algo.
do $do$
declare
  hay boolean;
begin
  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid' and p.pronargs = 0
  ) into hay;
  if not hay then
    execute $crea$
      create function auth.uid()
      returns uuid
      language sql stable
      as $cuerpo$
        select nullif(
          coalesce(
            current_setting('request.jwt.claim.sub', true),
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
          ), ''
        )::uuid;
      $cuerpo$
    $crea$;
  end if;

  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'jwt' and p.pronargs = 0
  ) into hay;
  if not hay then
    execute $crea$
      create function auth.jwt()
      returns jsonb
      language sql stable
      as $cuerpo$
        select coalesce(
          nullif(current_setting('request.jwt.claim', true), '')::jsonb,
          nullif(current_setting('request.jwt.claims', true), '')::jsonb,
          '{}'::jsonb
        );
      $cuerpo$
    $crea$;
  end if;

  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'role' and p.pronargs = 0
  ) into hay;
  if not hay then
    execute $crea$
      create function auth.role()
      returns text
      language sql stable
      as $cuerpo$
        select coalesce(
          current_setting('request.jwt.claim.role', true),
          (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
        );
      $cuerpo$
    $crea$;
  end if;
end
$do$;

do $$
begin
  grant execute on function auth.uid(), auth.jwt(), auth.role()
    to anon, authenticated, service_role;
exception when insufficient_privilege then
  raise notice 'las funciones auth.* son de supabase_auth_admin y ya tienen estos permisos';
end $$;

-- -----------------------------------------------------------------------------
-- Si tu proveedor no ofrece pg_cron ni pg_net
--
-- La migración 500 ya tolera su ausencia, así que el despliegue no se rompe:
-- simplemente los informes no se disparan solos. Alternativa, desde el cron del
-- sistema o el programador de la plataforma:
--
--   0  7 * * *  curl -fsS -X POST https://TU-WORKER/generate \
--                 -H "Authorization: Bearer $REPORTS_WORKER_TOKEN" \
--                 -H 'Content-Type: application/json' \
--                 -d '{"kind":"diario"}'
--   30 7 * * 1  ... -d '{"kind":"semanal"}'
--
-- El worker expone el mismo endpoint que llamaría pg_net, así que no hay que
-- cambiar nada de código.
-- -----------------------------------------------------------------------------
