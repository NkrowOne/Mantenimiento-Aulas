#!/usr/bin/env bash
#
# Despliegue completo.
#
#   ./scripts/deploy.sh              # despliegue normal
#   ./scripts/deploy.sh --con-seed   # además carga el Excel importado
#
# Valida la configuración ANTES de levantar nada. Un despliegue que arranca a
# medias y falla en el tercer servicio es mucho más difícil de diagnosticar que
# uno que se niega a empezar diciendo qué falta.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }

# ── 1. Configuración ────────────────────────────────────────────────────
say 'Comprobando la configuración'

[ -f .env ] || fail 'No existe .env. Copia .env.example y ejecuta: npx tsx scripts/gen-keys.ts'
set -a; . ./.env; set +a

faltan=()
for v in DOMAIN ACME_EMAIL CLOUDFLARE_API_TOKEN POSTGRES_PASSWORD JWT_SECRET \
         ANON_KEY SERVICE_ROLE_KEY REPORTS_WORKER_TOKEN VITE_SUPABASE_URL \
         VITE_SUPABASE_ANON_KEY; do
  [ -n "${!v:-}" ] || faltan+=("$v")
done
[ ${#faltan[@]} -eq 0 ] || fail "Faltan variables en .env: ${faltan[*]}"
ok 'todas las variables presentes'

# Un error clásico: cambiar DOMAIN y olvidar VITE_SUPABASE_URL, que se compila
# dentro del bundle. La app quedaría hablando con el host anterior.
[ "$VITE_SUPABASE_URL" = "https://$DOMAIN" ] \
  || fail "VITE_SUPABASE_URL ($VITE_SUPABASE_URL) no coincide con DOMAIN (https://$DOMAIN)"
ok 'el front apunta al dominio correcto'

[ "$VITE_SUPABASE_ANON_KEY" = "$ANON_KEY" ] \
  || fail 'VITE_SUPABASE_ANON_KEY y ANON_KEY no coinciden'
ok 'las claves anónimas coinciden'

# ── 2. Construir la PWA ─────────────────────────────────────────────────
say 'Construyendo la aplicación'
npm ci --silent
npm run build
ok "dist/ listo ($(du -sh dist | cut -f1))"

# ── 3. Levantar la infraestructura ──────────────────────────────────────
say 'Levantando servicios'
docker compose up -d --build db
docker compose exec -T db bash -c 'until pg_isready -U postgres; do sleep 1; done' >/dev/null
ok 'base de datos lista'

# ── 4. Migraciones ──────────────────────────────────────────────────────
say 'Aplicando migraciones'
for f in supabase/migrations/*.sql; do
  printf '   %s\n' "$(basename "$f")"
  docker compose exec -T db psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 < "$f"
done
ok "$(ls supabase/migrations/*.sql | wc -l) migraciones aplicadas"

# ── 5. Un solo origen para el token del worker ──────────────────────────
#
# Antes había que mantenerlo a mano en dos sitios: la tabla app_config y la
# variable del contenedor. Cuando se desincronizaban, los informes programados
# devolvían 401 sin decir por qué.
say 'Sincronizando el token del worker'
docker compose exec -T db psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 <<SQL
insert into app_config (key, value)
values ('reports_worker_token', '${REPORTS_WORKER_TOKEN}'),
       ('reports_worker_url',   'http://reports-worker:8080/generate')
on conflict (key) do update set value = excluded.value;
SQL
ok 'token y URL alineados con el .env'

# ── 6. Datos iniciales ──────────────────────────────────────────────────
if [[ "${1:-}" == '--con-seed' ]]; then
  say 'Cargando datos iniciales'
  salas=$(docker compose exec -T db psql -U postgres -d postgres -tAc \
          'select count(*) from rooms' 2>/dev/null || echo 0)
  if [ "$salas" -gt 0 ]; then
    ok "ya hay $salas salas; no se recarga el seed"
  else
    [ -f supabase/seed.sql ] || fail 'No existe supabase/seed.sql. Ejecuta antes: npm run import:excel -- <xlsx>'
    docker compose exec -T db psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 < supabase/seed.sql
    ok 'seed cargado'
    # Las migraciones corrieron antes que el seed, así que cuando el relleno de
    # inventario se ejecutó no había ni una sala. Se repite ahora que sí las hay.
    docker compose exec -T db psql -U postgres -d postgres -q -c 'select public.backfill_room_assets()' >/dev/null
    docker compose exec -T db psql -U postgres -d postgres -q -c 'select public.backfill_asset_models()' >/dev/null
    ok 'inventario de las salas materializado'
  fi
fi

# ── 7. El resto de servicios ────────────────────────────────────────────
say 'Levantando el resto'
docker compose up -d --build
ok 'todos los servicios arriba'

# ── 8. Comprobaciones ───────────────────────────────────────────────────
say 'Comprobando el resultado'

printf '   esperando al certificado'
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://${DOMAIN}/" >/dev/null 2>&1; then break; fi
  printf '.'; sleep 5
done
printf '\n'

if curl -fsS --max-time 10 "https://${DOMAIN}/" >/dev/null 2>&1; then
  ok "https://${DOMAIN} responde con certificado válido"
else
  printf '\033[33m  ! El dominio aún no responde por HTTPS.\033[0m\n'
  printf '    Revisa el certificado:  docker compose logs caddy | tail -40\n'
  printf '    Y la resolución:        dig +short %s\n' "$DOMAIN"
  printf '    Recuerda: el registro A debe existir en el DNS interno, no en el público.\n'
fi

usuarios=$(docker compose exec -T db psql -U postgres -d postgres -tAc \
           'select count(*) from profiles' 2>/dev/null || echo 0)
if [ "$usuarios" -eq 0 ]; then
  printf '\n\033[33m  Todavía no hay ningún usuario. Crea el primer administrador:\033[0m\n'
  printf '    npm run admin:user -- crear --email tu@correo.es --nombre "Tu nombre" --primer-admin\n'
else
  ok "$usuarios usuarios dados de alta"
fi

printf '\n\033[32m✓ Despliegue completado\033[0m\n\n'
