ALTER TABLE "audit_log" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "old_values" jsonb;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "new_values" jsonb;