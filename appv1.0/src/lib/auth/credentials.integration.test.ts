import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, users } from "@/db";
import { hashPassword, hashPin } from "./password";
import { authorizeWithPassword, authorizeWithPin } from "./credentials";
import { clearAllRateLimits } from "./rate-limit";

/**
 * Contra Postgres real, ya migrado (`docker compose up -d postgres &&
 * npm run db:migrate`): ejercita la lógica de autorización tal cual la
 * usa `src/auth.ts`, sin pasar por HTTP. Los flujos que sí necesitan HTTP
 * real (middleware, cookies, roles en la API) están en
 * `src/test/auth-http.integration.test.ts`.
 */

const suffix = uuidv7();
const activeUserId = uuidv7();
const inactiveUserId = uuidv7();

const ACTIVE_EMAIL = `credentials-active-${suffix}@example.test`;
const INACTIVE_EMAIL = `credentials-inactive-${suffix}@example.test`;
const NONEXISTENT_EMAIL = `credentials-ghost-${suffix}@example.test`;
const PASSWORD = "Sup3rSecreta!";
const PIN = "1357";

beforeAll(async () => {
  await db.insert(users).values([
    {
      id: activeUserId,
      email: ACTIVE_EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      pinHash: await hashPin(PIN),
      name: "Usuario Activo de Pruebas",
      role: "operador",
      active: true,
    },
    {
      id: inactiveUserId,
      email: INACTIVE_EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      name: "Usuario Inactivo de Pruebas",
      role: "operador",
      active: false,
    },
  ]);
});

afterAll(async () => {
  // Los usuarios NO se borran: en cuanto authorizeWithPassword/authorizeWithPin
  // tiene éxito, el trigger de auditoría los referencia desde audit_log.user_id,
  // y esa FK impide el DELETE (ver docs/AUDITORIA.md) — es el comportamiento
  // correcto, no una limitación del test.
});

describe("authorizeWithPassword", () => {
  it("autentica con email y contraseña correctos", async () => {
    clearAllRateLimits();
    const result = await authorizeWithPassword(ACTIVE_EMAIL, PASSWORD);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.email).toBe(ACTIVE_EMAIL);
      expect(result.user.role).toBe("operador");
    }
  });

  it("no revela si el email existe: mismo motivo para email inexistente y contraseña incorrecta", async () => {
    clearAllRateLimits();
    const ghost = await authorizeWithPassword(NONEXISTENT_EMAIL, "cualquiera");
    clearAllRateLimits();
    const wrongPassword = await authorizeWithPassword(ACTIVE_EMAIL, "mala");

    expect(ghost).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(wrongPassword).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("bloquea a un usuario inactivo con el mismo motivo genérico", async () => {
    clearAllRateLimits();
    const result = await authorizeWithPassword(INACTIVE_EMAIL, PASSWORD);
    expect(result).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("aplica rate limiting tras varios intentos fallidos, para la misma clave (exista o no el email)", async () => {
    clearAllRateLimits();
    const email = `credentials-rl-${uuidv7()}@example.test`;

    let last;
    for (let i = 0; i < 6; i += 1) {
      last = await authorizeWithPassword(email, "intento-erroneo");
    }

    expect(last).toEqual({ ok: false, reason: "rate_limited" });
  });
});

describe("authorizeWithPin", () => {
  it("autentica con email y PIN correctos", async () => {
    clearAllRateLimits();
    const result = await authorizeWithPin(ACTIVE_EMAIL, PIN);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.email).toBe(ACTIVE_EMAIL);
    }
  });

  it("trata 'sin PIN configurado' igual que 'PIN incorrecto'", async () => {
    clearAllRateLimits();
    // INACTIVE_EMAIL nunca configuró PIN (pinHash es NULL).
    const result = await authorizeWithPin(INACTIVE_EMAIL, "0000");
    expect(result).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("no revela si el email existe: mismo motivo para email inexistente y PIN incorrecto", async () => {
    clearAllRateLimits();
    const ghost = await authorizeWithPin(NONEXISTENT_EMAIL, "0000");
    clearAllRateLimits();
    const wrongPin = await authorizeWithPin(ACTIVE_EMAIL, "9999");

    expect(ghost).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(wrongPin).toEqual({ ok: false, reason: "invalid_credentials" });
  });
});
