# Mantenimiento de Aulas y Salas

PWA para la gestión de mantenimiento de aulas y salas de reunión. Este documento describe la base técnica del proyecto; el contexto funcional completo está en [`docs/PLAN.md`](../docs/PLAN.md).

> Estado actual: base de datos (Drizzle + PostgreSQL), auditoría y autenticación (Auth.js v5) ya implementadas; la lógica de negocio de cada módulo (salas, revisiones, incidencias, almacén) llega en fases posteriores según `docs/PLAN.md`.

## Requisitos

- Node.js 20 o superior
- npm 10 o superior
- Docker y Docker Compose (para la infraestructura local: PostgreSQL, MinIO y la app)

## Instalación

```bash
npm install
```

## Comandos disponibles

| Comando | Descripción |
|---|---|
| `npm run dev` | Arranca el servidor de desarrollo en http://localhost:3000 |
| `npm run build` | Genera la build de producción |
| `npm run start` | Sirve la build de producción |
| `npm run lint` | Ejecuta ESLint |
| `npm run typecheck` | Comprueba los tipos con `tsc --noEmit` |
| `npm run test` | Ejecuta los tests unitarios con Vitest (no requieren Docker) |
| `npm run test:watch` | Ejecuta Vitest en modo observador |
| `npm run test:integration` | Tests de integración contra Postgres real (triggers de auditoría incluidos) |
| `npm run test:e2e` | Ejecuta los tests end-to-end con Playwright |
| `npm run db:generate` | Genera SQL de migración a partir del esquema Drizzle |
| `npm run db:migrate` | Aplica las migraciones pendientes y sincroniza el rol `app_runtime` |
| `npm run db:studio` | Abre Drizzle Studio contra la base configurada |
| `npm run db:seed` | Siembra datos iniciales (idempotente, ver más abajo) |

Antes del primer `npm run test:e2e` es necesario instalar los navegadores de Playwright:

```bash
npx playwright install
```

## Infraestructura local con Docker

`docker-compose.yml` levanta la infraestructura de desarrollo local: **PostgreSQL 16**, **MinIO** (almacenamiento S3 compatible) y la propia aplicación **Next.js**, construida con un `Dockerfile` multi-stage (`deps` → `builder` → `runner`) que usa `output: "standalone"` para que la imagen final no incluya `devDependencies` ni el resto de `node_modules`.

### Configuración

Copia el fichero de variables de entorno de ejemplo y ajusta los valores:

```bash
cp .env.example .env
```

`.env` no se sube al repositorio (está en `.gitignore`) ni se copia dentro de la imagen (está en `.dockerignore`); Docker Compose lo lee automáticamente para sustituir las variables del `docker-compose.yml`.

Todas las variables que lee el proceso de Next.js se validan de forma centralizada con Zod en [`src/lib/env.ts`](./src/lib/env.ts) — ver la sección [Variables de entorno](#variables-de-entorno-srclibenvts) más abajo. `POSTGRES_DB`/`POSTGRES_USER`/`POSTGRES_PASSWORD` y `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` solo los consumen los contenedores de `postgres` y `minio` respectivamente, nunca el proceso de la app.

Variables mínimas (ver `.env.example`):

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Conexión de PostgreSQL con el rol migrador (superusuario): migraciones, `drizzle-kit` |
| `APP_DATABASE_URL` | Conexión con `app_runtime` (mínimo privilegio): la usa la app y el seed, ver `docs/AUDITORIA.md` |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | Credenciales de PostgreSQL (solo para el contenedor `postgres`) |
| `POSTGRES_APP_PASSWORD` | Contraseña del rol `app_runtime`; se sincroniza en cada `db:migrate` |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | Credenciales del usuario root de MinIO (solo para el contenedor `minio`) |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Configuración del cliente S3 contra MinIO |
| `STORAGE_DRIVER` | Driver de almacenamiento de fotos/ficheros (`s3` para MinIO) |
| `AUTH_SECRET` | Firma/cifra las sesiones de Auth.js (mínimo 32 caracteres) |
| `NEXT_PUBLIC_APP_URL` | URL pública de la aplicación (no es secreta, visible en el navegador) |
| `GEMINI_API_KEY` | Clave de Gemini, **opcional** — sin ella las funciones de IA se ocultan |

### Levantar los servicios

```bash
docker compose config       # valida la configuración resuelta
docker compose up --build   # construye la imagen y arranca app + postgres + minio
docker compose ps           # comprueba que los tres servicios están "healthy"
```

- **app** → http://localhost:3000 (healthcheck sobre `GET /api/health`)
- **postgres** → puerto `5432`, healthcheck con `pg_isready`
- **minio** → API en `9000`, consola web en http://localhost:9001, healthcheck sobre `/minio/health/live`

`app` no arranca hasta que `postgres` y `minio` estén en estado `healthy` (`depends_on` con `condition: service_healthy`). Los datos de PostgreSQL y MinIO se conservan en los volúmenes con nombre `postgres_data` y `minio_data` aunque se pare o recree el stack (`docker compose down`, sin `-v`).

Para parar y limpiar contenedores conservando los volúmenes:

```bash
docker compose down
```

## Base de datos (Drizzle ORM)

El esquema vive en `src/db/schema/` (16 tablas + la vista `stock_levels`) y se gestiona con **Drizzle ORM** + **drizzle-kit**, usando el driver `postgres` (postgres.js). El modelo completo, con diagrama de relaciones, está documentado en [`docs/MODELO-DATOS.md`](../docs/MODELO-DATOS.md).

Con `postgres` levantado (`docker compose up -d postgres`), desde el host:

```bash
npm run db:generate   # genera SQL de migración a partir del esquema
npm run db:migrate    # la aplica contra DATABASE_URL
npm run db:seed       # siembra datos iniciales (idempotente)
npm run db:studio     # explorador visual de la base
```

`db:generate`/`db:migrate` usan el `DATABASE_URL` de `.env` (rol migrador, superusuario), que apunta a `localhost:5432` (el puerto que Docker Compose publica en el host). `db:seed` y la propia app usan `APP_DATABASE_URL`: un segundo rol de PostgreSQL, `app_runtime`, sin privilegios de superusuario y sin permiso de escritura sobre `audit_log` — ver [`docs/AUDITORIA.md`](../docs/AUDITORIA.md). **Dentro** del contenedor `app`, `docker-compose.yml` compone sus propias `DATABASE_URL`/`APP_DATABASE_URL` con el host de red interno `postgres` a partir de `POSTGRES_DB`/`USER`/`PASSWORD` y `POSTGRES_APP_PASSWORD` — son valores distintos a propósito, ver el comentario en `.env.example`.

Las migraciones **se aplican solas** al arrancar el contenedor: `src/instrumentation.ts` las ejecuta con el runtime de Drizzle (no el CLI de `drizzle-kit`, que es una herramienta de desarrollo) y sincroniza la contraseña de `app_runtime`, antes de servir peticiones. Es idempotente, así que `docker compose down -v && docker compose up` deja el sistema operativo sin pasos manuales. El seed sigue siendo manual (`npm run db:seed`) porque crea un usuario administrador con una contraseña conocida — no algo que quieras repetir sin querer en cada reinicio.

Toda escritura sobre las tablas de negocio queda auditada automáticamente por un trigger de PostgreSQL — API, sincronización o SQL directo por igual — y `audit_log` no puede alterarse desde el rol con el que se conecta la aplicación. Detalle completo, con los tests que lo verifican, en [`docs/AUDITORIA.md`](../docs/AUDITORIA.md) (`npm run test:integration`).

## Autenticación (Auth.js v5)

Login por email/contraseña (Argon2id) y PIN de 4 dígitos, roles `operador` (lectura y escritura) / `lector` (solo lectura), y bloqueo de usuarios inactivos. El mecanismo completo — hashing, *rate limiting*, protección contra enumeración de usuarios, el reparto de la configuración entre Edge Runtime y Node.js, y por qué el cambio de contraseña forzado del alta inicial necesita su propia excepción en el middleware — está documentado en [`docs/AUTENTICACION.md`](../docs/AUTENTICACION.md).

- `/login` — email + contraseña, o pestaña de reapertura por PIN
- `/account/change-password` — cambio de contraseña (obligatorio en el primer login del admin sembrado)
- `/account/pin` — configurar el PIN de reapertura
- `npm run test:integration` incluye `src/lib/auth/credentials.integration.test.ts` (lógica de autorización contra Postgres real) y `src/test/auth-http.integration.test.ts` (flujo completo por HTTP: login, roles, sesión persistente, cierre de sesión, cambio forzado — este último requiere `npm run build` antes, porque arranca el servidor standalone real)

## Variables de entorno (src/lib/env.ts)

Todas las variables de entorno que usa la aplicación se validan con **Zod** en un único módulo central: [`src/lib/env.ts`](./src/lib/env.ts). Ningún otro fichero debe leer `process.env` directamente (una regla de ESLint lo impide fuera de ese módulo).

- **`serverEnv`** — configuración de servidor: `DATABASE_URL`, `STORAGE_DRIVER`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `AUTH_SECRET` y `GEMINI_API_KEY` (opcional). No debe importarse nunca desde un componente de cliente.
- **`clientEnv`** — configuración pública, con prefijo `NEXT_PUBLIC_*`: por ahora solo `NEXT_PUBLIC_APP_URL`. Ninguna variable secreta lleva ese prefijo.

```ts
import { serverEnv } from "@/lib/env";

const bucket = serverEnv.S3_BUCKET; // tipado y validado, sin tocar process.env
```

Si falta una variable obligatoria, **la aplicación falla al arrancar** con un mensaje explicando cuál: `src/instrumentation.ts` llama a `assertEnv()` en cuanto arranca el servidor (`next dev` / `next start`), antes de atender ninguna petición. `GEMINI_API_KEY` es deliberadamente la única opcional — sin ella, el resto de la aplicación funciona con normalidad y las funciones de IA simplemente se ocultan.

`src/lib/env.test.ts` cubre configuraciones válidas e inválidas (variables ausentes, URLs mal formadas, `GEMINI_API_KEY` ausente, etc.).

## Estructura inicial

```
Dockerfile              # Build multi-stage (deps/builder/runner), output standalone
docker-compose.yml      # app + postgres + minio, volúmenes y healthchecks
drizzle.config.ts       # Configuración de drizzle-kit (generate/migrate/studio)
vitest.integration.config.ts # Tests contra Postgres real (npm run test:integration)
.dockerignore
.env.example            # Plantilla de variables de entorno

src/
├── app/              # Rutas (App Router de Next.js)
│   ├── api/
│   │   ├── health/           # Endpoint usado por el healthcheck de Docker
│   │   ├── auth/[...nextauth]/ # Route handler de Auth.js
│   │   ├── account/          # change-password, set-pin
│   │   └── buildings/        # Recurso de ejemplo: GET (todos) / POST (operador)
│   ├── login/        # Email+contraseña y reapertura por PIN
│   ├── account/      # change-password/, pin/
│   ├── dashboard/
│   ├── rooms/
│   ├── revisions/
│   ├── incidents/
│   ├── stock/
│   ├── reports/
│   ├── layout.tsx    # Layout general
│   └── page.tsx      # Página de inicio
├── components/
│   ├── ui/           # Componentes de interfaz genéricos
│   ├── layout/       # SignOutButton y estructura (cabecera, navegación...)
│   ├── forms/        # LoginForm, ChangePasswordForm, SetPinForm
│   └── feedback/     # Estados de carga, error, vacío...
├── db/
│   ├── schema/       # 16 tablas + vista stock_levels (Drizzle)
│   ├── migrations/   # SQL generado por drizzle-kit + trigger de auditoría
│   ├── index.ts      # Cliente Drizzle, rol app_runtime (drizzle-orm/postgres-js)
│   ├── migrate.ts    # Migrador en runtime + sincroniza el rol app_runtime
│   ├── migrate-cli.ts # Entrada de `npm run db:migrate`
│   ├── audit-context.ts # withAuditContext(): usuario/origen para el trigger
│   ├── audit.integration.test.ts # Tests del trigger (npm run test:integration)
│   └── seed.ts        # Semilla idempotente (npm run db:seed)
├── lib/
│   ├── env.ts        # Validación centralizada de variables de entorno (Zod)
│   ├── env.test.ts
│   └── auth/
│       ├── password.ts        # Hash/verify Argon2id (contraseña y PIN, independientes)
│       ├── rate-limit.ts      # Rate limiting básico en memoria
│       ├── credentials.ts     # authorizeWithPassword/Pin (enumeration-safe)
│       ├── authorize.ts       # requireUser/requireOperador para Route Handlers
│       └── *.test.ts / *.integration.test.ts
├── services/         # Lógica de negocio / casos de uso
├── repositories/      # Acceso a datos
├── hooks/            # Hooks de React reutilizables
├── types/            # Tipos e interfaces compartidos (incluye next-auth.d.ts)
├── validators/       # Esquemas de validación (Zod, pendiente)
├── offline/          # Autoguardado, outbox y sincronización
├── storage/          # Abstracción de almacenamiento de ficheros/fotos
├── test/             # Configuración de test (Vitest) + auth-http.integration.test.ts
├── middleware.ts     # Protege páginas: sesión y cambio de contraseña forzado
├── auth.config.ts    # Config "edge-safe" de Auth.js (la usa el middleware)
├── auth.ts           # Config completa (proveedores Credentials, Node.js)
└── instrumentation.ts # Falla el arranque si faltan variables obligatorias

e2e/                  # Tests end-to-end (Playwright)
```

Las carpetas todavía sin contenido llevan un `.gitkeep` para conservar la estructura en el repositorio.

## Stack técnico de esta base

- **Next.js** (App Router) + **React** + **TypeScript estricto**
- **Tailwind CSS**
- **Vitest** + **Testing Library** para tests unitarios/integración
- **Playwright** para tests end-to-end
- Alias de importación `@/*` → `src/*`
- **Docker / Docker Compose**: PostgreSQL 16 y MinIO como infraestructura local
- **Drizzle ORM** + **drizzle-kit** (driver `postgres`) para el esquema y las migraciones
- **Auth.js v5** + **Argon2id** (`@node-rs/argon2`) para login por contraseña y PIN

No se ha añadido todavía la lógica de negocio de cada módulo (salas, revisiones, incidencias, almacén): esto se abordará en fases posteriores según [`docs/PLAN.md`](../docs/PLAN.md).
