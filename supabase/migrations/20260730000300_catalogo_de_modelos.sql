-- =============================================================================
-- Marca y modelo: un «Ordenador» deja de ser un ordenador
--
-- El inventario sabía QUÉ CLASE de aparato hay en cada aula —Proyector,
-- Pantalla, Ordenador— y para el modelo tenía una casilla de texto libre. Con
-- eso, el aula 2.4 y el aula 3.1 tienen las dos «un ordenador», y la pregunta
-- que de verdad se hace todos los días —«¿cuántos ASPEN 223 nos quedan?, ¿el
-- Lenovo U3302 es el que da problemas con la docking?»— no se puede contestar.
--
-- Y el texto libre se degrada solo. Estas cinco filas son el mismo aparato:
--
--     Lenovo U3302   ·   lenovo u3302   ·   LENOVO-U3302
--     U3302 Lenovo   ·   Lenovo  U3302
--
-- No es un problema de disciplina, es el mismo que ya resolvió el catálogo de
-- tipos: si escribir es libre, se escribe distinto. La solución es la misma y
-- por eso encaja sin inventar nada nuevo — un catálogo, con id derivado del
-- nombre, índice único normalizado, alias, fusión y lápida.
--
-- LO QUE CAMBIA, DICHO EN UNA LÍNEA
--
--     tipo (Ordenador)  +  modelo (Lenovo · U3302)  +  nº de serie
--     ─────────────────    ────────────────────────    ─────────────
--     qué clase de cosa    exactamente cuál            cuál de ellas
--
-- Los tres niveles hacen falta y ninguno sobra: el tipo ordena la revisión, el
-- modelo agrupa para comprar y para diagnosticar, y el número de serie
-- identifica el aparato concreto que se lleva su historia consigo cuando lo
-- cambian de aula.
--
-- LA FECHA DE INSTALACIÓN
--
-- No se pide: se pone sola. `created_at` no servía —lo escribe el servidor al
-- recibir la fila, así que un levantamiento de inventario de aparatos que llevan
-- seis años puestos los fecharía todos el día del levantamiento— y además no
-- viajaba en el envío. Ahora hay `installed_at`, la escribe el dispositivo con
-- su reloj (igual que `occurred_at` en todo lo demás del proyecto, que es lo que
-- hace que funcione sin cobertura) y un disparador la rellena si no viene y la
-- refresca cuando un equipo cambia de sala.
--
-- Y NO SE RELLENA HACIA ATRÁS A LO TONTO
--
-- Los 1.094 equipos que entraron con la importación comparten la fecha del
-- despliegue. Ponerla como fecha de instalación sería inventarse un dato con
-- pinta de cierto — «instalado el 28/07/2026» para un proyector de 2019—, y un
-- dato falso en un inventario es peor que un hueco. Se rellena solo lo que
-- apuntó una persona (`created_by is not null`), que es la misma frontera que ya
-- usa `room_timeline`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0 — uuid v5 en SQL, gemelo del que usa el cliente
--
-- Es la pieza que hace que el catálogo funcione sin cobertura sin duplicarse.
-- El id de un modelo NO es aleatorio: sale de (tipo, marca, modelo), así que dos
-- técnicos que en dos aulas distintas y sin línea registren el mismo «Epson
-- EB-2250U» generan **literalmente la misma fila**, y al sincronizar convergen
-- en vez de chocar.
--
-- El cliente ya lo hacía para los tipos con `uuidv5` (`src/domain/inventory.ts`).
-- Lo que faltaba era poder calcular el MISMO id desde SQL, que es lo que
-- necesitan el relleno y el importador: si el servidor generase ids aleatorios,
-- el primer modelo creado desde un aula chocaría contra el índice único y se
-- quedaría rechazado en la cola, lejos de quien lo escribió.
--
-- `search_path` incluye `extensions` porque pgcrypto puede estar en `public` o
-- en `extensions` según por dónde se desplegara esto, y `digest()` es suya.
-- -----------------------------------------------------------------------------

create or replace function public.uuid_v5(p_namespace uuid, p_name text)
returns uuid
language plpgsql
immutable
strict
set search_path = public, extensions
as $$
declare
  v bytea;
begin
  v := substring(
         digest(
           decode(replace(p_namespace::text, '-', ''), 'hex') || convert_to(p_name, 'UTF8'),
           'sha1'
         ) from 1 for 16
       );
  -- Versión 5 en el nibble alto del séptimo byte, y la variante RFC 4122 en los
  -- dos bits altos del noveno. Sin esto el uuid es un hash con formato de uuid,
  -- y `uuid.v5()` del cliente daría otro.
  v := set_byte(v, 6, (get_byte(v, 6) & 15) | 80);
  v := set_byte(v, 8, (get_byte(v, 8) & 63) | 128);
  return encode(v, 'hex')::uuid;
end;
$$;

comment on function public.uuid_v5(uuid, text) is
  'uuid v5 (SHA-1), gemelo de uuidv5() del cliente. Es lo que hace converger dos altas offline del mismo modelo.';

-- El mismo espacio de nombres que usa `src/domain/inventory.ts`. Arbitrario,
-- pero **fijo para siempre**: cambiarlo duplicaría el catálogo entero.
create or replace function public.asset_model_id(p_type uuid, p_brand text, p_model text)
returns uuid
language sql
immutable
set search_path = public
as $$
  select public.uuid_v5(
    'f1c0f1d2-6a52-5a3b-9c2e-2f6f0b7d4a11'::uuid,
    p_type::text || '|' || public.norm_text(coalesce(p_brand, '')) || '|' || public.norm_text(coalesce(p_model, ''))
  )
$$;

-- -----------------------------------------------------------------------------
-- 1 — El catálogo de modelos
--
-- Mismas piezas que el catálogo de tipos, y no por simetría: cada una resuelve
-- un problema que ya se vio ocurrir con los tipos.
--
--   · `aliases`   — lo que la gente escribe de verdad: «u3302», «aspen223».
--   · `merged_into` — la lápida de una fusión. «ASPEN 223» y «Aspen-223» no son
--     un problema de grafía sino de vocabulario, y el índice único no los ve.
--   · `confirmed`  — un técnico puede crear el modelo desde el aula sin esperar
--     a nadie. Sale marcado hasta que un coordinador lo valida.
--   · `active`     — un modelo descatalogado no se borra: hay equipos que lo
--     llevan y su historia lo menciona. Deja de ofrecerse y ya está.
--   · `specs`      — lo que cada centro quiera guardar de cada modelo. Es la
--     parte modular: los campos los define el TIPO (ver más abajo), no el
--     código, así que añadir «Resolución» a los proyectores no es un despliegue.
-- -----------------------------------------------------------------------------

create table if not exists asset_models (
  id            uuid primary key,
  asset_type_id uuid not null references asset_types(id),

  -- Vacía y no nula: hay aparatos sin marca legible, y un `null` obligaría a
  -- tratar el caso en cada `coalesce` y en cada índice. La interfaz enseña
  -- «Sin marca» cuando está vacía.
  brand         text not null default '',
  model         text not null,

  aliases       text[] not null default '{}',
  specs         jsonb  not null default '{}'::jsonb,
  notes         text,

  /* Fin de soporte del fabricante. Es la columna que convierte el inventario en
     una herramienta de planificación: «qué hay que cambiar el curso que viene»
     deja de ser una conversación y pasa a ser una consulta. */
  eol_on        date,

  confirmed     boolean not null default false,
  active        boolean not null default true,
  merged_into   uuid references asset_models(id),
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now()
);

comment on table asset_models is
  'Marca y modelo concretos de un tipo de equipo: «Ordenador» → «Lenovo U3302».';

-- La regla que impide los duplicados de grafía, gemela de `asset_types_norm_idx`.
-- Excluye los fusionados para que fusionar libere el nombre en vez de bloquearlo.
create unique index if not exists asset_models_norm_idx
  on asset_models (asset_type_id, public.norm_text(brand), public.norm_text(model))
  where merged_into is null;

create index if not exists asset_models_type_idx on asset_models (asset_type_id);
create index if not exists asset_models_pendientes_idx
  on asset_models (created_at desc) where confirmed = false;

alter table asset_models enable row level security;

create policy "personal lee modelos" on asset_models
  for select to authenticated using (public.is_staff());

-- Un técnico propone; un coordinador puede dar de alta ya validado.
--
-- Es la misma puerta que tiene `assets` desde el panel de administración, y por
-- el mismo motivo: nadie se auto-valida un modelo colándolo con `confirmed =
-- true`, pero quien SÍ puede validar no tiene por qué dar dos pasos —crear y
-- luego validar— para hacer algo que ya podía hacer.
create policy "personal propone modelos" on asset_models
  for insert to authenticated
  with check (public.is_staff() and (confirmed = false or public.is_supervisor()));

create policy "supervisor gestiona modelos" on asset_models
  for update to authenticated
  using (public.is_supervisor()) with check (public.is_supervisor());

create trigger asset_models_audit
  after insert or update or delete on asset_models
  for each row execute function public.audit_trigger();

-- -----------------------------------------------------------------------------
-- 2 — Los campos que cada tipo quiere guardar
--
-- Aquí está la parte «personalizable» sin que personalizar signifique tocar
-- código. Un tipo declara qué campos tiene sentido rellenar en sus modelos y en
-- sus aparatos, y la interfaz los pinta sola:
--
--   [{"clave":"resolucion","etiqueta":"Resolución","tipo":"texto"},
--    {"clave":"lumenes","etiqueta":"Lúmenes","tipo":"numero","unidad":"lm"}]
--
-- Lo que NO se hace, y es deliberado: convertir esto en un constructor de
-- formularios con validaciones, secciones y campos obligatorios. Eso es un
-- proyecto aparte y se paga en una interfaz que nadie entiende. Cuatro tipos de
-- campo —texto, número, fecha y sí/no— cubren lo que un inventario de aulas
-- necesita, y lo que no encaje cabe en las observaciones.
-- -----------------------------------------------------------------------------

alter table asset_types
  add column if not exists spec_fields jsonb not null default '[]'::jsonb;

comment on column asset_types.spec_fields is
  'Campos propios de este tipo: [{clave, etiqueta, tipo: texto|numero|fecha|si_no, unidad?, en: modelo|equipo|ambos}].';

alter table asset_types
  add column if not exists active boolean not null default true;

comment on column asset_types.active is
  'Un tipo retirado deja de ofrecerse al añadir equipos. No se borra: hay inventario e historial que lo nombran.';

-- Los campos que ya tienen sentido de fábrica. No es una lista cerrada —se
-- editan desde el panel— pero estrenar el catálogo con cero campos haría que la
-- pieza pareciera no existir.
update asset_types set spec_fields = '[
  {"clave":"resolucion","etiqueta":"Resolución","tipo":"texto","en":"modelo"},
  {"clave":"lumenes","etiqueta":"Lúmenes","tipo":"numero","unidad":"lm","en":"modelo"},
  {"clave":"lampara","etiqueta":"Referencia de lámpara","tipo":"texto","en":"modelo"}
]'::jsonb
where public.norm_text(name) = 'PROYECTOR' and spec_fields = '[]'::jsonb;

update asset_types set spec_fields = '[
  {"clave":"pulgadas","etiqueta":"Pulgadas","tipo":"numero","unidad":"\"","en":"modelo"},
  {"clave":"resolucion","etiqueta":"Resolución","tipo":"texto","en":"modelo"}
]'::jsonb
where public.norm_text(name) = 'PANTALLA' and spec_fields = '[]'::jsonb;

update asset_types set spec_fields = '[
  {"clave":"procesador","etiqueta":"Procesador","tipo":"texto","en":"modelo"},
  {"clave":"ram","etiqueta":"RAM","tipo":"numero","unidad":"GB","en":"ambos"},
  {"clave":"disco","etiqueta":"Disco","tipo":"texto","en":"ambos"},
  {"clave":"so","etiqueta":"Sistema operativo","tipo":"texto","en":"equipo"}
]'::jsonb
where public.norm_text(name) = 'ORDENADOR' and spec_fields = '[]'::jsonb;

-- -----------------------------------------------------------------------------
-- 3 — El equipo concreto: a qué modelo pertenece y desde cuándo está puesto
-- -----------------------------------------------------------------------------

alter table assets
  add column if not exists asset_model_id uuid references asset_models(id),
  add column if not exists installed_at   timestamptz,
  add column if not exists specs          jsonb not null default '{}'::jsonb,
  add column if not exists notes          text,
  add column if not exists warranty_until date;

comment on column assets.asset_model_id is
  'El modelo del catálogo. `assets.model` se conserva como el texto que se escribió antes de que existiera.';
comment on column assets.installed_at is
  'Cuándo se puso en esta sala. La escribe el dispositivo con su reloj; el disparador la rellena si no viene.';
comment on column assets.warranty_until is
  'Hasta cuándo cubre la garantía. Nulo = no consta, que no es lo mismo que caducada.';

create index if not exists assets_model_idx on assets (asset_model_id)
  where asset_model_id is not null;
create index if not exists assets_installed_idx on assets (installed_at desc)
  where installed_at is not null;

/*
 * La fecha de instalación, sola.
 *
 * Tres reglas y ni una más:
 *
 *  - Alta con sala y sin fecha: la fecha es ahora. Es el caso de «he puesto esto
 *    hoy», que es la mayoría.
 *  - Alta con fecha: se respeta. Es el caso del levantamiento —«esto lleva aquí
 *    desde 2019»— y el del dispositivo que estuvo sin cobertura y sube su hora
 *    real, no la de llegada al servidor.
 *  - Cambio de sala: se refresca, salvo que quien escribe mande una fecha
 *    distinta a propósito. Un proyector que se mueve al aula de al lado lleva
 *    ahí desde hoy, no desde 2019.
 *
 * Y una que NO está: retirar un equipo no borra la fecha. La instalación ocurrió
 * y el histórico la necesita.
 */
create or replace function public.assets_fecha_instalacion()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.room_id is not null and new.installed_at is null then
      new.installed_at := coalesce(new.created_at, now());
    end if;
    return new;
  end if;

  if new.room_id is not null
     and new.room_id is distinct from old.room_id
     and new.installed_at is not distinct from old.installed_at
  then
    new.installed_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists assets_fecha_instalacion on assets;
create trigger assets_fecha_instalacion
  before insert or update on assets
  for each row execute function public.assets_fecha_instalacion();

-- -----------------------------------------------------------------------------
-- 4 — Relleno: sacar los modelos del texto libre que ya hay
--
-- `assets.model` lleva meses recogiendo lo que cada uno escribió. Ahí dentro hay
-- modelos de verdad, y tirarlos para empezar de cero sería tirar el único dato
-- de modelo que existe.
--
-- La marca se deduce de una lista de fabricantes conocidos. No es magia y no
-- pretende serlo: acierta cuando el texto empieza por la marca —que es como se
-- escribe casi siempre— y cuando no, deja la marca vacía y el texto entero como
-- modelo. Por eso TODO lo que sale de aquí nace `confirmed = false`: es una
-- propuesta para que un coordinador la mire, no un hecho.
-- -----------------------------------------------------------------------------

/*
 * Partir «Lenovo U3302» en marca y modelo.
 *
 * La lista de fabricantes va DENTRO de la función y no en una tabla, y es una
 * decisión, no una prisa: solo se usa aquí, para leer lo que ya está escrito. El
 * catálogo de marcas que la aplicación ofrece al escribir sale de los modelos
 * que existen de verdad —lo que este relleno acaba de crear— y no de una lista
 * que alguien tendría que mantener al día para siempre.
 *
 * Devuelve `{marca, modelo}`. Sin marca reconocida, `{'', texto entero}`: es
 * mejor un modelo entero mal partido, que se corrige en dos segundos desde el
 * catálogo, que una marca inventada.
 */
create or replace function public.partir_marca_modelo(p_texto text)
returns text[]
language plpgsql
immutable
set search_path = public
as $$
declare
  v_texto  text := btrim(coalesce(p_texto, ''));
  v_norm   text := public.norm_text(coalesce(p_texto, ''));
  v_marca  text;
  v_resto  text;
begin
  if v_texto = '' then
    return array['', ''];
  end if;

  select mk into v_marca
    from unnest(array[
      'AVerMedia', 'ViewSonic', 'Sennheiser', 'Microsoft', 'Logitech', 'Panasonic',
      'Crestron', 'Gigabyte', 'Christie', 'Polycom', 'Netgear', 'Ubiquiti',
      'Toshiba', 'Fujitsu', 'TP-Link', 'Vivitek', 'InFocus', 'Behringer',
      'Samsung', 'Philips', 'Hitachi', 'Kramer', 'D-Link', 'Optoma', 'Lenovo',
      'Iiyama', 'Maxell', 'Xiaomi', 'Atlona', 'Vaddio', 'Yamaha', 'Aruba',
      'Zyxel', 'Ricoh', 'Sharp', 'Barco', 'Extron', 'Canon', 'Shure', 'Casio',
      'Jabra', 'Aspen', 'Apple', 'Cisco', 'Bosch', 'Epson', 'Asus', 'Acer',
      'BenQ', 'Sony', 'Bose', 'Poly', 'Aver', 'Dell', 'Intel', 'MSI', 'AOC',
      'JBL', 'NEC', 'AMD', 'TOA', 'HP', 'LG'
    ]) as mk
   -- Un separador detrás es obligatorio: sin él, «LG» se comería el principio de
   -- «LGX-40» y «HP» el de «HPE ProLiant».
   where v_norm like public.norm_text(mk) || ' %'
      or v_norm like public.norm_text(mk) || '-%'
   -- La marca más larga gana, que es lo que separa «TP-Link» de un «TP» suelto.
   order by length(mk) desc
   limit 1;

  if v_marca is null then
    return array['', v_texto];
  end if;

  v_resto := btrim(substring(v_texto from length(v_marca) + 1));
  -- Se quita el guion de unión si lo había: «TP-Link-Archer» → «Archer».
  v_resto := btrim(regexp_replace(v_resto, '^-+', ''));

  if v_resto = '' then
    -- El texto era solo la marca. Entonces la marca ES lo que se sabe del
    -- aparato, y dejarlo sin modelo daría una fila con el nombre en blanco.
    return array['', v_texto];
  end if;

  return array[v_marca, v_resto];
end;
$$;

/*
 * Va como función y no como sentencia suelta por el orden de arranque, que es la
 * misma razón por la que `backfill_room_assets()` lo es: en una instalación
 * limpia las migraciones corren **antes** que el seed, así que aquí `assets`
 * está vacía y no habría un solo modelo que deducir. Siendo función se llama en
 * los dos momentos —aquí, para una base que ya está en producción, y después de
 * cargar el seed, para una nueva—.
 *
 * Es idempotente: los ids son derivados, así que volver a ejecutarla no duplica
 * nada, y solo toca los equipos que todavía no tienen modelo asignado. Eso la
 * hace además útil después de una importación.
 */
create or replace function public.backfill_asset_models()
returns text
language plpgsql
as $$
declare
  v_creados int;
  v_ligados int;
  v_fechas  int;
begin
  -- Uno por (tipo, marca, modelo) distinto, con el id derivado — el mismo que
  -- calcularía un iPad sin cobertura, que es lo que hace que las dos altas
  -- converjan en vez de chocar.
  with partido as (
    select distinct
      a.asset_type_id,
      (public.partir_marca_modelo(a.model))[1] as brand,
      (public.partir_marca_modelo(a.model))[2] as model
    from assets a
    where a.model is not null and btrim(a.model) <> ''
  )
  insert into asset_models (id, asset_type_id, brand, model, confirmed, created_by)
  select
    public.asset_model_id(p.asset_type_id, p.brand, p.model),
    p.asset_type_id,
    p.brand,
    p.model,
    false,
    null
  from partido p
  where p.model <> ''
  on conflict (id) do nothing;

  get diagnostics v_creados = row_count;

  -- Y cada equipo apunta al suyo. No se busca por nombre —dos filas distintas
  -- pueden normalizar igual y el resultado dependería del orden de lectura—:
  -- se vuelve a calcular el id por el mismo camino por el que se creó, así que
  -- la correspondencia es exacta por construcción.
  update assets a
     set asset_model_id = public.asset_model_id(
           a.asset_type_id,
           (public.partir_marca_modelo(a.model))[1],
           (public.partir_marca_modelo(a.model))[2]
         )
   where a.asset_model_id is null
     and a.model is not null
     and btrim(a.model) <> ''
     and exists (
       select 1 from asset_models m
        where m.id = public.asset_model_id(
                a.asset_type_id,
                (public.partir_marca_modelo(a.model))[1],
                (public.partir_marca_modelo(a.model))[2]
              )
     );

  get diagnostics v_ligados = row_count;

  -- La fecha de instalación de lo que apuntó una persona. Lo que cargó una
  -- máquina se queda sin fecha a propósito: inventarla es peor que no tenerla.
  update assets
     set installed_at = created_at
   where installed_at is null and room_id is not null and created_by is not null;

  get diagnostics v_fechas = row_count;

  return format(
    '%s modelos creados, %s equipos ligados, %s fechas de instalación deducidas',
    v_creados, v_ligados, v_fechas
  );
end;
$$;

comment on function public.backfill_asset_models() is
  'Deduce el catálogo de modelos del texto libre de assets.model. Idempotente: llámala tras cargar datos.';

-- Escribe inventario en masa. No es `security definer` —la RLS la frena— pero
-- no hay motivo para que la llame nadie desde la aplicación.
revoke execute on function public.backfill_asset_models() from public, anon, authenticated;

grant execute on function public.partir_marca_modelo(text) to authenticated;

-- Para una base que ya está en producción. En una limpia no encuentra nada y
-- quien la vuelve a llamar es el guion de despliegue, después del seed.
select public.backfill_asset_models();

-- -----------------------------------------------------------------------------
-- 5 — Las operaciones del coordinador
--
-- Van como RPC y no como UPDATE directo por lo mismo que las de los tipos: cada
-- una son varias escrituras que tienen que pasar juntas. Fusionar mueve equipos,
-- hereda alias y deja la lápida; a medias dejaría inventario apuntando a un
-- modelo que ya no se usa.
-- -----------------------------------------------------------------------------

create or replace function public.confirm_asset_models(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador valida modelos'
      using errcode = 'insufficient_privilege';
  end if;
  update asset_models set confirmed = true where id = any(p_ids) and confirmed = false;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

/*
 * Corregir la marca o el modelo.
 *
 * El id NO se recalcula, y esa es la decisión importante. Es derivado del nombre
 * para que dos altas sin cobertura converjan, pero una vez existe la fila hay
 * equipos apuntando a ella: recalcularlo sería crear otra y dejar huérfanos a
 * los de antes. El id derivado sirve para NACER, no para vivir.
 *
 * Y el nombre viejo se queda de alias, igual que en `rename_asset_type`: quien
 * lo teclee mañana encuentra el modelo corregido en vez de crear otro.
 */
create or replace function public.rename_asset_model(
  p_id    uuid,
  p_brand text,
  p_model text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text;
  v_tipo uuid;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador corrige un modelo'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_model), '') = '' then
    raise exception 'El modelo no puede quedarse vacío';
  end if;

  select btrim(coalesce(brand, '') || ' ' || model), asset_type_id
    into v_old, v_tipo
    from asset_models where id = p_id;
  if v_tipo is null then
    raise exception 'No existe ese modelo';
  end if;

  if exists (
    select 1 from asset_models o
     where o.id <> p_id
       and o.asset_type_id = v_tipo
       and o.merged_into is null
       and public.norm_text(o.brand) = public.norm_text(coalesce(p_brand, ''))
       and public.norm_text(o.model) = public.norm_text(p_model)
  ) then
    raise exception 'Ya existe otro modelo con esa marca y ese modelo. Fusiónalos en vez de renombrar.';
  end if;

  update asset_models
     set brand = btrim(coalesce(p_brand, '')),
         model = btrim(p_model),
         aliases = case
           when public.norm_text(v_old) = public.norm_text(btrim(coalesce(p_brand, '') || ' ' || p_model))
             then aliases
           else array(select distinct unnest(aliases || v_old))
         end,
         confirmed = true
   where id = p_id;
end;
$$;

create or replace function public.merge_asset_model(p_from uuid, p_into uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from record;
  v_into record;
  v_n integer;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador fusiona modelos'
      using errcode = 'insufficient_privilege';
  end if;
  if p_from = p_into then
    raise exception 'No se puede fusionar un modelo consigo mismo';
  end if;

  select * into v_from from asset_models where id = p_from;
  select * into v_into from asset_models where id = p_into and merged_into is null;
  if v_from.id is null then raise exception 'No existe el modelo de origen'; end if;
  if v_into.id is null then raise exception 'El modelo de destino no existe o ya está fusionado'; end if;
  if v_from.asset_type_id <> v_into.asset_type_id then
    raise exception 'No se pueden fusionar modelos de tipos distintos. Corrige antes el tipo.';
  end if;

  update assets set asset_model_id = p_into where asset_model_id = p_from;
  get diagnostics v_n = row_count;

  update asset_models
     set aliases = array(
           select distinct unnest(
             v_into.aliases
             || btrim(coalesce(v_from.brand, '') || ' ' || v_from.model)
             || v_from.aliases
           )
         )
   where id = p_into;

  update asset_models set merged_into = p_into, active = false where id = p_from;
  return v_n;
end;
$$;

/**
 * Retirar un modelo del catálogo sin borrarlo.
 *
 * Deja de ofrecerse al añadir equipos y sigue existiendo para los que ya lo
 * llevan. Borrarlo de verdad no es una opción: la clave ajena lo impide, y hace
 * bien — el historial de un aula menciona modelos que ya no se compran.
 */
create or replace function public.archive_asset_model(p_id uuid, p_activo boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador retira modelos del catálogo'
      using errcode = 'insufficient_privilege';
  end if;
  update asset_models set active = coalesce(p_activo, false) where id = p_id;
end;
$$;

/**
 * Asignar un modelo a varios equipos de golpe.
 *
 * Es la operación que convierte el catálogo en algo usable el primer día: hay
 * 1.094 equipos y ninguno tiene modelo. Ir uno por uno desde el aula son 1.094
 * viajes; desde el ordenador, filtrando por tipo y sala, son cuatro clics.
 *
 * Comprueba que el modelo sea del mismo tipo que los equipos, que es el error
 * que se comete de verdad al seleccionar en bloque: dejar un proyector con
 * modelo de pantalla no lo detecta nadie después.
 */
create or replace function public.set_asset_model(p_ids uuid[], p_model uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tipo uuid;
  v_n integer;
begin
  if not public.is_staff() then
    raise exception 'No tienes permiso para tocar el inventario'
      using errcode = 'insufficient_privilege';
  end if;

  if p_model is null then
    update assets set asset_model_id = null where id = any(p_ids);
    get diagnostics v_n = row_count;
    return v_n;
  end if;

  select asset_type_id into v_tipo from asset_models where id = p_model;
  if v_tipo is null then
    raise exception 'Ese modelo no existe';
  end if;

  if exists (select 1 from assets where id = any(p_ids) and asset_type_id <> v_tipo) then
    raise exception 'Alguno de los equipos seleccionados no es de ese tipo. Filtra por tipo antes de asignar el modelo.';
  end if;

  update assets set asset_model_id = p_model where id = any(p_ids);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

/** Los campos propios de un tipo, editables desde el panel. */
create or replace function public.set_asset_type_fields(p_id uuid, p_fields jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador define los campos de un tipo'
      using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_fields) <> 'array' then
    raise exception 'Los campos tienen que ser una lista';
  end if;
  update asset_types set spec_fields = p_fields where id = p_id;
end;
$$;

grant execute on function public.confirm_asset_models(uuid[])          to authenticated;
grant execute on function public.rename_asset_model(uuid, text, text)  to authenticated;
grant execute on function public.merge_asset_model(uuid, uuid)         to authenticated;
grant execute on function public.archive_asset_model(uuid, boolean)    to authenticated;
grant execute on function public.set_asset_model(uuid[], uuid)         to authenticated;
grant execute on function public.set_asset_type_fields(uuid, jsonb)    to authenticated;
grant execute on function public.asset_model_id(uuid, text, text)      to authenticated;
grant execute on function public.uuid_v5(uuid, text)                   to authenticated;

-- -----------------------------------------------------------------------------
-- 6 — Fusionar tipos tiene que arrastrar sus modelos
--
-- `merge_asset_type` ya movía equipos, artículos de almacén y equipamiento por
-- defecto, y renombraba las etiquetas de las salas. Ahora hay una cosa más
-- colgando de un tipo, y si no se mueve queda un modelo apuntando a un tipo
-- fusionado: el catálogo lo seguiría ofreciendo bajo un nombre que ya no existe.
--
-- Se reescribe entera —es `create or replace`— y por eso hay que copiar TODO lo
-- que ya hacía: `create or replace` no extiende, sustituye. Lo que se añade es
-- el bucle de modelos, con su choque resuelto: si el destino ya tiene un modelo
-- con la misma marca y el mismo nombre, no se duplica, se fusiona con él.
--
-- El orden importa. Los modelos se mueven ANTES que los equipos, porque el
-- bucle busca gemelos por `asset_type_id` y mover los equipos primero no cambia
-- nada — pero el renombrado de etiquetas va al FINAL, cuando el destino ya tiene
-- dentro todo lo que venía del absorbido. Era así antes y sigue siéndolo.
-- -----------------------------------------------------------------------------

create or replace function public.merge_asset_type(p_from uuid, p_into uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from_name text;
  v_into_name text;
  v_modelo record;
  v_gemelo uuid;
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

  -- Los modelos, uno a uno, porque cada uno puede tener gemelo o no tenerlo.
  for v_modelo in
    select * from asset_models where asset_type_id = p_from and merged_into is null
  loop
    select id into v_gemelo
      from asset_models
     where asset_type_id = p_into
       and merged_into is null
       and public.norm_text(brand) = public.norm_text(v_modelo.brand)
       and public.norm_text(model) = public.norm_text(v_modelo.model);

    if v_gemelo is null then
      update asset_models set asset_type_id = p_into where id = v_modelo.id;
    else
      -- Ya existía el mismo modelo en el destino: los equipos se repuntan y el
      -- de origen queda como lápida, igual que en una fusión de modelos.
      update assets set asset_model_id = v_gemelo where asset_model_id = v_modelo.id;
      update asset_models
         set aliases = array(select distinct unnest(
               aliases || btrim(coalesce(v_modelo.brand, '') || ' ' || v_modelo.model) || v_modelo.aliases
             ))
       where id = v_gemelo;
      update asset_models set merged_into = v_gemelo, active = false where id = v_modelo.id;
    end if;
  end loop;

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

-- -----------------------------------------------------------------------------
-- 7 — La vista del inventario, con las tres identidades resueltas
--
-- Existe para las pantallas que trabajan contra el servidor —la gestión desde el
-- ordenador, la bandeja del coordinador, la exportación— y para no repetir en
-- cuatro sitios el mismo join de cinco tablas. El aula sigue leyendo del espejo
-- local: allí no se puede depender de una vista.
-- -----------------------------------------------------------------------------

create or replace view asset_overview as
select
  a.id,
  a.label,
  a.serial,
  a.status,
  a.confirmed,
  a.installed_at,
  a.warranty_until,
  a.created_at,
  a.created_by,
  a.notes,
  a.specs,

  a.asset_type_id,
  coalesce(tv.name, t.name)      as type_name,
  coalesce(tv.category, t.category) as type_category,

  a.asset_model_id,
  coalesce(mv.brand, m.brand)    as brand,
  coalesce(mv.model, m.model)    as model_name,
  -- Lo que se escribió a mano antes de que existiera el catálogo. Se conserva
  -- para que un equipo sin modelo asignado no se quede mudo.
  a.model                        as model_libre,
  coalesce(mv.confirmed, m.confirmed) as model_confirmed,

  -- La identidad completa, ya montada: «Ordenador Lenovo U3302».
  btrim(
    concat_ws(' ',
      coalesce(tv.name, t.name),
      nullif(coalesce(mv.brand, m.brand), ''),
      coalesce(mv.model, m.model, nullif(btrim(a.model), ''))
    )
  ) as identidad,

  a.room_id,
  r.code       as room_code,
  r.name       as room_name,
  z.id         as zone_id,
  z.name       as zone_name,
  b.id         as building_id,
  b.code       as building_code,
  b.name       as building_name,
  p.full_name  as created_by_name
from assets a
join asset_types t on t.id = a.asset_type_id
left join asset_types  tv on tv.id = t.merged_into
left join asset_models m  on m.id = a.asset_model_id
left join asset_models mv on mv.id = m.merged_into
left join rooms r     on r.id = a.room_id
left join zones z     on z.id = r.zone_id
left join buildings b on b.id = z.building_id
left join profiles p  on p.id = a.created_by;

alter view asset_overview set (security_invoker = on);

comment on view asset_overview is
  'Cada equipo con su tipo, su marca, su modelo y su sala ya resueltos, siguiendo las fusiones.';

-- -----------------------------------------------------------------------------
-- 8 — La línea de tiempo dice qué aparato era
--
-- `room_timeline` titulaba las filas de equipo con la etiqueta de la sala
-- —«Pantalla 2»— y el detalle con el modelo escrito a mano. Con el catálogo hay
-- algo mejor que enseñar, y es justo lo que se pregunta al leer un histórico:
-- qué se instaló, de qué modelo y con qué número de serie.
--
-- Se tira y se rehace porque `create or replace` solo sabe añadir columnas al
-- final; las tres pantallas que la consumen piden `select('*')`, así que añadir
-- columnas no rompe nada. El vocabulario de `kind` no se toca.
-- -----------------------------------------------------------------------------

drop view if exists room_timeline;

create view room_timeline as
with equipo_id as (
  -- El nombre completo del aparato, resuelto una vez y usado en las dos ramas
  -- de equipo. Sin esto el mismo `concat_ws` de cinco piezas iría duplicado, y
  -- duplicado es exactamente como se desincronizan.
  select
    a.id,
    a.room_id,
    a.serial,
    a.status,
    a.created_at,
    a.created_by,
    a.installed_at,
    coalesce(a.label, coalesce(tv.name, t.name), 'Equipo') as titulo,
    nullif(
      btrim(concat_ws(' · ',
        nullif(btrim(concat_ws(' ',
          nullif(coalesce(mv.brand, m.brand), ''),
          coalesce(mv.model, m.model, nullif(btrim(a.model), ''))
        )), ''),
        a.serial
      )),
      ''
    ) as ficha
  from assets a
  left join asset_types  t  on t.id = a.asset_type_id
  left join asset_types  tv on tv.id = t.merged_into
  left join asset_models m  on m.id = a.asset_model_id
  left join asset_models mv on mv.id = m.merged_into
),
eventos as (

-- Incidencias, solicitudes y observaciones: la apertura --------------------
select
  i.id                                  as ref_id,
  case i.kind
    when 'solicitud'   then 'solicitud'
    when 'observacion' then 'observacion'
    else 'incidencia'
  end                                   as kind,
  i.state::text                         as subkind,
  i.room_id,
  i.opened_at                           as at,
  coalesce(i.title, '(sin describir)')  as title,
  nullif(i.description, '')             as detail,
  null::int                             as qty,
  i.opened_by                           as by_user,
  i.external_ref                        as ref,
  i.state::text                         as state
from incidents i

union all

-- …y el cierre, como fila propia. Abrir en enero y resolver en marzo son dos
-- cosas que pasaron, en dos momentos, y entre las dos fechas está lo que se
-- tardó. Solo para lo que se rompió: una observación o una solicitud no se
-- «resuelven» en el mismo sentido y ensuciarían la línea.
select
  i.id,
  'incidencia',
  'resuelta',
  i.room_id,
  i.resolved_at,
  'Resuelta: ' || coalesce(i.title, '(sin describir)'),
  nullif(i.resolution, ''),
  null::int,
  i.resolved_by,
  i.external_ref,
  'resuelta'
from incidents i
where i.resolved_at is not null and i.kind = 'incidencia'

union all

-- Revisiones ----------------------------------------------------------------
select
  ins.id,
  case ins.overall when 'ok' then 'revision_ok' else 'revision_ko' end,
  ins.status::text,
  ins.room_id,
  ins.occurred_at,
  case ins.overall
    when 'ok' then 'Revisión completa sin incidencias'
    else 'Revisión con incidencias'
  end,
  nullif(ins.notes, ''),
  null::int,
  ins.by_user,
  null,
  ins.status::text
from inspections ins
where ins.status = 'completa'

union all

-- Material ------------------------------------------------------------------
select
  sm.id,
  'material',
  sm.kind::text,
  sm.room_id,
  sm.occurred_at,
  si.name,
  nullif(sm.note, ''),
  sm.qty,
  sm.by_user,
  null,
  sm.kind::text
from stock_movements sm
join stock_items si on si.id = sm.stock_item_id
where sm.room_id is not null

union all

-- Equipos: el alta ----------------------------------------------------------
--
-- `created_by is not null` separa lo que alguien dio de alta desde el aula de
-- los 1.094 equipos que entraron con la importación: comparten todos la fecha
-- del despliegue, y sin el filtro cada sala abriría su histórico con seis altas
-- idénticas por delante de las incidencias reales de 2025.
--
-- La fecha es ahora `installed_at`, que es la que dice cuándo se puso de verdad;
-- `created_at` decía cuándo llegó la fila al servidor, que con un iPad sin
-- cobertura puede ser un día después y en otro orden.
select
  e.id,
  'equipo',
  'alta',
  e.room_id,
  coalesce(e.installed_at, e.created_at),
  e.titulo,
  e.ficha,
  null::int,
  e.created_by,
  e.serial,
  e.status::text
from equipo_id e
where e.room_id is not null and e.created_by is not null

union all

-- Equipos: lo que les pasa después ------------------------------------------
select
  ae.id,
  'equipo',
  ae.kind::text,
  coalesce(ae.room_id, e.room_id),
  ae.occurred_at,
  e.titulo,
  -- Lo que dijo quien registró el evento, y si no dijo nada, de qué aparato se
  -- está hablando. Antes, un traslado sin nota salía sin una sola pista de qué
  -- se movió más allá de «Pantalla 2».
  coalesce(nullif(ae.meta ->> 'nota', ''), e.ficha),
  null::int,
  ae.by_user,
  e.serial,
  ae.kind::text
from asset_events ae
join equipo_id e on e.id = ae.asset_id
where coalesce(ae.room_id, e.room_id) is not null

union all

-- El levantamiento ----------------------------------------------------------
select
  v.id,
  'inventario',
  'levantamiento',
  v.room_id,
  v.occurred_at,
  'Inventario confirmado',
  coalesce(nullif(v.note, ''), v.asset_count || ' equipos en la sala'),
  null::int,
  v.by_user,
  null,
  'levantamiento'
from room_inventories v

)
-- El contexto de sala y edificio se añade una vez, fuera de la unión. Lo pide
-- la pestaña Historial, que filtra por edificio y busca por código de aula:
-- hacerlo en el cliente obligaría a descargar el histórico entero para pintar
-- una página. `who` sale aquí por lo mismo — un `join` en vez de siete.
select
  e.ref_id,
  e.kind,
  e.subkind,
  e.room_id,
  e.at,
  e.title,
  e.detail,
  e.qty,
  e.by_user,
  e.ref,
  e.state,
  p.full_name as who,
  r.code      as room_code,
  r.name      as room_name,
  z.building_id,
  b.code      as building_code
from eventos e
join rooms r     on r.id = e.room_id
join zones z     on z.id = r.zone_id
join buildings b on b.id = z.building_id
left join profiles p on p.id = e.by_user;

alter view room_timeline set (security_invoker = on);

comment on view room_timeline is
  'Todo lo que le ha pasado a una sala: registros, revisiones, material, equipos e inventarios.';

notify pgrst, 'reload schema';
