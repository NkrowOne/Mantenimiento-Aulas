import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { auditOriginEnum, dbOperationEnum } from "./enums";

/**
 * Auditoría genérica: qué fila de qué tabla cambió, quién y cómo.
 * docs/PLAN.md exige que esto se alimente con triggers de PostgreSQL (para
 * cubrir también escrituras por sync o SQL directo), no solo desde código
 * de aplicación; los triggers son una pieza pendiente de una fase
 * posterior — esta tabla ya deja el destino listo para recibirlos.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey(),
    tableName: text("table_name").notNull(),
    recordId: uuid("record_id").notNull(),
    action: dbOperationEnum("action").notNull(),
    userId: uuid("user_id").references(() => users.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    diff: jsonb("diff"),
    origin: auditOriginEnum("origin").notNull().default("app"),
  },
  (table) => [
    index("audit_log_table_record_idx").on(table.tableName, table.recordId),
    index("audit_log_occurred_at_idx").on(table.occurredAt),
  ],
);

/**
 * Excepción deliberada a "UUID v7 en todas partes": esta tabla existe
 * únicamente para que `GET /api/sync/pull?since=<seq>` tenga un cursor
 * estrictamente monótono (ver docs/PLAN.md § Sincronización offline, punto
 * 4). Un UUID v7 es ordenable por tiempo pero no sirve como cursor de
 * paginación estable; un `bigserial` sí. No es una entidad de negocio con
 * identidad propia, es un registro de cambios interno del servidor.
 */
export const changeLog = pgTable(
  "change_log",
  {
    seq: bigserial("seq", { mode: "bigint" }).primaryKey(),
    tableName: text("table_name").notNull(),
    recordId: uuid("record_id").notNull(),
    operation: dbOperationEnum("operation").notNull(),
    payload: jsonb("payload"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("change_log_table_record_idx").on(table.tableName, table.recordId),
  ],
);
