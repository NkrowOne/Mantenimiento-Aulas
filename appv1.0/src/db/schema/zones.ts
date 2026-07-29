import {
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamps } from "./columns.helpers";
import { buildings } from "./buildings";

/**
 * Planta/módulo/área dentro de un edificio. Tabla propia (no texto suelto)
 * para que "1ª PLANTA" y "1ª  PLANTA" no generen dos zonas distintas.
 */
export const zones = pgTable(
  "zones",
  {
    id: uuid("id").primaryKey(),
    buildingId: uuid("building_id")
      .notNull()
      .references(() => buildings.id),
    name: text("name").notNull(),
    nameNormalized: text("name_normalized")
      .notNull()
      .generatedAlwaysAs(
        sql`lower(regexp_replace(trim(both from name), '\\s+', '', 'g'))`,
      ),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("zones_building_name_normalized_key").on(
      table.buildingId,
      table.nameNormalized,
    ),
  ],
);
