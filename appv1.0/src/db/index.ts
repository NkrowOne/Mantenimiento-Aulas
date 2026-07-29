import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { serverEnv } from "@/lib/env";
import * as schema from "./schema";

/**
 * Conexión de la app en tiempo de ejecución: usa el rol `app_runtime`
 * (mínimo privilegio, sin permiso de escritura sobre `audit_log`), no el
 * rol migrador de `DATABASE_URL`. Ver docs/AUDITORIA.md.
 */
const queryClient = postgres(serverEnv.APP_DATABASE_URL, { max: 10 });

export const db = drizzle(queryClient, { schema });

export * from "./schema";
