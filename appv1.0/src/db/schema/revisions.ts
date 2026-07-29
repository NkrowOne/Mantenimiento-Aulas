import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./columns.helpers";
import { rooms } from "./rooms";
import { users } from "./users";
import {
  checkResultEnum,
  revisionBlockEnum,
  revisionResultEnum,
  revisionStatusEnum,
} from "./enums";

/**
 * Una revisión de sala. No existe una columna `client_uuid` separada:
 * `id` ya es el UUID v7 generado en el cliente (ver docs/PLAN.md §
 * Identidad estable), así que reenviar la misma operación varias veces
 * hace upsert por `id` y logra la misma idempotencia sin duplicar la
 * clave.
 */
export const revisions = pgTable(
  "revisions",
  {
    id: uuid("id").primaryKey(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    status: revisionStatusEnum("status").notNull().default("borrador"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Identificador del dispositivo que originó la revisión (informativo). */
    deviceId: text("device_id"),
    overallResult: revisionResultEnum("overall_result"),
    notes: text("notes"),
    ...timestamps(),
  },
  (table) => [
    index("revisions_room_id_idx").on(table.roomId),
    index("revisions_user_id_idx").on(table.userId),
  ],
);

/**
 * Un registro por cada uno de los seis bloques fijos de una revisión.
 * `detail` es jsonb porque su forma cambia según el bloque (p. ej. en
 * `proyector` guarda horas y % de lámpara); el resto de columnas son
 * planas porque su forma es fija.
 */
export const revisionChecks = pgTable(
  "revision_checks",
  {
    id: uuid("id").primaryKey(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => revisions.id),
    block: revisionBlockEnum("block").notNull(),
    result: checkResultEnum("result").notNull(),
    detail: jsonb("detail"),
    note: text("note"),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("revision_checks_revision_block_key").on(
      table.revisionId,
      table.block,
    ),
  ],
);

export const revisionPhotos = pgTable(
  "revision_photos",
  {
    id: uuid("id").primaryKey(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => revisions.id),
    storageKey: text("storage_key").notNull(),
    thumbnailKey: text("thumbnail_key"),
    width: integer("width"),
    height: integer("height"),
    bytes: integer("bytes"),
    uploaded: boolean("uploaded").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("revision_photos_revision_id_idx").on(table.revisionId)],
);
