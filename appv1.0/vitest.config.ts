import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Los tests de integración necesitan Postgres real (docker compose up
    // postgres) y viven en su propia config: ver vitest.integration.config.ts
    // y `npm run test:integration`.
    exclude: ["**/node_modules/**", "**/e2e/**", "**/*.integration.test.ts"],
  },
});
