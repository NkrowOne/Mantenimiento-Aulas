import type { JWT } from "next-auth/jwt";
import type { NextAuthConfig } from "next-auth";
import { NextResponse } from "next/server";

/**
 * Config "edge-safe": la usa tanto `src/middleware.ts` (Edge Runtime) como
 * `src/auth.ts` (Node.js). Por eso NO declara `providers` aquí — los
 * proveedores de credenciales importan Argon2id y el cliente de
 * PostgreSQL, que no funcionan en Edge Runtime — ver docs/AUTENTICACION.md
 * § por qué la configuración está partida en dos ficheros.
 *
 * `jwt`/`session` SÍ viven aquí (no solo en `auth.ts`): son manipulación
 * de datos pura, sin APIs de Node, y el middleware los necesita para
 * saber `role`/`mustChangePassword` al decidir si redirige — si solo
 * estuvieran en `auth.ts`, el middleware vería siempre los valores por
 * defecto (undefined) porque nunca pasaría por esos callbacks.
 */

// Las rutas /api/* no están aquí a propósito: se gestionan aparte, ver
// el comentario junto a `pathname.startsWith("/api/")` más abajo.
const PUBLIC_PATHS = ["/", "/login"];
const CHANGE_PASSWORD_PATH = "/account/change-password";

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

export const authConfig = {
  // Autoalojado detrás de un único origen controlado (Skyway/Railway, ver
  // docs/PLAN.md § Despliegue), no en Vercel: sin esto, Auth.js rechaza
  // cualquier Host que no reconozca automáticamente.
  trustHost: true,
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
    // 12 horas: suficiente para un turno de trabajo sin re-loguearse,
    // sin dejar sesiones abiertas indefinidamente.
    maxAge: 60 * 60 * 12,
  },
  providers: [],
  callbacks: {
    authorized({ request, auth }) {
      const { pathname } = request.nextUrl;

      if (isPublicPath(pathname)) {
        return true;
      }

      // Las rutas de API hacen su propia comprobación de sesión y rol
      // (`requireUser`/`requireOperador`, ver src/lib/auth/authorize.ts)
      // y devuelven 401/403 en JSON. El middleware solo redirige
      // *páginas*: a un cliente de API no le sirve de nada un 307 hacia
      // una página HTML de login.
      if (pathname.startsWith("/api/")) {
        return true;
      }

      if (!auth?.user) {
        // `false` hace que NextAuth redirija a `pages.signIn` él solo.
        return false;
      }

      if (auth.user.mustChangePassword && pathname !== CHANGE_PASSWORD_PATH) {
        return NextResponse.redirect(
          new URL(CHANGE_PASSWORD_PATH, request.nextUrl),
        );
      }

      return true;
    },
    jwt({ token, user }) {
      const t = token as JWT;
      if (user) {
        t.uid = user.id;
        t.role = user.role;
        t.mustChangePassword = user.mustChangePassword;
      }
      return t;
    },
    session({ session, token }) {
      const t = token as JWT;
      if (session.user && t.uid) {
        session.user.id = t.uid;
        session.user.role = t.role ?? "lector";
        session.user.mustChangePassword = t.mustChangePassword ?? false;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
