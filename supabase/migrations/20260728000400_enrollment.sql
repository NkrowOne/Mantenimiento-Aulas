-- =============================================================================
-- Alta de dispositivos por código de un solo uso
--
-- Por qué no OTP por email: los informes son de descarga y no hay SMTP que
-- mantener. Con un equipo pequeño, las altas son un hecho puntual y el admin
-- puede entregar el código en mano.
--
-- El código funciona como contraseña temporal. En cuanto el dispositivo entra,
-- la app rota la contraseña a una aleatoria fuerte que NO se guarda en ninguna
-- parte, y a partir de ahí la única llave es el refresh token cifrado con el PIN.
-- Así el código no queda como credencial válida indefinidamente.
-- =============================================================================

create table enrollment_codes (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id) on delete cascade,
  -- Nunca el código en claro: solo su hash.
  code_hash   text not null,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now()
);

create index enrollment_codes_profile_idx on enrollment_codes(profile_id)
  where consumed_at is null;

alter table enrollment_codes enable row level security;

-- Nadie lo lee desde el cliente. El admin lo gestiona a través del endpoint
-- de servicio, que usa service-role y se salta RLS.
create policy "admin ve altas" on enrollment_codes
  for select to authenticated using (public.is_admin());

-- Marca el código como consumido. La llama el propio usuario justo después de
-- entrar por primera vez, así que solo puede quemar el suyo.
create or replace function public.consume_enrollment_code()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update enrollment_codes
  set consumed_at = now()
  where profile_id = (select auth.uid())
    and consumed_at is null
    and expires_at > now();
end;
$$;

grant execute on function public.consume_enrollment_code() to authenticated;

-- Registro de dispositivos dados de alta. Sirve para que un supervisor pueda
-- ver desde dónde se está trabajando y revocar un iPad perdido.
create table devices (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references profiles(id) on delete cascade,
  label        text not null,
  user_agent   text,
  enrolled_at  timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);

create index devices_profile_idx on devices(profile_id);

alter table devices enable row level security;

create policy "ver dispositivos propios" on devices
  for select to authenticated
  using (profile_id = (select auth.uid()) or public.is_supervisor());

create policy "registrar dispositivo propio" on devices
  for insert to authenticated
  with check (profile_id = (select auth.uid()));

create policy "actualizar dispositivo propio" on devices
  for update to authenticated
  using (profile_id = (select auth.uid()) or public.is_supervisor())
  with check (profile_id = (select auth.uid()) or public.is_supervisor());
