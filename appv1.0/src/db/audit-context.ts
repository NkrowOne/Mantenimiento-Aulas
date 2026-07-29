import { sql } from "drizzle-orm";
import { db } from "./index";

export type AuditOrigin = "app" | "sync" | "import";

export interface AuditContext {
  /** UUID del usuario autenticado que origina el cambio, si lo hay. */
  userId?: string | null;
  origin: AuditOrigin;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Ejecuta `fn` dentro de una transacción con el usuario y el origen fijados
 * como variables de configuración de sesión (`SET LOCAL`, vía
 * `set_config(..., true)`) para que el trigger de auditoría de PostgreSQL
 * los recoja (ver `src/db/migrations/0002_audit_triggers.sql` y
 * docs/AUDITORIA.md). Es el punto de entrada que deben usar todas las
 * rutas de API que escriban en tablas auditadas.
 */
export async function withAuditContext<T>(
  context: AuditContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.audit.user_id', ${context.userId ?? ""}, true)`,
    );
    await tx.execute(
      sql`select set_config('app.audit.origin', ${context.origin}, true)`,
    );
    return fn(tx);
  });
}
