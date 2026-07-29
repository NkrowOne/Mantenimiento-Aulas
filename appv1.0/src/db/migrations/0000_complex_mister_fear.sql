CREATE TYPE "public"."audit_origin" AS ENUM('app', 'sync', 'import');--> statement-breakpoint
CREATE TYPE "public"."check_result" AS ENUM('ok', 'ko', 'na');--> statement-breakpoint
CREATE TYPE "public"."db_operation" AS ENUM('insert', 'update', 'delete');--> statement-breakpoint
CREATE TYPE "public"."equipment_type_status" AS ENUM('validado', 'pendiente_validacion');--> statement-breakpoint
CREATE TYPE "public"."incident_origin" AS ENUM('revision', 'manual');--> statement-breakpoint
CREATE TYPE "public"."incident_priority" AS ENUM('baja', 'media', 'alta');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('borrador', 'abierta', 'en_curso', 'resuelta', 'cerrada');--> statement-breakpoint
CREATE TYPE "public"."incident_type" AS ENUM('incidencia', 'solicitud', 'observacion');--> statement-breakpoint
CREATE TYPE "public"."report_type" AS ENUM('diario', 'semanal', 'bajo_demanda');--> statement-breakpoint
CREATE TYPE "public"."revision_block" AS ENUM('pantallas', 'microfono', 'red', 'sonido', 'proyector', 'botonera');--> statement-breakpoint
CREATE TYPE "public"."revision_result" AS ENUM('ok', 'con_incidencias');--> statement-breakpoint
CREATE TYPE "public"."revision_status" AS ENUM('borrador', 'completada');--> statement-breakpoint
CREATE TYPE "public"."room_equipment_status" AS ENUM('instalado', 'averiado', 'retirado', 'ausente');--> statement-breakpoint
CREATE TYPE "public"."room_status" AS ENUM('activa', 'de_baja', 'fusionada');--> statement-breakpoint
CREATE TYPE "public"."room_type" AS ENUM('aula', 'sala_reunion', 'laboratorio', 'despacho');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_reason" AS ENUM('compra', 'consumo', 'ajuste');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('operador', 'lector');--> statement-breakpoint
CREATE SEQUENCE "public"."rooms_stable_code_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "buildings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"code_normalized" text GENERATED ALWAYS AS (lower(regexp_replace(trim(both from code), '\s+', '', 'g'))) STORED NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"building_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text GENERATED ALWAYS AS (lower(regexp_replace(trim(both from name), '\s+', '', 'g'))) STORED NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"building_id" uuid NOT NULL,
	"zone_id" uuid,
	"code" text NOT NULL,
	"code_normalized" text GENERATED ALWAYS AS (lower(regexp_replace(trim(both from code), '\s+', '', 'g'))) STORED NOT NULL,
	"stable_code" text DEFAULT ('SALA-' || lpad(nextval('rooms_stable_code_seq')::text, 6, '0')) NOT NULL,
	"name" text NOT NULL,
	"room_type" "room_type" NOT NULL,
	"status" "room_status" DEFAULT 'activa' NOT NULL,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_stable_code_unique" UNIQUE("stable_code")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"pin_hash" text,
	"name" text NOT NULL,
	"role" "user_role" DEFAULT 'operador' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "equipment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type_id" uuid NOT NULL,
	"model" text,
	"serial_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text GENERATED ALWAYS AS (lower(regexp_replace(trim(both from name), '\s+', '', 'g'))) STORED NOT NULL,
	"block" "revision_block" NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "equipment_type_status" DEFAULT 'pendiente_validacion' NOT NULL,
	"created_by" uuid,
	"validated_by" uuid,
	"validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_equipment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"equipment_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"label" text NOT NULL,
	"index_number" integer DEFAULT 1 NOT NULL,
	"status" "room_equipment_status" DEFAULT 'instalado' NOT NULL,
	"assigned_from" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_until" timestamp with time zone,
	"revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text GENERATED ALWAYS AS (lower(regexp_replace(trim(both from name), '\s+', '', 'g'))) STORED NOT NULL,
	"category" text,
	"unit" text DEFAULT 'ud' NOT NULL,
	"min_threshold" integer DEFAULT 0 NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity_delta" integer NOT NULL,
	"reason" "stock_movement_reason" NOT NULL,
	"incident_id" uuid,
	"revision_id" uuid,
	"user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revision_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision_id" uuid NOT NULL,
	"block" "revision_block" NOT NULL,
	"result" "check_result" NOT NULL,
	"detail" jsonb,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revision_photos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"thumbnail_key" text,
	"width" integer,
	"height" integer,
	"bytes" integer,
	"uploaded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "revision_status" DEFAULT 'borrador' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"device_id" text,
	"overall_result" "revision_result",
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"external_code" text,
	"type" "incident_type" DEFAULT 'incidencia' NOT NULL,
	"origin" "incident_origin" DEFAULT 'manual' NOT NULL,
	"opened_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"problem_description" text,
	"resolution" text,
	"status" "incident_status" DEFAULT 'borrador' NOT NULL,
	"priority" "incident_priority",
	"assigned_to" uuid,
	"revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"record_id" uuid NOT NULL,
	"action" "db_operation" NOT NULL,
	"user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"diff" jsonb,
	"origin" "audit_origin" DEFAULT 'app' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"record_id" uuid NOT NULL,
	"operation" "db_operation" NOT NULL,
	"payload" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" "report_type" NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"storage_key" text NOT NULL,
	"filters" jsonb,
	"generated_by" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_merged_into_id_rooms_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_type_id_equipment_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."equipment_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_types" ADD CONSTRAINT "equipment_types_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_types" ADD CONSTRAINT "equipment_types_validated_by_users_id_fk" FOREIGN KEY ("validated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_equipment" ADD CONSTRAINT "room_equipment_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_equipment" ADD CONSTRAINT "room_equipment_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_equipment" ADD CONSTRAINT "room_equipment_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_stock_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_checks" ADD CONSTRAINT "revision_checks_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_photos" ADD CONSTRAINT "revision_photos_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buildings_code_normalized_key" ON "buildings" USING btree ("code_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "zones_building_name_normalized_key" ON "zones" USING btree ("building_id","name_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_building_code_normalized_key" ON "rooms" USING btree ("building_id","code_normalized");--> statement-breakpoint
CREATE INDEX "equipment_type_id_idx" ON "equipment" USING btree ("type_id");--> statement-breakpoint
CREATE INDEX "equipment_serial_number_idx" ON "equipment" USING btree ("serial_number");--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_types_name_normalized_key" ON "equipment_types" USING btree ("name_normalized");--> statement-breakpoint
CREATE INDEX "room_equipment_room_id_idx" ON "room_equipment" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_equipment_equipment_id_idx" ON "room_equipment" USING btree ("equipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_items_name_normalized_key" ON "stock_items" USING btree ("name_normalized");--> statement-breakpoint
CREATE INDEX "stock_movements_item_id_idx" ON "stock_movements" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "stock_movements_incident_id_idx" ON "stock_movements" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "stock_movements_revision_id_idx" ON "stock_movements" USING btree ("revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "revision_checks_revision_block_key" ON "revision_checks" USING btree ("revision_id","block");--> statement-breakpoint
CREATE INDEX "revision_photos_revision_id_idx" ON "revision_photos" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "revisions_room_id_idx" ON "revisions" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "revisions_user_id_idx" ON "revisions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "incidents_room_id_idx" ON "incidents" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "incidents_status_idx" ON "incidents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "incidents_revision_id_idx" ON "incidents" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "audit_log_table_record_idx" ON "audit_log" USING btree ("table_name","record_id");--> statement-breakpoint
CREATE INDEX "audit_log_occurred_at_idx" ON "audit_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "change_log_table_record_idx" ON "change_log" USING btree ("table_name","record_id");--> statement-breakpoint
CREATE INDEX "reports_type_idx" ON "reports" USING btree ("type");--> statement-breakpoint
CREATE INDEX "reports_generated_at_idx" ON "reports" USING btree ("generated_at");--> statement-breakpoint
CREATE VIEW "public"."stock_levels" AS (select "item_id", coalesce(sum("quantity_delta"), 0)::integer as "quantity_on_hand" from "stock_movements" group by "stock_movements"."item_id");