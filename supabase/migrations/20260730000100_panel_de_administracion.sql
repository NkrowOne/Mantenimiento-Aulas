-- =============================================================================
-- El panel de administración: lo que el técnico propone y alguien decide
--
-- Hasta aquí el técnico podía dar de alta equipos y tipos desde el aula, que es
-- lo que hace que el inventario se apunte de verdad. Lo que faltaba era el otro
-- lado del trato: **alguien que lo confirme**. Sin él, «crear sobre la marcha»
-- no es un catálogo abierto, es un catálogo sin dueño.
--
-- Cuatro piezas, y las cuatro responden a lo mismo desde ángulos distintos:
--
--  1. `assets.confirmed`. El tipo ya se validaba; el **equipo concreto** no.
--     «Micrófono Jabra» puede estar perfectamente validado como tipo y aun así
--     ser mentira que haya uno en el aula 2.4. Ahora lo que se apunta desde el
--     aula entra marcado y sale marcado cuando alguien lo mira.
--
--  2. Equipamiento por defecto. Un aula nueva no nace vacía: nace con lo que
--     todas las aulas llevan. Se declara una vez —global, o por edificio cuando
--     un edificio se sale de la norma— y se materializa sola al crear la sala.
--     Lo contrario es escribir seis equipos a mano 276 veces, que no se hace.
--
--  3. Agrupar. Fusionar existía de uno en uno, y los duplicados no vienen de
--     uno en uno: llegan «Jabra», «Mic Jabra» y «Micro Jabra» la misma semana.
--     Agrupar es fusionar varios a la vez y ponerle al resultado el nombre
--     bueno — que se propaga a TODAS las salas, incluidas las etiquetas de cada
--     equipo, porque si en la sala sigue poniendo «Jabra» el renombrado no ha
--     servido de nada.
--
--  4. Altas y bajas del maestro. Salas y edificios se creaban ejecutando SQL
--     contra el servidor, y eso significa que en la práctica no se crean. Van
--     como RPC —no como INSERT suelto— porque una sala necesita zona, matrícula
--     y equipamiento, y una baja tiene que decidir entre borrar y archivar sin
--     dejar el histórico colgando.
--
-- Todo lo que decide va detrás de `is_admin()` o `is_supervisor()`. La RLS de
-- `buildings`, `zones` y `rooms` ya era «solo admin escribe»: aquí no se abre
-- nada, se le da una puerta a lo que ya estaba permitido.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0 — La etiqueta libre de una sala, en SQL
--
-- Gemela de `nextLabel()` en `src/domain/inventory.ts`, y por el mismo motivo
-- que `norm_text()` es gemela de `norm()`: el cliente la necesita para enseñar
-- el nombre antes de guardar, y el servidor para materializar equipamiento sin
-- chocar contra `assets_room_label_idx`.
--
-- Se cuenta sobre las etiquetas usadas y no sobre cuántos equipos hay: si
-- alguien retiró la «Pantalla 2» y quedan dos, el siguiente no puede volver a
-- llamarse «Pantalla 2».
-- -----------------------------------------------------------------------------

create or replace function public.next_asset_label(
  p_room   uuid,
  p_base   text,
  p_except uuid default null
)
returns text
language plpgsql
as $$
declare
  v_used text[];
  v_candidate text;
  n int;
begin
  select coalesce(array_agg(public.norm_text(label)), '{}')
    into v_used
    from assets
   where room_id = p_room
     and label is not null
     and status <> 'retirado'
     and (p_except is null or id <> p_except);

  if not (public.norm_text(p_base) = any(v_used)) then
    return btrim(p_base);
  end if;

  for n in 2..99 loop
    v_candidate := btrim(p_base) || ' ' || n;
    if not (public.norm_text(v_candidate) = any(v_used)) then
      return v_candidate;
    end if;
  end loop;

  return btrim(p_base) || ' ' || (coalesce(array_length(v_used, 1), 0) + 1);
end;
$$;

comment on function public.next_asset_label(uuid, text, uuid) is
  'La etiqueta libre que le toca a un equipo en esa sala. Gemela de nextLabel() en el cliente.';

-- -----------------------------------------------------------------------------
-- 1 — El equipo concreto, no solo su tipo
--
-- Lo que ya está viene del Excel y de `backfill_room_assets()`: está validado
-- por definición, igual que se hizo con los tipos. A partir de aquí el defecto
-- es «sin confirmar», que es lo que hace falta para lo que se apunta desde el
-- aula.
-- -----------------------------------------------------------------------------

alter table assets
  add column if not exists confirmed boolean not null default false;

-- Antes del disparador de más abajo, y no es casualidad: ese disparador impide
-- que quien no es coordinador mueva la columna, y una migración corre sin token
-- ninguno. Puesto después, este relleno se revertiría a sí mismo.
update assets set confirmed = true where confirmed = false;

comment on column assets.confirmed is
  'false = lo apuntó alguien desde el aula y nadie lo ha mirado todavía. Se usa igual.';

-- La bandeja del coordinador pregunta exactamente por esto. Sin índice son
-- barridos completos de las 1.094 filas cada vez que se abre el panel.
create index if not exists assets_pendientes_idx
  on assets (created_at desc)
  where confirmed = false and status <> 'retirado';

-- Nadie se auto-valida un equipo colándolo con `confirmed = true`, igual que ya
-- pasaba con los tipos.
drop policy if exists "personal da de alta equipos" on assets;
create policy "personal da de alta equipos" on assets
  for insert to authenticated
  with check (public.is_staff() and (confirmed = false or public.is_supervisor()));

/*
 * Y la misma puerta por el otro lado.
 *
 * La política de UPDATE tiene que seguir dejando que un técnico corrija la
 * etiqueta, el modelo y el número de serie de un equipo YA confirmado —es el
 * trabajo del que vuelve del aula, y pedirle permiso para eso significa que la
 * corrección no se hace nunca—. Así que no se puede cerrar con un `with check`
 * sobre `confirmed`: bloquearía la corrección legítima.
 *
 * Lo que sí se puede es que el valor no se mueva. Quien no sea coordinador
 * escribe lo que quiera en la columna y la fila se guarda con el valor que ya
 * tenía.
 *
 * `auth_role() <> 'none'` es la puerta de servicio, y sin ella esto se muerde
 * la cola: una sesión de `psql` —una migración, el importador, el relleno que
 * valida lo que carga una máquina— no lleva ningún token, así que tampoco es
 * coordinadora, y el disparador le revertía sus propias escrituras. Quien entra
 * sin claims ya tiene la llave de la base entera; a quien hay que frenar es al
 * técnico autenticado, que sí trae rol.
 */
create or replace function public.assets_confirmed_guard()
returns trigger
language plpgsql
as $$
begin
  if new.confirmed is distinct from old.confirmed
     and public.auth_role() <> 'none'
     and not public.is_supervisor()
  then
    new.confirmed := old.confirmed;
  end if;
  return new;
end;
$$;

drop trigger if exists assets_confirmed_guard on assets;
create trigger assets_confirmed_guard
  before update on assets
  for each row execute function public.assets_confirmed_guard();

create or replace function public.confirm_assets(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador confirma equipos'
      using errcode = 'insufficient_privilege';
  end if;

  update assets set confirmed = true
   where id = any(p_ids) and confirmed = false;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

comment on function public.confirm_assets(uuid[]) is
  'Valida equipos apuntados desde el aula. Devuelve cuántos ha tocado.';

-- `backfill_room_assets()` materializa el equipamiento que describe
-- `rooms.capabilities`: eso es maestro, no la propuesta de nadie, así que nace
-- confirmado. Sin esto, ejecutarla dejaría cientos de equipos en la bandeja del
-- coordinador el día que alguien cargue datos. El resto de la función es la de
-- `20260728000700_inventario.sql` sin un cambio.
create or replace function public.backfill_room_assets()
returns integer
language plpgsql
as $$
declare
  v_inserted integer;
begin
  insert into assets (asset_type_id, room_id, status, confirmed)
  select t.id, r.id, 'instalado', true
    from rooms r
    cross join lateral (
      values
        ('proyector', 'Proyector'),
        ('tv',        'Pantalla'),
        ('altavoces', 'Altavoces'),
        ('microfono', 'Micrófono'),
        ('camara',    'Cámara'),
        ('botonera',  'Botonera')
    ) as cap(key, type_name)
    join asset_types t on t.id = public.asset_type_id(cap.type_name)
   where (r.capabilities ->> cap.key)::boolean is true
     and not exists (
       select 1 from assets a
        where a.room_id = r.id and a.asset_type_id = t.id and a.status <> 'retirado'
     );

  get diagnostics v_inserted = row_count;

  with numbered as (
    select a.id,
           t.name,
           row_number() over (
             partition by a.room_id, a.asset_type_id order by a.created_at, a.id
           ) as n
      from assets a
      join asset_types t on t.id = a.asset_type_id
     where a.label is null and a.room_id is not null
  )
  update assets a
     set label = case when n.n = 1 then n.name else n.name || ' ' || n.n end
    from numbered n
   where a.id = n.id;

  -- Y lo que acabe de entrar por el importador o por el seed queda validado.
  --
  -- En una instalación limpia las migraciones corren ANTES que el seed, así que
  -- el relleno de `confirmed` de más arriba no llega a ver esas filas: entran
  -- después y con el defecto, o sea sin confirmar. Sin esta línea, un despliegue
  -- nuevo estrena la bandeja del coordinador con los 1.094 equipos del Excel
  -- dentro, que es la mejor forma de que nadie la mire nunca.
  --
  -- `created_by is null` es la frontera, la misma que usa `room_timeline`: lo
  -- que carga una máquina no es la propuesta de nadie que haya estado en el
  -- aula. Lo que apunta una persona sí, y ese conserva su marca.
  update assets set confirmed = true where created_by is null and not confirmed;

  return v_inserted;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2 — El equipamiento que toda sala lleva
--
-- `building_id is null` es el ámbito global: vale para todas las salas. Con
-- edificio, vale solo para el suyo Y MANDA sobre el global, que es lo que
-- permite decir «en todas partes un proyector; en el EPS, dos» sin repetir la
-- lista entera por edificio.
--
-- Dos índices únicos parciales en vez de uno con `nulls not distinct`: hacen lo
-- mismo y no dependen de la versión del servidor, que aquí puede ser el
-- Postgres del contenedor o uno gestionado.
-- -----------------------------------------------------------------------------

create table if not exists asset_defaults (
  id            uuid primary key default gen_random_uuid(),
  asset_type_id uuid not null references asset_types(id) on delete cascade,
  -- Nulo = global. Con valor = solo ese edificio, y pisa al global.
  building_id   uuid references buildings(id) on delete cascade,
  qty           int not null default 1 check (qty between 1 and 20),
  created_at    timestamptz not null default now(),
  created_by    uuid references profiles(id)
);

comment on table asset_defaults is
  'Qué equipos lleva una sala por defecto. Sin edificio = todas; con edificio, manda sobre el global.';

create unique index if not exists asset_defaults_global_idx
  on asset_defaults (asset_type_id) where building_id is null;
create unique index if not exists asset_defaults_building_idx
  on asset_defaults (asset_type_id, building_id) where building_id is not null;

alter table asset_defaults enable row level security;

-- Lee todo el personal: el cliente lo espeja para poder decir, dentro del aula
-- y sin cobertura, qué debería haber aquí y no está.
create policy "personal lee equipamiento por defecto" on asset_defaults
  for select to authenticated using (public.is_staff());

create policy "admin gestiona equipamiento por defecto" on asset_defaults
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Decide qué se materializa en 276 aulas. Igual que el catálogo, no puede ser
-- el único sitio del sistema donde una decisión así no deje autor.
drop trigger if exists asset_defaults_audit on asset_defaults;
create trigger asset_defaults_audit
  after insert or update or delete on asset_defaults
  for each row execute function public.audit_trigger();

/**
 * Declarar un defecto: si ya estaba, corrige la cantidad.
 *
 * Va como función y no como `upsert` desde el cliente porque el ámbito lo
 * garantizan dos índices únicos PARCIALES —uno para el global, otro por
 * edificio— y `on conflict` no sabe inferir un índice parcial. Sin esto, la
 * segunda vez que alguien declara «Proyector, en todas las salas» recibe un
 * error de clave duplicada, cuando lo que quiere decir es «cámbiame la
 * cantidad».
 */
create or replace function public.set_asset_default(
  p_type     uuid,
  p_building uuid,
  p_qty      int
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador declara el equipamiento por defecto'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from asset_types where id = p_type and merged_into is null) then
    raise exception 'Ese tipo de equipo no existe o está fusionado con otro';
  end if;

  update asset_defaults
     set qty = p_qty, created_by = (select auth.uid()), created_at = now()
   where asset_type_id = p_type
     and building_id is not distinct from p_building
  returning id into v_id;

  if v_id is null then
    insert into asset_defaults (asset_type_id, building_id, qty, created_by)
    values (p_type, p_building, p_qty, (select auth.uid()))
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

/**
 * Materializa el equipamiento por defecto que falte.
 *
 * Idempotente y por defecto: solo añade lo que falta para llegar a la cantidad
 * declarada, y nunca quita nada. Un aula que tenga tres pantallas donde el
 * defecto dice una se queda con sus tres — el defecto es un mínimo que se
 * garantiza, no una plantilla que se impone. Lo contrario borraría inventario
 * real por una declaración escrita en un despacho.
 *
 * Los equipos nacen `confirmed = true` y con `created_by` nulo, como los del
 * importador y por la misma razón: no son la propuesta de nadie que haya estado
 * en el aula, son maestro materializado. Y con autor entrarían en
 * `room_timeline` —que filtra justo por `created_by is not null`— llenando el
 * histórico de 276 salas de altas idénticas con la fecha del día que alguien
 * pulsó el botón, por delante de las incidencias reales.
 *
 * Sin comprobación de permisos a propósito: la llama el disparador de alta de
 * sala, y una sala la crea también el importador desde `psql`, donde no hay
 * ningún JWT y `is_admin()` es falso. La puerta con permisos es
 * `apply_asset_defaults`, y es la única que se publica.
 */
create or replace function public.materializar_defaults(
  p_building uuid default null,
  p_room     uuid default null
)
returns integer
language plpgsql
as $$
declare
  d record;
  v_faltan int;
  v_total int := 0;
  i int;
begin
  for d in
    -- Un defecto por sala y tipo: el del edificio gana al global, y el tipo se
    -- resuelve siguiendo las fusiones para no materializar una lápida.
    select distinct on (r.id, coalesce(t.merged_into, t.id))
           r.id as room_id,
           coalesce(t.merged_into, t.id) as type_id,
           def.qty
      from rooms r
      join zones z           on z.id = r.zone_id
      join asset_defaults def on (def.building_id is null or def.building_id = z.building_id)
      join asset_types t     on t.id = def.asset_type_id
     where r.active
       and (p_room is null or r.id = p_room)
       and (p_building is null or z.building_id = p_building)
     order by r.id, coalesce(t.merged_into, t.id), (def.building_id is not null) desc
  loop
    select d.qty - count(*)
      into v_faltan
      from assets a
     where a.room_id = d.room_id
       and a.asset_type_id = d.type_id
       and a.status <> 'retirado';

    for i in 1..greatest(v_faltan, 0) loop
      insert into assets (asset_type_id, room_id, label, status, confirmed)
      select d.type_id,
             d.room_id,
             public.next_asset_label(d.room_id, t.name),
             'instalado',
             true
        from asset_types t
       where t.id = d.type_id;

      v_total := v_total + 1;
    end loop;
  end loop;

  return v_total;
end;
$$;

revoke execute on function public.materializar_defaults(uuid, uuid) from public, anon, authenticated;

create or replace function public.apply_asset_defaults(
  p_building uuid default null,
  p_room     uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador aplica el equipamiento por defecto'
      using errcode = 'insufficient_privilege';
  end if;
  return public.materializar_defaults(p_building, p_room);
end;
$$;

comment on function public.apply_asset_defaults(uuid, uuid) is
  'Añade a las salas el equipamiento por defecto que les falte. Devuelve cuántos equipos ha creado.';

-- Una sala nueva nace con lo que su edificio lleva. Es el caso que justifica
-- toda la pieza: sin esto, el defecto sería una lista que hay que acordarse de
-- aplicar, y acordarse no es un mecanismo.
create or replace function public.aplicar_defaults_a_sala_nueva()
returns trigger
language plpgsql
as $$
begin
  perform public.materializar_defaults(p_room => new.id);
  return null;
end;
$$;

drop trigger if exists rooms_defaults on rooms;
create trigger rooms_defaults
  after insert on rooms
  for each row execute function public.aplicar_defaults_a_sala_nueva();

-- -----------------------------------------------------------------------------
-- 3 — Renombrar de verdad: el tipo Y lo que pone en cada sala
--
-- Cambiar `asset_types.name` renombra el tipo en el catálogo y en ningún sitio
-- más. Los equipos llevan su propia etiqueta —«Cañón», «Cañón 2»— porque es
-- propia de esa sala, y esa etiqueta nació copiando el nombre del tipo. Si el
-- coordinador corrige «Cañón» a «Proyector» y en las cuarenta aulas sigue
-- poniendo «Cañón», el renombrado no ha llegado a donde se lee.
--
-- Se renombran solo las etiquetas que son el nombre viejo, tal cual o con su
-- número detrás. Una etiqueta que alguien escribió a mano —«Pantalla atril»—
-- vale más que el nombre del tipo y no se toca: es lo que sabe el que estuvo
-- delante.
--
-- Y cada una se recoloca con `next_asset_label`, no con un `replace` a lo
-- bruto: en una sala que ya tuviera un «Proyector» propio, renombrar el «Cañón»
-- a «Proyector» chocaría contra el índice único y la operación entera se caería
-- por una sola sala.
-- -----------------------------------------------------------------------------

create or replace function public.relabel_assets_of_type(
  p_type uuid,
  p_old  text,
  p_new  text
)
returns integer
language plpgsql
as $$
declare
  a record;
  v_old text := public.norm_text(p_old);
  v_n integer := 0;
begin
  if v_old = '' or v_old = public.norm_text(p_new) then
    return 0;
  end if;

  for a in
    select id, room_id
      from assets
     where asset_type_id = p_type
       and room_id is not null
       and label is not null
       and status <> 'retirado'
       and (
         public.norm_text(label) = v_old
         or (
           starts_with(public.norm_text(label), v_old || ' ')
           and substr(public.norm_text(label), length(v_old) + 2) ~ '^[0-9]+$'
         )
       )
     order by created_at, id
  loop
    update assets
       set label = public.next_asset_label(a.room_id, p_new, a.id)
     where id = a.id;
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

comment on function public.relabel_assets_of_type(uuid, text, text) is
  'Propaga el nombre nuevo de un tipo a las etiquetas que lo copiaban. Respeta las escritas a mano.';

-- Renombrar pasa a ser global de verdad. El resto de la función es la de
-- `20260728000700_inventario.sql` sin un cambio: el nombre viejo se queda de
-- alias salvo que fuera solo cuestión de tildes o que ya sea de otro tipo vivo.
create or replace function public.rename_asset_type(p_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador corrige el nombre de un tipo'
      using errcode = 'insufficient_privilege';
  end if;

  select name into v_old from asset_types where id = p_id;
  if v_old is null then
    raise exception 'No existe ese tipo de equipo';
  end if;
  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'El nombre no puede quedar vacío';
  end if;

  update asset_types
     set name = btrim(p_name),
         aliases = case
           when public.norm_text(v_old) = public.norm_text(p_name) then aliases
           -- Se pregunta por OTRO tipo explícitamente. Resolver el nombre sin
           -- más devolvería este mismo, que todavía se llama así.
           when exists (
             select 1 from asset_types o
              where o.id <> p_id
                and o.merged_into is null
                and (
                  public.norm_text(o.name) = public.norm_text(v_old)
                  or exists (
                    select 1 from unnest(o.aliases) a
                     where public.norm_text(a) = public.norm_text(v_old)
                  )
                )
           ) then aliases
           else array(select distinct unnest(aliases || v_old))
         end,
         confirmed = true
   where id = p_id;

  perform public.relabel_assets_of_type(p_id, v_old, btrim(p_name));
end;
$$;

-- Fusionar mueve los equipos al tipo bueno; ahora también les pone el nombre
-- del tipo bueno, y se lleva consigo el equipamiento por defecto del absorbido.
create or replace function public.merge_asset_type(p_from uuid, p_into uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from_name text;
  v_into_name text;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador fusiona tipos de equipo'
      using errcode = 'insufficient_privilege';
  end if;
  if p_from = p_into then
    raise exception 'No se puede fusionar un tipo consigo mismo';
  end if;

  select name into v_from_name from asset_types where id = p_from;
  if v_from_name is null then
    raise exception 'No existe el tipo de origen';
  end if;
  select name into v_into_name from asset_types where id = p_into and merged_into is null;
  if v_into_name is null then
    raise exception 'El tipo de destino no existe o ya está fusionado';
  end if;

  update assets      set asset_type_id = p_into where asset_type_id = p_from;
  update stock_items set asset_type_id = p_into where asset_type_id = p_from;

  -- El equipamiento por defecto viaja igual que los equipos. Si el destino ya
  -- tenía uno en el mismo ámbito, el del absorbido sobra: dos filas para el
  -- mismo tipo y el mismo edificio no caben —hay índice único— y la que manda
  -- es la que ya estaba.
  delete from asset_defaults d
   where d.asset_type_id = p_from
     and exists (
       select 1 from asset_defaults o
        where o.asset_type_id = p_into
          and o.building_id is not distinct from d.building_id
     );
  update asset_defaults set asset_type_id = p_into where asset_type_id = p_from;

  -- El destino hereda el nombre absorbido como alias, por lo mismo que en el
  -- renombrado: para que la palabra que alguien escribió siga encontrando algo.
  update asset_types
     set aliases = array(select distinct unnest(
           aliases || v_from_name || (select aliases from asset_types where id = p_from)))
   where id = p_into;

  update asset_types set merged_into = p_into where id = p_from;

  -- Y lo que en la sala ponía «Cañón» pasa a poner «Proyector».
  perform public.relabel_assets_of_type(p_into, v_from_name, v_into_name);
end;
$$;

/**
 * Agrupar: fusionar varios de golpe y ponerle al resultado el nombre bueno.
 *
 * Es la operación real del coordinador, y no es la suma de tres fusiones
 * sueltas por un motivo de orden: el destino suele ser uno de los propios
 * seleccionados —los tres son propuestas y ninguno es «el del catálogo»— y
 * hacerlo a mano obliga a acertar cuál sobrevive antes de poder renombrarlo.
 *
 * Con `p_name`, el superviviente se renombra AL FINAL, cuando ya tiene dentro
 * todos los equipos: así el renombrado de etiquetas alcanza también a los que
 * acaban de llegar de los tipos absorbidos.
 */
create or replace function public.group_asset_types(
  p_ids  uuid[],
  p_into uuid,
  p_name text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_n integer := 0;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador agrupa tipos de equipo'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from asset_types where id = p_into and merged_into is null) then
    raise exception 'El tipo de destino no existe o ya está fusionado';
  end if;

  foreach v_id in array coalesce(p_ids, '{}'::uuid[]) loop
    if v_id <> p_into and exists (
      select 1 from asset_types where id = v_id and merged_into is null
    ) then
      perform public.merge_asset_type(v_id, p_into);
      v_n := v_n + 1;
    end if;
  end loop;

  if p_name is not null and btrim(p_name) <> '' then
    perform public.rename_asset_type(p_into, p_name);
  else
    -- Agrupar es un acto de coordinador: lo que sobrevive queda validado
    -- aunque no se le cambie el nombre.
    update asset_types set confirmed = true where id = p_into;
  end if;

  return v_n;
end;
$$;

comment on function public.group_asset_types(uuid[], uuid, text) is
  'Fusiona varios tipos en uno y le pone el nombre bueno. Devuelve cuántos ha absorbido.';

-- -----------------------------------------------------------------------------
-- 4 — Altas y bajas del maestro
--
-- Van como RPC y no como INSERT porque ninguna de las dos es una fila:
--
--  - Una sala necesita zona. Y la zona es del edificio, se llama «1ª PLANTA» y
--    puede existir o no. Pedirle al panel que resuelva eso a mano acabaría en
--    «1 PLANTA», «1ª planta» y «Planta 1» como tres plantas distintas.
--  - Una baja tiene que elegir entre borrar y archivar, y esa decisión depende
--    de si hay histórico colgando. `inspections.room_id` es `on delete
--    restrict`: sin esto, borrar una sala revisada devuelve un error de clave
--    ajena que nadie sabe leer desde un iPad.
-- -----------------------------------------------------------------------------

create or replace function public.create_building(p_code text, p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_name text := btrim(coalesce(p_name, ''));
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador da de alta edificios'
      using errcode = 'insufficient_privilege';
  end if;
  if v_code = '' or v_name = '' then
    raise exception 'El edificio necesita código y nombre';
  end if;
  if exists (select 1 from buildings where upper(code) = v_code) then
    raise exception 'Ya existe un edificio con el código %', v_code;
  end if;

  -- Al final de la lista, y con hueco: el orden de la pantalla de edificios se
  -- retoca a mano y dejar saltos de diez evita tener que renumerar los 23.
  insert into buildings (code, name, sort_order, needs_review)
  select v_code, v_name, coalesce(max(sort_order), 0) + 10, false from buildings
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.create_room(
  p_building uuid,
  p_zone     text,
  p_code     text,
  p_name     text,
  p_kind     room_kind default 'aula'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_zone uuid;
  v_room uuid;
  v_zone_name text := btrim(coalesce(p_zone, ''));
  v_code text := btrim(coalesce(p_code, ''));
  v_name text := btrim(coalesce(p_name, ''));
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador da de alta salas'
      using errcode = 'insufficient_privilege';
  end if;
  if v_code = '' then
    raise exception 'La sala necesita un código';
  end if;
  if not exists (select 1 from buildings where id = p_building) then
    raise exception 'Ese edificio no existe';
  end if;
  if v_zone_name = '' then
    v_zone_name := 'SIN ZONA';
  end if;
  -- El nombre descriptivo es opcional: en la hoja de estado la mayoría de las
  -- aulas se llaman como su código, y repetirlo a mano solo produce erratas.
  if v_name = '' then
    v_name := v_code;
  end if;

  -- La zona se busca normalizada y se crea si no está. Es lo que impide que
  -- «1ª PLANTA» y «1ª Planta» acaben siendo dos plantas del mismo edificio.
  select id into v_zone
    from zones
   where building_id = p_building
     and public.norm_text(name) = public.norm_text(v_zone_name);

  if v_zone is null then
    insert into zones (building_id, name, sort_order)
    select p_building, v_zone_name, coalesce(max(sort_order), 0) + 10
      from zones where building_id = p_building
    returning id into v_zone;
  end if;

  if exists (select 1 from rooms where zone_id = v_zone and code = v_code) then
    raise exception 'Ya hay una sala % en esa planta', v_code;
  end if;

  -- La matrícula la pone `rooms_matricula` y el equipamiento `rooms_defaults`:
  -- los dos son disparadores, así que una sala creada por cualquier otro camino
  -- —el importador, un script— sale igual de completa que esta.
  insert into rooms (zone_id, code, name, kind)
  values (v_zone, v_code, v_name, p_kind)
  returning id into v_room;

  return v_room;
end;
$$;

/**
 * La baja de una sala: borrar si no ha pasado nada, archivar si sí.
 *
 * Archivar es `active = false`, y eso la saca de `room_overview` —o sea, de la
 * lista de trabajo, del buscador y de la descarga al dispositivo— conservando
 * entero lo que se revisó allí. Borrarla de verdad solo se puede cuando no hay
 * nada que conservar, y entonces se lleva por delante el equipamiento que le
 * materializó el defecto, que es lo único que tenía dentro.
 */
create or replace function public.delete_room(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hist boolean;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador da de baja salas'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from rooms where id = p_id) then
    raise exception 'Esa sala no existe';
  end if;

  select exists (select 1 from inspections      where room_id = p_id)
      or exists (select 1 from incidents        where room_id = p_id)
      or exists (select 1 from room_inventories where room_id = p_id)
      or exists (select 1 from stock_movements  where room_id = p_id)
    into v_hist;

  if v_hist then
    update rooms set active = false where id = p_id;
    return 'archivada';
  end if;

  -- Sin histórico, los equipos de la sala son los que le puso el defecto o los
  -- que alguien apuntó y nadie ha tocado. Los que sí tienen vida propia —un
  -- traslado, una avería registrada— se quedan sin sala, que es lo que hace el
  -- `on delete set null` de la clave ajena, y salen como equipo sin ubicar.
  delete from assets a
   where a.room_id = p_id
     and not exists (select 1 from asset_events e where e.asset_id = a.id)
     and not exists (select 1 from incidents i where i.asset_id = a.id);

  delete from rooms where id = p_id;
  return 'borrada';
end;
$$;

comment on function public.delete_room(uuid) is
  'Da de baja una sala. Devuelve «borrada» o «archivada» según tuviera histórico.';

create or replace function public.restore_room(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador reactiva salas'
      using errcode = 'insufficient_privilege';
  end if;
  update rooms set active = true where id = p_id;
end;
$$;

/**
 * La baja de un edificio.
 *
 * No hay archivado: `buildings` no tiene `active`, y añadírselo obligaría a
 * tocar `room_overview` y las tres vistas de alertas que cuelgan de ella. Un
 * edificio con salas no se borra — o se vacía sala a sala, y ahí cada una
 * decide si se archiva, o se fusiona con el edificio bueno, que es lo que
 * `merge_building` ya hace y es la respuesta correcta para el caso frecuente:
 * el duplicado.
 */
create or replace function public.delete_building(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rooms int;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador da de baja edificios'
      using errcode = 'insufficient_privilege';
  end if;

  select count(*) into v_rooms
    from rooms r join zones z on z.id = r.zone_id
   where z.building_id = p_id;

  if v_rooms > 0 then
    raise exception 'El edificio todavía tiene % sala(s). Dalas de baja o fusiónalo con otro.', v_rooms;
  end if;

  delete from zones where building_id = p_id;
  delete from buildings where id = p_id;
end;
$$;

-- La bandeja del panel pregunta por las salas archivadas, que `room_overview`
-- ya no enseña —filtra por `r.active`— y son justo las que hay que poder
-- devolver a la vida.
create or replace view archived_rooms as
select r.id   as room_id,
       r.code as room_code,
       r.name as room_name,
       r.short_ref,
       z.name as zone_name,
       b.id   as building_id,
       b.code as building_code,
       b.name as building_name
from rooms r
join zones z     on z.id = r.zone_id
join buildings b on b.id = z.building_id
where not r.active;

-- Igual que las demás: sin esto la vista corre con los privilegios de su
-- propietario y se salta la RLS de las tablas de debajo.
alter view archived_rooms set (security_invoker = on);

grant execute on function public.confirm_assets(uuid[])                to authenticated;
grant execute on function public.group_asset_types(uuid[], uuid, text) to authenticated;
grant execute on function public.apply_asset_defaults(uuid, uuid)      to authenticated;
grant execute on function public.set_asset_default(uuid, uuid, int)    to authenticated;
grant execute on function public.next_asset_label(uuid, text, uuid)    to authenticated;
grant execute on function public.create_building(text, text)           to authenticated;
grant execute on function public.delete_building(uuid)                 to authenticated;
grant execute on function public.create_room(uuid, text, text, text, room_kind) to authenticated;
grant execute on function public.delete_room(uuid)                     to authenticated;
grant execute on function public.restore_room(uuid)                    to authenticated;

-- `relabel_assets_of_type` no la llama nadie desde la aplicación: es la mitad
-- interna de renombrar y fusionar, y las dos ya comprueban el rol.
revoke execute on function public.relabel_assets_of_type(uuid, text, text)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
