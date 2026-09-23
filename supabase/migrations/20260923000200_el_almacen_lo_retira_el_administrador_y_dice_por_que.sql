-- =============================================================================
-- El almacén lo retira el administrador, y dice por qué
--
-- Quitar algo del almacén era, hasta hoy, cosa de la terminal: la guía enseña
-- el `update stock_items set active = false` y no había botón. Y dar de baja
-- un ordenador de repuesto lo podía hacer un supervisor con una nota en
-- blanco, así que la lista de bajas decía «Baja · 08/09/2026» y nada más:
-- ni quién decidió que ese tiny no valía ni por qué.
--
-- Tres cosas cambian, y las tres las decide la base y no la pantalla:
--
--  1. Retirar un artículo y dar de baja un ordenador es de **administrador**.
--     Un botón que el servidor va a rechazar no es un permiso, es una
--     promesa rota, así que la pantalla lo esconde; pero el que manda es el
--     `is_admin()` de aquí.
--  2. Las dos piden un **motivo de al menos diez caracteres**. «Roto» no cuenta:
--     el que lea el registro dentro de un año tiene que entender qué pasó.
--     El motivo queda en la fila (`retired_reason`, o las notas de la unidad)
--     y, por el disparador de auditoría, en `audit_log` con su autor.
--  3. **Retirar no borra nada.** El artículo pasa a inactivo: sale de la
--     pestaña Almacén y deja de contarse, pero sus movimientos, las
--     incidencias que lo citan y los ordenadores ya instalados en las aulas
--     siguen exactamente donde estaban. Una unidad instalada no se puede dar
--     de baja desde aquí —ya se rechazaba— porque su sitio es el aula.
--
-- Y se puede deshacer: «Restaurar» devuelve el artículo al almacén. Y se
-- puede renombrar sin romper el Excel: el nombre anterior se queda como alias,
-- que es por lo que `stock_item_id()` sigue encontrándolo cuando la hoja o un
-- parte lo escriben como siempre.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — Qué se retiró, cuándo, quién y por qué
-- -----------------------------------------------------------------------------

alter table stock_items add column if not exists retired_at     timestamptz;
alter table stock_items add column if not exists retired_by     uuid references profiles(id);
alter table stock_items add column if not exists retired_reason text;

comment on column stock_items.retired_reason is
  'Por qué se retiró del almacén (mínimo diez caracteres, lo exige stock_item_retirar). Se vacía al restaurar; el texto sigue en audit_log.';

-- -----------------------------------------------------------------------------
-- 2 — El motivo, comprobado en un solo sitio
--
-- Lo usan las dos funciones de abajo. Es interna: no se expone por la API.
-- -----------------------------------------------------------------------------

create or replace function public.motivo_obligatorio(p_motivo text)
returns text
language plpgsql
immutable
as $$
declare
  v text := btrim(coalesce(p_motivo, ''));
begin
  if length(v) < 10 then
    raise exception 'El motivo es obligatorio y debe tener al menos 10 caracteres'
      using errcode = 'check_violation';
  end if;
  return v;
end $$;

comment on function public.motivo_obligatorio(text) is
  'Devuelve el motivo recortado o falla si tiene menos de diez caracteres. Interna: la usan las retiradas y las bajas del almacén.';

revoke all on function public.motivo_obligatorio(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3 — Retirar un artículo del almacén (y volverlo a poner)
-- -----------------------------------------------------------------------------

create or replace function public.stock_item_retirar(p_item uuid, p_motivo text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activo boolean;
  v_motivo text;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador retira artículos del almacén'
      using errcode = 'insufficient_privilege';
  end if;
  v_motivo := public.motivo_obligatorio(p_motivo);

  select active into v_activo from stock_items where id = p_item for update;
  if v_activo is null then raise exception 'Ese artículo no existe'; end if;
  if not v_activo then raise exception 'Ese artículo ya está retirado del almacén'; end if;

  -- Solo la fila del artículo. Ni un movimiento, ni una incidencia, ni un
  -- ordenador instalado: `stock_levels` filtra por `active` y con eso basta.
  update stock_items
     set active         = false,
         retired_at     = now(),
         retired_by     = auth.uid(),
         retired_reason = v_motivo
   where id = p_item;
end $$;

comment on function public.stock_item_retirar(uuid, text) is
  'Retira un artículo del almacén (pasa a inactivo) con un motivo de al menos diez caracteres. Solo administrador. No borra movimientos, incidencias ni equipos instalados.';

revoke all on function public.stock_item_retirar(uuid, text) from public, anon;
grant execute on function public.stock_item_retirar(uuid, text) to authenticated;

create or replace function public.stock_item_restaurar(p_item uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activo boolean;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador restaura artículos del almacén'
      using errcode = 'insufficient_privilege';
  end if;

  select active into v_activo from stock_items where id = p_item for update;
  if v_activo is null then raise exception 'Ese artículo no existe'; end if;
  if v_activo then raise exception 'Ese artículo ya está en el almacén'; end if;

  -- El motivo se vacía en la fila; sigue en audit_log, que guarda la anterior.
  update stock_items
     set active = true, retired_at = null, retired_by = null, retired_reason = null
   where id = p_item;
end $$;

comment on function public.stock_item_restaurar(uuid) is
  'Devuelve al almacén un artículo retirado. Solo administrador.';

revoke all on function public.stock_item_restaurar(uuid) from public, anon;
grant execute on function public.stock_item_restaurar(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 4 — Renombrar un artículo sin que el Excel lo pierda de vista
-- -----------------------------------------------------------------------------

create or replace function public.stock_item_renombrar(p_item uuid, p_nombre text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nombre text := btrim(coalesce(p_nombre, ''));
  v_actual text;
  v_alias  text[];
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador renombra artículos del almacén'
      using errcode = 'insufficient_privilege';
  end if;
  if v_nombre = '' then
    raise exception 'El nombre no puede quedar vacío' using errcode = 'check_violation';
  end if;

  select name, aliases into v_actual, v_alias from stock_items where id = p_item for update;
  if v_actual is null then raise exception 'Ese artículo no existe'; end if;
  if v_actual = v_nombre then return; end if;

  -- El índice único sobre el nombre normalizado lo pararía igual, pero con un
  -- «duplicate key value violates unique constraint» que no dice qué artículo.
  if exists (
    select 1 from stock_items si
     where si.id <> p_item
       and public.norm_text(si.name) = public.norm_text(v_nombre)
  ) then
    raise exception 'Ya hay otro artículo que se llama «%»', v_nombre
      using errcode = 'unique_violation';
  end if;

  -- El nombre de hasta ahora se queda como alias: la hoja y los partes lo
  -- seguirán escribiendo así y `stock_item_id()` lo seguirá encontrando.
  if public.norm_text(v_actual) <> public.norm_text(v_nombre)
     and not exists (select 1 from unnest(v_alias) a where public.norm_text(a) = public.norm_text(v_actual)) then
    v_alias := array_append(v_alias, v_actual);
  end if;
  -- Y si el nombre nuevo era uno de los alias, deja de serlo: ya es el nombre.
  v_alias := array(
    select a from unnest(v_alias) a
     where public.norm_text(a) <> public.norm_text(v_nombre)
  );

  update stock_items set name = v_nombre, aliases = v_alias where id = p_item;
end $$;

comment on function public.stock_item_renombrar(uuid, text) is
  'Cambia el nombre de un artículo del almacén y deja el anterior como alias, para que el Excel y los partes lo sigan encontrando. Solo administrador.';

revoke all on function public.stock_item_renombrar(uuid, text) from public, anon;
grant execute on function public.stock_item_renombrar(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 5 — La baja de un ordenador de repuesto: administrador, y con motivo
--
-- Misma firma que hasta ahora, así que la pantalla la llama igual. Cambian
-- quién puede (era supervisor) y que la nota deja de ser opcional.
-- -----------------------------------------------------------------------------

create or replace function public.stock_unit_baja(p_unit uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_estado text;
  v_motivo text;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador da de baja ordenadores de repuesto'
      using errcode = 'insufficient_privilege';
  end if;
  v_motivo := public.motivo_obligatorio(p_note);

  select status into v_estado from stock_units where id = p_unit for update;
  if v_estado is null then raise exception 'Esa unidad no existe'; end if;
  -- Lo instalado no se toca desde el almacén: su sitio es el aula, y desde
  -- allí se pide la retirada con su destino.
  if v_estado = 'instalado' then
    raise exception 'Esa unidad está instalada en un aula: retírala desde el aula';
  end if;
  if v_estado = 'baja' then raise exception 'Esa unidad ya está de baja'; end if;

  update stock_units
     set status = 'baja', retired_at = now(), updated_at = now(),
         notes = concat_ws(' · ', notes, 'Baja: ' || v_motivo)
   where id = p_unit;
end $$;

comment on function public.stock_unit_baja(uuid, text) is
  'Da de baja un ordenador de repuesto que está en el almacén, con un motivo de al menos diez caracteres. Solo administrador; uno instalado en un aula se retira desde el aula.';

revoke all on function public.stock_unit_baja(uuid, text) from public, anon;
grant execute on function public.stock_unit_baja(uuid, text) to authenticated;

notify pgrst, 'reload schema';
