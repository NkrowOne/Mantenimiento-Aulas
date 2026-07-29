import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

/**
 * Protección de rutas a nivel de middleware: es la primera línea (evita
 * que se renderice nada de una página protegida), pero NUNCA la única —
 * cada API route que escribe datos vuelve a comprobar la sesión y el rol
 * server-side (`src/lib/auth/authorize.ts`). Ver docs/AUTENTICACION.md.
 */
export const { auth: middleware } = NextAuth(authConfig);
export default middleware;

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
