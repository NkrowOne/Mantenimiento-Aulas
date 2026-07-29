export async function register() {
  const { assertEnv } = await import("@/lib/env");
  assertEnv();

  const { runMigrations } = await import("@/db/migrate");
  await runMigrations();
}
