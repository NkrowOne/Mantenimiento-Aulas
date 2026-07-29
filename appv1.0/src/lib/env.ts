import { z } from "zod";

/**
 * Único punto de acceso a las variables de entorno de la aplicación.
 * Ningún otro módulo debe leer `process.env` directamente: importa
 * `serverEnv` o `clientEnv` desde aquí.
 *
 * - `serverEnv` — secretos y configuración de servidor (BD, S3, auth, IA).
 *   Nunca debe importarse desde un componente de cliente ("use client").
 * - `clientEnv` — variables `NEXT_PUBLIC_*`, seguras para el navegador.
 */

function requiredString(message: string) {
  return z.string({ error: message }).min(1, message);
}

function requiredUrl(requiredMessage: string, urlMessage: string) {
  return requiredString(requiredMessage).url(urlMessage);
}

export const serverEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  // PostgreSQL. Dos roles, dos cadenas de conexión distintas a propósito
  // (ver docs/AUDITORIA.md): DATABASE_URL es el rol migrador/superusuario
  // (drizzle-kit, migraciones); APP_DATABASE_URL es "app_runtime", sin
  // privilegios de superusuario y sin permiso de escritura sobre
  // audit_log, que es la conexión que usa la app en tiempo de ejecución.
  // Las credenciales sueltas (POSTGRES_USER/PASSWORD/DB) las consume
  // únicamente el contenedor de postgres, nunca el proceso de Next.js.
  DATABASE_URL: requiredUrl(
    "DATABASE_URL es obligatoria",
    "DATABASE_URL debe ser una cadena de conexión válida",
  ),
  APP_DATABASE_URL: requiredUrl(
    "APP_DATABASE_URL es obligatoria",
    "APP_DATABASE_URL debe ser una cadena de conexión válida",
  ),

  // Almacenamiento S3 compatible (MinIO). MINIO_ROOT_USER/PASSWORD
  // configuran el propio servidor MinIO y tampoco llegan a la app.
  STORAGE_DRIVER: z
    .enum(["s3", "fs"], { error: 'STORAGE_DRIVER debe ser "s3" o "fs"' })
    .default("s3"),
  S3_ENDPOINT: requiredUrl(
    "S3_ENDPOINT es obligatoria",
    "S3_ENDPOINT debe ser una URL válida",
  ),
  S3_REGION: requiredString("S3_REGION es obligatoria"),
  S3_BUCKET: requiredString("S3_BUCKET es obligatoria"),
  S3_ACCESS_KEY: requiredString("S3_ACCESS_KEY es obligatoria"),
  S3_SECRET_KEY: requiredString("S3_SECRET_KEY es obligatoria"),

  AUTH_SECRET: requiredString("AUTH_SECRET es obligatoria"),

  // Opcional a propósito: sin ella, las funciones de IA (Gemini) se
  // ocultan y el resto de la aplicación sigue funcionando con normalidad.
  // Se preprocesa "" -> undefined porque Docker Compose asigna cadena
  // vacía (no "ausente") a las variables sin valor en `environment:`.
  GEMINI_API_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
});

export const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: requiredUrl(
    "NEXT_PUBLIC_APP_URL es obligatoria",
    "NEXT_PUBLIC_APP_URL debe ser una URL válida",
  ),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type ClientEnv = z.infer<typeof clientEnvSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(raíz)"}: ${issue.message}`)
    .join("\n");
}

export function parseServerEnv(
  input: Record<string, string | undefined>,
): ServerEnv {
  const result = serverEnvSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      "❌ Variables de entorno de servidor inválidas o ausentes:\n" +
        `${formatIssues(result.error)}\n\n` +
        "Revisa tu fichero .env contra .env.example.",
    );
  }
  return result.data;
}

export function parseClientEnv(
  input: Record<string, string | undefined>,
): ClientEnv {
  const result = clientEnvSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      "❌ Variables de entorno públicas inválidas o ausentes:\n" +
        `${formatIssues(result.error)}\n\n` +
        "Revisa tu fichero .env contra .env.example.",
    );
  }
  return result.data;
}

function assertServerContext(): void {
  if (typeof window !== "undefined") {
    throw new Error(
      "❌ serverEnv solo puede usarse en código de servidor. " +
        "No lo importes desde un componente de cliente.",
    );
  }
}

let cachedServerEnv: ServerEnv | undefined;
function getServerEnv(): ServerEnv {
  assertServerContext();
  if (!cachedServerEnv) {
    cachedServerEnv = parseServerEnv(process.env);
  }
  return cachedServerEnv;
}

let cachedClientEnv: ClientEnv | undefined;
function getClientEnv(): ClientEnv {
  if (!cachedClientEnv) {
    cachedClientEnv = parseClientEnv({
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    });
  }
  return cachedClientEnv;
}

/**
 * La validación se difiere hasta el primer acceso a una propiedad
 * (en vez de ejecutarse al importar el módulo) para que los tests
 * puedan importar `parseServerEnv`/`parseClientEnv` sin necesitar
 * variables de entorno reales, y para que `assertEnv()` sea quien
 * decide, explícitamente, cuándo se falla el arranque.
 */
function createLazyEnvProxy<T extends object>(getTarget: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      return Reflect.get(getTarget(), prop as string);
    },
    has(_target, prop) {
      return Reflect.has(getTarget(), prop as string);
    },
    ownKeys() {
      return Reflect.ownKeys(getTarget());
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Object.getOwnPropertyDescriptor(getTarget(), prop as string);
    },
  });
}

/** Configuración de servidor: secretos de BD, S3, auth y (opcional) Gemini. */
export const serverEnv: ServerEnv = createLazyEnvProxy(getServerEnv);

/** Configuración pública, segura para el navegador (prefijo NEXT_PUBLIC_). */
export const clientEnv: ClientEnv = createLazyEnvProxy(getClientEnv);

/**
 * Valida toda la configuración de una vez. Se invoca en `instrumentation.ts`
 * para que la aplicación falle al arrancar, con un mensaje claro, si falta
 * alguna variable obligatoria — en vez de fallar más tarde y a medias
 * la primera vez que algo intente usarla.
 */
export function assertEnv(): void {
  getServerEnv();
  getClientEnv();
}
