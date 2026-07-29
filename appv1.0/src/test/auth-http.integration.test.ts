import { existsSync } from "node:fs";
import { type ChildProcess, spawn } from "node:child_process";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, users } from "@/db";
import { hashPassword } from "@/lib/auth/password";

/**
 * Tests de integración de extremo a extremo, sobre HTTP real: arrancan el
 * mismo servidor standalone que corre en Docker (`node
 * .next/standalone/server.js`, ver `src/instrumentation.ts` y el
 * `Dockerfile`) y lo ejercitan con `fetch()`, manejando las cookies a
 * mano. Es la única forma de probar de verdad el middleware, las cookies
 * de sesión y las respuestas HTTP tal cual las vería un navegador.
 *
 * Requisitos previos: `npm run build`, Postgres migrado y sembrado
 * (`docker compose up -d postgres && npm run db:migrate`).
 */

const PORT = 3211;
const BASE_URL = `http://localhost:${PORT}`;
const SERVER_ENTRY = ".next/standalone/server.js";

let serverProcess: ChildProcess;

class CookieJar {
  private readonly cookies = new Map<string, string>();

  applyFrom(response: Response): void {
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(";", 1)[0] ?? "";
      const eqIndex = pair.indexOf("=");
      if (eqIndex === -1) continue;
      const name = pair.slice(0, eqIndex).trim();
      const value = pair.slice(eqIndex + 1).trim();
      this.cookies.set(name, value);
    }
  }

  header(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

async function request(
  jar: CookieJar,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    redirect: "manual",
    headers: { ...init.headers, cookie: jar.header() },
  });
  jar.applyFrom(response);
  return response;
}

async function getCsrfToken(jar: CookieJar): Promise<string> {
  const response = await request(jar, "/api/auth/csrf");
  const body = (await response.json()) as { csrfToken: string };
  return body.csrfToken;
}

async function signInPassword(
  jar: CookieJar,
  email: string,
  password: string,
): Promise<Response> {
  const csrfToken = await getCsrfToken(jar);
  const body = new URLSearchParams({ email, password, csrfToken, json: "true" });
  return request(jar, "/api/auth/callback/password", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function signInPin(
  jar: CookieJar,
  email: string,
  pin: string,
): Promise<Response> {
  const csrfToken = await getCsrfToken(jar);
  const body = new URLSearchParams({ email, pin, csrfToken, json: "true" });
  return request(jar, "/api/auth/callback/pin", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function getSession(
  jar: CookieJar,
): Promise<{ user?: { role: string; mustChangePassword: boolean; email: string } } | null> {
  const response = await request(jar, "/api/auth/session");
  const body = await response.json();
  return body && Object.keys(body).length > 0 ? body : null;
}

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.ok) return;
    } catch {
      // Todavía no acepta conexiones.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `El servidor de pruebas no respondió en ${BASE_URL}/api/health a tiempo.`,
  );
}

const suffix = uuidv7();
const OPERADOR_EMAIL = `http-operador-${suffix}@example.test`;
const LECTOR_EMAIL = `http-lector-${suffix}@example.test`;
const FORCED_EMAIL = `http-forced-${suffix}@example.test`;
const PASSWORD = "Sup3rSecreta!";
const NEW_PASSWORD = "OtraSup3rSecreta!";
const PIN = "2468";

beforeAll(async () => {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `Falta ${SERVER_ENTRY}: ejecuta \`npm run build\` antes de \`npm run test:integration\`.`,
    );
  }

  await db.insert(users).values([
    {
      id: uuidv7(),
      email: OPERADOR_EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      name: "Operador HTTP",
      role: "operador",
      active: true,
    },
    {
      id: uuidv7(),
      email: LECTOR_EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      name: "Lector HTTP",
      role: "lector",
      active: true,
    },
    {
      id: uuidv7(),
      email: FORCED_EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      name: "Cambio Forzado HTTP",
      role: "operador",
      active: true,
      mustChangePassword: true,
    },
  ]);

  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), HOSTNAME: "localhost" },
    stdio: "pipe",
  });

  await waitForServer();
}, 60_000);

afterAll(async () => {
  serverProcess?.kill();
  // Los usuarios NO se borran: en cuanto inician sesión, el trigger de
  // auditoría los referencia desde audit_log.user_id (FK), igual que en
  // src/lib/auth/credentials.integration.test.ts.
});

describe("Login por email y contraseña", () => {
  it("crea una sesión con el rol correcto", async () => {
    const jar = new CookieJar();
    await signInPassword(jar, OPERADOR_EMAIL, PASSWORD);

    const session = await getSession(jar);
    expect(session?.user?.email).toBe(OPERADOR_EMAIL);
    expect(session?.user?.role).toBe("operador");
  });
});

describe("Autorización por rol en la API", () => {
  it("un lector puede leer pero el POST le devuelve 403", async () => {
    const jar = new CookieJar();
    await signInPassword(jar, LECTOR_EMAIL, PASSWORD);

    const getResponse = await request(jar, "/api/buildings");
    expect(getResponse.status).toBe(200);

    const postResponse = await request(jar, "/api/buildings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: `LECTOR-${suffix}`, name: "No debería crearse" }),
    });
    expect(postResponse.status).toBe(403);
  });

  it("un operador sí puede escribir (201)", async () => {
    const jar = new CookieJar();
    await signInPassword(jar, OPERADOR_EMAIL, PASSWORD);

    const postResponse = await request(jar, "/api/buildings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: `OPERADOR-${suffix}`, name: "Sí debería crearse" }),
    });
    expect(postResponse.status).toBe(201);
  });

  it("sin sesión, la API responde 401 en JSON (no un redirect) y las páginas redirigen a /login", async () => {
    const jar = new CookieJar();

    const apiResponse = await request(jar, "/api/buildings");
    expect(apiResponse.status).toBe(401);

    const pageResponse = await request(jar, "/dashboard");
    expect(pageResponse.status).toBe(307);
    expect(pageResponse.headers.get("location")).toContain("/login");
  });
});

describe("Sesión persistente", () => {
  it("sobrevive a peticiones independientes (equivalente a recargar la página)", async () => {
    const jar = new CookieJar();
    await signInPassword(jar, OPERADOR_EMAIL, PASSWORD);

    // Cada llamada siguiente es una petición HTTP nueva e independiente,
    // exactamente lo que ocurre al recargar la página en el navegador:
    // la cookie de sesión (no ningún estado en memoria) es lo único que
    // sostiene la sesión.
    for (let i = 0; i < 3; i += 1) {
      const session = await getSession(jar);
      expect(session?.user?.email).toBe(OPERADOR_EMAIL);
    }
  });
});

describe("Cierre de sesión", () => {
  it("invalida la cookie de sesión", async () => {
    const jar = new CookieJar();
    await signInPassword(jar, OPERADOR_EMAIL, PASSWORD);
    expect((await getSession(jar))?.user?.email).toBe(OPERADOR_EMAIL);

    const csrfToken = await getCsrfToken(jar);
    await request(jar, "/api/auth/signout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken, json: "true" }),
    });

    expect(await getSession(jar)).toBeNull();
  });
});

describe("Reapertura mediante PIN", () => {
  it("configurar un PIN exige la contraseña actual, y luego permite entrar solo con el PIN", async () => {
    const jar = new CookieJar();
    await signInPassword(jar, OPERADOR_EMAIL, PASSWORD);

    const setPinResponse = await request(jar, "/api/account/set-pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: PASSWORD, pin: PIN }),
    });
    expect(setPinResponse.status).toBe(200);

    const pinJar = new CookieJar();
    await signInPin(pinJar, OPERADOR_EMAIL, PIN);
    const session = await getSession(pinJar);
    expect(session?.user?.email).toBe(OPERADOR_EMAIL);
  });
});

describe("Cambio de contraseña forzado del alta inicial", () => {
  it("bloquea el resto de rutas salvo su propia API hasta completarse, y un login nuevo desbloquea", async () => {
    const jar = new CookieJar();
    await signInPassword(jar, FORCED_EMAIL, PASSWORD);
    expect((await getSession(jar))?.user?.mustChangePassword).toBe(true);

    const dashboardResponse = await request(jar, "/dashboard");
    expect(dashboardResponse.status).toBe(307);
    expect(dashboardResponse.headers.get("location")).toContain(
      "/account/change-password",
    );

    const changeResponse = await request(jar, "/api/account/change-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }),
    });
    expect(changeResponse.status).toBe(200);

    // El JWT de la sesión anterior sigue llevando mustChangePassword=true
    // (las sesiones JWT no se revocan; son intencionadamente sin estado):
    // hace falta un login nuevo para obtener un token al día.
    const freshJar = new CookieJar();
    await signInPassword(freshJar, FORCED_EMAIL, NEW_PASSWORD);
    const freshSession = await getSession(freshJar);
    expect(freshSession?.user?.mustChangePassword).toBe(false);

    const dashboardAfter = await request(freshJar, "/dashboard");
    expect(dashboardAfter.status).toBe(200);
  });
});
