-- =============================================================================
-- Sincronización con los dos Excel de SharePoint — el sitio donde apoyarse
--
-- Fase 2 de `docs/sincronizacion-sharepoint.md`. No sincroniza todavía: pone lo
-- que la sincronización necesita para no destrozar nada, que son dos cosas
-- distintas y conviene no confundirlas.
--
-- **Uno.** Tres datos del libro de revisión que hoy no tienen dónde caer: el
-- código oficial de espacio, los metros cuadrados y la capacidad. Sin columna,
-- las 194 filas de ese libro entran a medias y nadie sabe qué se quedó fuera.
--
-- **Dos.** Las tablas de la sincronización, y de ellas la que de verdad importa
-- es la **instantánea** (`sync_celdas`). Sin ella, «bidireccional» solo puede
-- significar «gana el último», que es otra manera de decir que se pierden
-- ediciones y nadie sabe cuáles. Con ella hay tres valores para cada celda —el
-- de la base, el del Excel y el de la última pasada correcta— y la decisión deja
-- de ser una apuesta: si solo cambió un lado, ese lado manda; si cambiaron los
-- dos, se paran los dos y decide una persona.
--
-- Todo lo que entra por aquí queda aterrizado antes de interpretarse: el fichero
-- entero con su hash, y cada fila de cada hoja tal cual venía. Es lo que permite
-- contestar «¿de dónde salió este dato?» seis meses después, y lo que hace que
-- una pasada fallida se pueda repetir sin consecuencias.
--
-- Nada de esto escribe en `rooms`, `assets` ni `stock_movements`. Eso lo hace el
-- sincronizador, en una transacción, con `source = 'sharepoint'` y
-- `by_user = NULL`: el Excel no dice quién hizo cada cosa, y atribuírselo a
-- alguien falsearía la trazabilidad que sostiene todo lo demás.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — Los tres datos que dice Patrimonio
--
-- `space_code` va aparte de `code` y de `short_ref` a propósito, y no es
-- duplicación: son tres identidades con tres dueños distintos.
--
--   `code`      la etiqueta de la puerta (`1.4`). Se repite entre edificios y
--               se puede cambiar: la cambia quien pone el cartel.
--   `short_ref` la matrícula (`SALA-000087`). La pone la aplicación, no cambia
--               nunca, y es la que va a la columna `Ref` del Excel.
--   `space_code` lo que dice Patrimonio (`11A002`).
--
-- Meterlas en la misma columna es garantizar que una pise a otra el día que
-- alguien renumere un edificio.
--
-- Las tres nacen vacías y **la app no las edita**: vienen del libro de revisión
-- en cada pasada. La app las muestra y las imprime.
-- -----------------------------------------------------------------------------

alter table rooms add column if not exists space_code text;
alter table rooms add column if not exists area_m2    numeric(7,2);
alter table rooms add column if not exists seats      int;

comment on column rooms.space_code is
  'Código oficial de espacio de Patrimonio (11A002). Ni es la etiqueta de la puerta (code) ni la matrícula (short_ref): tres dueños distintos. Lo escribe la sincronización, no la app.';
comment on column rooms.area_m2 is
  'Metros cuadrados según Espacios. Solo lectura en la app.';
comment on column rooms.seats is
  'Capacidad según Espacios. Solo lectura en la app.';

-- Un código de espacio identifica un espacio: si aparece dos veces es que el
-- libro tiene un error, y es mejor que la base lo diga a que lo repita en
-- silencio. Parcial porque la inmensa mayoría de las salas todavía no lo tienen.
create unique index if not exists rooms_space_code_idx
  on rooms(space_code) where space_code is not null;

-- Un aula de 0 m² o de 4.000 asientos es un dedo que resbaló en la hoja, no un
-- dato. Se rechaza en la puerta: corregirlo después exige saber cuál era el
-- valor bueno, y para entonces ya nadie se acuerda.
alter table rooms drop constraint if exists rooms_area_m2_check;
alter table rooms add constraint rooms_area_m2_check
  check (area_m2 is null or (area_m2 > 0 and area_m2 < 10000));
alter table rooms drop constraint if exists rooms_seats_check;
alter table rooms add constraint rooms_seats_check
  check (seats is null or (seats > 0 and seats < 2000));

-- -----------------------------------------------------------------------------
-- 2 — El aterrizaje: el fichero entero, antes de interpretar nada
--
-- La idempotencia es por hash y no por nombre de fichero ni por fecha: los dos
-- libros se llaman siempre igual y la fecha de modificación cambia cuando
-- alguien abre el libro y lo cierra sin tocarlo. Con `unique (origen, sha256)`,
-- reprocesar el mismo fichero dos veces no aterriza dos veces — que es lo que
-- impide que una pasada repetida duplique 276 aulas.
--
-- `ctag` y no `etag`: el `eTag` de Graph cambia al renombrar el fichero o al
-- tocar una columna de la biblioteca, y eso dispararía resincronizaciones de un
-- fichero cuyo contenido es idéntico. El `cTag` solo cambia con el contenido.
-- Va nullable porque por la vía manual —subir el libro a mano— no hay ninguno.
-- -----------------------------------------------------------------------------

create table if not exists sync_ficheros (
  id          bigserial primary key,
  -- 'material_aulas' | 'aulas_revision'
  origen      text not null,
  nombre      text not null,
  ctag        text,
  sha256      text not null,
  bytes       bigint not null check (bytes > 0),
  -- Quién lo subió, cuando lo sube una persona. NULL si lo bajó el worker.
  subido_por  uuid references profiles(id),
  at          timestamptz not null default now(),
  unique (origen, sha256)
);

comment on table sync_ficheros is
  'Cada .xlsx visto, con su hash. La idempotencia va por sha256: el mismo fichero dos veces no se aterriza dos veces.';

-- Las filas tal cual venían, sin interpretar. Esto es lo que contesta «¿de dónde
-- salió este dato?» seis meses después, cuando el libro ya se ha editado veinte
-- veces y la fila 87 de entonces no es la de hoy.
create table if not exists sync_filas (
  id          bigserial primary key,
  fichero_id  bigint not null references sync_ficheros(id) on delete cascade,
  hoja        text not null,
  fila        int not null check (fila > 0),
  -- La matrícula de la columna `Ref`. NULL = alta hecha desde el Excel: la
  -- sincronización la crea y le devuelve la suya. Sin esta columna un aula nueva
  -- es indistinguible de una renombrada, y se duplica.
  ref         text,
  contenido   jsonb not null,
  sha256      text not null,
  unique (fichero_id, hoja, fila)
);

create index if not exists sync_filas_ref_idx on sync_filas(ref) where ref is not null;
create index if not exists sync_filas_hoja_idx on sync_filas(fichero_id, hoja);

-- -----------------------------------------------------------------------------
-- 3 — La instantánea: el antepasado común
--
-- La pieza que hace que la bidireccionalidad sea segura, y la única de esta
-- migración que no se puede reconstruir si se pierde: son los valores de la
-- última pasada correcta, y sin ellos no hay forma de distinguir «esto lo cambió
-- el Excel» de «esto lo cambió la app».
--
-- Se guarda como texto a propósito, aunque la columna de origen sea numérica o
-- una fecha. Lo que se compara es lo que había en la celda, y guardarlo tipado
-- obligaría a una tabla por tipo o a un jsonb que en la práctica también es
-- texto. La comparación la hace `canonizar()` en `src/domain/fusion.ts`, que ya
-- sabe que `12,50` y `12.5` son la misma medición y que `0012` y `12` no son el
-- mismo número de serie.
--
-- La clave es (hoja, ref, columna) y no la entidad de la base: una celda
-- pertenece a una hoja. `entidad`/`entidad_id` van al lado para poder mirar la
-- instantánea desde el otro extremo —«¿qué celdas tocan esta sala?»— sin
-- reconstruir el cruce entero.
-- -----------------------------------------------------------------------------

create table if not exists sync_celdas (
  id          bigserial primary key,
  hoja        text not null,
  ref         text not null,
  columna     text not null,
  valor_base  text,
  -- 'room' | 'asset' | 'stock_item' | 'inspection'
  entidad     text,
  entidad_id  uuid,
  at          timestamptz not null default now(),
  unique (hoja, ref, columna)
);

comment on table sync_celdas is
  'El antepasado común de la fusión a tres bandas: el valor exacto de cada celda tras la última pasada correcta. Perderlo deja la sincronización en «gana el último».';

create index if not exists sync_celdas_entidad_idx
  on sync_celdas(entidad, entidad_id) where entidad_id is not null;

-- -----------------------------------------------------------------------------
-- 4 — El parte de cada pasada
--
-- Una sincronización que no deja parte es una en la que nadie confía a los tres
-- meses. Y el parte se abre **antes** de empezar y se cierra al terminar: una
-- pasada que se murió a la mitad tiene que verse como lo que es —una fila con
-- `termino_at` vacío— y no desaparecer sin dejar rastro, que es justo el caso en
-- el que hace falta mirar.
-- -----------------------------------------------------------------------------

create table if not exists sync_partes (
  id             bigserial primary key,
  origen         text not null,
  fichero_id     bigint references sync_ficheros(id) on delete set null,
  -- 'manual' (alguien subió el libro) | 'programada' | 'a_mano' (botón)
  disparo        text not null default 'manual',
  comenzo_at     timestamptz not null default now(),
  termino_at     timestamptz,
  filas_leidas   int not null default 0,
  sin_cambios    int not null default 0,
  hacia_la_base  int not null default 0,
  hacia_el_excel int not null default 0,
  conflictos     int not null default 0,
  descuadres     int not null default 0,
  altas          int not null default 0,
  error          text
);

create index if not exists sync_partes_recientes_idx on sync_partes(comenzo_at desc);

-- -----------------------------------------------------------------------------
-- 5 — Permisos
--
-- Todo esto es material de administración: contiene el libro entero aterrizado,
-- incluidas columnas que en la hoja no ve todo el mundo. `import_quarantine` y
-- `import_fixes`, donde caen los choques y las correcciones, ya estaban
-- restringidas a admin desde el esquema de autenticación, y estas van al mismo
-- sitio para que la bandeja de choques sea una sola pantalla con un solo
-- criterio de acceso.
--
-- Sin política de escritura: quien sincroniza es el worker con service-role, que
-- no pasa por RLS. Un cliente autenticado no tiene por qué poder inventarse una
-- instantánea — hacerlo sería poder decidir, a posteriori, quién ganó cada
-- celda de la última pasada.
-- -----------------------------------------------------------------------------

alter table sync_ficheros enable row level security;
alter table sync_filas    enable row level security;
alter table sync_celdas   enable row level security;
alter table sync_partes   enable row level security;

drop policy if exists "admin lee ficheros sincronizados" on sync_ficheros;
create policy "admin lee ficheros sincronizados" on sync_ficheros
  for select to authenticated using (public.is_admin());

drop policy if exists "admin lee filas aterrizadas" on sync_filas;
create policy "admin lee filas aterrizadas" on sync_filas
  for select to authenticated using (public.is_admin());

drop policy if exists "admin lee la instantánea" on sync_celdas;
create policy "admin lee la instantánea" on sync_celdas
  for select to authenticated using (public.is_admin());

-- El parte lo lee el supervisor: «¿cuándo se sincronizó por última vez y cuántos
-- choques dejó?» es una pregunta de quien firma el informe del viernes, no solo
-- de quien administra la base.
drop policy if exists "supervisor lee los partes" on sync_partes;
create policy "supervisor lee los partes" on sync_partes
  for select to authenticated using (public.is_supervisor());

-- -----------------------------------------------------------------------------
-- 6 — La bandeja de choques
--
-- Los conflictos van a `import_quarantine`, que ya existe y ya tiene pantalla de
-- resolución. Esta vista es solo el filtro con el orden que hace falta para
-- mirarla: lo sin resolver primero y lo más reciente arriba.
--
-- `source` empieza por `sharepoint` para distinguir estos de los que dejó la
-- importación inicial, que son de otra época y ya se miraron.
-- -----------------------------------------------------------------------------

create or replace view sync_choques as
select
  iq.id,
  iq.source,
  iq.row_ref,
  iq.raw,
  iq.reason,
  iq.resolved,
  iq.resolved_by,
  iq.resolved_at,
  iq.at
from import_quarantine iq
where iq.source like 'sharepoint%'
order by iq.resolved, iq.at desc;

-- Sin esto la vista consulta con los permisos de quien la creó y **se salta la
-- RLS de `import_quarantine`**: cualquier autenticado vería los choques. Es la
-- misma línea que llevan todas las vistas de este esquema, y por el mismo
-- motivo.
alter view sync_choques set (security_invoker = on);

comment on view sync_choques is
  'Lo que la sincronización no se atrevió a decidir. Hereda las políticas de import_quarantine: solo admin.';
