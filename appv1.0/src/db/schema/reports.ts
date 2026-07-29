import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";
import { reportTypeEnum } from "./enums";

/**
 * Archivo histórico de informes: el PDF ya renderizado vive en
 * almacenamiento (`storage_key`); `filters` guarda los parámetros del
 * constructor bajo demanda (edificios, rango de fechas, tipo, estado...).
 * `generated_by` queda nulo para los informes automáticos del cron.
 */
export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey(),
    type: reportTypeEnum("type").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    storageKey: text("storage_key").notNull(),
    filters: jsonb("filters"),
    generatedBy: uuid("generated_by").references(() => users.id),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("reports_type_idx").on(table.type),
    index("reports_generated_at_idx").on(table.generatedAt),
  ],
);
