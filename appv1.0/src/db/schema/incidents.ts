import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./columns.helpers";
import { rooms } from "./rooms";
import { users } from "./users";
import { revisions } from "./revisions";
import {
  incidentOriginEnum,
  incidentPriorityEnum,
  incidentStatusEnum,
  incidentTypeEnum,
} from "./enums";

/**
 * `room_id` es la única columna obligatoria: un borrador se guarda con
 * solo la sala y se completa después, desde la bandeja de borradores
 * (ver docs/PLAN.md § Borradores). El resto queda anulable a propósito.
 */
export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id),
    /** Código de ticket externo, tecleado a mano; nunca lo genera la app. */
    externalCode: text("external_code"),
    type: incidentTypeEnum("type").notNull().default("incidencia"),
    origin: incidentOriginEnum("origin").notNull().default("manual"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    problemDescription: text("problem_description"),
    resolution: text("resolution"),
    status: incidentStatusEnum("status").notNull().default("borrador"),
    priority: incidentPriorityEnum("priority"),
    assignedTo: uuid("assigned_to").references(() => users.id),
    /** Revisión que detectó la incidencia, si viene de un bloque en FALLA. */
    revisionId: uuid("revision_id").references(() => revisions.id),
    ...timestamps(),
  },
  (table) => [
    index("incidents_room_id_idx").on(table.roomId),
    index("incidents_status_idx").on(table.status),
    index("incidents_revision_id_idx").on(table.revisionId),
  ],
);
