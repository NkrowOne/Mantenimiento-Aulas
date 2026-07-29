import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { serverEnv } from "@/lib/env";

const migrationsFolder = path.join(process.cwd(), "src/db/migrations");

/** Nombre fijo del rol de mínimo privilegio creado en 0002_audit_triggers.sql. */
const APP_RUNTIME_ROLE = "app_runtime";

/**
 * Mantiene la contraseña de `app_runtime` sincronizada con
 * `APP_DATABASE_URL` en cada arranque. El rol se crea en la migración
 * versionada sin contraseña (`NOLOGIN`) a propósito: así ningún fichero
 * que se sube al repositorio contiene un secreto. `password` sale de la
 * configuración del propio despliegue (APP_DATABASE_URL), nunca de una
 * entrada de usuario, así que el escapado manual de comillas es seguro.
 */
async function syncAppRuntimePassword(
  adminDb: ReturnType<typeof drizzle>,
): Promise<void> {
  const { password } = new URL(serverEnv.APP_DATABASE_URL);
  if (!password) {
    throw new Error(
      "APP_DATABASE_URL debe incluir una contraseña (postgresql://usuario:contraseña@host:puerto/bd).",
    );
  }
  const escapedPassword = decodeURIComponent(password).replace(/'/g, "''");
  await adminDb.execute(
    sql.raw(
      `ALTER ROLE "${APP_RUNTIME_ROLE}" WITH LOGIN PASSWORD '${escapedPassword}'`,
    ),
  );
}

/**
 * Aplica las migraciones pendientes con el runtime de Drizzle (no el CLI
 * de drizzle-kit, que es una herramienta de desarrollo y no viaja en la
 * imagen de producción), y sincroniza la contraseña de `app_runtime`. Usa
 * su propia conexión de administrador (`DATABASE_URL`, rol migrador): la
 * conexión de la app (`APP_DATABASE_URL` / `db` de `./index`) ya no tiene
 * privilegio para ejecutar DDL ni para alterar roles (ver
 * docs/AUDITORIA.md). Es idempotente: se puede llamar en cada arranque
 * del contenedor sin riesgo (ver docs/PLAN.md § Despliegue).
 */
export async function runMigrations(): Promise<void> {
  const adminClient = postgres(serverEnv.DATABASE_URL, { max: 1 });
  const adminDb = drizzle(adminClient);
  try {
    await migrate(adminDb, { migrationsFolder });
    await syncAppRuntimePassword(adminDb);
  } finally {
    await adminClient.end();
  }
}
