import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { buildings, db } from "@/db";
import { withAuditContext } from "@/db/audit-context";
import {
  requireOperador,
  requireUser,
  toAuthErrorResponse,
} from "@/lib/auth/authorize";

/**
 * Recurso de ejemplo que demuestra la autorización server-side por rol:
 * `lector` y `operador` pueden leer; solo `operador` puede escribir. La
 * comprobación ocurre aquí, en el propio handler — nunca solo en si el
 * cliente decide mostrar u ocultar un botón de "crear edificio".
 */

export async function GET() {
  try {
    await requireUser();
  } catch (error) {
    return toAuthErrorResponse(error);
  }

  const rows = await db.select().from(buildings);
  return NextResponse.json(rows);
}

const createBuildingSchema = z.object({
  code: z.string().min(1, "El código es obligatorio."),
  name: z.string().min(1, "El nombre es obligatorio."),
});

export async function POST(request: Request) {
  let user;
  try {
    user = await requireOperador();
  } catch (error) {
    return toAuthErrorResponse(error);
  }

  const json = await request.json().catch(() => null);
  const parsed = createBuildingSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const id = uuidv7();
  await withAuditContext({ userId: user.id, origin: "app" }, async (tx) => {
    await tx.insert(buildings).values({
      id,
      code: parsed.data.code,
      name: parsed.data.name,
    });
  });

  return NextResponse.json({ id }, { status: 201 });
}
