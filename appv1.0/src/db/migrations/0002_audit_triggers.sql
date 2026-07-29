-- Auditoría en PostgreSQL (no solo en TypeScript) + rol de aplicación de
-- mínimo privilegio, para que "audit_log" no pueda alterarse desde rutas
-- ordinarias: ver docs/AUDITORIA.md para la explicación completa.

-- 1) Función de trigger genérica -------------------------------------------
--
-- Se adjunta a cada tabla de negocio (no a audit_log ni a change_log, ver
-- más abajo). Lee el usuario y el origen de variables de configuración de
-- transacción (`app.audit.user_id` / `app.audit.origin`), que la aplicación
-- fija con `set_config(..., true)` al principio de cada transacción. Si no
-- se han fijado (por ejemplo, una sesión de `psql` directa), el origen cae
-- a 'import' y el usuario queda NULL: la escritura se audita igual.
CREATE OR REPLACE FUNCTION public.audit_row_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid;
  v_origin public.audit_origin;
  v_record_id uuid;
  v_old jsonb;
  v_new jsonb;
  v_diff jsonb;
BEGIN
  -- Nunca auditar la propia tabla de auditoría, aunque alguien llegara a
  -- adjuntar este trigger ahí por error.
  IF TG_TABLE_NAME = 'audit_log' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_user_id := NULLIF(current_setting('app.audit.user_id', true), '')::uuid;
  IF v_user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_user_id) THEN
    -- Referencia obsoleta o de prueba: no debe romper la operación de
    -- negocio por una violación de FK en audit_log.
    v_user_id := NULL;
  END IF;

  v_origin := COALESCE(
    NULLIF(current_setting('app.audit.origin', true), '')::public.audit_origin,
    'import'
  );

  IF TG_OP = 'DELETE' THEN
    v_record_id := OLD.id;
    v_old := to_jsonb(OLD);
    v_new := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    v_record_id := NEW.id;
    v_old := NULL;
    v_new := to_jsonb(NEW);
  ELSE
    v_record_id := NEW.id;
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(
             n.key,
             jsonb_build_object('anterior', v_old -> n.key, 'nuevo', n.value)
           )
      INTO v_diff
      FROM jsonb_each(v_new) AS n(key, value)
      WHERE v_old -> n.key IS DISTINCT FROM n.value;
  ELSE
    v_diff := NULL;
  END IF;

  INSERT INTO public.audit_log (
    table_name, record_id, action, user_id, old_values, new_values, diff, origin
  ) VALUES (
    TG_TABLE_NAME, v_record_id, lower(TG_OP)::public.db_operation,
    v_user_id, v_old, v_new, v_diff, v_origin
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint

-- 2) Triggers en las tablas de negocio --------------------------------------
--
-- Deliberadamente NO se adjunta a "audit_log" (sería auditar la auditoría)
-- ni a "change_log" (no tiene columna "id": es un bigserial interno de
-- sincronización, ver src/db/schema/audit.ts).
CREATE TRIGGER trg_audit_buildings AFTER INSERT OR UPDATE OR DELETE ON public.buildings FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();--> statement-breakpoint
CREATE TRIGGER trg_audit_zones AFTER INSERT OR UPDATE OR DELETE ON public.zones FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();--> statement-breakpoint
CREATE TRIGGER trg_audit_rooms AFTER INSERT OR UPDATE OR DELETE ON public.rooms FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();--> statement-breakpoint
CREATE TRIGGER trg_audit_users AFTER INSERT OR UPDATE OR DELETE ON public.users FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();--> statement-breakpoint
CREATE TRIGGER trg_audit_equipment_types AFTER INSERT OR UPDATE OR DELETE ON public.equipment_types FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();--> statement-breakpoint
CREATE TRIGGER trg_audit_equipment AFTER INSERT OR UPDATE OR DELETE ON public.equipment FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();--> statement-breakpoint
CREATE TRIGGER trg_audit_room_equipment AFTER INSERT OR UPDATE OR DELETE ON public.room_equipment FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();--> statement-breakpoint
CREATE TRIGGER trg_audit_stock_items AFTER INSERT OR UPDATE OR DELETE ON public.stock_items FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();--> statement-breakpoint
CREATE TRIGGER trg_audit_stock_movements AFTER INSERT OR UPDATE OR DELETE ON public.stock_movements FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();--> statement-breakpoint
CREATE TRIGGER trg_audit_revisions AFTER INSERT OR UPDATE OR DELETE ON public.revisions FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();--> statement-breakpoint
CREATE TRIGGER trg_audit_revision_checks AFTER INSERT OR UPDATE OR DELETE ON public.revision_checks FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();--> statement-breakpoint
CREATE TRIGGER trg_audit_revision_photos AFTER INSERT OR UPDATE OR DELETE ON public.revision_photos FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();--> statement-breakpoint
CREATE TRIGGER trg_audit_incidents AFTER INSERT OR UPDATE OR DELETE ON public.incidents FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();--> statement-breakpoint
CREATE TRIGGER trg_audit_reports AFTER INSERT OR UPDATE OR DELETE ON public.reports FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();--> statement-breakpoint

-- 3) Rol de aplicación de mínimo privilegio ---------------------------------
--
-- El rol que crea el contenedor de Postgres a partir de POSTGRES_USER es
-- SUPERUSER (así lo hace la imagen oficial), así que ni REVOKE ni Row
-- Level Security tendrían ningún efecto sobre él: un superusuario se
-- salta ambos mecanismos. Por eso la app en tiempo de ejecución se conecta
-- con este rol nuevo, sin privilegios de superusuario, y sin ningún
-- privilegio de escritura sobre "audit_log": únicamente puede leerla. Solo
-- la función de trigger (SECURITY DEFINER, propiedad del rol migrador)
-- puede insertar en ella.
--
-- Sin LOGIN ni contraseña todavía: `src/db/migrate.ts` fija la contraseña
-- en cada arranque a partir de APP_DATABASE_URL, para no dejar secretos en
-- una migración versionada.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN;
  END IF;
END;
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO app_runtime;--> statement-breakpoint

-- Tablas de negocio: lectura y escritura normal.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.buildings,
  public.zones,
  public.rooms,
  public.users,
  public.equipment_types,
  public.equipment,
  public.room_equipment,
  public.stock_items,
  public.stock_movements,
  public.revisions,
  public.revision_checks,
  public.revision_photos,
  public.incidents,
  public.reports
TO app_runtime;--> statement-breakpoint

-- audit_log: solo lectura. Toda escritura pasa por el trigger SECURITY
-- DEFINER, nunca por una ruta ordinaria de la aplicación.
GRANT SELECT ON public.audit_log TO app_runtime;--> statement-breakpoint

-- change_log: lo alimenta la futura capa de sincronización con INSERT,
-- pero no se corrige a posteriori (sin UPDATE/DELETE).
GRANT SELECT, INSERT ON public.change_log TO app_runtime;--> statement-breakpoint

-- Necesario para los DEFAULT que usan nextval() (p. ej. rooms.stable_code)
-- y para las columnas bigserial/identity.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;--> statement-breakpoint

-- Privilegios por defecto para tablas/secuencias que se creen en el
-- futuro con migraciones nuevas (ejecutadas por el rol migrador). Si una
-- tabla nueva necesita las mismas restricciones que audit_log, hay que
-- añadir un REVOKE explícito para ella, igual que aquí arriba.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
