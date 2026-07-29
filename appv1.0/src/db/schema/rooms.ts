import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  pgSequence,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamps } from "./columns.helpers";
import { buildings } from "./buildings";
import { zones } from "./zones";
import { roomStatusEnum, roomTypeEnum } from "./enums";

/** Alimenta el código corto e inmutable `SALA-000142` (ver docs/PLAN.md). */
export const roomsStableCodeSeq = pgSequence("rooms_stable_code_seq", {
  startWith: 1,
  minValue: 1,
  increment: 1,
});

/**
 * Salas y aulas. `code` es la etiqueta editable de puerta ("1.4 O");
 * `code_normalized` (generada) evita que "1.4 O" y "1.4O" se dupliquen.
 * `stable_code` es la referencia corta e inmutable para hablar por
 * teléfono o imprimir: sobrevive a cualquier renombrado de `code`/`name`.
 */
export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").primaryKey(),
    buildingId: uuid("building_id")
      .notNull()
      .references(() => buildings.id),
    zoneId: uuid("zone_id").references(() => zones.id),
    code: text("code").notNull(),
    codeNormalized: text("code_normalized")
      .notNull()
      .generatedAlwaysAs(
        sql`lower(regexp_replace(trim(both from code), '\\s+', '', 'g'))`,
      ),
    stableCode: text("stable_code")
      .notNull()
      .unique()
      .default(
        sql`('SALA-' || lpad(nextval('rooms_stable_code_seq')::text, 6, '0'))`,
      ),
    name: text("name").notNull(),
    roomType: roomTypeEnum("room_type").notNull(),
    status: roomStatusEnum("status").notNull().default("activa"),
    /** Solo se rellena cuando `status = 'fusionada'`; nunca se borra la fila. */
    mergedIntoId: uuid("merged_into_id").references(
      (): AnyPgColumn => rooms.id,
    ),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("rooms_building_code_normalized_key").on(
      table.buildingId,
      table.codeNormalized,
    ),
  ],
);
