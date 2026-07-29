import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Toda la configuración de entorno pasa por src/lib/env.ts: prohíbe
  // acceder a process.env directamente desde el resto de la app.
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    ignores: [
      "src/lib/env.ts",
      "playwright.config.ts",
      "drizzle.config.ts",
      // Guarda de runtime documentada por Next.js (NEXT_RUNTIME) para que
      // instrumentation.ts no ejecute código de Node.js dentro del Edge
      // Runtime que usa el middleware — ver src/instrumentation.ts.
      "src/instrumentation.ts",
      // Arranca un servidor real como proceso hijo y necesita heredar el
      // process.env (incluido lo cargado por dotenv/config) tal cual.
      "src/test/auth-http.integration.test.ts",
    ],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "No accedas a process.env directamente: usa `serverEnv`/`clientEnv` de @/lib/env.",
        },
      ],
    },
  },
]);

export default eslintConfig;
