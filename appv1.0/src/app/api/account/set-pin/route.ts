import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, users } from "@/db";
import { withAuditContext } from "@/db/audit-context";
import { requireUser, toAuthErrorResponse } from "@/lib/auth/authorize";
import { hashPin, verifyPassword } from "@/lib/auth/password";

const bodySchema = z.object({
  currentPassword: z.string().min(1, "Introduce tu contraseña actual."),
  pin: z.string().regex(/^\d{4}$/, "El PIN debe tener exactamente 4 dígitos."),
});

/**
 * Configura o cambia el PIN de reapertura. Exige la contraseña actual
 * (no basta con la sesión abierta) para que nadie pueda añadir un PIN de
 * desbloqueo a una cuenta ajena a partir de una sesión robada.
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

  const pinHash = await hashPin(parsed.data.pin);

  await withAuditContext({ userId: user.id, origin: "app" }, async (tx) => {
    await tx.update(users).set({ pinHash }).where(eq(users.id, user.id));
  });

  return NextResponse.json({ ok: true });
}
