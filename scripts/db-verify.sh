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

XLSX="${1:-}"
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
psql "$PGURL" -q -c "drop schema if exists public cascade; create schema public; drop schema if exists auth cascade;" >/dev/null
psql "$PGURL" -q -c "
  drop role if exists anon;
  drop role if exists authenticated;
  drop role if exists service_role;
  drop role if exists supabase_auth_admin;" >/dev/null

echo "▸ Emulando el entorno Supabase"
psql "$PGURL" -q -v ON_ERROR_STOP=1 -f supabase/test-harness.sql

echo "▸ Aplicando migraciones"
for f in supabase/migrations/*.sql; do
  printf '   %s\n' "$(basename "$f")"
  psql "$PGURL" -q -v ON_ERROR_STOP=1 -f "$f"
done

if [ -n "$XLSX" ]; then
  echo "▸ Importando el Excel"
  npx tsx scripts/import-excel.ts "$XLSX" | sed 's/^/   /'
fi

if [ -f supabase/seed.sql ]; then
  echo "▸ Cargando el seed"
  psql "$PGURL" -q -v ON_ERROR_STOP=1 -f supabase/seed.sql
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
union all select 'artículos de almacén', count(*) from stock_items
union all select 'correcciones registradas', count(*) from import_fixes
union all select 'en cuarentena', count(*) from import_quarantine;" | sed 's/^/   /'

echo "▸ Alertas"
psql "$PGURL" -t -A -F'  ' -c "
select 'lámparas por debajo del 20%', count(*) from alerts_lamp_low
union all select 'incidencias estancadas', count(*) from alerts_stale_incidents
union all select 'salas sin revisar', count(*) from alerts_overdue_rooms
union all select 'stock bajo mínimo', count(*) from stock_levels where below_threshold;" | sed 's/^/   /'

echo "▸ Pruebas de RLS e inmutabilidad"
psql "$PGURL" -q -v ON_ERROR_STOP=1 -f supabase/rls-test.sql 2>&1 \
  | grep -E "===|OK:|FALLO|ATENCIÓN" | sed 's/^/   /'

echo
echo "✓ Verificación completada"
