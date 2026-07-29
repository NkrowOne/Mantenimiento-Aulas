import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Tests de integración: requieren Postgres real y migrado (docker compose
 * up postgres && npm run db:migrate). Se ejecutan por separado
 * (`npm run test:integration`) porque no deben bloquear `npm run test` en
 * una máquina sin Docker levantado.
 *
 * `src/test/auth-http.integration.test.ts` además arranca el servidor
 * standalone real, así que requiere `npm run build` antes.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["dotenv/config"],
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
