export async function register() {
  // Next.js invoca register() una vez por runtime que esté en uso. Desde
  // que existe src/middleware.ts, eso incluye el Edge Runtime — que no
  // soporta node:path/postgres/Argon2id. assertEnv()/runMigrations() solo
  // deben ejecutarse en el runtime de Node.js real del servidor.
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { assertEnv } = await import("@/lib/env");
  assertEnv();

  const { runMigrations } = await import("@/db/migrate");
  await runMigrations();
}
