import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "./auth.config";
import { authorizeWithPassword, authorizeWithPin } from "./lib/auth/credentials";

/**
 * Código de error propio para que el formulario pueda distinguir "demasiados
 * intentos" de "credenciales inválidas". Es seguro de mostrar: el límite de
 * intentos se aplica por igual exista o no la cuenta (ver
 * `src/lib/auth/credentials.ts`), así que no revela nada sobre el email.
 */
class TooManyAttemptsError extends CredentialsSignin {
  code = "too_many_attempts";
}

function readCredential(
  credentials: Partial<Record<string, unknown>>,
  key: string,
): string {
  const value = credentials[key];
  return typeof value === "string" ? value : "";
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      id: "password",
      name: "Email y contraseña",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Contraseña", type: "password" },
      },
      async authorize(credentials) {
        const email = readCredential(credentials, "email");
        const password = readCredential(credentials, "password");
        if (!email || !password) return null;

        const result = await authorizeWithPassword(email, password);
        if (result.ok) return result.user;
        if (result.reason === "rate_limited") throw new TooManyAttemptsError();
        return null;
      },
    }),
    Credentials({
      id: "pin",
      name: "PIN",
      credentials: {
        email: { label: "Email", type: "email" },
        pin: { label: "PIN", type: "password" },
      },
      async authorize(credentials) {
        const email = readCredential(credentials, "email");
        const pin = readCredential(credentials, "pin");
        if (!email || !/^\d{4}$/.test(pin)) return null;

        const result = await authorizeWithPin(email, pin);
        if (result.ok) return result.user;
        if (result.reason === "rate_limited") throw new TooManyAttemptsError();
        return null;
      },
    }),
  ],
  // jwt/session ya están en authConfig.callbacks (ver auth.config.ts): el
  // middleware los necesita también, así que viven en el config
  // compartido en vez de duplicarse aquí.
});
