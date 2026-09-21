-- =============================================================================
-- El código de EasyVista, otra vez: por si el registro dijo que ya estaba
--
-- El 21 de septiembre, con la aplicación recién desplegada, los móviles de los
-- técnicos seguían diciendo «Could not find the 'easyvista_ref' column of
-- 'incidents' in the schema cache» —23 filas atascadas en un móvil, siete
-- días de trabajo sin subir—. `deploy.sh` había corrido y no había aplicado
-- la migración 20260916000100: el registro `schema_migrations` la tenía
-- anotada como aplicada. Es lo que pasa cuando el registro se estrena sobre
-- una base que ya existía y se anotan de golpe todas las migraciones del
-- repositorio, también las que llegaron después del último despliegue: quedan
-- como hechas sin haberse hecho, y ningún despliegue posterior las vuelve a
-- mirar.
--
-- Esta migración repite la 20260916000100 entera. Su contenido es idempotente
-- —`add column if not exists`, `create or replace`, `drop … if exists`—, así
-- que sobre una base que sí la aplicó no cambia nada, y sobre una que solo la
-- tenía anotada deja las dos columnas, sus disparadores y su función. Como es
-- un fichero nuevo, el registro no puede tenerla anotada de antemano: el
-- siguiente `deploy.sh` la aplica seguro. Y la API recarga el esquema al
-- final, como la original.
--
-- Lo que sigue es el texto de la 20260916000100 tal cual.
-- =============================================================================

-- 1 — La columna
-- -----------------------------------------------------------------------------

alter table incidents add column if not exists easyvista_ref text;

alter table incidents drop constraint if exists incidents_easyvista_ref_formato;
alter table incidents add constraint incidents_easyvista_ref_formato
  check (easyvista_ref is null or easyvista_ref ~ '^\S{1,40}$');

comment on column incidents.easyvista_ref is
  'El ticket de EasyVista del parte, tal y como lo da EasyVista. Aparte de external_ref, que es el número del libro y lo pone la base. Lo escribe el personal al abrir, al cerrar o después.';

create index if not exists incidents_easyvista_idx
  on incidents (easyvista_ref) where easyvista_ref is not null;

-- -----------------------------------------------------------------------------
-- 2 — Y en el asiento de cierre, para que viaje por la cola
-- -----------------------------------------------------------------------------

alter table incident_resolutions add column if not exists easyvista_ref text;

alter table incident_resolutions drop constraint if exists incident_resolutions_easyvista_ref_formato;
alter table incident_resolutions add constraint incident_resolutions_easyvista_ref_formato
  check (easyvista_ref is null or easyvista_ref ~ '^\S{1,40}$');

comment on column incident_resolutions.easyvista_ref is
  'El ticket de EasyVista tecleado al cerrar, si se tecleó. El disparador lo copia a la incidencia; aquí queda como parte del asiento.';

/**
 * Deja el código como se guarda: recortado, en mayúsculas y nulo si no hay nada.
 *
 * La regla vive aquí y la usan las tres puertas, para que «I260916_0042» y
 * « i260916_0042 » sean el mismo código entren por donde entren.
 */
create or replace function public.normalizar_codigo_easyvista(p_codigo text)
returns text
language sql
immutable
as $$
  select nullif(upper(btrim(coalesce(p_codigo, ''))), '');
$$;

comment on function public.normalizar_codigo_easyvista(text) is
  'Recorta, pasa a mayúsculas y devuelve nulo si no queda nada. Es la única forma en que un código de EasyVista entra en la base.';

-- El cierre, con el código dentro cuando lo trae.
create or replace function public.aplicar_resolucion_de_incidencia()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_codigo text := public.normalizar_codigo_easyvista(new.easyvista_ref);
begin
  update incidents i
     set state       = 'resuelta',
         resolution  = new.resolution,
         resolved_at = least(greatest(new.resolved_at, i.opened_at), now()),
         resolved_by = new.resolved_by,
         -- El código que se tecleó al cerrar manda sobre el que hubiera; sin
         -- código en el cierre, el que hubiera se queda.
         easyvista_ref = coalesce(v_codigo, i.easyvista_ref)
   where i.id = new.incident_id
     and i.state in ('abierta', 'en_curso');

  return new;
end;
$$;

-- Que el asiento guarde el código normalizado, y no lo que se tecleó: lo que
-- se lee después tiene que ser lo mismo que lo que quedó en la incidencia.
create or replace function public.normalizar_codigo_del_cierre()
returns trigger
language plpgsql
as $$
begin
  new.easyvista_ref := public.normalizar_codigo_easyvista(new.easyvista_ref);
  return new;
end;
$$;

drop trigger if exists incident_resolutions_codigo on incident_resolutions;
create trigger incident_resolutions_codigo
  before insert on incident_resolutions
  for each row execute function public.normalizar_codigo_del_cierre();

-- Y lo mismo al abrir: la fila entra por la cola con lo que se tecleó.
create or replace function public.normalizar_codigo_de_la_incidencia()
returns trigger
language plpgsql
as $$
begin
  new.easyvista_ref := public.normalizar_codigo_easyvista(new.easyvista_ref);
  return new;
end;
$$;

drop trigger if exists incidents_codigo_easyvista on incidents;
create trigger incidents_codigo_easyvista
  before insert or update of easyvista_ref on incidents
  for each row execute function public.normalizar_codigo_de_la_incidencia();

-- -----------------------------------------------------------------------------
-- 3 — Ponerlo o cambiarlo después
--
-- `security definer` por lo mismo que el cierre: `incidents` no acepta el
-- UPDATE de un técnico, y abrirle la tabla entera para una columna sería
-- devolverle el bolígrafo sobre el número del libro. Esta función toca esa
-- columna y ninguna otra.
-- -----------------------------------------------------------------------------

create or replace function public.incidencia_poner_codigo_easyvista(p_incidencia uuid, p_codigo text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_codigo text := public.normalizar_codigo_easyvista(p_codigo);
begin
  if not public.is_staff() then
    raise exception 'Solo el personal pone el código de EasyVista'
      using errcode = 'insufficient_privilege';
  end if;

  if v_codigo is not null and v_codigo !~ '^\S{1,40}$' then
    raise exception 'El código de EasyVista no puede llevar espacios ni pasar de 40 caracteres';
  end if;

  update incidents
     set easyvista_ref = v_codigo
   where id = p_incidencia;

  if not found then
    raise exception 'Esa incidencia no está en la aplicación';
  end if;

  return v_codigo;
end;
$$;

comment on function public.incidencia_poner_codigo_easyvista(uuid, text) is
  'Pone —o quita, con texto vacío— el ticket de EasyVista de una incidencia, esté abierta o resuelta. Es la única escritura sobre incidents que tiene un técnico después de abrirla, y toca solo esa columna. Devuelve el código tal y como quedó.';

revoke all on function public.incidencia_poner_codigo_easyvista(uuid, text) from public, anon;
grant execute on function public.incidencia_poner_codigo_easyvista(uuid, text) to authenticated;

revoke all on function public.normalizar_codigo_easyvista(text) from public, anon;
grant execute on function public.normalizar_codigo_easyvista(text) to authenticated;

notify pgrst, 'reload schema';
