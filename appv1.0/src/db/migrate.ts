import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./index";

const migrationsFolder = path.join(process.cwd(), "src/db/migrations");

/**
 * Aplica las migraciones pendientes con el runtime de Drizzle (no el CLI
 * de drizzle-kit, que es una herramienta de desarrollo y no viaja en la
 * imagen de producción). Es idempotente: Drizzle lleva su propio registro
 * de qué migraciones ya se aplicaron, así que se puede llamar en cada
 * arranque del contenedor sin riesgo (ver docs/PLAN.md § Despliegue).
 */
export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder });
}
