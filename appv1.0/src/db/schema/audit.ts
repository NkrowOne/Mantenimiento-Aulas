import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";
import { auditOriginEnum, dbOperationEnum } from "./enums";

/**
 * Auditoría genérica: qué fila de qué tabla cambió, quién y cómo. Se
 * alimenta EXCLUSIVAMENTE mediante un trigger de PostgreSQL (ver
 * `src/db/migrations/0001_audit_triggers.sql` y docs/AUDITORIA.md), nunca
 * escrita directamente desde código de aplicación — así cubre también las
 * escrituras por sincronización o SQL directo, y el rol de la app en
 * tiempo de ejecución (`app_runtime`) no tiene privilegio para alterarla.
 *
 * `id` usa `gen_random_uuid()` como default (en vez del UUID v7 generado
 * en cliente que usan las entidades de negocio): esta fila la crea el
 * propio trigger dentro de la base de datos, no hay "cliente" que la
 * origine.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tableName: text("table_name").notNull(),
    recordId: uuid("record_id").notNull(),
    action: dbOperationEnum("action").notNull(),
    userId: uuid("user_id").references(() => users.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Fila completa antes del cambio (NULL en INSERT). */
    oldValues: jsonb("old_values"),
    /** Fila completa después del cambio (NULL en DELETE). */
    newValues: jsonb("new_values"),
    /** Solo las claves que cambiaron, cada una con `{anterior, nuevo}`. */
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
