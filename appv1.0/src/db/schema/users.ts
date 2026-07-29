import { boolean, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./columns.helpers";
import { userRoleEnum } from "./enums";

/**
 * `password_hash`/`pin_hash` guardan únicamente hashes (nunca texto plano).
 * El algoritmo de hashing (argon2id vía Auth.js) se implementa en la Fase 2
 * de docs/PLAN.md; esta tabla ya deja el esquema listo para ello.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  pinHash: text("pin_hash"),
  name: text("name").notNull(),
  role: userRoleEnum("role").notNull().default("operador"),
  active: boolean("active").notNull().default(true),
  ...timestamps(),
});
