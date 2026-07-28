# Despliegue con Postgres gestionado

Guía para cuando **la plataforma te da el Postgres** (Railway, Render, Fly,
Neon, RDS…) y tú levantas encima los servicios de Supabase como contenedores.

Es un escenario distinto al del `docker-compose.yml` de la raíz, que levanta
todo —Postgres incluido— en tu propia máquina. Aquí la base de datos es del
proveedor y los servicios son piezas sueltas apuntando a ella.

> **Verificado**: `npm run db:verify -- --gestionado` reproduce este escenario
> sobre un Postgres desnudo, sin la imagen de Supabase, y ejecuta las 11 pruebas
> de RLS. Los pasos de abajo son los que hacen que eso funcione.

---

## Lo que hay que saber antes de empezar

**Un Postgres gestionado no es el Postgres de Supabase.** La imagen
`supabase/postgres` trae roles, esquemas y funciones que el resto de servicios
dan por existentes. Un Postgres normal no los tiene:

| Falta | Quién lo necesita | Síntoma si no está |
|---|---|---|
| `supabase_auth_admin` | El hook que mete el rol en el JWT | **El login devuelve 500** sin más pistas |
| `authenticator`, `anon`, `authenticated`, `service_role` | PostgREST | No hay API en absoluto |
| `supabase_storage_admin` | Storage | Las fotos no suben |
| `auth.uid()`, `auth.jwt()` | Las 16 políticas RLS | Las migraciones ni siquiera compilan |
| `pg_cron`, `pg_net` | Informes automáticos | Se pueden sustituir por cron externo |

Todo eso lo crea `supabase/migrations/00000000000000_bootstrap_roles.sql`.

**Y el orden importa.** `profiles` referencia `auth.users`, que la crea GoTrue
con sus propias migraciones, no nosotros. Lo mismo con `storage.buckets`. Si
aplicas todas las migraciones de golpe contra una base virgen, la tercera falla
con `relation "auth.users" does not exist`, que no dice en ningún momento que el
problema sea de secuencia.

---

## Paso 1 — Postgres

Crea la base de datos en la plataforma y anota la cadena de conexión.

Comprueba qué extensiones permite:

```sql
select name, default_version, installed_version
from pg_available_extensions
where name in ('pgcrypto', 'pg_cron', 'pg_net', 'pgjwt');
```

- `pgcrypto` es **imprescindible** (`gen_random_uuid()`). Si no está, esa
  plataforma no sirve.
- `pg_cron` y `pg_net` son deseables. Sin ellas los informes no se disparan
  solos, pero hay alternativa en el paso 7.

## Paso 2 — Secretos

```bash
npm run gen:keys
```

Genera `JWT_SECRET` y firma con él `ANON_KEY` y `SERVICE_ROLE_KEY`. **No copies
estas claves de ningún tutorial**: son JWT firmados, y usar las de un ejemplo
significa desplegar con un secreto que conoce todo internet.

Añade además contraseñas para los roles que creará el bootstrap:

```bash
openssl rand -base64 24   # una para cada uno
```

## Paso 3 — Bootstrap de roles (solo este fichero)

```bash
psql "$DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -c "select set_config('app.authenticator_password', 'TU_PASS_1', false);
      select set_config('app.auth_admin_password',    'TU_PASS_2', false);
      select set_config('app.storage_admin_password', 'TU_PASS_3', false);" \
  -f supabase/migrations/00000000000000_bootstrap_roles.sql
```

Es idempotente: sobre la imagen oficial de Supabase no hace nada.

Verifica antes de seguir:

```sql
select rolname from pg_roles
where rolname in ('anon','authenticated','service_role','authenticator',
                  'supabase_auth_admin','supabase_storage_admin');
-- deben salir los 6
```

## Paso 4 — Arrancar GoTrue y Storage

Despliega los dos contenedores apuntando a tu Postgres. Variables mínimas:

**GoTrue** (`supabase/gotrue`)

```
GOTRUE_DB_DRIVER=postgres
GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:TU_PASS_2@HOST:5432/DB
GOTRUE_JWT_SECRET=<JWT_SECRET>
GOTRUE_JWT_EXP=3600
GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
GOTRUE_SITE_URL=https://TU-DOMINIO
API_EXTERNAL_URL=https://TU-DOMINIO
GOTRUE_DISABLE_SIGNUP=true
GOTRUE_MAILER_AUTOCONFIRM=true

# ⚠️ El hook del rol. En self-hosted se activa AQUÍ, no desde ningún panel:
#    la documentación oficial está escrita para la nube y no lo menciona.
#    Sin esto, auth_role() devuelve 'none' y RLS no deja hacer nada.
GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true
GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI=pg-functions://postgres/public/custom_access_token_hook
```

**Storage** (`supabase/storage-api`)

```
DATABASE_URL=postgres://supabase_storage_admin:TU_PASS_3@HOST:5432/DB
ANON_KEY=<ANON_KEY>
SERVICE_KEY=<SERVICE_ROLE_KEY>
PGRST_JWT_SECRET=<JWT_SECRET>
POSTGREST_URL=http://<host-de-postgrest>:3000
STORAGE_BACKEND=file
FILE_STORAGE_BACKEND_PATH=/var/lib/storage   # con volumen persistente
```

Espera a que ambos terminen sus migraciones y comprueba:

```sql
select to_regclass('auth.users'), to_regclass('storage.buckets');
-- ninguno debe ser null
```

**No sigas hasta que esto dé resultado.** Es el punto exacto donde falla si te
saltas el orden.

## Paso 5 — El resto de migraciones

```bash
for f in supabase/migrations/2026*.sql; do
  echo "$f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

Y los datos del Excel:

```bash
npm run import:excel -- ruta/al/Material_Aulas.xlsx
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed.sql
```

Comprobación: `select count(*) from rooms;` → **276**.

## Paso 6 — PostgREST y Kong

**PostgREST** (`postgrest/postgrest`)

```
PGRST_DB_URI=postgres://authenticator:TU_PASS_1@HOST:5432/DB
PGRST_DB_SCHEMAS=public,storage
PGRST_DB_ANON_ROLE=anon
PGRST_JWT_SECRET=<JWT_SECRET>
PGRST_DB_USE_LEGACY_GUCS=false
```

**Kong** con `supabase/kong.yml` de este repositorio, sustituyendo
`$SUPABASE_ANON_KEY` y `$SUPABASE_SERVICE_KEY`.

Si la plataforma ya te da un dominio con HTTPS válido apuntando a Kong, **no
necesitas Caddy ni el reto DNS-01**: esa parte del despliegue en servidor propio
sobra aquí, y con ella desaparece el riesgo más grande del proyecto.

## Paso 7 — Informes

Despliega `reports-worker/` con:

```
DATABASE_URL=postgresql://postgres:...@HOST:5432/DB
SUPABASE_URL=https://TU-DOMINIO
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY>
WORKER_TOKEN=<REPORTS_WORKER_TOKEN>
```

Y alinea el token en la base, que si no los informes dan 401 sin explicar nada:

```sql
insert into app_config (key, value) values
  ('reports_worker_token', '<REPORTS_WORKER_TOKEN>'),
  ('reports_worker_url',   'http://<host-del-worker>:8080/generate')
on conflict (key) do update set value = excluded.value;
```

**Si no hay `pg_cron`**, programa desde el cron de la plataforma:

```
0  7 * * *  curl -fsS -X POST https://TU-WORKER/generate \
              -H "Authorization: Bearer $REPORTS_WORKER_TOKEN" \
              -H 'Content-Type: application/json' -d '{"kind":"diario"}'
30 7 * * 1  ...  -d '{"kind":"semanal"}'
```

Es el mismo endpoint que llamaría `pg_net`: no cambia nada de código.

## Paso 8 — La PWA

```bash
VITE_SUPABASE_URL=https://TU-DOMINIO \
VITE_SUPABASE_ANON_KEY=<ANON_KEY> \
npm run build
```

Publica `dist/` como sitio estático. **Ambas variables se compilan dentro del
bundle**, así que cambiar el dominio obliga a reconstruir; no basta con tocar
una variable de entorno del servidor.

Si la PWA queda en un dominio distinto al de la API, habrá peticiones entre
orígenes y hará falta activar CORS en Kong. Servir las dos cosas bajo el mismo
nombre evita ese problema por completo.

## Paso 9 — Primer usuario

```bash
SUPABASE_URL=https://TU-DOMINIO \
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY> \
npm run admin:user -- crear --email tu@correo.es --nombre "Tu nombre" --primer-admin
```

Imprime un código de un solo uso que caduca en 24h.

## Paso 10 — Comprobar que el rol viaja en el token

Entra en la app y descodifica el `access_token` en la consola:

```js
JSON.parse(atob((await supabase.auth.getSession()).data.session.access_token.split('.')[1]))
```

Debe contener **`app_role`**. Si pone `none` o no aparece, el hook no está
activo y nada de lo demás funcionará. Revisa por este orden:

1. Las dos variables `GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_*` en el contenedor.
2. Los permisos a `supabase_auth_admin` (los da la migración 300).
3. Que el perfil exista y esté activo en `profiles`.

---

## Copias de seguridad

Si la plataforma hace copias de Postgres, ya tienes media parte. **La otra
media son las fotos**, que viven en el volumen de Storage y no en la base de
datos: un volcado solo de Postgres deja las incidencias sin sus pruebas.
Asegúrate de que ese volumen entra en la copia, y prueba una restauración:

```bash
npm run backup -- --probar <fichero>
```
