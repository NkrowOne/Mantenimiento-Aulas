import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serverEnv } from "@/lib/env";
import { auditLog, buildings, db, rooms, users } from "./index";
import { withAuditContext } from "./audit-context";

/**
 * Verifica el trigger de auditoría de PostgreSQL descrito en
 * docs/AUDITORIA.md: requiere Postgres real, ya migrado
 * (`docker compose up -d postgres && npm run db:migrate`).
 *
 * `db` (importado de `./index`) ya se conecta con el rol de mínimo
 * privilegio `app_runtime`, así que usarlo aquí simula exactamente una
 * "ruta ordinaria" de la aplicación.
 */

const testUserId = uuidv7();
const testBuildingId = uuidv7();
const testRoomId = uuidv7();

async function latestAuditRow(recordId: string) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.recordId, recordId))
    .orderBy(auditLog.occurredAt);
  return rows[rows.length - 1];
}

/**
 * drizzle-orm envuelve el error de postgres.js en un `DrizzleQueryError`
 * cuyo `.message` es genérico ("Failed query: ..."); el mensaje real de
 * Postgres ("permission denied for table audit_log") va en `.cause`.
 */
async function expectPermissionDenied(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    cause: expect.objectContaining({
      message: expect.stringMatching(/permission denied/i),
    }),
  });
}

beforeAll(async () => {
  await db.insert(users).values({
    id: testUserId,
    email: `audit-test-${testUserId}@example.test`,
    passwordHash: "not-a-real-hash",
    name: "Usuario de pruebas de auditoría",
  });
  await db.insert(buildings).values({
    id: testBuildingId,
    code: `AUD-${testBuildingId.slice(0, 8)}`,
    name: "Edificio de pruebas de auditoría",
  });
  await db.insert(rooms).values({
    id: testRoomId,
    buildingId: testBuildingId,
    code: "T.01",
    name: "Sala original",
    roomType: "aula",
  });
});

afterAll(async () => {
  await db.delete(rooms).where(eq(rooms.id, testRoomId));
  await db.delete(buildings).where(eq(buildings.id, testBuildingId));
  // El usuario de pruebas NO se borra: una vez que audit_log.user_id lo
  // referencia, la FK impide eliminarlo (ver docs/AUDITORIA.md § un
  // usuario auditado no se puede borrar). Es el comportamiento correcto,
  // no una limitación del test.
});

describe("auditoría de PostgreSQL: modificar una sala desde la API", () => {
  it("genera una fila de auditoría con usuario y origen 'app'", async () => {
    await withAuditContext(
      { userId: testUserId, origin: "app" },
      async (tx) => {
        await tx
          .update(rooms)
          .set({ name: "Sala renombrada vía API" })
          .where(eq(rooms.id, testRoomId));
      },
    );

    const row = await latestAuditRow(testRoomId);
    expect(row.tableName).toBe("rooms");
    expect(row.action).toBe("update");
    expect(row.origin).toBe("app");
    expect(row.userId).toBe(testUserId);
  });

  it("conserva el valor anterior y el nuevo del nombre en el mismo cambio", async () => {
    await withAuditContext(
      { userId: testUserId, origin: "app" },
      async (tx) => {
        await tx
          .update(rooms)
          .set({ name: "Sala renombrada otra vez" })
          .where(eq(rooms.id, testRoomId));
      },
    );

    const row = await latestAuditRow(testRoomId);
    expect(row.oldValues).toMatchObject({ name: "Sala renombrada vía API" });
    expect(row.newValues).toMatchObject({ name: "Sala renombrada otra vez" });
    expect(row.diff).toMatchObject({
      name: { anterior: "Sala renombrada vía API", nuevo: "Sala renombrada otra vez" },
    });
  });
});

describe("auditoría de PostgreSQL: modificar una sala con SQL directo", () => {
  it("también genera auditoría, con origen 'import' por defecto y sin usuario", async () => {
    // Cliente aparte, sin pasar por withAuditContext: simula un `psql`
    // directo que nunca fija app.audit.user_id/app.audit.origin.
    const directClient = postgres(serverEnv.APP_DATABASE_URL, { max: 1 });
    try {
      await directClient`
        UPDATE rooms SET name = 'Sala renombrada por SQL directo'
        WHERE id = ${testRoomId}
      `;
    } finally {
      await directClient.end();
    }

    const row = await latestAuditRow(testRoomId);
    expect(row.action).toBe("update");
    expect(row.origin).toBe("import");
    expect(row.userId).toBeNull();
    expect(row.newValues).toMatchObject({
      name: "Sala renombrada por SQL directo",
    });
  });
});

describe("auditoría de PostgreSQL: insert y delete", () => {
  it("audita el alta y la baja de una fila", async () => {
    const throwawayId = uuidv7();

    await db.insert(buildings).values({
      id: throwawayId,
      code: `AUD-DEL-${throwawayId.slice(0, 8)}`,
      name: "Edificio desechable",
    });
    const insertRow = await latestAuditRow(throwawayId);
    expect(insertRow.action).toBe("insert");
    expect(insertRow.oldValues).toBeNull();
    expect(insertRow.newValues).toMatchObject({ name: "Edificio desechable" });

    await db.delete(buildings).where(eq(buildings.id, throwawayId));
    const deleteRow = await latestAuditRow(throwawayId);
    expect(deleteRow.action).toBe("delete");
    expect(deleteRow.newValues).toBeNull();
    expect(deleteRow.oldValues).toMatchObject({ name: "Edificio desechable" });
  });
});

describe("auditoría de PostgreSQL: audit_log no puede alterarse desde rutas ordinarias", () => {
  it("el rol de la app (app_runtime) no es superusuario ni se salta RLS", async () => {
    const rows = await db.execute<{
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it("rechaza UPDATE directo sobre audit_log", async () => {
    const row = await latestAuditRow(testRoomId);
    await expectPermissionDenied(
      db
        .update(auditLog)
        .set({ action: "delete" })
        .where(eq(auditLog.id, row.id)),
    );
  });

  it("rechaza DELETE directo sobre audit_log", async () => {
    const row = await latestAuditRow(testRoomId);
    await expectPermissionDenied(
      db.delete(auditLog).where(eq(auditLog.id, row.id)),
    );
  });

  it("rechaza INSERT directo sobre audit_log (solo el trigger puede escribir ahí)", async () => {
    await expectPermissionDenied(
      db.insert(auditLog).values({
        tableName: "rooms",
        recordId: testRoomId,
        action: "update",
        origin: "app",
      }),
    );
  });

  it("nunca hay una fila de auditoría sobre la propia audit_log", async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tableName, "audit_log"));
    expect(rows).toHaveLength(0);
  });
});
