-- reejecutable: si
-- (`create table if not exists`, `create index if not exists`, `alter table …
-- enable row level security`, `drop policy if exists` delante de cada `create
-- policy`, `comment`, `grant`, `revoke` y `notify`. Ni un dato tocado.)
-- =============================================================================
-- El informe se pide y se cierra la aplicación
--
-- El informe se arma en el navegador desde `20260821000100`. Tiene un límite
-- que se ve en un iPhone: en cuanto la aplicación pasa a segundo plano —se
-- bloquea la pantalla, se abre el correo para mirar a quién hay que mandárselo—
-- el sistema la congela, las peticiones a medias se cortan y el informe se
-- queda sin hacer. Con la IA redactando eso es hasta un minuto con la pantalla
-- encendida y sin tocar nada, y nadie pide un informe para quedarse mirándolo.
--
-- Desde hoy la pantalla solo lo PIDE. El servidor de informes —el que ya
-- convertía el documento a PDF— lo genera entero, con el mismo código que la
-- aplicación y con la sesión de quien lo pidió, y lo deja en el archivo. Se
-- puede cerrar la aplicación: al volver, está.
--
-- Esta tabla es la memoria de eso: una fila por informe pedido al servidor,
-- con por dónde va. Es lo que permite que la pantalla diga «leyendo las fotos»
-- mientras se mira, y «listo» o «no ha salido, por esto» al volver —desde ese
-- dispositivo o desde otro—, sin que el servidor tenga que acordarse de nada
-- si lo reinician.
--
-- No sustituye a `report_requests`, que es otra cosa: el registro de las
-- llamadas de pg_net al worker antiguo, con el id de pg_net por clave.
--
-- Si el servidor de informes no está desplegado, o esta migración no se ha
-- aplicado, no se rompe nada: la aplicación lo nota y genera el informe en el
-- navegador, como hasta ahora.
-- =============================================================================

create table if not exists report_jobs (
  id           uuid primary key default gen_random_uuid(),

  -- Lo que se pidió. Las mismas tres columnas que `reports`, y `params` con las
  -- casillas marcadas y las instrucciones: con esto se puede volver a pedir el
  -- mismo informe con un toque si no salió.
  kind         text not null check (kind in ('diario', 'semanal', 'personalizado')),
  period_start date not null,
  period_end   date not null,
  params       jsonb not null default '{}'::jsonb,

  -- Por dónde va.
  --   en_cola   aceptado, esperando turno (el servidor los hace de uno en uno)
  --   en_curso  generándose; `paso` y `detalle` dicen qué está haciendo
  --   hecho     archivado; `storage_path` dice dónde
  --   fallido   no ha salido; `error` dice por qué, con palabras para enseñar
  estado       text not null default 'en_cola'
               check (estado in ('en_cola', 'en_curso', 'hecho', 'fallido')),
  paso         text,
  detalle      text,
  error        text,

  -- Dónde quedó el documento: el mismo valor que `reports.storage_path`.
  storage_path text,

  -- Si la cuenta se borra, la petición se queda sin autor: una cola de
  -- trabajos no es motivo para impedir un borrado.
  pedido_por   uuid references profiles(id) on delete set null,
  pedido_at    timestamptz not null default now(),

  -- El pulso. El servidor lo renueva cada pocos segundos mientras el trabajo
  -- está vivo. Si lo reinician a mitad, el pulso se para, y eso es lo que
  -- distingue «sigue en ello» de «se quedó a medias» sin tener que preguntarle
  -- a un proceso que ya no existe.
  latido_at    timestamptz not null default now(),
  terminado_at timestamptz
);

comment on table report_jobs is
  'Los informes pedidos al servidor para que se generen sin la aplicación abierta: una fila por petición, con su estado, el paso por el que va y dónde quedó archivado. La escribe el servidor de informes; la pantalla solo la lee.';

create index if not exists report_jobs_pedido_idx on report_jobs (pedido_at desc);

alter table report_jobs enable row level security;

-- De administrador, igual que emitir un informe. La fila lleva dentro las
-- instrucciones que se le dieron a la IA y la nota de la portada.
drop policy if exists "admin ve informes en curso" on report_jobs;
create policy "admin ve informes en curso" on report_jobs
  for select to authenticated using ((select public.is_admin()));

-- Quitar de la lista uno que falló o que ya se ha recogido. Borrar la fila no
-- borra ningún informe: el documento está en el archivo, que no se toca.
drop policy if exists "admin quita informes en curso" on report_jobs;
create policy "admin quita informes en curso" on report_jobs
  for delete to authenticated using ((select public.is_admin()));

-- Sin política de INSERT ni de UPDATE, y los permisos dicen lo mismo: la fila
-- la crea y la mueve el servidor de informes, con el rol de servicio, después
-- de comprobar la sesión de quien llama. Si la pantalla pudiera escribirla,
-- «hecho» sería un campo de formulario.
revoke all on public.report_jobs from anon;
revoke insert, update, truncate on public.report_jobs from authenticated;
grant select, delete on public.report_jobs to authenticated;
grant all on public.report_jobs to service_role;

notify pgrst, 'reload schema';
