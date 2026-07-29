import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamps } from "./columns.helpers";
import { rooms } from "./rooms";
import { users } from "./users";
import { revisions } from "./revisions";
import {
  equipmentTypeStatusEnum,
  revisionBlockEnum,
  roomEquipmentStatusEnum,
} from "./enums";

/**
 * Catálogo de tipos de equipo (proyector, monitor, micrófono Jabra...).
 * `aliases` alimenta el autocompletado offline; un tipo tecleado que no
 * casa con ningún alias nace `pendiente_validacion` en vez de bloquear
 * el alta (ver docs/PLAN.md § Autocompletado).
 */
export const equipmentTypes = pgTable(
  "equipment_types",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    nameNormalized: text("name_normalized")
      .notNull()
      .generatedAlwaysAs(
        sql`lower(regexp_replace(trim(both from name), '\\s+', '', 'g'))`,
      ),
    block: revisionBlockEnum("block").notNull(),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    status: equipmentTypeStatusEnum("status")
      .notNull()
      .default("pendiente_validacion"),
    createdBy: uuid("created_by").references(() => users.id),
    validatedBy: uuid("validated_by").references(() => users.id),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("equipment_types_name_normalized_key").on(
      table.nameNormalized,
    ),
  ],
);

/**
 * El aparato físico. Su identidad (UUID, nº de serie) no depende de la
 * sala: moverlo es cerrar una asignación en `room_equipment` y abrir otra,
 * nunca sobrescribir esta fila (ver docs/PLAN.md § Por qué se separa...).
 * No hay restricción UNIQUE sobre `serial_number` a propósito: un número
 * de serie duplicado en dos salas es una anomalía que el sistema debe
 * poder *detectar* con una consulta, no algo que la base de datos impida.
 */
export const equipment = pgTable(
  "equipment",
  {
    id: uuid("id").primaryKey(),
    typeId: uuid("type_id")
      .notNull()
      .references(() => equipmentTypes.id),
    model: text("model"),
    serialNumber: text("serial_number"),
    ...timestamps(),
  },
  (table) => [
    index("equipment_type_id_idx").on(table.typeId),
    index("equipment_serial_number_idx").on(table.serialNumber),
  ],
);

/**
 * La asignación de un aparato a una sala. `label`/`index_number` son la
 * etiqueta editable ("Monitor 2" → "Monitor atril"); no llevan UNIQUE
 * porque dos dispositivos offline pueden generar el mismo "Monitor 2" a
 * la vez, y el servidor los renumera al sincronizar sin perder ninguno
 * (ver docs/PLAN.md § Choque de numeración offline).
 */
export const roomEquipment = pgTable(
  "room_equipment",
  {
    id: uuid("id").primaryKey(),
    equipmentId: uuid("equipment_id")
      .notNull()
      .references(() => equipment.id),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id),
    label: text("label").notNull(),
    indexNumber: integer("index_number").notNull().default(1),
    status: roomEquipmentStatusEnum("status").notNull().default("instalado"),
    assignedFrom: timestamp("assigned_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    assignedUntil: timestamp("assigned_until", { withTimezone: true }),
    /** Revisión que dio de alta o modificó por última vez esta asignación. */
    revisionId: uuid("revision_id").references(() => revisions.id),
    ...timestamps(),
  },
  (table) => [
    index("room_equipment_room_id_idx").on(table.roomId),
    index("room_equipment_equipment_id_idx").on(table.equipmentId),
  ],
);
