# Mantenimiento de Aulas y Salas

PWA para la gestión de mantenimiento de aulas y salas de reunión. Este documento describe la base técnica del proyecto; el contexto funcional completo está en [`docs/PLAN.md`](../docs/PLAN.md).

> Estado actual: esqueleto de proyecto (Fase 1). No incluye autenticación ni base de datos funcional todavía.

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
| `npm run test` | Ejecuta los tests unitarios/integración con Vitest |
| `npm run test:watch` | Ejecuta Vitest en modo observador |
| `npm run test:e2e` | Ejecuta los tests end-to-end con Playwright |

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
| `DATABASE_URL` | Cadena de conexión a PostgreSQL usada por la app |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | Credenciales de PostgreSQL (solo para el contenedor `postgres`) |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | Credenciales del usuario root de MinIO (solo para el contenedor `minio`) |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Configuración del cliente S3 contra MinIO |
| `STORAGE_DRIVER` | Driver de almacenamiento de fotos/ficheros (`s3` para MinIO) |
| `AUTH_SECRET` | Secreto para la futura capa de autenticación |
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

Esta infraestructura todavía no incluye Drizzle ni migraciones: PostgreSQL arranca vacío, a la espera de las fases del `docs/PLAN.md` donde se introduce el ORM.

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
.dockerignore
.env.example            # Plantilla de variables de entorno

src/
├── app/              # Rutas (App Router de Next.js)
│   ├── api/
│   │   └── health/   # Endpoint usado por el healthcheck de Docker
│   ├── login/
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
│   ├── layout/       # Componentes de estructura (cabecera, navegación...)
│   ├── forms/        # Componentes de formularios
│   └── feedback/     # Estados de carga, error, vacío...
├── db/
│   ├── schema/       # Esquema de base de datos (Drizzle, pendiente)
│   ├── migrations/   # Migraciones (pendiente)
│   └── index.ts      # Punto de entrada de la capa de datos
├── lib/
│   ├── env.ts        # Validación centralizada de variables de entorno (Zod)
│   └── env.test.ts
├── services/         # Lógica de negocio / casos de uso
├── repositories/      # Acceso a datos
├── hooks/            # Hooks de React reutilizables
├── types/            # Tipos e interfaces compartidos
├── validators/       # Esquemas de validación (Zod, pendiente)
├── offline/          # Autoguardado, outbox y sincronización
├── storage/          # Abstracción de almacenamiento de ficheros/fotos
├── test/             # Configuración y utilidades de test (Vitest)
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

No se ha añadido todavía autenticación, ORM (Drizzle) ni lógica de negocio: esto se abordará en fases posteriores según [`docs/PLAN.md`](../docs/PLAN.md).
