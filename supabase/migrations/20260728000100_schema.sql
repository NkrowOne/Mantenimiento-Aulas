-- =============================================================================
-- Esquema base — modelo append-only
--
-- Lo que se escribe desde el móvil son eventos inmutables, no ediciones.
-- Consecuencia: la sincronización offline no tiene conflictos que resolver, y
-- el historial de "quién hizo qué" es la propia tabla, no una copia aparte.
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- Perfiles y roles
-- -----------------------------------------------------------------------------
create type app_role as enum ('tecnico', 'supervisor', 'admin');

create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  email       text not null,
  role        app_role not null default 'tecnico',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Maestros: edificios, zonas, salas
-- -----------------------------------------------------------------------------
create table buildings (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  name         text not null,
  sort_order   int  not null default 0,
  -- `BC` aparece en 38 incidencias del histórico pero no en la hoja de estado.
  -- Entra marcado para que un humano decida si es el CRAI o un edificio propio.
  needs_review boolean not null default false,
  review_note  text,
  created_at   timestamptz not null default now()
);

create table zones (
  id          uuid primary key default gen_random_uuid(),
  building_id uuid not null references buildings(id) on delete cascade,
  name        text not null,
  sort_order  int  not null default 0,
  unique (building_id, name)
);

create type room_kind as enum ('aula', 'sala_reunion', 'laboratorio', 'otro');

create table rooms (
  id              uuid primary key default gen_random_uuid(),
  zone_id         uuid not null references zones(id) on delete cascade,
  code            text not null,
  name            text not null,
  kind            room_kind not null default 'aula',
  -- Lo que la sala tiene instalado. Alimenta el autocompletado del formulario:
  -- si no hay micrófono, ese check nace en "No aplica" y plegado.
  capabilities    jsonb not null default
    '{"proyector":false,"altavoces":false,"camara":false,"microfono":false,"botonera":false,"tv":false}'::jsonb,
  projector_hours int,
  lamp_pct        numeric(4,3),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (zone_id, code)
);

create index rooms_zone_idx on rooms(zone_id);

-- Alias de sala: el histórico usa `1.7 H` y `Sotano -1.5 BC`, la hoja de estado
-- usa `EDIFICIO H / 1ª PLANTA / 1.7`. Sin esta tabla no se pueden cruzar.
create table room_aliases (
  id      uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  alias   text not null,
  -- Normalizado: mayúsculas, sin tildes, comas a puntos, espacios colapsados.
  alias_norm text not null unique
);

create index room_aliases_room_idx on room_aliases(room_id);

-- -----------------------------------------------------------------------------
-- Inventario instalado
-- -----------------------------------------------------------------------------
create table asset_types (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique,
  category          text not null default 'av',
  tracks_serial     boolean not null default true,
  tracks_lamp_hours boolean not null default false
);

create type asset_status as enum ('instalado', 'retirado', 'averiado');

create table assets (
  id            uuid primary key default gen_random_uuid(),
  asset_type_id uuid not null references asset_types(id),
  room_id       uuid references rooms(id) on delete set null,
  serial        text,
  model         text,
  status        asset_status not null default 'instalado',
  created_at    timestamptz not null default now()
);

create index assets_room_idx on assets(room_id);
-- `merge_asset_type` recorre todos los equipos de un tipo, y la bandeja del
-- coordinador cuenta cuántos hay de cada uno: sin índice son barridos completos
-- de las 1.094 filas.
create index assets_type_idx on assets(asset_type_id);
create unique index assets_serial_idx on assets(serial) where serial is not null;

create type asset_event_kind as enum ('alta', 'baja', 'sustitucion', 'traslado', 'averia');

create table asset_events (
  id         uuid primary key,
  asset_id   uuid not null references assets(id) on delete cascade,
  room_id    uuid references rooms(id) on delete set null,
  kind       asset_event_kind not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  by_user    uuid references profiles(id),
  meta       jsonb not null default '{}'::jsonb
);

create index asset_events_asset_idx on asset_events(asset_id);

-- -----------------------------------------------------------------------------
-- Stock de almacén — la cantidad actual es una suma, nunca un campo editable.
-- Así es imposible el descuadre que hoy produce stock negativo en la Bolsa.
-- -----------------------------------------------------------------------------
create table stock_items (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  unit          text not null default 'ud',
  min_threshold int  not null default 0,
  asset_type_id uuid references asset_types(id),
  active        boolean not null default true
);

create index stock_items_type_idx on stock_items(asset_type_id)
  where asset_type_id is not null;

create type stock_movement_kind as enum ('compra', 'consumo', 'ajuste', 'devolucion');

create table stock_movements (
  id            uuid primary key,
  stock_item_id uuid not null references stock_items(id) on delete restrict,
  qty           int not null check (qty <> 0),
  kind          stock_movement_kind not null,
  incident_id   uuid,
  inspection_id uuid,
  occurred_at   timestamptz not null,
  recorded_at   timestamptz not null default now(),
  by_user       uuid references profiles(id),
  source        text not null default 'app',
  note          text
);

-- El signo tiene que corresponderse con el tipo: `material_consumption_ranking`
-- calcula `sum(-qty) where kind = 'consumo'`, así que un consumo positivo habría
-- producido consumos negativos en el informe sin que nadie entendiera por qué.
alter table stock_movements
  add constraint stock_movements_signo_check check (
    (kind = 'consumo' and qty < 0) or
    (kind = 'compra'  and qty > 0) or
    (kind in ('ajuste', 'devolucion'))
  );

create index stock_movements_item_idx on stock_movements(stock_item_id);
create index stock_movements_incidencia_idx on stock_movements(incident_id)
  where incident_id is not null;
create index stock_movements_occurred_idx on stock_movements(occurred_at desc);

-- -----------------------------------------------------------------------------
-- Revisiones — el corazón de la app
-- -----------------------------------------------------------------------------
create type inspection_status as enum ('borrador', 'completa');
create type inspection_overall as enum ('ok', 'con_incidencias');

create table inspections (
  -- uuid v7 generado en el cliente. Es también la clave de idempotencia:
  -- reenviar la misma revisión dos veces no crea dos filas.
  id          uuid primary key,
  room_id     uuid not null references rooms(id) on delete restrict,
  by_user     uuid references profiles(id),
  -- Reloj del dispositivo: cuándo se revisó el aula de verdad.
  occurred_at timestamptz not null,
  -- Reloj del servidor: cuándo llegó. Con un solo campo, o mientes en el
  -- informe o mientes en la auditoría.
  recorded_at timestamptz not null default now(),
  status      inspection_status not null default 'borrador',
  overall     inspection_overall,
  notes       text,
  source      text not null default 'app'
);

create index inspections_room_idx on inspections(room_id, occurred_at desc);
create index inspections_user_idx on inspections(by_user, occurred_at desc);
-- Los borradores se consultan constantemente al abrir la app: "¿qué dejé a medias?"
create index inspections_draft_idx on inspections(by_user) where status = 'borrador';

create type check_result as enum ('ok', 'incidencia', 'na');
create type severity as enum ('baja', 'media', 'alta');

create table inspection_checks (
  id            uuid primary key,
  inspection_id uuid not null references inspections(id) on delete cascade,
  check_key     text not null,
  result        check_result not null,
  severity      severity,
  measure       numeric,
  measure_unit  text,
  note          text,
  unique (inspection_id, check_key)
);

-- -----------------------------------------------------------------------------
-- Incidencias
-- -----------------------------------------------------------------------------
create type incident_state as enum ('abierta', 'en_curso', 'resuelta');

create table incidents (
  id                       uuid primary key,
  room_id                  uuid references rooms(id) on delete set null,
  asset_id                 uuid references assets(id) on delete set null,
  opened_from_inspection_id uuid references inspections(id) on delete set null,
  -- El `I260203_0051` de vuestro Excel. También es el puente futuro a ServiceNow.
  external_ref             text,
  title                    text not null,
  description              text,
  severity                 severity not null default 'media',
  state                    incident_state not null default 'abierta',
  opened_at                timestamptz not null,
  opened_by                uuid references profiles(id),
  resolved_at              timestamptz,
  resolved_by              uuid references profiles(id),
  resolution               text,
  source                   text not null default 'app',
  recorded_at              timestamptz not null default now()
);

create index incidents_room_idx on incidents(room_id);
create index incidents_open_idx on incidents(opened_at desc) where state <> 'resuelta';
create index incidents_external_idx on incidents(external_ref) where external_ref is not null;

create table incident_materials (
  id            uuid primary key,
  incident_id   uuid not null references incidents(id) on delete cascade,
  stock_item_id uuid references stock_items(id),
  qty           int not null default 1,
  serial        text,
  -- Texto original del Excel cuando no se pudo parsear con confianza.
  raw_text      text
);

-- -----------------------------------------------------------------------------
-- Adjuntos
-- -----------------------------------------------------------------------------
create table attachments (
  id           uuid primary key,
  entity_type  text not null check (entity_type in ('inspection', 'incident', 'asset')),
  entity_id    uuid not null,
  storage_path text not null,
  taken_at     timestamptz not null,
  recorded_at  timestamptz not null default now(),
  by_user      uuid references profiles(id),
  meta         jsonb not null default '{}'::jsonb
);

create index attachments_entity_idx on attachments(entity_type, entity_id);

-- -----------------------------------------------------------------------------
-- Informes archivados — un informe emitido no se regenera, se versiona.
-- -----------------------------------------------------------------------------
create table reports (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('diario', 'semanal', 'personalizado')),
  period_start date not null,
  period_end   date not null,
  storage_path text not null,
  content_hash text not null,
  params       jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now(),
  generated_by uuid references profiles(id)
);

create index reports_period_idx on reports(kind, period_start desc);

-- El worker inserta con `on conflict do nothing` porque un informe ya emitido no
-- se regenera. Sin esta restricción no habría con qué chocar —la clave primaria
-- es un uuid nuevo cada vez— y cada ejecución añadiría una fila más apuntando al
-- mismo PDF. El hash del contenido es la identidad real del documento.
create unique index reports_unico_idx
  on reports (kind, period_start, period_end, content_hash);

-- -----------------------------------------------------------------------------
-- Auditoría — solo para lo mutable. Las tablas append-only ya son su historial.
-- -----------------------------------------------------------------------------
create table audit_log (
  id         bigserial primary key,
  table_name text not null,
  row_id     text not null,
  op         text not null,
  old_data   jsonb,
  new_data   jsonb,
  by_user    uuid,
  at         timestamptz not null default now()
);

create index audit_log_row_idx on audit_log(table_name, row_id, at desc);

-- -----------------------------------------------------------------------------
-- Trazas de la importación — nada se corrige en silencio.
-- -----------------------------------------------------------------------------
create table import_fixes (
  id          bigserial primary key,
  source      text not null,
  row_ref     text,
  field       text not null,
  original    text,
  corrected   text,
  reason      text not null,
  at          timestamptz not null default now()
);

-- Lo que no se pudo parsear con confianza no se inventa: queda aquí para que
-- una persona lo resuelva desde la pantalla de depuración.
create table import_quarantine (
  id         bigserial primary key,
  source     text not null,
  row_ref    text,
  raw        jsonb not null,
  reason     text not null,
  resolved   boolean not null default false,
  resolved_by uuid references profiles(id),
  resolved_at timestamptz,
  at         timestamptz not null default now()
);
