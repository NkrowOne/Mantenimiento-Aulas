import { integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamps } from "./columns.helpers";

/**
 * Edificios. El nombre y el código son editables (no son la identidad,
 * ver docs/PLAN.md § Identidad estable); `code_normalized` es una columna
 * generada por PostgreSQL para deduplicar variantes como "EDIFICIO E" vs
 * "Edifico E" sin depender de que el código de aplicación lo mantenga.
 */
export const buildings = pgTable(
  "buildings",
  {
    id: uuid("id").primaryKey(),
    code: text("code").notNull(),
    codeNormalized: text("code_normalized")
      .notNull()
      .generatedAlwaysAs(
        sql`lower(regexp_replace(trim(both from code), '\\s+', '', 'g'))`,
      ),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("buildings_code_normalized_key").on(table.codeNormalized),
  ],
);
