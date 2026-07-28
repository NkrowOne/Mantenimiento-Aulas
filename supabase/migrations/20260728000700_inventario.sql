-- =============================================================================
-- Inventario por elemento
--
-- Hasta aquí la revisión preguntaba por «Pantallas», una casilla que tapaba
-- tres objetos distintos. A partir de aquí pregunta por **cada elemento de la
-- sala**: Proyector, Pantalla, Pantalla 2. Es la diferencia entre saber que
-- «algo de las pantallas falla» y saber cuál.
--
-- Tres piezas nuevas:
--
--  1. `asset_types.confirmed`. El técnico puede crear un tipo que no existe sin
--     esperar a nadie —en un aula, sin cobertura, con el profesor esperando—.
--     Nace sin confirmar, se usa igual, y sale en naranja hasta que el
--     coordinador lo valida. Lo contrario, obligar a pedir permiso, acaba en
--     campos de texto libre y en las ocho grafías de SÍ/NO que trae el Excel.
--
--  2. Nombre normalizado único. «Micrófono», «microfono» y «MICROFONO» son el
--     mismo tipo, y la base lo impide de raíz. El cliente refuerza lo mismo
--     derivando el id del nombre normalizado (uuid v5), así dos técnicos sin
--     cobertura que creen «Pantalla nueva» generan **la misma fila**.
--
--  3. Fusión. Aun con todo lo anterior entrarán duplicados de verdad —«Cañón» y
--     «Proyector»—, que no son un problema de grafía sino de vocabulario. El
--     coordinador los fusiona y el histórico se conserva.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Normalización, la misma que aplica el cliente en `src/domain/normalize.ts`
-- -----------------------------------------------------------------------------

-- Se hace con `translate` y no con la extensión `unaccent` a propósito: en un
-- Postgres gestionado puede no estar disponible, y esto tiene que funcionar en
-- los dos escenarios de despliegue.
create or replace function public.norm_text(t text)
returns text
language sql
immutable
strict
parallel safe
as $$
  select btrim(regexp_replace(
    upper(translate(
      t,
      'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
      'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC'
    )),
    '\s+', ' ', 'g'
  ))
$$;

comment on function public.norm_text(text) is
  'Mayúsculas, sin tildes, espacios colapsados. Gemela de norm() en el cliente.';

-- -----------------------------------------------------------------------------
-- Catálogo de tipos
-- -----------------------------------------------------------------------------

alter table asset_types
  add column confirmed   boolean not null default false,
  add column aliases     text[]  not null default '{}',
  add column merged_into uuid    references asset_types(id),
  add column created_by  uuid    references profiles(id),
  add column created_at  timestamptz not null default now();

-- Lo que ya estaba viene del Excel del equipo: está validado por definición.
-- A partir de aquí el defecto es "sin confirmar", que es lo que hace falta para
-- lo que cree el técnico desde el aula.
update asset_types set confirmed = true;

-- La regla que impide los duplicados de grafía. Excluye los fusionados para que
-- fusionar libere el nombre en vez de bloquearlo para siempre.
create unique index asset_types_norm_idx
  on asset_types (public.norm_text(name))
  where merged_into is null;

comment on column asset_types.confirmed is
  'false = creado desde el aula, pendiente de que lo valide un coordinador. Se usa igual.';
comment on column asset_types.merged_into is
  'Lápida: el tipo se fusionó con otro. Se conserva para que un cliente viejo resuelva el nombre.';

-- -----------------------------------------------------------------------------
-- Elementos instalados
-- -----------------------------------------------------------------------------

-- El nombre con el que el elemento aparece en la revisión: «Pantalla 2», o
-- «Pantalla atril» si el técnico lo corrige. Va en el elemento y no en el tipo
-- porque es propio de esta sala.
alter table assets
  add column label      text,
  add column created_by uuid references profiles(id);

-- Dos «Pantalla 2» en la misma sala harían la revisión ilegible: no se sabría
-- cuál de las dos falla, que es justo el problema que esto viene a resolver.
-- Los retirados quedan fuera para poder reutilizar la etiqueta.
create unique index assets_room_label_idx
  on assets (room_id, public.norm_text(label))
  where room_id is not null and label is not null and status <> 'retirado';

-- -----------------------------------------------------------------------------
-- Catálogo base
--
-- Las seis categorías que salen de `rooms.capabilities`, más las que ya trae el
-- importador. `Pantalla` absorbe `TV`: es la palabra que usa el equipo.
-- -----------------------------------------------------------------------------

insert into asset_types (name, category, tracks_serial, tracks_lamp_hours, confirmed, aliases)
values
  ('Proyector',  'av', true,  true,  true, array['canon', 'cañón', 'video proyector']),
  ('Pantalla',   'av', true,  false, true, array['tv', 'televisor', 'monitor', 'display']),
  ('Altavoces',  'av', false, false, true, array['sonido', 'audio', 'bafles']),
  ('Micrófono',  'av', true,  false, true, array['micro', 'mic', 'jabra']),
  ('Cámara',     'av', true,  false, true, array['camara', 'webcam']),
  ('Botonera',   'av', false, false, true, array['control', 'panel', 'mando']),
  ('Ordenador',  'ti', true,  false, true, array['pc', 'equipo', 'cpu']),
  ('Atril',      'av', false, false, true, array[]::text[])
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Resolver un nombre al tipo vivo
--
-- Es el único sitio por el que se debe entrar al catálogo desde SQL. Resuelve
-- por nombre o por alias y **sigue las fusiones**, así que quien escribió `TV`
-- acaba en `Pantalla` sin enterarse.
--
-- Existe porque el importador tenía un fallo latente: calculaba el id del tipo
-- a partir del nombre y lo insertaba con `on conflict (name) do nothing`. Si el
-- tipo ya existía con otro id, el insert se saltaba en silencio y los equipos
-- quedaban apuntando a un id inexistente.
-- -----------------------------------------------------------------------------

create or replace function public.asset_type_id(p_name text)
returns uuid
language sql
stable
strict
parallel safe
as $$
  select coalesce(t.merged_into, t.id)
    from asset_types t
   where public.norm_text(t.name) = public.norm_text(p_name)
      or exists (
        select 1 from unnest(t.aliases) a
         where public.norm_text(a) = public.norm_text(p_name)
      )
   -- El nombre exacto gana al alias: si alguien registra un tipo llamado
   -- «Monitor», deja de resolverse como alias de «Pantalla».
   order by (public.norm_text(t.name) = public.norm_text(p_name)) desc,
            t.confirmed desc,
            t.created_at
   limit 1
$$;

-- -----------------------------------------------------------------------------
-- Operaciones del coordinador
--
-- Van como RPC y no como UPDATE directo porque cada una es varias escrituras
-- que tienen que pasar juntas o no pasar: fusionar mueve elementos, mueve
-- artículos de almacén, hereda alias y deja la lápida. A medias dejaría
-- inventario apuntando a un tipo que ya no se usa.
-- -----------------------------------------------------------------------------

create or replace function public.confirm_asset_type(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador confirma tipos de equipo';
  end if;
  update asset_types set confirmed = true where id = p_id;
end;
$$;

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
    raise exception 'Solo un coordinador corrige el nombre de un tipo';
  end if;

  select name into v_old from asset_types where id = p_id;
  if v_old is null then
    raise exception 'No existe ese tipo de equipo';
  end if;

  -- El nombre viejo se queda de alias: quien lo teclee mañana encuentra el tipo
  -- corregido en vez de crear otro.
  --
  -- Dos casos en los que NO se añade, y los dos importan:
  --  - La corrección era solo de tilde o mayúsculas. La búsqueda ya normaliza,
  --    así que el alias no aportaría nada y solo ensuciaría el catálogo.
  --  - La palabra ya es de otro tipo vivo. Añadirla aquí dejaría un alias que
  --    apunta a dos sitios, y quien lo escriba acabaría en uno u otro según el
  --    orden de creación. Un alias ambiguo es peor que no tener alias.
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
end;
$$;

create or replace function public.merge_asset_type(p_from uuid, p_into uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from_name text;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador fusiona tipos de equipo';
  end if;
  if p_from = p_into then
    raise exception 'No se puede fusionar un tipo consigo mismo';
  end if;

  select name into v_from_name from asset_types where id = p_from;
  if v_from_name is null then
    raise exception 'No existe el tipo de origen';
  end if;
  if not exists (select 1 from asset_types where id = p_into and merged_into is null) then
    raise exception 'El tipo de destino no existe o ya está fusionado';
  end if;

  update assets      set asset_type_id = p_into where asset_type_id = p_from;
  update stock_items set asset_type_id = p_into where asset_type_id = p_from;

  -- El destino hereda el nombre absorbido como alias, por lo mismo que en el
  -- renombrado: para que la palabra que alguien escribió siga encontrando algo.
  update asset_types
     set aliases = array(select distinct unnest(aliases || v_from_name || (select aliases from asset_types where id = p_from)))
   where id = p_into;

  update asset_types set merged_into = p_into where id = p_from;
end;
$$;

grant execute on function public.confirm_asset_type(uuid) to authenticated;
grant execute on function public.rename_asset_type(uuid, text) to authenticated;
grant execute on function public.merge_asset_type(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Permisos
--
-- El cambio de fondo: el técnico ya puede dar de alta tipos y elementos. Sin
-- esto, «crear desde el aula» no existe.
-- -----------------------------------------------------------------------------

-- Solo sin confirmar: nadie se auto-valida un tipo colándolo con confirmed=true.
create policy "personal propone tipos de equipo" on asset_types
  for insert to authenticated
  with check (public.is_staff() and confirmed = false);

create policy "supervisor gestiona tipos de equipo" on asset_types
  for update to authenticated
  using (public.is_supervisor()) with check (public.is_supervisor());

create policy "personal da de alta equipos" on assets
  for insert to authenticated
  with check (public.is_staff());

-- El técnico corrige la etiqueta y marca averiado, retirado o movido. Es el
-- trabajo del que vuelve del aula, y hacerle pedir permiso para eso significa
-- que la corrección no se hace nunca.
create policy "personal corrige equipos de la sala" on assets
  for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- -----------------------------------------------------------------------------
-- Relleno: convertir las capacidades en elementos reales
--
-- `rooms.capabilities` dice que la sala tiene proyector, pero no hay ninguna
-- fila que lo represente salvo que el Excel trajera número de serie. Sin este
-- paso, al pasar la revisión a elementos las salas se quedarían con una sola
-- comprobación y se perdería lo que hoy se revisa.
-- -----------------------------------------------------------------------------

-- `TV` la creó el importador; `Pantalla` es la palabra del equipo. Se fusionan
-- con la misma función que usará el coordinador, no con un apaño aparte.
do $$
declare
  v_tv uuid;
  v_pantalla uuid;
begin
  select id into v_tv       from asset_types where public.norm_text(name) = 'TV' and merged_into is null;
  select id into v_pantalla from asset_types where public.norm_text(name) = 'PANTALLA' and merged_into is null;

  if v_tv is not null and v_pantalla is not null then
    update assets      set asset_type_id = v_pantalla where asset_type_id = v_tv;
    update stock_items set asset_type_id = v_pantalla where asset_type_id = v_tv;
    update asset_types set aliases = array(select distinct unnest(aliases || 'TV')) where id = v_pantalla;
    update asset_types set merged_into = v_pantalla where id = v_tv;
  end if;
end;
$$;

-- Va como función y no como sentencia suelta por el orden de arranque: en una
-- instalación limpia las migraciones corren **antes** del seed, así que aquí
-- `rooms` está vacía y no habría nada que rellenar. Siendo función se llama en
-- los dos momentos —aquí, para una base que ya está en producción, y después de
-- cargar el seed, para una nueva— y como es idempotente volver a ejecutarla
-- también materializa los elementos de una sala que gane equipamiento mañana.
create or replace function public.backfill_room_assets()
returns integer
language plpgsql
as $$
declare
  v_inserted integer;
begin
  insert into assets (asset_type_id, room_id, status)
  select t.id, r.id, 'instalado'
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
     -- Solo si no existe ya: las salas cuyo Excel traía número de serie ya
     -- tienen su proyector dado de alta, y duplicarlo sería exactamente lo que
     -- este trabajo viene a evitar.
     and not exists (
       select 1 from assets a
        where a.room_id = r.id and a.asset_type_id = t.id and a.status <> 'retirado'
     );

  get diagnostics v_inserted = row_count;

  -- Etiquetas: el primero de cada tipo lleva el nombre del tipo, el segundo el
  -- nombre y un 2. Nadie teclea el número.
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

  return v_inserted;
end;
$$;

comment on function public.backfill_room_assets() is
  'Convierte rooms.capabilities en elementos de inventario. Idempotente: llámala tras cargar datos.';

select public.backfill_room_assets();
