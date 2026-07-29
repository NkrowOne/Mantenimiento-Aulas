import { boolean, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./columns.helpers";
import { userRoleEnum } from "./enums";

/**
 * `password_hash`/`pin_hash` guardan únicamente hashes Argon2id (nunca
 * texto plano), calculados de forma independiente entre sí — ver
 * `src/lib/auth/password.ts` y docs/AUTENTICACION.md. `pin_hash` es
 * nullable: un usuario puede no haberse configurado todavía un PIN de
 * reapertura.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  pinHash: text("pin_hash"),
  name: text("name").notNull(),
  role: userRoleEnum("role").notNull().default("operador"),
  active: boolean("active").notNull().default(true),
  /** Fuerza el cambio de contraseña antes de usar el resto de la app. */
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  ...timestamps(),
});
