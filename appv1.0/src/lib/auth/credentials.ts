import { eq } from "drizzle-orm";
import { db, users } from "@/db";
import {
  DUMMY_PASSWORD_HASH,
  DUMMY_PIN_HASH,
  verifyPassword,
  verifyPin,
} from "./password";
import {
  LOGIN_RATE_LIMIT,
  PIN_RATE_LIMIT,
  checkRateLimit,
  resetRateLimit,
} from "./rate-limit";

export interface AuthorizedUser {
  id: string;
  email: string;
  name: string;
  role: "operador" | "lector";
  mustChangePassword: boolean;
}

/**
 * `reason` distingue "demasiados intentos" (seguro de mostrar: se aplica
 * por igual exista o no ese email) de "credenciales inválidas" (email
 * inexistente, secreto incorrecto o usuario inactivo — deliberadamente
 * la MISMA razón para las tres, para no revelar cuál de ellas ocurrió).
 */
export type AuthorizeResult =
  | { ok: true; user: AuthorizedUser }
  | { ok: false; reason: "invalid_credentials" | "rate_limited" };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function findUserByEmail(email: string) {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return rows[0] ?? null;
}

function toAuthorizedUser(user: typeof users.$inferSelect): AuthorizedUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
}

/**
 * Verifica email + contraseña. En caso de fallo, `reason` es siempre
 * `"invalid_credentials"` — igual si el email no existe, si la
 * contraseña es incorrecta o si el usuario está inactivo — para no
 * revelar cuál de las tres ocurrió (ver docs/AUTENTICACION.md § protección
 * contra enumeración). Cuando el email no existe, se verifica igualmente
 * contra un hash señuelo para que el tiempo de respuesta tampoco lo
 * delate.
 */
export async function authorizeWithPassword(
  emailInput: string,
  password: string,
): Promise<AuthorizeResult> {
  const email = normalizeEmail(emailInput);
  const rateKey = `login:${email}`;
  if (!checkRateLimit(rateKey, LOGIN_RATE_LIMIT).allowed) {
    return { ok: false, reason: "rate_limited" };
  }

  const user = await findUserByEmail(email);
  const hashToCheck = user?.passwordHash ?? (await DUMMY_PASSWORD_HASH);
  const valid = await verifyPassword(hashToCheck, password);

  if (!user || !valid || !user.active) {
    return { ok: false, reason: "invalid_credentials" };
  }

  resetRateLimit(rateKey);
  return { ok: true, user: toAuthorizedUser(user) };
}

/**
 * Verifica email + PIN de reapertura. Misma política de fallo genérico y
 * de hash señuelo que {@link authorizeWithPassword}; "el usuario no tiene
 * PIN configurado" cuenta como `"invalid_credentials"`, igual que un PIN
 * incorrecto.
 */
export async function authorizeWithPin(
  emailInput: string,
  pin: string,
): Promise<AuthorizeResult> {
  const email = normalizeEmail(emailInput);
  const rateKey = `pin:${email}`;
  if (!checkRateLimit(rateKey, PIN_RATE_LIMIT).allowed) {
    return { ok: false, reason: "rate_limited" };
  }

  const user = await findUserByEmail(email);
  const hashToCheck = user?.pinHash ?? (await DUMMY_PIN_HASH);
  const valid = await verifyPin(hashToCheck, pin);

  if (!user || !user.pinHash || !valid || !user.active) {
    return { ok: false, reason: "invalid_credentials" };
  }

  resetRateLimit(rateKey);
  return { ok: true, user: toAuthorizedUser(user) };
}
