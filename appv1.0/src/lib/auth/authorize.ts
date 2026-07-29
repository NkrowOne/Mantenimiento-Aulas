import { NextResponse } from "next/server";
import { auth } from "@/auth";

/**
 * Comprobación server-side de sesión y rol para Route Handlers. El
 * middleware (`src/middleware.ts`) ya redirige a `/login` a quien no
 * tiene sesión, pero eso es solo la primera línea de defensa — una API
 * route nunca debe confiar en que el cliente respetó esa redirección
 * (ni, mucho menos, en que el cliente simplemente ocultó un botón).
 * Cada handler que lea o escriba datos vuelve a llamar aquí.
 */
export class AuthorizationError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/** Cualquier usuario autenticado (operador o lector). */
export async function requireUser() {
  const session = await auth();
  if (!session?.user) {
    throw new AuthorizationError(401, "No autenticado.");
  }
  return session.user;
}

/** Rol `operador`: lectura y escritura. `lector` llega hasta aquí y falla. */
export async function requireOperador() {
  const user = await requireUser();
  if (user.role !== "operador") {
    throw new AuthorizationError(
      403,
      "No autorizado: esta acción requiere el rol operador.",
    );
  }
  return user;
}

/** Traduce {@link AuthorizationError} a una respuesta JSON; relanza cualquier otro error. */
export function toAuthErrorResponse(error: unknown): NextResponse {
  if (error instanceof AuthorizationError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  throw error;
}
