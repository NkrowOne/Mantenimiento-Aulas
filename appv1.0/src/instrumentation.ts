export async function register() {
  const { assertEnv } = await import("@/lib/env");
  assertEnv();
}
