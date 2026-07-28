-- Emula lo mínimo de Supabase para poder validar las migraciones en un Postgres
-- desnudo: los roles, el esquema `auth` y las funciones que usan las políticas.
--
-- No forma parte del despliegue. Solo lo usa `npm run db:verify`.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role supabase_auth_admin login noinherit createrole;

create schema if not exists auth authorization supabase_auth_admin;

create table auth.users (
  id                   uuid primary key default gen_random_uuid(),
  email                text unique,
  raw_user_meta_data   jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now()
);

grant usage on schema auth to authenticated, anon, service_role;

-- En Supabase estas leen el JWT que PostgREST inyecta como GUC de la sesión.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

-- Supabase concede estos permisos de serie a los roles de PostgREST; RLS es
-- quien restringe después. Sin ellos, `authenticated` ni siquiera ve las tablas
-- y las pruebas fallarían por el motivo equivocado.
grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;
