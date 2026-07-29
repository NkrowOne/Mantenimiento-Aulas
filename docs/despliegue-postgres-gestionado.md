# Despliegue con Postgres gestionado

Guía para cuando **la plataforma te da el Postgres** (Railway, Render, Fly,
Neon, RDS…) y tú levantas encima los servicios de Supabase como contenedores.

Es un escenario distinto al del `docker-compose.yml` de la raíz, que levanta
todo —Postgres incluido— en tu propia máquina. Aquí la base de datos es del
proveedor y los servicios son piezas sueltas apuntando a ella.

> **Verificado**: `npm run db:verify -- --gestionado` reproduce este escenario
> sobre un Postgres desnudo, sin la imagen de Supabase, y ejecuta las 13 pruebas
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

**Ojo con el puerto de `DATABASE_URL`.** La cadena que ofrece por defecto el
panel de Supabase es la del *pooler* en modo transacción (puerto 6543), y ese
modo no admite sentencias preparadas, que es lo que usa el cliente `postgres`.
`src/db.ts` detecta el pooler —puerto 6543, host `pooler.…` o `?pgbouncer=true`—
y desactiva las preparadas solo en ese caso. Si tu proveedor lo señala de otra
forma, añade `?pgbouncer=true` a la cadena: sin eso, el worker arranca bien,
supera el healthcheck y solo falla cuando `pg_cron` le pide el primer informe,
de madrugada y sin nadie mirando.

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

---

## Si el servicio queda expuesto a Internet

Es lo habitual con una plataforma gestionada, y trae una ventaja grande: **te
ahorras Caddy, el reto DNS-01 y el DNS split-horizon enteros**, y con ellos el
riesgo más serio que tenía el proyecto. El certificado deja de ser tu problema.

Además el modo offline pasa a ser lo que debería: una red de seguridad para
sótanos y puntos muertos, no el modo de funcionamiento diario. Los técnicos
sincronizan igual desde datos móviles que desde el wifi del campus.

A cambio, **RLS deja de ser una segunda capa y pasa a ser LA capa**. Cualquiera
en Internet puede llamar a PostgREST con la clave anónima, que es pública por
diseño. Dos pruebas del proyecto cubren exactamente eso:

```
=== 12. Un anónimo de Internet no ve NADA ===
 OK: 0 salas, 0 incidencias, 0 perfiles, 0 revisiones
=== 13. Un usuario autenticado SIN rol tampoco ve nada ===
 OK: sin rol no se ve nada
```

Merece la pena ejecutarlas contra la base **real** después de desplegar, no solo
contra la de pruebas.

### Lo que hay que apretar

| Punto | Qué hacer |
|---|---|
| **Límite de intentos en el login** | `GOTRUE_RATE_LIMIT_VERIFY` y `GOTRUE_RATE_LIMIT_TOKEN_REFRESH`. El endpoint de contraseña es por donde se canjean los códigos de alta |
| **Rotación de refresh tokens** | `GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=true` y `..._REUSE_INTERVAL=10`. Si alguien clona la sesión de un iPad, la familia de tokens se revoca sola |
| **Registro cerrado** | `GOTRUE_DISABLE_SIGNUP=true`. Sin esto, cualquiera se crea una cuenta —aunque sin rol no vería nada, ver prueba 13 |
| **Studio** | No lo publiques. Si la plataforma lo expone por defecto, quítalo o ponle autenticación delante |
| **Worker de informes** | Sin puerto público. Solo lo llama `pg_cron` o el cron de la plataforma |
| **`SERVICE_ROLE_KEY`** | Se salta RLS por completo. Solo en variables de entorno del servidor, jamás en el front ni en un commit |
| **Buckets** | Ya son privados y se sirven con URL firmada de 60s. No los pongas públicos "para simplificar" |

### Lo que NO cambia

El diseño del PIN aguanta sin tocar nada: **nunca viaja al servidor**. Deriva
una clave que descifra la sesión guardada en el dispositivo, así que estar en
Internet no le añade superficie de ataque. Un iPad perdido sigue sin dar acceso.
