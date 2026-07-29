import {
  index,
  integer,
  pgTable,
  pgView,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamps } from "./columns.helpers";
import { incidents } from "./incidents";
import { revisions } from "./revisions";
import { users } from "./users";
import { stockMovementReasonEnum } from "./enums";

export const stockItems = pgTable(
  "stock_items",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    nameNormalized: text("name_normalized")
      .notNull()
      .generatedAlwaysAs(
        sql`lower(regexp_replace(trim(both from name), '\\s+', '', 'g'))`,
      ),
    category: text("category"),
    unit: text("unit").notNull().default("ud"),
    minThreshold: integer("min_threshold").notNull().default(0),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("stock_items_name_normalized_key").on(table.nameNormalized),
  ],
);

/**
 * Kardex append-only: nunca se actualiza ni se borra una fila, solo se
 * insertan nuevas. El stock disponible NO se guarda en ningún contador;
 * se calcula siempre con `SUM()` sobre esta tabla (ver la vista
 * `stock_levels` más abajo y docs/PLAN.md § por qué hoy `Total Instalado`
 * está roto).
 */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => stockItems.id),
    /** Positivo = entrada (compra/ajuste al alza), negativo = consumo. */
    quantityDelta: integer("quantity_delta").notNull(),
    reason: stockMovementReasonEnum("reason").notNull(),
    incidentId: uuid("incident_id").references(() => incidents.id),
    revisionId: uuid("revision_id").references(() => revisions.id),
    userId: uuid("user_id").references(() => users.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("stock_movements_item_id_idx").on(table.itemId),
    index("stock_movements_incident_id_idx").on(table.incidentId),
    index("stock_movements_revision_id_idx").on(table.revisionId),
  ],
);

/**
 * Stock actual por artículo = `SUM(quantity_delta)`. Una vista, nunca un
 * contador guardado: así no puede volver a descuadrar como en el Excel
 * (`Total Instalado = 0` con 96 consumos ya registrados).
 */
export const stockLevels = pgView("stock_levels").as((qb) =>
  qb
    .select({
      itemId: stockMovements.itemId,
      quantityOnHand:
        sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)::integer`.as(
          "quantity_on_hand",
        ),
    })
    .from(stockMovements)
    .groupBy(stockMovements.itemId),
);
