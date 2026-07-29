# Mantenimiento de Aulas y Salas

PWA para la gestión de mantenimiento de aulas y salas de reunión. Este documento describe la base técnica del proyecto; el contexto funcional completo está en [`docs/PLAN.md`](../docs/PLAN.md).

> Estado actual: esqueleto de proyecto (Fase 1). No incluye autenticación ni base de datos funcional todavía.

## Requisitos

- Node.js 20 o superior
- npm 10 o superior

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

## Estructura inicial

```
src/
├── app/              # Rutas (App Router de Next.js)
│   ├── api/          # Endpoints de API (pendiente)
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
├── lib/              # Utilidades transversales
├── services/         # Lógica de negocio / casos de uso
├── repositories/      # Acceso a datos
├── hooks/            # Hooks de React reutilizables
├── types/            # Tipos e interfaces compartidos
├── validators/       # Esquemas de validación (Zod, pendiente)
├── offline/          # Autoguardado, outbox y sincronización
├── storage/          # Abstracción de almacenamiento de ficheros/fotos
└── test/             # Configuración y utilidades de test (Vitest)

e2e/                  # Tests end-to-end (Playwright)
```

Las carpetas todavía sin contenido llevan un `.gitkeep` para conservar la estructura en el repositorio.

## Stack técnico de esta base

- **Next.js** (App Router) + **React** + **TypeScript estricto**
- **Tailwind CSS**
- **Vitest** + **Testing Library** para tests unitarios/integración
- **Playwright** para tests end-to-end
- Alias de importación `@/*` → `src/*`

No se ha añadido todavía autenticación, base de datos funcional ni lógica de negocio: esto se abordará en fases posteriores según [`docs/PLAN.md`](../docs/PLAN.md).
