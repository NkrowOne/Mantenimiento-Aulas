-- =============================================================================
-- Buckets de Storage y sus políticas
--
-- El código ya sube a estos dos buckets (`src/sync/outbox.ts` y
-- `reports-worker/src/server.ts`), pero nadie los creaba: toda foto de
-- incidencia fallaba al subir, en silencio y reintentando para siempre.
--
-- Los dos son PRIVADOS. Las fotos muestran instalaciones y a veces personas, y
-- los informes contienen el estado operativo del campus. El acceso va siempre
-- por URL firmada de duración corta, nunca por enlace público permanente.
-- =============================================================================

-- `storage.buckets` la crea el servicio de Storage con sus propias migraciones.
-- Si aún no existe, el error nativo de Postgres no dice nada útil sobre la
-- causa, así que se sustituye por uno que sí explica qué hacer.
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise exception
      'El servicio de Storage aún no ha arrancado. Levántalo y vuelve a aplicar esta migración.'
      using hint = 'Orden correcto: bootstrap → arrancar GoTrue y Storage → resto de migraciones.';
  end if;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  -- 5 MB por foto es holgado: el cliente las comprime a ~200 KB. El límite está
  -- para atajar una subida anómala en el borde, no para el caso normal.
  ('fotos', 'fotos', false, 5242880, array['image/jpeg', 'image/png']),
  ('reports', 'reports', false, 26214400, array['application/pdf'])
on conflict (id) do update
  set file_size_limit   = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types,
      public            = excluded.public;

-- -----------------------------------------------------------------------------
-- fotos — el personal sube y lee; nadie borra ni modifica
--
-- Coherente con el modelo append-only del resto del sistema: una foto de
-- incidencia es prueba de un estado en un momento dado. Permitir borrarla o
-- reemplazarla convertiría el historial en algo negociable.
-- -----------------------------------------------------------------------------
drop policy if exists "personal sube fotos" on storage.objects;
create policy "personal sube fotos"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'fotos' and public.is_staff());

drop policy if exists "personal lee fotos" on storage.objects;
create policy "personal lee fotos"
  on storage.objects for select to authenticated
  using (bucket_id = 'fotos' and public.is_staff());

-- Sin políticas de UPDATE ni DELETE sobre `fotos`: en RLS, lo que no se permite
-- explícitamente queda denegado. Si algún día hay que retirar una foto por
-- protección de datos, se hace con el rol de servicio y queda registrado.

-- -----------------------------------------------------------------------------
-- reports — el personal los lee; los escribe solo el worker
-- -----------------------------------------------------------------------------
drop policy if exists "personal lee informes" on storage.objects;
create policy "personal lee informes"
  on storage.objects for select to authenticated
  using (bucket_id = 'reports' and public.is_staff());

-- El worker usa la clave de servicio, que se salta RLS. No hay política de
-- escritura para usuarios: un informe emitido no se regenera, se versiona, y
-- dejar que un cliente lo sobrescriba rompería esa garantía.
