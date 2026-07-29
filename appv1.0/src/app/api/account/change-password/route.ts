import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, users } from "@/db";
import { withAuditContext } from "@/db/audit-context";
import { requireUser, toAuthErrorResponse } from "@/lib/auth/authorize";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

const bodySchema = z.object({
  currentPassword: z.string().min(1, "Introduce tu contraseña actual."),
  newPassword: z
    .string()
    .min(8, "La nueva contraseña debe tener al menos 8 caracteres."),
});

/**
 * Cualquier usuario autenticado puede cambiar SU PROPIA contraseña (no
 * requiere el rol operador): exige siempre la contraseña actual, incluso
 * en el cambio forzado del alta inicial, para que una sesión robada no
 * baste por sí sola para tomar la cuenta.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return toAuthErrorResponse(error);
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const [dbUser] = await db
    .select()
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (!dbUser) {
    return NextResponse.json(
      { error: "Usuario no encontrado." },
      { status: 404 },
    );
  }

  const currentOk = await verifyPassword(
    dbUser.passwordHash,
    parsed.data.currentPassword,
  );
  if (!currentOk) {
    return NextResponse.json(
      { error: "La contraseña actual no es correcta." },
      { status: 400 },
    );
  }

  const newHash = await hashPassword(parsed.data.newPassword);

  await withAuditContext({ userId: user.id, origin: "app" }, async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash: newHash, mustChangePassword: false })
      .where(eq(users.id, user.id));
  });

  return NextResponse.json({ ok: true });
}
