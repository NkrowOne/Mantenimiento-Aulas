-- =============================================================================
-- Autenticación, roles, RLS y auditoría
--
-- Dos cosas críticas aquí:
--  1. Los GRANT a supabase_auth_admin. Sin ellos el hook falla EN SILENCIO y el
--     login devuelve 500 al emitir el token. Es la causa nº1 de que esto no tire.
--  2. Cada auth.uid() va envuelto en (select ...). Provoca un initPlan que el
--     planificador cachea por sentencia en vez de evaluar fila a fila.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Hook que mete el rol en el JWT, para que RLS no tenga que hacer join por fila
-- -----------------------------------------------------------------------------
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims     jsonb;
  user_role  public.app_role;
begin
  select role into user_role
  from public.profiles
  where id = (event->>'user_id')::uuid and active;

  claims := event->'claims';

  if user_role is not null then
    claims := jsonb_set(claims, '{app_role}', to_jsonb(user_role::text));
  else
    -- Usuario desactivado o sin perfil: entra sin rol y RLS no le deja nada.
    claims := jsonb_set(claims, '{app_role}', '"none"'::jsonb);
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- Sin este bloque, el hook no dispara y el login se rompe sin mensaje útil.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
grant select on table public.profiles to supabase_auth_admin;

alter table profiles enable row level security;

drop policy if exists "auth admin lee perfiles" on profiles;
create policy "auth admin lee perfiles"
  on profiles as permissive for select to supabase_auth_admin using (true);

-- -----------------------------------------------------------------------------
-- Ayudantes de rol. Leen del claim, no de la tabla: cero joins en las políticas.
-- -----------------------------------------------------------------------------
create or replace function public.auth_role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'app_role',
    'none'
  );
$$;

create or replace function public.is_admin()
returns boolean language sql stable as $$
  select public.auth_role() = 'admin';
$$;

create or replace function public.is_supervisor()
returns boolean language sql stable as $$
  select public.auth_role() in ('supervisor', 'admin');
$$;

create or replace function public.is_staff()
returns boolean language sql stable as $$
  select public.auth_role() in ('tecnico', 'supervisor', 'admin');
$$;

-- -----------------------------------------------------------------------------
-- Perfiles
-- -----------------------------------------------------------------------------
drop policy if exists "ver perfiles" on profiles;
create policy "ver perfiles" on profiles
  for select to authenticated
  using ((select auth.uid()) = id or public.is_supervisor());

drop policy if exists "admin gestiona perfiles" on profiles;
create policy "admin gestiona perfiles" on profiles
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- -----------------------------------------------------------------------------
-- Maestros: todo el personal lee, solo admin escribe
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['buildings','zones','rooms','room_aliases','asset_types','stock_items']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy "personal lee %1$s" on %1$I for select to authenticated using (public.is_staff())', t);
    execute format(
      'create policy "admin escribe %1$s" on %1$I for all to authenticated
         using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Revisiones
--
-- Un técnico crea las suyas y puede editarlas MIENTRAS son borrador.
-- En cuanto pasan a 'completa' quedan congeladas: eso es lo que hace que el
-- historial valga como registro de auditoría.
-- -----------------------------------------------------------------------------
alter table inspections enable row level security;

drop policy if exists "personal lee revisiones" on inspections;
create policy "personal lee revisiones" on inspections
  for select to authenticated using (public.is_staff());

drop policy if exists "tecnico crea sus revisiones" on inspections;
create policy "tecnico crea sus revisiones" on inspections
  for insert to authenticated
  with check (public.is_staff() and by_user = (select auth.uid()));

drop policy if exists "tecnico edita su borrador" on inspections;
create policy "tecnico edita su borrador" on inspections
  for update to authenticated
  using (by_user = (select auth.uid()) and status = 'borrador')
  with check (by_user = (select auth.uid()));

drop policy if exists "supervisor corrige revisiones" on inspections;
create policy "supervisor corrige revisiones" on inspections
  for update to authenticated
  using (public.is_supervisor()) with check (public.is_supervisor());

-- La garantía append-only, a nivel de base de datos y no de confianza en el cliente.
create or replace function public.freeze_completed_inspection()
returns trigger language plpgsql as $$
begin
  if old.status = 'completa' and public.auth_role() <> 'admin' then
    raise exception 'Una revisión completa es inmutable (id=%)', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger inspections_freeze
  before update on inspections
  for each row execute function public.freeze_completed_inspection();

alter table inspection_checks enable row level security;

drop policy if exists "personal lee checks" on inspection_checks;
create policy "personal lee checks" on inspection_checks
  for select to authenticated using (public.is_staff());

-- Los checks se escriben solo si su revisión sigue siendo borrador del propio usuario.
drop policy if exists "escribir checks del borrador propio" on inspection_checks;
create policy "escribir checks del borrador propio" on inspection_checks
  for all to authenticated
  using (
    exists (
      select 1 from inspections i
      where i.id = inspection_id
        and (i.by_user = (select auth.uid()) and i.status = 'borrador' or public.is_supervisor())
    )
  )
  with check (
    exists (
      select 1 from inspections i
      where i.id = inspection_id
        and (i.by_user = (select auth.uid()) and i.status = 'borrador' or public.is_supervisor())
    )
  );

-- -----------------------------------------------------------------------------
-- Incidencias: cualquiera del equipo abre, solo supervisor cierra
-- -----------------------------------------------------------------------------
alter table incidents enable row level security;

drop policy if exists "personal lee incidencias" on incidents;
create policy "personal lee incidencias" on incidents
  for select to authenticated using (public.is_staff());

drop policy if exists "personal abre incidencias" on incidents;
create policy "personal abre incidencias" on incidents
  for insert to authenticated
  with check (public.is_staff() and state = 'abierta');

drop policy if exists "supervisor gestiona incidencias" on incidents;
create policy "supervisor gestiona incidencias" on incidents
  for update to authenticated
  using (public.is_supervisor()) with check (public.is_supervisor());

alter table incident_materials enable row level security;

drop policy if exists "personal lee materiales" on incident_materials;
create policy "personal lee materiales" on incident_materials
  for select to authenticated using (public.is_staff());

drop policy if exists "supervisor escribe materiales" on incident_materials;
create policy "supervisor escribe materiales" on incident_materials
  for all to authenticated
  using (public.is_supervisor()) with check (public.is_supervisor());

-- -----------------------------------------------------------------------------
-- Inventario y stock
-- -----------------------------------------------------------------------------
alter table assets enable row level security;
alter table asset_events enable row level security;
alter table stock_movements enable row level security;

drop policy if exists "personal lee equipos" on assets;
create policy "personal lee equipos" on assets
  for select to authenticated using (public.is_staff());
drop policy if exists "supervisor gestiona equipos" on assets;
create policy "supervisor gestiona equipos" on assets
  for all to authenticated
  using (public.is_supervisor()) with check (public.is_supervisor());

drop policy if exists "personal lee eventos de equipo" on asset_events;
create policy "personal lee eventos de equipo" on asset_events
  for select to authenticated using (public.is_staff());
drop policy if exists "personal registra eventos de equipo" on asset_events;
create policy "personal registra eventos de equipo" on asset_events
  for insert to authenticated
  with check (public.is_staff() and by_user = (select auth.uid()));

drop policy if exists "personal lee movimientos" on stock_movements;
create policy "personal lee movimientos" on stock_movements
  for select to authenticated using (public.is_staff());

-- Un técnico puede descontar material al resolver algo en el aula, pero no
-- puede inventar entradas de almacén: las compras y los ajustes son de supervisor.
drop policy if exists "tecnico consume material" on stock_movements;
create policy "tecnico consume material" on stock_movements
  for insert to authenticated
  with check (
    public.is_staff() and by_user = (select auth.uid())
    and (kind = 'consumo' or public.is_supervisor())
  );

drop policy if exists "supervisor corrige movimientos" on stock_movements;
create policy "supervisor corrige movimientos" on stock_movements
  for update to authenticated
  using (public.is_supervisor()) with check (public.is_supervisor());

-- -----------------------------------------------------------------------------
-- Adjuntos e informes
-- -----------------------------------------------------------------------------
alter table attachments enable row level security;

drop policy if exists "personal lee adjuntos" on attachments;
create policy "personal lee adjuntos" on attachments
  for select to authenticated using (public.is_staff());
drop policy if exists "personal sube adjuntos" on attachments;
create policy "personal sube adjuntos" on attachments
  for insert to authenticated
  with check (public.is_staff() and by_user = (select auth.uid()));

alter table reports enable row level security;

drop policy if exists "personal lee informes" on reports;
create policy "personal lee informes" on reports
  for select to authenticated using (public.is_staff());
drop policy if exists "supervisor genera informes" on reports;
create policy "supervisor genera informes" on reports
  for insert to authenticated with check (public.is_supervisor());

-- -----------------------------------------------------------------------------
-- Tablas de importación: solo admin
-- -----------------------------------------------------------------------------
alter table import_fixes enable row level security;
alter table import_quarantine enable row level security;
alter table audit_log enable row level security;

drop policy if exists "admin lee correcciones" on import_fixes;
create policy "admin lee correcciones" on import_fixes
  for select to authenticated using (public.is_admin());
drop policy if exists "admin gestiona cuarentena" on import_quarantine;
create policy "admin gestiona cuarentena" on import_quarantine
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "supervisor lee auditoría" on audit_log;
create policy "supervisor lee auditoría" on audit_log
  for select to authenticated using (public.is_supervisor());

-- -----------------------------------------------------------------------------
-- Auditoría de lo mutable
--
-- Solo se audita lo que se puede editar. Las tablas append-only no lo necesitan:
-- su propio historial ya es el registro.
-- -----------------------------------------------------------------------------
create or replace function public.audit_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor uuid;
begin
  -- Puede ser NULL: el worker de informes escribe con service-role y no debe
  -- atribuirse la autoría de nadie.
  actor := (select auth.uid());

  if tg_op = 'DELETE' then
    insert into audit_log(table_name, row_id, op, old_data, new_data, by_user)
    values (tg_table_name, old.id::text, tg_op, to_jsonb(old), null, actor);
    return old;
  elsif tg_op = 'UPDATE' then
    -- Un UPDATE que no cambia nada no merece una fila de auditoría.
    if to_jsonb(old) = to_jsonb(new) then
      return new;
    end if;
    insert into audit_log(table_name, row_id, op, old_data, new_data, by_user)
    values (tg_table_name, new.id::text, tg_op, to_jsonb(old), to_jsonb(new), actor);
    return new;
  else
    insert into audit_log(table_name, row_id, op, old_data, new_data, by_user)
    values (tg_table_name, new.id::text, tg_op, null, to_jsonb(new), actor);
    return new;
  end if;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['buildings','zones','rooms','stock_items','assets','incidents','profiles']
  loop
    execute format(
      'create trigger %1$s_audit after insert or update or delete on %1$I
         for each row execute function public.audit_trigger()', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Alta automática de perfil al crear el usuario en auth
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.email,
    coalesce((new.raw_user_meta_data->>'role')::public.app_role, 'tecnico')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
