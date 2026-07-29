import "dotenv/config";
import { randomBytes, scryptSync } from "node:crypto";
import { db } from "./index";
import { buildings, equipmentTypes, rooms, stockItems, users, zones } from "./schema";

/**
 * Semilla idempotente: UUID v7 fijos (en vez de generados en cada
 * ejecución) para que `onConflictDoNothing` reconozca las mismas filas
 * la segunda vez y no se dupliquen. Solo datos imprescindibles para
 * verificar la interfaz, según docs/PLAN.md — nada de histórico.
 */
const ids = {
  userAdmin: "019fad73-0ab5-7b72-8c0e-0dbf34c047fb",

  buildingA: "019fad73-0abb-7a4d-adca-f137dcbe5006",
  zoneA1: "019fad73-0abb-7a4d-adca-f138354df846",
  roomA101: "019fad73-0abb-7a4d-adca-f1390be2a4d9",
  roomA102: "019fad73-0abc-7f9c-bbbc-2225c8989ec9",

  buildingB: "019fad73-0abc-7f9c-bbbc-222687defe1c",
  zoneB1: "019fad73-0abc-7f9c-bbbc-222786b31bb5",
  roomB201: "019fad73-0abc-7f9c-bbbc-222852c9ef35",

  buildingC: "019fad73-0abc-7f9c-bbbc-22296f6f8e44",
  roomC001: "019fad73-0abc-7f9c-bbbc-222a2ddf78ea",

  eqtypeProyector: "019fad73-0abc-7f9c-bbbc-222b08e2e3b7",
  eqtypeTv: "019fad73-0abc-7f9c-bbbc-222c1db15f61",
  eqtypeMonitor: "019fad73-0abc-7f9c-bbbc-222df612d3a0",
  eqtypeMonitorAux: "019fad73-0abd-7d78-b206-dbc64a71cc1c",
  eqtypeOrdenador: "019fad73-0abd-7d78-b206-dbc769831778",
  eqtypeCamara: "019fad73-0abd-7d78-b206-dbc870118f76",
  eqtypeAltavoces: "019fad73-0abd-7d78-b206-dbc9b66e4445",
  eqtypeMicrofono: "019fad73-0abd-7d78-b206-dbca8c10fa66",
  eqtypeBotonera: "019fad73-0abd-7d78-b206-dbcbf948f5e7",
  eqtypeScreenbeam: "019fad73-0abd-7d78-b206-dbcc7649f157",
  eqtypeBarco: "019fad73-0abd-7d78-b206-dbcd36ebf85d",
  eqtypePanacast: "019fad73-0abd-7d78-b206-dbce6f2d7e07",
  eqtypePantallaProyeccion: "019fad73-0abd-7d78-b206-dbcf2800b423",

  stockLampara: "019fad73-0abd-7d78-b206-dbd05e0ff6fe",
  stockCableHdmi10m: "019fad73-0abd-7d78-b206-dbd16d752853",
  stockCableHdmi15m: "019fad73-0abd-7d78-b206-dbd2bf2c64fa",
  stockMandoBotonera: "019fad73-0abd-7d78-b206-dbd348f93e65",
  stockPilaAa: "019fad73-0abd-7d78-b206-dbd4cccf0320",
} as const;

/**
 * Placeholder de hashing (scrypt, sin dependencias nativas) para poder
 * sembrar un usuario administrador sin guardar la contraseña en texto
 * plano. NO es el hash final de producción: Auth.js + argon2id llegan
 * en la Fase 2 de docs/PLAN.md y sustituirán este esquema.
 */
function hashPasswordForSeed(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

const ADMIN_EMAIL = "admin@mantenimiento-aulas.local";
const ADMIN_PASSWORD = "ChangeMe123!";

async function seedUsers() {
  await db
    .insert(users)
    .values({
      id: ids.userAdmin,
      email: ADMIN_EMAIL,
      passwordHash: hashPasswordForSeed(ADMIN_PASSWORD),
      name: "Administrador",
      role: "operador",
      active: true,
    })
    .onConflictDoNothing({ target: users.email });
}

async function seedBuildingsZonesRooms() {
  await db
    .insert(buildings)
    .values([
      { id: ids.buildingA, code: "A", name: "Edificio A", sortOrder: 1 },
      { id: ids.buildingB, code: "B", name: "Edificio B", sortOrder: 2 },
      { id: ids.buildingC, code: "C", name: "Edificio C", sortOrder: 3 },
    ])
    .onConflictDoNothing({ target: buildings.codeNormalized });

  await db
    .insert(zones)
    .values([
      { id: ids.zoneA1, buildingId: ids.buildingA, name: "Planta 1", sortOrder: 1 },
      { id: ids.zoneB1, buildingId: ids.buildingB, name: "Planta 2", sortOrder: 1 },
    ])
    .onConflictDoNothing({ target: [zones.buildingId, zones.nameNormalized] });

  await db
    .insert(rooms)
    .values([
      {
        id: ids.roomA101,
        buildingId: ids.buildingA,
        zoneId: ids.zoneA1,
        code: "1.01",
        name: "Aula 1.01",
        roomType: "aula",
      },
      {
        id: ids.roomA102,
        buildingId: ids.buildingA,
        zoneId: ids.zoneA1,
        code: "1.02",
        name: "Aula 1.02",
        roomType: "aula",
      },
      {
        id: ids.roomB201,
        buildingId: ids.buildingB,
        zoneId: ids.zoneB1,
        code: "2.01",
        name: "Sala de reuniones 2.01",
        roomType: "sala_reunion",
      },
      {
        id: ids.roomC001,
        buildingId: ids.buildingC,
        zoneId: null,
        code: "0.01",
        name: "Despacho 0.01",
        roomType: "despacho",
      },
    ])
    .onConflictDoNothing({ target: [rooms.buildingId, rooms.codeNormalized] });
}

/**
 * Asignación inicial de bloque por tipo de equipo. Es un punto de partida
 * razonable, no una regla fija: el catálogo es editable y un admin puede
 * reasignar el bloque de cualquier tipo más adelante.
 */
async function seedEquipmentTypes() {
  await db
    .insert(equipmentTypes)
    .values([
      { id: ids.eqtypeProyector, name: "Proyector", block: "proyector", status: "validado", aliases: ["proyector", "cañón"] },
      { id: ids.eqtypeTv, name: "TV", block: "pantallas", status: "validado", aliases: ["televisor", "pantalla tv"] },
      { id: ids.eqtypeMonitor, name: "Monitor", block: "pantallas", status: "validado", aliases: ["monitor"] },
      { id: ids.eqtypeMonitorAux, name: "Monitor auxiliar", block: "pantallas", status: "validado", aliases: ["monitor aux", "segundo monitor"] },
      { id: ids.eqtypePantallaProyeccion, name: "Pantalla de proyección", block: "pantallas", status: "validado", aliases: ["pantalla proyección", "pantalla enrollable"] },
      { id: ids.eqtypeMicrofono, name: "Micrófono", block: "microfono", status: "validado", aliases: ["micro", "micrófono jabra", "jabra"] },
      { id: ids.eqtypeAltavoces, name: "Altavoces", block: "sonido", status: "validado", aliases: ["altavoz", "sonido"] },
      { id: ids.eqtypeBotonera, name: "Botonera", block: "botonera", status: "validado", aliases: ["botonera", "panel de control"] },
      { id: ids.eqtypeOrdenador, name: "Ordenador", block: "red", status: "validado", aliases: ["pc", "ordenador de aula"] },
      { id: ids.eqtypeCamara, name: "Cámara", block: "red", status: "validado", aliases: ["camara", "webcam"] },
      { id: ids.eqtypeScreenbeam, name: "ScreenBeam", block: "red", status: "validado", aliases: ["screen beam"] },
      { id: ids.eqtypeBarco, name: "Barco ClickShare", block: "red", status: "validado", aliases: ["barco", "clickshare"] },
      { id: ids.eqtypePanacast, name: "Panacast", block: "red", status: "validado", aliases: ["pana cast"] },
    ])
    .onConflictDoNothing({ target: equipmentTypes.nameNormalized });
}

/** Catálogo con existencias a cero: sin movimientos, el stock disponible (SUM) es 0. */
async function seedStockItems() {
  await db
    .insert(stockItems)
    .values([
      { id: ids.stockLampara, name: "Lámpara de proyector", unit: "ud", category: "recambios", minThreshold: 2 },
      { id: ids.stockCableHdmi10m, name: "Cable HDMI 10m", unit: "ud", category: "cableado", minThreshold: 3, aliases: ["cable hdmi 10 metros"] },
      { id: ids.stockCableHdmi15m, name: "Cable HDMI Fibra 15m", unit: "ud", category: "cableado", minThreshold: 3, aliases: ["cable hdmi fibra 15 metros"] },
      { id: ids.stockMandoBotonera, name: "Mando de botonera", unit: "ud", category: "recambios", minThreshold: 1 },
      { id: ids.stockPilaAa, name: "Pila AA", unit: "ud", category: "consumibles", minThreshold: 10 },
    ])
    .onConflictDoNothing({ target: stockItems.nameNormalized });
}

async function main() {
  await seedUsers();
  await seedBuildingsZonesRooms();
  await seedEquipmentTypes();
  await seedStockItems();

  console.log("✅ Seed completado.");
  console.log(`   Usuario admin: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD} (cámbiala cuanto antes)`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("❌ Error al ejecutar el seed:", error);
    process.exit(1);
  });
