import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { serverEnv } from "@/lib/env";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Conexión de la app en tiempo de ejecución: usa el rol `app_runtime`
 * (mínimo privilegio, sin permiso de escritura sobre `audit_log`), no el
 * rol migrador de `DATABASE_URL`. Ver docs/AUDITORIA.md.
 *
 * Se construye de forma perezosa (al primer uso real, no al importar el
 * módulo): `next build` importa cada Route Handler para inspeccionarlo
 * ("Collecting page data"), sin ningún `.env` disponible en la imagen de
 * Docker (las variables solo llegan en tiempo de ejecución, vía
 * `environment:` de docker-compose) — si `postgres(serverEnv...)` se
 * ejecutara al importar este módulo, ese paso del build fallaría en
 * cuanto una ruta importe `@/db`.
 */
let realDb: Db | undefined;

function getDb(): Db {
  if (!realDb) {
    const queryClient = postgres(serverEnv.APP_DATABASE_URL, { max: 10 });
    realDb = drizzle(queryClient, { schema });
  }
  return realDb;
}

export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const value = Reflect.get(getDb() as object, prop);
    return typeof value === "function" ? value.bind(getDb()) : value;
  },
});

export * from "./schema";
