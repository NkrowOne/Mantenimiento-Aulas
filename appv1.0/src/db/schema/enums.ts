import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Los seis bloques fijos de la revisión (ver docs/PLAN.md). Se reutiliza
 * tanto en `equipment_types.bloque` como en `revision_checks.bloque`.
 */
export const revisionBlockEnum = pgEnum("revision_block", [
  "pantallas",
  "microfono",
  "red",
  "sonido",
  "proyector",
  "botonera",
]);

export const roomTypeEnum = pgEnum("room_type", [
  "aula",
  "sala_reunion",
  "laboratorio",
  "despacho",
]);

/** `fusionada` conserva el histórico; fusionar nunca borra la fila. */
export const roomStatusEnum = pgEnum("room_status", [
  "activa",
  "de_baja",
  "fusionada",
]);

export const equipmentTypeStatusEnum = pgEnum("equipment_type_status", [
  "validado",
  "pendiente_validacion",
]);

export const roomEquipmentStatusEnum = pgEnum("room_equipment_status", [
  "instalado",
  "averiado",
  "retirado",
  "ausente",
]);

export const stockMovementReasonEnum = pgEnum("stock_movement_reason", [
  "compra",
  "consumo",
  "ajuste",
]);

export const revisionStatusEnum = pgEnum("revision_status", [
  "borrador",
  "completada",
]);

export const revisionResultEnum = pgEnum("revision_result", [
  "ok",
  "con_incidencias",
]);

export const checkResultEnum = pgEnum("check_result", ["ok", "ko", "na"]);

export const incidentTypeEnum = pgEnum("incident_type", [
  "incidencia",
  "solicitud",
  "observacion",
]);

export const incidentOriginEnum = pgEnum("incident_origin", [
  "revision",
  "manual",
]);

export const incidentStatusEnum = pgEnum("incident_status", [
  "borrador",
  "abierta",
  "en_curso",
  "resuelta",
  "cerrada",
]);

export const incidentPriorityEnum = pgEnum("incident_priority", [
  "baja",
  "media",
  "alta",
]);

export const userRoleEnum = pgEnum("user_role", ["operador", "lector"]);

/** Compartido por `audit_log.action` y `change_log.operation`. */
export const dbOperationEnum = pgEnum("db_operation", [
  "insert",
  "update",
  "delete",
]);

export const auditOriginEnum = pgEnum("audit_origin", [
  "app",
  "sync",
  "import",
]);

export const reportTypeEnum = pgEnum("report_type", [
  "diario",
  "semanal",
  "bajo_demanda",
]);
