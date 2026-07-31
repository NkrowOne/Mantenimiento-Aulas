#!/usr/bin/env bash
#
# Inicializa la base de datos de un despliegue en plataforma.
#
#   export DATABASE_URL=postgresql://postgres:CLAVE@HOST:5432/postgres
#   export REPORTS_WORKER_TOKEN=...            # el mismo del servicio del worker
#   export REPORTS_WORKER_URL=http://worker.interno:8080/generate
#   ./scripts/init-plataforma.sh --con-seed
#
# Hermano de `deploy.sh`, para cuando los servicios los levanta la plataforma
# (skyway, Railway, Fly…) y aquí solo llega una cadena de conexión. `deploy.sh`
# no sirve en ese escenario: cada paso suyo pasa por `docker compose exec`.
#
# Es idempotente: repetirlo no duplica nada. El seed solo entra si no hay salas.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
avisa(){ printf '  \033[33m!\033[0m %s\n' "$1"; }

CON_SEED=0
[ "${1:-}" = '--con-seed' ] && CON_SEED=1

# ── 1. Configuración ────────────────────────────────────────────────────
say 'Comprobando la configuración'

[ -n "${DATABASE_URL:-}" ] || fail 'Falta DATABASE_URL'
command -v psql >/dev/null || fail 'Falta psql (paquete postgresql-client)'

# Con `-v ON_ERROR_STOP=1` en todas: sin eso psql sigue tras un error y termina
# con código 0, así que un fallo a mitad de una migración pasaría por éxito.
P() { psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 "$@"; }
Q() { psql "$DATABASE_URL" -tAc "$1"; }

Q 'select 1' >/dev/null 2>&1 || fail "No se puede conectar con DATABASE_URL"
ok "conectado a $(Q 'select current_database()') ($(Q "select split_part(version(), ' ', 2)"))"

# ── 2. Que los servicios hayan pasado antes ─────────────────────────────
#
# Este es el orden que más quebraderos da, y el error nativo no lo explica:
# `profiles` referencia `auth.users`, que crea GoTrue con SUS migraciones al
# arrancar, y los buckets viven en `storage.buckets`, que crea Storage con las
# suyas. Si aún no han pasado, la migración 100 muere con
# «relation "auth.users" does not exist», que no menciona el orden por ningún
# lado. Comprobarlo aquí convierte media tarde de depuración en una frase.
say 'Comprobando que GoTrue y Storage ya han arrancado'

[ "$(Q "select to_regclass('auth.users') is not null")" = 't' ] \
  || fail 'No existe auth.users: GoTrue no ha arrancado todavía (o apunta a otra base). Levántalo, espera a que termine sus migraciones y repite.'
ok "auth.users existe ($(Q 'select count(*) from auth.users') usuarios)"

[ "$(Q "select to_regclass('storage.buckets') is not null")" = 't' ] \
  || fail 'No existe storage.buckets: el servicio de Storage no ha arrancado todavía. Levántalo y repite.'
ok 'storage.buckets existe'

# ── 3. Migraciones ──────────────────────────────────────────────────────
#
# En orden alfabético, que es el cronológico: el bootstrap lleva ceros delante
# justamente para ir primero. Sobre la imagen `supabase/postgres` no hace nada
# —todo existe ya y cada bloque se salta solo—, pero cuesta un segundo y cubre
# el caso de que la plataforma haya montado un Postgres a secas.
say 'Aplicando migraciones'

# Registro de lo ya aplicado.
#
# Las migraciones NO son idempotentes por separado: `schema.sql` empieza con un
# `create type app_role`, así que la segunda pasada muere con «type "app_role"
# already exists». Sin llevar la cuenta, este script sería de un solo uso —y va
# a hacer falta repetirlo, aunque solo sea porque la primera vez algo faltaba.
P -c 'create table if not exists public.schema_migrations (
        filename   text primary key,
        applied_at timestamptz not null default now())' >/dev/null

# Las que cambiaron de nombre, reconciliadas antes de comparar.
#
# El registro va por NOMBRE DE FICHERO, así que renumerar una migración la
# convierte en una desconocida y este script la reejecutaría. Y no son
# idempotentes: `retirada_de_equipos` crea políticas, y `create policy` no admite
# `if not exists`, así que la segunda pasada muere con «already exists» sobre una
# base que en realidad estaba perfecta.
#
# Las dos de aquí se renumeraron porque compartían marca de tiempo con otra —dos
# ficheros con el mismo prefijo dejan su orden relativo en manos del alfabeto, y
# el alfabeto puso «etiqueta» antes que «incidencias» cuando se escribieron al
# revés—. Esto solo mueve la anotación: no aplica nada y no toca el esquema.
#
# `where not exists` para que una base que ya tenga anotado el nombre nuevo no
# choque contra la clave primaria.
while IFS='|' read -r viejo nuevo; do
  [ -n "$viejo" ] || continue
  P -c "update public.schema_migrations set filename = '$nuevo'
         where filename = '$viejo'
           and not exists (select 1 from public.schema_migrations m
                            where m.filename = '$nuevo')" >/dev/null
done <<'RENOMBRADAS'
20260730000200_retirada_de_equipos.sql|20260730000400_retirada_de_equipos.sql
20260730000300_etiqueta_sin_choque.sql|20260730000500_etiqueta_sin_choque.sql
RENOMBRADAS

nuevas=0
for f in supabase/migrations/*.sql; do
  b="$(basename "$f")"
  if [ "$(Q "select count(*) from public.schema_migrations where filename = '$b'")" != '0' ]; then
    printf '   %s \033[2m(ya aplicada)\033[0m\n' "$b"
    continue
  fi
  printf '   %s\n' "$b"
  # Solo la salida normal: `inventario.sql` termina llamando a
  # `backfill_room_assets()` y su fila se colaba en medio del listado. Los
  # errores siguen yendo a stderr, y `ON_ERROR_STOP` corta igual.
  if ! P -f "$f" >/dev/null; then
    printf '\n' >&2
    # El aviso sale siempre, no solo con el registro vacío: el bootstrap es
    # idempotente y se anota antes de que reviente la siguiente, así que para
    # cuando falla la de verdad el registro ya tiene una fila.
    cat >&2 <<TXT
  «already exists» aquí casi siempre significa que esa migración ya estaba
  aplicada y el registro no lo sabía. Anótalas sin volver a ejecutarlas:

    psql "\$DATABASE_URL" -c "insert into public.schema_migrations (filename)
      values $(cd supabase/migrations && ls *.sql | sed "s/.*/('&')/" | paste -sd, -)
      on conflict do nothing"

TXT
    fail "Falló $b"
  fi
  P -c "insert into public.schema_migrations (filename) values ('$b')" >/dev/null
  nuevas=$((nuevas + 1))
done
ok "$nuevas migraciones nuevas, $(Q 'select count(*) from public.schema_migrations') en total"

# ── 4. Un solo origen para el token del worker ──────────────────────────
#
# La migración deja 'cambiame-en-produccion' y la URL interna del compose. Si
# no se tocan, los informes programados dan 401 —o llaman a un host que no
# existe— sin decir por qué.
if [ -n "${REPORTS_WORKER_TOKEN:-}" ]; then
  say 'Sincronizando el worker de informes'
  [ ${#REPORTS_WORKER_TOKEN} -ge 16 ] \
    || fail 'REPORTS_WORKER_TOKEN es más corto de 16 caracteres; el worker se niega a arrancar con uno así'
  # En una plataforma la URL interna del compose no existe: escribirla como
  # valor por defecto era dejar los informes llamando a un host imposible, en
  # silencio y para siempre — el mismo síntoma exacto que pg_net sin precargar.
  # Aquí el valor no se adivina: se exige.
  [ -n "${REPORTS_WORKER_URL:-}" ] \
    || fail 'Falta REPORTS_WORKER_URL: en una plataforma el worker no se llama http://reports-worker:8080. Exporta la URL interna real de tu servicio de informes (p. ej. http://<servicio>.railway.internal:8080/generate)'
  URL="${REPORTS_WORKER_URL}"
  P <<SQL
insert into app_config (key, value)
values ('reports_worker_token', '${REPORTS_WORKER_TOKEN}'),
       ('reports_worker_url',   '${URL}')
on conflict (key) do update set value = excluded.value;
SQL
  ok "token alineado y worker en ${URL}"
else
  avisa 'sin REPORTS_WORKER_TOKEN: los informes programados seguirán con el token de ejemplo'
fi

# ── 5. Datos iniciales ──────────────────────────────────────────────────
if [ "$CON_SEED" = 1 ]; then
  say 'Cargando datos iniciales'
  salas=$(Q 'select count(*) from rooms')
  if [ "$salas" -gt 0 ]; then
    ok "ya hay $salas salas; no se recarga el seed"
  else
    [ -f supabase/seed.sql ] || fail 'No existe supabase/seed.sql. Ejecuta antes: npm run import:excel -- <xlsx>'
    P -f supabase/seed.sql
    ok 'seed cargado'
    # Las migraciones corrieron antes que el seed, así que cuando el relleno de
    # inventario se ejecutó no había ni una sala. Se repite ahora que sí las hay.
    P -c 'select public.backfill_room_assets()' >/dev/null
    ok 'inventario de las salas materializado'
  fi
fi

# ── 6. Comprobaciones finales ───────────────────────────────────────────
say 'Comprobando el resultado'

printf '   salas %s · incidencias %s · equipos %s · buckets %s\n' \
  "$(Q 'select count(*) from rooms')" \
  "$(Q 'select count(*) from incidents')" \
  "$(Q 'select count(*) from assets')" \
  "$(Q 'select count(*) from storage.buckets')"

# El hook que mete el rol en el JWT. Sin el GRANT falla EN SILENCIO: el token
# sale sin rol, `auth_role()` devuelve 'none' y RLS no deja hacer nada, sin un
# solo mensaje que apunte aquí.
[ "$(Q "select has_function_privilege('supabase_auth_admin', 'public.custom_access_token_hook(jsonb)', 'execute')")" = 't' ] \
  || fail 'supabase_auth_admin no puede ejecutar custom_access_token_hook: el login funcionará pero RLS bloqueará todo'
ok 'el hook del rol es ejecutable por supabase_auth_admin'

say 'Base de datos lista'
cat <<'TXT'
  Falta comprobar dos cosas que NO se ven desde la base de datos:

  1. En el servicio de GoTrue (auth), estas dos variables:

       GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true
       GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI=pg-functions://postgres/public/custom_access_token_hook

     En self-hosted el hook se activa AHÍ, no desde ningún panel: la
     documentación oficial está escrita para la nube y no lo menciona. Sin
     ellas RLS bloquea todo y el fallo no da ningún mensaje útil.

  2. El primer administrador, que no lo crea ninguna migración:

       npm run admin:user -- crear --email tu@correo.es --nombre "Tu nombre" --primer-admin

     Necesita SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno.
TXT
