#!/usr/bin/env bash
#
# Verificación completa del lado servidor contra un Postgres desechable.
#
#   ./scripts/db-verify.sh [ruta-al-xlsx]
#
# Levanta un clúster limpio, emula lo mínimo de Supabase, aplica las migraciones,
# carga el seed real del Excel y ejecuta las pruebas de RLS. Sirve para no
# descubrir en producción que una política no bloquea lo que dice bloquear.
set -euo pipefail

GESTIONADO=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --gestionado) GESTIONADO=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
export GESTIONADO
XLSX="${ARGS[0]:-}"
PGDATA="${PGDATA:-/var/tmp/pgdata-aulas}"
PGSOCK="${PGSOCK:-/var/tmp}"
PGPORT="${PGPORT:-5433}"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
export PATH="$PGBIN:$PATH"
PGURL="postgresql://postgres@/postgres?host=${PGSOCK}&port=${PGPORT}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

if ! pg_isready -h "$PGSOCK" -p "$PGPORT" >/dev/null 2>&1; then
  echo "▸ Arrancando Postgres en $PGDATA"
  rm -rf "$PGDATA"; mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"; chmod 700 "$PGDATA"
  su postgres -c "PATH=$PGBIN:\$PATH initdb -D $PGDATA -A trust" >/dev/null
  su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $PGDATA -l /var/tmp/pg.log -o '-k $PGSOCK -p $PGPORT' -w start" >/dev/null
fi

echo "▸ Reiniciando el esquema"
# El esquema `storage` también se borra: si queda, sus permisos siguen
# dependiendo de los roles y estos no se pueden recrear.
psql "$PGURL" -q -c "
  drop schema if exists public cascade;
  create schema public;
  drop schema if exists auth cascade;
  drop schema if exists storage cascade;" >/dev/null
# `drop owned by` antes de `drop role`: los ALTER DEFAULT PRIVILEGES dejan
# dependencias que, si no se retiran, impiden borrar el rol con un error que
# no menciona en ningún momento los privilegios por defecto.
psql "$PGURL" -q -c "
  do \$\$
  declare r text;
  begin
    foreach r in array array['anon','authenticated','service_role',
                             'authenticator','supabase_auth_admin',
                             'supabase_storage_admin']
    loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('drop owned by %I cascade', r);
        execute format('drop role %I', r);
      end if;
    end loop;
  end \$\$;" >/dev/null

# Dos escenarios distintos, y conviene probar los dos:
#
#   (por defecto) imagen `supabase/postgres`: los roles y `auth.uid()` ya
#                 existen, así que se emulan con el harness.
#   --gestionado  Postgres a secas (Railway, Neon, RDS): no existe nada de eso
#                 y tiene que crearlo la migración de arranque. Es el escenario
#                 real cuando el Postgres lo da la plataforma.
if [[ "${GESTIONADO:-}" == '1' ]]; then
  echo "▸ Postgres desnudo: sin harness, arranca la migración de bootstrap"
  psql "$PGURL" -q -c "create extension if not exists pgcrypto;" >/dev/null
else
  echo "▸ Emulando el entorno Supabase"
  psql "$PGURL" -q -v ON_ERROR_STOP=1 -f supabase/test-harness.sql
fi

echo "▸ Aplicando migraciones"
for f in supabase/migrations/*.sql; do
  printf '   %s\n' "$(basename "$f")"
  psql "$PGURL" -q -v ON_ERROR_STOP=1 -f "$f"

  # En un Postgres gestionado, `auth.users` la crea GoTrue con sus propias
  # migraciones, no nosotros. El orden real de despliegue es:
  #   1) bootstrap de roles y esquemas   2) arrancar GoTrue   3) el resto
  # Aquí se simula ese paso intermedio para que la prueba refleje la secuencia
  # de verdad en lugar de una que nunca ocurre.
  if [[ "${GESTIONADO:-}" == '1' && "$(basename "$f")" == 00000000000000_* ]]; then
    printf '   (simulando el arranque de GoTrue y Storage)\n'
    psql "$PGURL" -q -v ON_ERROR_STOP=1 -c "
      create table if not exists auth.users (
        id                 uuid primary key default gen_random_uuid(),
        email              text unique,
        raw_user_meta_data jsonb not null default '{}'::jsonb,
        created_at         timestamptz not null default now()
      );
      grant select on auth.users to supabase_auth_admin;

      create table if not exists storage.buckets (
        id                 text primary key,
        name               text not null,
        public             boolean not null default false,
        file_size_limit    bigint,
        allowed_mime_types text[],
        created_at         timestamptz not null default now()
      );
      create table if not exists storage.objects (
        id         uuid primary key default gen_random_uuid(),
        bucket_id  text references storage.buckets(id),
        name       text not null,
        owner      uuid,
        metadata   jsonb,
        created_at timestamptz not null default now()
      );
      alter table storage.objects enable row level security;
      grant all on storage.buckets, storage.objects to authenticated, service_role;"
  fi
done

if [ -n "$XLSX" ]; then
  echo "▸ Importando el Excel"
  npx tsx scripts/import-excel.ts "$XLSX" | sed 's/^/   /'
fi

if [ -f supabase/seed.sql ]; then
  echo "▸ Cargando el seed"
  psql "$PGURL" -q -v ON_ERROR_STOP=1 -f supabase/seed.sql

  # En una instalación limpia las migraciones corren antes que el seed, así que
  # cuando el relleno de inventario se ejecutó no había ni una sala. Ahora sí.
  echo "▸ Materializando el inventario de las salas"
  psql "$PGURL" -t -A -c "select public.backfill_room_assets() || ' elementos creados'" | sed 's/^/   /'
fi

echo "▸ Recuento"
psql "$PGURL" -t -A -F'  ' -c "
select 'edificios', count(*) from buildings
union all select '  sin identificar', count(*) from buildings where needs_review
union all select 'zonas', count(*) from zones
union all select 'salas', count(*) from rooms
union all select 'equipos con S/N', count(*) from assets
union all select 'incidencias', count(*) from incidents
union all select '  sin sala asignada', count(*) from incidents where room_id is null
union all select 'artículos de almacén', count(*) from stock_items where active
union all select '  archivados', count(*) from stock_items where not active
union all select 'correcciones registradas', count(*) from import_fixes
union all select 'en cuarentena', count(*) from import_quarantine;" | sed 's/^/   /'

echo "▸ Alertas"
psql "$PGURL" -t -A -F'  ' -c "
select 'lámparas por debajo del 20%', count(*) from alerts_lamp_low
union all select 'incidencias estancadas', count(*) from alerts_stale_incidents
union all select 'salas sin revisar', count(*) from alerts_overdue_rooms
union all select 'stock bajo mínimo', count(*) from stock_levels where below_threshold
union all select 'artículos en negativo', count(*) from stock_levels where on_hand < 0
union all select 'consumos sin destino', count(*) from stock_movements
  where kind = 'consumo' and incident_id is null and room_id is null;" | sed 's/^/   /'

echo "▸ Pruebas de RLS e inmutabilidad"
psql "$PGURL" -q -v ON_ERROR_STOP=1 -f supabase/rls-test.sql 2>&1 \
  | grep -E "===|OK:|FALLO|ATENCIÓN" | sed 's/^/   /'

echo
echo "✓ Verificación completada"
