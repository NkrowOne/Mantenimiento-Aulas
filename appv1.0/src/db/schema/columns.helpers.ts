import { timestamp } from "drizzle-orm/pg-core";

/**
 * `created_at`/`updated_at` estándar, siempre con zona horaria.
 * `updated_at` lo actualiza la aplicación (Drizzle `$onUpdate`); no hay
 * trigger de base de datos para ello en esta fase.
 */
export function timestamps() {
  return {
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  };
}
