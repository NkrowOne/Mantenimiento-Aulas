-- reejecutable: si
--
-- Todo lo que hay aquí da lo mismo la segunda vez que la primera: `add column
-- if not exists`, `drop constraint if exists` y `add constraint` en la misma
-- sentencia, `create table if not exists`, `create index if not exists`,
-- `create or replace` para las funciones y las vistas, `drop trigger if exists`
-- delante de cada `create trigger`, `drop policy if exists` delante de cada
-- `create policy`, `comment`, `grant`, `revoke` y `alter view … set
-- (security_invoker = on)`. Ni un `update` de datos: las unidades que ya hay se
-- quedan «sin indicar», que es exactamente lo que son hasta que alguien las
-- mire, y ninguna unidad nace de un equipo que se retiró antes de hoy. La
-- deducción automática no se fía del `alter view` —y en general hace bien—, así
-- que se dice aquí.
-- =============================================================================
-- Cada unidad del almacén, con su estado
--
-- `stock_units` nació en septiembre para una sola hoja —«PCs STOCK 2026»— y
-- para una sola cosa: saber qué ordenador de repuesto, con qué número de serie,
-- espera en la estantería. El almacén cuenta («quedan 7 Ordenador Tiny M70Q») y
-- las unidades nombran lo contado. Pero solo nombraban ordenadores, solo
-- entraban desde el Excel o desde el despacho, y tenían tres huecos que se ven
-- en cuanto se intenta usarlas desde el aula:
--
--  1. **Cómo está.** Un aparato de la estantería puede estar sin estrenar,
--     haber vuelto de otra aula, estar reparado o estar roto, y quien va a
--     instalarlo necesita saberlo antes de cargar con él. `status` dice DÓNDE
--     está —almacén, aula, baja— y lo decide lo que se hace con la unidad; la
--     columna nueva, `condicion`, dice CÓMO está y la dice quien la tiene
--     delante. Son dos preguntas y van en dos columnas.
--
--  2. **Instalar desde el aula, también sin cobertura.** `stock_unit_instalar`
--     solo existe como llamada al servidor, y decide sola qué retira: el último
--     equipo del mismo tipo de la sala. Sin red, al cliente no le quedaba más
--     remedio que crear él la fila del equipo, y eso choca: el número de serie
--     es único en TODA la base (`assets_serial_idx`), y el de una unidad que
--     vuelve del almacén suele ser ya el de un equipo retirado, que hay que
--     reutilizar y no duplicar. Eso solo lo sabe la base. Así que el cliente ya
--     no crea el equipo: **pide la instalación** —una fila de
--     `stock_unit_installs`, con su id de cliente, igual que un cierre de
--     incidencia es una fila de `incident_resolutions`— y la base hace lo mismo
--     que `stock_unit_instalar_en`, la llamada en línea. Las dos pasan por el
--     mismo núcleo, y en las dos el técnico dice qué equipo sustituye en vez de
--     dejar que se adivine.
--
--  3. **La vuelta.** Un equipo con número de serie que se retiraba al almacén
--     sumaba uno a su artículo, pero el almacén no podía decir cuál había
--     vuelto: la unidad no existía. Ahora, cuando se aprueba una retirada al
--     almacén, la unidad nace —o vuelve—, y vuelve «usada».
--
-- Y alrededor, lo que hace falta para que lo de arriba se pueda usar y se pueda
-- seguir: la auditoría de `stock_units` (que es también lo que mueve la versión
-- del espejo), una vista con todo lo que la pantalla enseña de cada unidad, la
-- corrección de una unidad con su puerta por columnas, y un disparador que saca
-- la unidad del almacén cuando su número de serie aparece en un aula por
-- cualquier otro camino.
--
-- Lo que NO cambia, a propósito: `stock_unit_instalar` —la siguen llamando las
-- aplicaciones viejas que quedan en caché en algún iPad—, `stock_unit_baja`, la
-- celda de la hoja de PCs y la firma de `stock_unit_alta`, a la que cuatro
-- versiones de la sincronización del Excel llaman con el mismo `jsonb` de
-- siempre: con él hace lo que hacía, salvo mirar mejor si el aparato ya está en
-- un aula (punto 4).
--
-- Los errores llevan código, como los de la ficha (`20261027000100`), y es lo
-- que lee la pantalla:
--
--   42501  no le toca a ese rol;
--   22023  falta un dato o no vale: un estado que no existe, una unidad que ya
--          no está en el almacén, una sala archivada, un artículo sin tipo…;
--   23505  un número de serie que ya es de otra unidad — y el mensaje dice de
--          cuál.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — Cómo está cada unidad
--
-- Cuatro estados que se eligen y uno que no: `sin_indicar` es lo que hay
-- mientras nadie ha dicho nada, y por eso es el defecto y lo que tienen todas
-- las unidades de hasta hoy. Ponerles «usado» porque vienen de la hoja de PCs
-- sería decidir por quien las tiene delante, que es justo lo que esta columna
-- viene a dejar de hacer.
--
-- Texto con un `check` con nombre y no un tipo enumerado, como `status` en la
-- misma tabla: el `check` se quita y se pone en la misma sentencia y la
-- migración se puede repetir; un `create type` no.
-- -----------------------------------------------------------------------------

alter table stock_units
  add column if not exists condicion text not null default 'sin_indicar';

alter table stock_units
  drop constraint if exists stock_units_condicion_check,
  add constraint stock_units_condicion_check
    check (condicion in ('nuevo', 'usado', 'reacondicionado', 'averiado', 'sin_indicar'));

comment on column stock_units.condicion is
  'Cómo está la unidad: nuevo, usado, reacondicionado, averiado o sin_indicar (nadie lo ha dicho todavía). Es independiente de status, que dice dónde está. Al volver al almacén desde un aula pasa a usado si era nuevo o sin_indicar.';

comment on table stock_units is
  'Unidades del almacén, una por número de serie: el almacén cuenta y esto nombra. Cuál está en la estantería y cómo está, cuál se instaló y dónde, cuál se dio de baja. Empezó con los ordenadores de repuesto y vale para cualquier artículo.';

-- `stock_unit_sigue_al_equipo` y la vuelta al almacén buscan la unidad por su
-- equipo: con índice, cada retirada de un aula es una lectura y no un barrido.
create index if not exists stock_units_asset_idx
  on stock_units (asset_id) where asset_id is not null;

-- -----------------------------------------------------------------------------
-- 2 — Las unidades dejan rastro
--
-- Con el disparador de auditoría de siempre, como los artículos, los equipos y
-- las retiradas. Sirve para tres cosas a la vez:
--
--   - la Actividad dice quién dio de alta una unidad, quién le cambió el estado
--     y quién la instaló, con la fila de antes y la de después;
--   - el motivo de una baja, que `stock_unit_baja` deja en las notas, queda con
--     su autor;
--   - y la versión del espejo se mueve con ellas. `espejo_version()` lee el
--     último `at` de `audit_log`, y las unidades disponibles bajan desde hoy a
--     cada dispositivo (`stock_unit_list`): sin auditoría, una unidad que se
--     instala desde otro iPad se le seguiría ofreciendo a este hasta la bajada
--     entera de la media hora.
--
-- La política de lectura de `audit_log` no hay que tocarla: «personal lee
-- auditoría» (`20261015000100`) abre al técnico todo menos `profiles`, y las
-- unidades ya las lee enteras en su propia tabla.
-- -----------------------------------------------------------------------------

drop trigger if exists stock_units_audit on stock_units;
create trigger stock_units_audit
  after insert or update or delete on stock_units
  for each row execute function public.audit_trigger();

-- -----------------------------------------------------------------------------
-- 3 — La lista de unidades
--
-- Una fila por unidad y en todas sus situaciones: la pantalla del almacén
-- enseña también las instaladas y las de baja, y el espejo del dispositivo se
-- baja solo las disponibles filtrando por `status`.
--
-- El tipo es el de la unidad y, si no lo tiene, el de su artículo; y siempre el
-- VIVO, con un salto de `merged_into`, como en el registro y en la hoja: el
-- nombre de una lápida de fusión no lo reconoce nadie, y su categoría tampoco
-- es la que vale.
--
-- `es_ordenador` es lo que separa lo que va a la hoja «PCs STOCK» y cuenta como
-- ordenador de repuesto en el informe de todo lo demás —desde hoy un proyector
-- que vuelve al almacén también es una unidad—. Lo dice primero la categoría
-- del tipo (`ti`); si no, el nombre: el del tipo, el del artículo o lo que
-- escribió la hoja, con las palabras con las que la hoja de PCs los llama.
-- `\m…\M` son los bordes de palabra de las expresiones de Postgres: «PC»
-- cuenta y «PCI» no.
--
-- La sala y el edificio son los de la unidad, que solo tiene sala mientras
-- está instalada.
-- -----------------------------------------------------------------------------

create or replace view public.stock_unit_list as
select
  u.id,
  u.stock_item_id,
  si.name                                    as item_name,
  si.active                                  as item_active,
  u.articulo,
  coalesce(tf.id, t.id)                      as asset_type_id,
  coalesce(tf.name, t.name)                  as type_name,
  (
    coalesce(coalesce(tf.category, t.category) = 'ti', false)
    or coalesce(tf.name, t.name, si.name, u.articulo)
         ~* '(ordenador|port[aá]til|tiny|thinkcentre|\mpc\M)'
  )                                          as es_ordenador,
  u.brand,
  u.model,
  u.serial,
  u.notes,
  u.status,
  u.condicion,
  u.asset_id,
  u.room_id,
  r.code                                     as room_code,
  r.name                                     as room_name,
  b.code                                     as building_code,
  u.installed_at,
  u.retired_at,
  u.source,
  u.created_at,
  u.updated_at
from stock_units u
left join stock_items si on si.id = u.stock_item_id
left join asset_types t  on t.id = coalesce(u.asset_type_id, si.asset_type_id)
left join asset_types tf on tf.id = t.merged_into
left join rooms r        on r.id = u.room_id
left join zones z        on z.id = r.zone_id
left join buildings b    on b.id = z.building_id;

-- Sin esto la vista correría con los privilegios de su propietario, que se
-- salta la RLS, y PostgREST la publicaría con cualquier token.
alter view public.stock_unit_list set (security_invoker = on);

comment on view public.stock_unit_list is
  'Una unidad del almacén por fila, en cualquier situación, con su artículo, su tipo vivo, si es un ordenador (categoría ti o el nombre lo dice), su estado y la sala donde está instalada.';

-- Con `security_invoker` la vista no abre nada que las tablas no abran: las
-- seis tienen su «personal lee …» con `is_staff()`. El GRANT va explícito
-- porque el `alter default privileges` del arranque solo cubre lo que crea el
-- mismo rol que lo declaró, y el de `anon` se retira porque ese mismo defecto
-- se lo daba.
revoke all on public.stock_unit_list from anon;
grant select on public.stock_unit_list to authenticated;

-- -----------------------------------------------------------------------------
-- 4 — El alta de una unidad: con su artículo, con su estado y, si entra,
--     sumando
--
-- La misma firma, y el mismo comportamiento con el `jsonb` de siempre: es lo
-- que manda la sincronización del Excel desde cuatro migraciones distintas
-- (`sync_alta`), y tiene que seguir entrando igual —incluido el «Ordenador» por
-- defecto, que es una suposición razonable para la hoja de PCs y para nada
-- más—.
--
-- Lo nuevo son tres claves opcionales, que es lo que manda la pantalla del
-- almacén cuando alguien da de alta una unidad desde un artículo:
--
--   stock_item_id  el artículo, nombrado. Gana a cualquier parecido de nombre:
--                  quien lo eligió en una lista no se ha equivocado de
--                  artículo, y el casado por nombre sí puede. La unidad toma
--                  el tipo del artículo TAL CUAL, aunque no tenga: inventarle
--                  «Ordenador» a un artículo de proyectores sería poner un
--                  proyector en la hoja de PCs.
--   condicion      el estado, comprobado. Si no viene, una unidad nueva nace
--                  «sin indicar» y una que ya existía se queda como estaba.
--   sumar          ¿entra ahora en el almacén, o ya estaba contada? Las dos
--                  cosas pasan: quien le pone por fin número de serie a los
--                  ocho teclados que el almacén ya cuenta no debe acabar con
--                  dieciséis, y quien recibe un proyector nuevo sí tiene que
--                  verlo sumar. Lo decide la pantalla, y aquí se apunta: un
--                  asiento de +1 —«compra» si llega nueva, «ajuste» si no—.
--
-- El +1 solo se apunta si la unidad NACE aquí, tiene artículo y nace en el
-- almacén. Una unidad que ya existía no suma nunca —el alta es idempotente por
-- número de serie, y un reintento de la pantalla o una segunda pasada del
-- Excel no pueden ingresar dos veces el mismo aparato—, y una cuyo número de
-- serie ya está en un aula nace instalada y no está en ninguna estantería que
-- contar.
--
-- Ese «ya está en un aula» se mira ahora como lo mira todo lo demás: por el
-- número de serie normalizado —la hoja escribe «S4GM-1899» donde el aula
-- apuntó «S4GM1899»— y en cualquier equipo no retirado, también el averiado,
-- que sigue estando en el aula.
-- -----------------------------------------------------------------------------

/**
 * Da de alta una unidad del almacén. Idempotente por número de serie: si ya
 * existe, se le actualizan los datos que vengan y se devuelve su id.
 *
 *   p: {articulo, marca, modelo, serial, observaciones, source,
 *       stock_item_id?, condicion?, sumar?}
 */
create or replace function public.stock_unit_alta(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_serial      text := btrim(coalesce(p->>'serial', ''));
  v_articulo    text := btrim(coalesce(p->>'articulo', ''));
  v_modelo      text := nullif(btrim(coalesce(p->>'modelo', '')), '');
  v_marca       text := nullif(btrim(coalesce(p->>'marca', '')), '');
  v_notas       text := nullif(btrim(coalesce(p->>'observaciones', '')), '');
  v_source      text := coalesce(nullif(btrim(coalesce(p->>'source', '')), ''), 'app');
  v_crudo       text;
  v_nombrado    boolean := false;
  v_item        uuid;
  v_item_nombre text;
  v_tipo        uuid;
  v_condicion   text;
  v_sumar       boolean;
  v_id          uuid;
  v_asset       uuid;
  v_room        uuid;
  v_estado      text;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor da de alta unidades del almacén.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_serial = '' then
    raise exception 'Una unidad del almacén necesita número de serie.'
      using errcode = '22023';
  end if;

  -- El estado, si viene. En blanco es que no viene.
  v_condicion := nullif(lower(btrim(coalesce(p->>'condicion', ''))), '');
  if v_condicion is not null
     and v_condicion not in ('nuevo', 'usado', 'reacondicionado', 'averiado', 'sin_indicar') then
    raise exception '«%» no es un estado de unidad: tiene que ser nuevo, usado, reacondicionado o averiado.',
      p->>'condicion'
      using errcode = '22023';
  end if;

  -- «sumar», como lo mande la pantalla: un booleano de JSON o su texto.
  begin
    v_sumar := coalesce(nullif(btrim(coalesce(p->>'sumar', '')), '')::boolean, false);
  exception when invalid_text_representation then
    raise exception '«%» no vale para «sumar»: tiene que ser sí o no.', p->>'sumar'
      using errcode = '22023';
  end;

  v_crudo := nullif(btrim(coalesce(p->>'stock_item_id', '')), '');
  if v_crudo is not null then
    -- El artículo nombrado: tiene que existir y estar en el almacén.
    begin
      v_item := v_crudo::uuid;
    exception when invalid_text_representation then
      raise exception '«%» no es un artículo del almacén.', v_crudo
        using errcode = '22023';
    end;
    select si.name, si.asset_type_id
      into v_item_nombre, v_tipo
      from stock_items si
     where si.id = v_item and si.active;
    if not found then
      raise exception 'Ese artículo no existe o está retirado del almacén.'
        using errcode = '22023';
    end if;
    v_nombrado := true;
    if v_articulo = '' then v_articulo := v_item_nombre; end if;
  else
    -- El camino de siempre, sin un cambio: el artículo se busca por nombre y
    -- alias, primero como «artículo modelo» —la hoja dice «Ordenador Tiny» y
    -- «M710Q» en dos columnas y la bolsa «Ordenador Tiny M710Q» en una—.
    if v_articulo = '' then v_articulo := 'Ordenador'; end if;

    select si.id into v_item from stock_items si
     where si.active
       and (
         (v_modelo is not null and public.norm_text(si.name) = public.norm_text(v_articulo || ' ' || v_modelo))
         or public.norm_text(v_articulo || ' ' || coalesce(v_modelo, '')) = any (
              select public.norm_text(a) from unnest(si.aliases) a)
       )
     limit 1;
    if v_item is null then
      select si.id into v_item from stock_items si
       where si.active
         and (public.norm_text(si.name) = public.norm_text(v_articulo)
              or public.norm_text(v_articulo) = any (select public.norm_text(a) from unnest(si.aliases) a))
       limit 1;
    end if;
    if v_item is not null then
      select asset_type_id into v_tipo from stock_items where id = v_item;
    end if;
    if v_tipo is null then
      v_tipo := public.asset_type_id('Ordenador');
    end if;
  end if;

  select id into v_id from stock_units
   where upper(regexp_replace(serial, '[\s\-_./]', '', 'g'))
       = upper(regexp_replace(v_serial, '[\s\-_./]', '', 'g'));

  if v_id is not null then
    -- Ya existe: se actualiza lo que venga, y solo si algo cambia, para que una
    -- segunda pasada del Excel no llene la Actividad de cambios que no lo son.
    if v_nombrado then
      update stock_units u
         set stock_item_id = v_item,
             articulo      = v_articulo,
             asset_type_id = v_tipo,
             brand         = coalesce(v_marca, u.brand),
             model         = coalesce(v_modelo, u.model),
             notes         = coalesce(v_notas, u.notes),
             condicion     = coalesce(v_condicion, u.condicion),
             updated_at    = now()
       where u.id = v_id
         and (u.stock_item_id, u.articulo, u.asset_type_id, u.brand, u.model, u.notes, u.condicion)
             is distinct from
             (v_item, v_articulo, v_tipo, coalesce(v_marca, u.brand), coalesce(v_modelo, u.model),
              coalesce(v_notas, u.notes), coalesce(v_condicion, u.condicion));
    else
      update stock_units u
         set articulo      = v_articulo,
             brand         = coalesce(v_marca, u.brand),
             model         = coalesce(v_modelo, u.model),
             notes         = coalesce(v_notas, u.notes),
             stock_item_id = coalesce(u.stock_item_id, v_item),
             asset_type_id = coalesce(u.asset_type_id, v_tipo),
             condicion     = coalesce(v_condicion, u.condicion),
             updated_at    = now()
       where u.id = v_id
         and (u.articulo, u.brand, u.model, u.notes, u.stock_item_id, u.asset_type_id, u.condicion)
             is distinct from
             (v_articulo, coalesce(v_marca, u.brand), coalesce(v_modelo, u.model), coalesce(v_notas, u.notes),
              coalesce(u.stock_item_id, v_item), coalesce(u.asset_type_id, v_tipo),
              coalesce(v_condicion, u.condicion));
    end if;
    return v_id;
  end if;

  -- ¿Ya está puesto en un aula? Entonces no está en el almacén, y decirlo
  -- sería mentir. Es el mismo aparato: la unidad nace apuntando a él.
  select a.id, a.room_id into v_asset, v_room
    from assets a
   where a.serial is not null
     and upper(regexp_replace(a.serial, '[\s\-_./]', '', 'g'))
       = upper(regexp_replace(v_serial, '[\s\-_./]', '', 'g'))
     and a.status <> 'retirado'
     and a.room_id is not null
   order by (a.serial = v_serial) desc, a.created_at desc
   limit 1;
  v_estado := case when v_asset is null then 'disponible' else 'instalado' end;

  insert into stock_units (stock_item_id, asset_type_id, articulo, brand, model, serial, notes,
                           status, condicion, asset_id, room_id, installed_at, source)
  values (v_item, v_tipo, v_articulo, v_marca, v_modelo, v_serial, v_notas,
          v_estado, coalesce(v_condicion, 'sin_indicar'),
          v_asset, v_room, case when v_asset is not null then now() end, v_source)
  returning id into v_id;

  if v_sumar and v_item is not null and v_estado = 'disponible' then
    insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user, source, note)
    values (gen_random_uuid(), v_item, 1,
            (case when coalesce(v_condicion, 'sin_indicar') = 'nuevo' then 'compra' else 'ajuste' end)::stock_movement_kind,
            now(), (select auth.uid()), v_source,
            format('Entrada de la unidad S/N %s', v_serial));
  end if;

  return v_id;
end $$;

comment on function public.stock_unit_alta(jsonb) is
  'Da de alta una unidad del almacén por número de serie (idempotente). Con stock_item_id, ese artículo y su tipo tal cual; sin él, casa el artículo por nombre o «artículo modelo» y supone Ordenador. condicion opcional (22023 si no existe). sumar = true apunta +1 (compra si nuevo, ajuste si no) solo si la unidad nace aquí, con artículo y en el almacén. Si el número ya es de un equipo en un aula, nace instalada y apuntando a él.';

revoke all on function public.stock_unit_alta(jsonb) from public, anon;
grant execute on function public.stock_unit_alta(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 5 — Corregir una unidad
--
-- Con una puerta por columnas, que es la misma que tiene el equipo en el aula
-- frente a su ficha (`assets_ficha_guard`):
--
--   - el estado y las observaciones son de quien tiene la unidad delante, y
--     ese suele ser el técnico: «esta está averiada», «le falta el cargador»;
--   - la marca, el modelo, el número de serie y el artículo son la identidad
--     del aparato y de su cuenta en el almacén, y los corrige el despacho.
--
-- Igual que en la ficha, la puerta mira lo que CAMBIA y no lo que llega: una
-- pantalla que reenvía la marca que ya había no está cambiando la marca, y un
-- técnico que guarda el estado no puede acabar con un 42501 por arrastrar el
-- resto del formulario. Lo que sí cambia y no le toca, 42501.
--
-- El número de serie es único entre las unidades sin contar espacios,
-- guiones, puntos ni barras, como en su índice; el choque se dice con el número
-- y el artículo de la otra, que es lo que hace falta para ir a mirarla. Cambiar
-- de artículo trae el nombre del artículo y su tipo, por lo mismo que en el
-- alta: la unidad es de la clase que dice su artículo, y un tipo viejo que se
-- quedara pegado instalaría un ordenador donde se iba a poner un monitor.
--
--   p: {condicion?, observaciones?, marca?, modelo?, serial?, stock_item_id?}
--
-- Lo que no está en la lista se ignora: la pantalla puede mandar la fila entera.
-- -----------------------------------------------------------------------------

create or replace function public.stock_unit_editar(p_unit uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_u          stock_units%rowtype;
  v_super      boolean := public.is_supervisor();
  v_crudo      text;
  v_condicion  text;
  v_notas      text;
  v_marca      text;
  v_modelo     text;
  v_serial     text;
  v_item       uuid;
  v_articulo   text;
  v_tipo       uuid;
  v_otra       stock_units%rowtype;
begin
  if not public.is_staff() then
    raise exception 'Solo el personal corrige unidades del almacén.'
      using errcode = '42501';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'La corrección llega vacía.' using errcode = '22023';
  end if;

  select * into v_u from stock_units where id = p_unit for update;
  if not found then
    raise exception 'Esa unidad no existe.' using errcode = '22023';
  end if;

  v_condicion := v_u.condicion;
  v_notas     := v_u.notes;
  v_marca     := v_u.brand;
  v_modelo    := v_u.model;
  v_serial    := v_u.serial;
  v_item      := v_u.stock_item_id;
  v_articulo  := v_u.articulo;
  v_tipo      := v_u.asset_type_id;

  -- Lo del aula.
  if p ? 'condicion' then
    v_crudo := lower(btrim(coalesce(p->>'condicion', '')));
    if v_crudo not in ('nuevo', 'usado', 'reacondicionado', 'averiado', 'sin_indicar') then
      raise exception '«%» no es un estado de unidad: tiene que ser nuevo, usado, reacondicionado o averiado.',
        coalesce(p->>'condicion', '')
        using errcode = '22023';
    end if;
    v_condicion := v_crudo;
  end if;
  if p ? 'observaciones' then
    v_notas := nullif(btrim(coalesce(p->>'observaciones', '')), '');
  end if;

  -- Lo del despacho.
  if p ? 'marca' then
    v_crudo := nullif(btrim(coalesce(p->>'marca', '')), '');
    if v_crudo is distinct from v_u.brand and not v_super then
      raise exception 'Solo un supervisor o administrador corrige la marca de una unidad.'
        using errcode = '42501';
    end if;
    v_marca := v_crudo;
  end if;

  if p ? 'modelo' then
    v_crudo := nullif(btrim(coalesce(p->>'modelo', '')), '');
    if v_crudo is distinct from v_u.model and not v_super then
      raise exception 'Solo un supervisor o administrador corrige el modelo de una unidad.'
        using errcode = '42501';
    end if;
    v_modelo := v_crudo;
  end if;

  if p ? 'serial' then
    v_crudo := btrim(coalesce(p->>'serial', ''));
    if v_crudo is distinct from v_u.serial and not v_super then
      raise exception 'Solo un supervisor o administrador corrige el número de serie de una unidad.'
        using errcode = '42501';
    end if;
    if v_crudo = '' then
      raise exception 'Una unidad del almacén necesita número de serie.' using errcode = '22023';
    end if;
    select * into v_otra
      from stock_units
     where id <> v_u.id
       and upper(regexp_replace(serial, '[\s\-_./]', '', 'g'))
         = upper(regexp_replace(v_crudo, '[\s\-_./]', '', 'g'));
    if found then
      raise exception 'El número de serie «%» ya es de otra unidad: %, S/N %.',
        v_crudo, v_otra.articulo, v_otra.serial
        using errcode = '23505';
    end if;
    v_serial := v_crudo;
  end if;

  if p ? 'stock_item_id' then
    v_crudo := nullif(btrim(coalesce(p->>'stock_item_id', '')), '');
    if v_crudo is null then
      -- Una unidad sin artículo que llega sin artículo no cambia: es la fila
      -- entera de una unidad de la hoja de PCs que nunca casó con ninguno.
      -- Quitarle el que tiene sí es un cambio, y no se puede: una unidad del
      -- despacho es de un artículo.
      if v_u.stock_item_id is not null then
        if not v_super then
          raise exception 'Solo un supervisor o administrador cambia el artículo de una unidad.'
            using errcode = '42501';
        end if;
        raise exception 'Elige el artículo del almacén al que pertenece la unidad.'
          using errcode = '22023';
      end if;
    else
      begin
        v_item := v_crudo::uuid;
      exception when invalid_text_representation then
        if not v_super then
          raise exception 'Solo un supervisor o administrador cambia el artículo de una unidad.'
            using errcode = '42501';
        end if;
        raise exception '«%» no es un artículo del almacén.', v_crudo using errcode = '22023';
      end;
      if v_item is distinct from v_u.stock_item_id then
        if not v_super then
          raise exception 'Solo un supervisor o administrador cambia el artículo de una unidad.'
            using errcode = '42501';
        end if;
        select si.name, si.asset_type_id into v_articulo, v_tipo
          from stock_items si
         where si.id = v_item and si.active;
        if not found then
          raise exception 'Ese artículo no existe o está retirado del almacén.' using errcode = '22023';
        end if;
      end if;
    end if;
  end if;

  -- Nada que cambie, nada que escribir: ni fecha de cambio ni fila de auditoría.
  if (v_condicion, v_notas, v_marca, v_modelo, v_serial, v_item, v_articulo, v_tipo)
     is not distinct from
     (v_u.condicion, v_u.notes, v_u.brand, v_u.model, v_u.serial, v_u.stock_item_id,
      v_u.articulo, v_u.asset_type_id) then
    return;
  end if;

  update stock_units
     set condicion     = v_condicion,
         notes         = v_notas,
         brand         = v_marca,
         model         = v_modelo,
         serial        = v_serial,
         stock_item_id = v_item,
         articulo      = v_articulo,
         asset_type_id = v_tipo,
         updated_at    = now()
   where id = v_u.id;
end $$;

comment on function public.stock_unit_editar(uuid, jsonb) is
  'Corrige una unidad del almacén. El personal cambia condicion y observaciones (en blanco = sin observaciones); un supervisor o administrador también marca, modelo, serial (único sin separadores: 23505 con la otra unidad) y stock_item_id (artículo activo: trae su nombre y su tipo). Cambiar lo que no le toca: 42501. Las claves desconocidas se ignoran.';

revoke all on function public.stock_unit_editar(uuid, jsonb) from public, anon;
grant execute on function public.stock_unit_editar(uuid, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 6 — Instalar una unidad en un aula
--
-- Hay dos puertas y una sola instalación:
--
--   - `stock_unit_instalar_en`, la llamada en línea, para quien tiene red;
--   - `stock_unit_installs`, la fila que sube por la cola de salida, para quien
--     está en un sótano.
--
-- Las dos acaban en `instalar_unidad_del_almacen`, que es interna y hace
-- exactamente esto, en una transacción:
--
--   1. Comprueba que la unidad sigue en el almacén, que la sala está viva, que
--      se sabe qué tipo de equipo es y, si se sustituye algo, que lo sustituido
--      está en esa sala y sin retirar. Y saca la unidad del almacén antes de
--      tocar nada más.
--   2. Si se sustituye un equipo, pide su retirada —o reutiliza la que ya
--      estuviera pendiente— con el destino que se diga. Un técnico la deja
--      pedida; un supervisor o un administrador la aprueba ahí mismo, y por el
--      MISMO camino que la bandeja (`decide_asset_removal`), así que sus
--      efectos son los de siempre y no una copia: el equipo sale, el almacén
--      suma si vuelve allí, su unidad vuelve a la estantería. Va antes de crear
--      el equipo nuevo para que este pueda heredar la etiqueta que se libera:
--      el «Puesto 7» que se sustituye deja sitio al «Puesto 7» que llega.
--   3. Busca un equipo con el mismo número de serie, normalizado. Si lo hay
--      —una baja de otro curso, el mismo aparato que vuelve—, es ese: se
--      reutiliza, conserva su id y su histórico y se trae a la sala. Si no, se
--      crea, validado —lo pone el almacén, no es una propuesta— y firmado.
--   4. La etiqueta: la que proponga el cliente si está libre en la sala; si
--      no, la siguiente libre de su tipo (`next_asset_label`, la gemela de
--      `nextLabel()`). Un equipo reutilizado que ya estaba en esta sala con su
--      etiqueta la conserva.
--   5. Apunta el alta en el histórico, descuenta una unidad del artículo —sin
--      tumbar la instalación si el saldo ya estaba a cero, como siempre: el
--      aparato está en el aula igual y el descuadre se arregla en el almacén—
--      y deja la unidad instalada, apuntando al equipo y a la sala.
--   6. Si sustituye algo, lo dice en el histórico de lo sustituido.
--
-- La fecha es la del dispositivo, acotada a ahora: un iPad mal puesto en hora
-- no puede dejar un alta en el año que viene encabezando el Historial (ya pasó
-- con el 2296). En la llamada en línea es `now()`.
--
-- El tipo es el de la unidad o el de su artículo, el VIVO. Sin tipo no hay
-- instalación: un equipo necesita uno, y adivinarlo es lo que hacía el
-- «Ordenador» por defecto de septiembre.
-- -----------------------------------------------------------------------------

create or replace function public.instalar_unidad_del_almacen(
  p_unit      uuid,
  p_room      uuid,
  p_sustituye uuid,
  p_destino   text,
  p_nota      text,
  p_asset_id  uuid,
  p_label     text,
  p_cuando    timestamptz,
  p_quien     uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_u           stock_units%rowtype;
  v_cuando      timestamptz := least(coalesce(p_cuando, now()), now());
  v_destino     text := replace(lower(btrim(coalesce(p_destino, 'almacen'))), 'é', 'e');
  v_nota        text := nullif(btrim(coalesce(p_nota, '')), '');
  v_propuesta   text := nullif(btrim(coalesce(p_label, '')), '');
  v_tipo        uuid;
  v_tipo_nombre text;
  v_donde       text;
  v_previo      assets%rowtype;
  v_viejo       assets%rowtype;
  v_reutiliza   boolean := false;
  v_asset       uuid;
  v_label       text;
  v_motivo      text;
  v_solicitud   uuid;
  v_aprobada    boolean := false;
  v_fin         text;
begin
  -- 1 — Lo que tiene que ser verdad antes de tocar nada.
  select * into v_u from stock_units where id = p_unit for update;
  if not found then
    raise exception 'Esa unidad no existe.' using errcode = '22023';
  end if;
  if v_u.status = 'instalado' then
    select format(' en %s %s', r.code, b.code) into v_donde
      from rooms r
      join zones z     on z.id = r.zone_id
      join buildings b on b.id = z.building_id
     where r.id = v_u.room_id;
    raise exception 'Esa unidad ya no está en el almacén: está instalada%.', coalesce(v_donde, '')
      using errcode = '22023';
  elsif v_u.status <> 'disponible' then
    raise exception 'Esa unidad ya no está en el almacén: está dada de baja.'
      using errcode = '22023';
  end if;

  if p_room is null or not exists (select 1 from rooms where id = p_room and active) then
    raise exception 'Esa sala no existe o está archivada.' using errcode = '22023';
  end if;

  select coalesce(tf.id, t.id), coalesce(tf.name, t.name)
    into v_tipo, v_tipo_nombre
    from asset_types t
    left join asset_types tf on tf.id = t.merged_into
   where t.id = coalesce(v_u.asset_type_id,
                         (select si.asset_type_id from stock_items si where si.id = v_u.stock_item_id));
  if v_tipo is null then
    raise exception 'Este artículo no dice qué tipo de equipo es: enlázalo con un tipo en el almacén.'
      using errcode = '22023';
  end if;

  if v_destino not in ('almacen', 'baja') then
    raise exception 'Lo sustituido va a «baja» o a «almacen», no a «%».', coalesce(p_destino, '')
      using errcode = '22023';
  end if;

  if p_sustituye is not null then
    select * into v_previo from assets where id = p_sustituye for update;
    if not found or v_previo.status = 'retirado' or v_previo.room_id is distinct from p_room then
      raise exception 'El equipo que se sustituye tiene que estar en esa sala y sin retirar.'
        using errcode = '22023';
    end if;
  end if;

  -- El mismo número de serie en otro equipo es este mismo aparato, que ya
  -- constaba: de baja, de vuelta en el almacén, o en otra aula por error.
  select * into v_viejo
    from assets a
   where a.serial is not null
     and upper(regexp_replace(a.serial, '[\s\-_./]', '', 'g'))
       = upper(regexp_replace(v_u.serial, '[\s\-_./]', '', 'g'))
   order by (a.serial = v_u.serial) desc, (a.status <> 'retirado') desc, a.created_at desc
   limit 1
   for update;
  if found then
    v_reutiliza := true;
    v_asset := v_viejo.id;
    if v_asset = p_sustituye then
      raise exception 'Un equipo no se sustituye a sí mismo: ese número de serie es el del equipo que se quita.'
        using errcode = '22023';
    end if;
  end if;

  v_motivo := format('Sustituido por %s S/N %s', v_tipo_nombre, v_u.serial);

  -- La unidad sale del almacén lo primero, y suelta el equipo al que apuntaba
  -- de su vida anterior. Lo que viene detrás mueve unidades por su cuenta —la
  -- aprobación de lo sustituido devuelve al almacén la unidad de un equipo, o
  -- la busca por su número de serie; el disparador del número de serie engancha
  -- las disponibles— y ninguno de los dos puede tomar esta por otra.
  update stock_units
     set status = 'instalado', asset_id = null, room_id = p_room, updated_at = now()
   where id = v_u.id;

  -- 2 — Lo sustituido: la retirada, pedida o decidida.
  if p_sustituye is not null then
    select id into v_solicitud
      from asset_removals
     where asset_id = p_sustituye and state = 'pendiente'
     for update;

    if v_solicitud is null then
      v_solicitud := gen_random_uuid();
      insert into asset_removals (id, asset_id, room_id, destino, reason, requested_at, requested_by)
      values (v_solicitud, p_sustituye, p_room, v_destino, v_motivo, v_cuando, p_quien);
    else
      -- La que ya estaba pedida no se duplica —el índice de una sola viva por
      -- equipo lo impediría, y además sería mentira—: se le pone el destino de
      -- ahora, y el motivo de quien la pidió se respeta.
      update asset_removals
         set destino = v_destino,
             reason  = coalesce(nullif(btrim(reason), ''), v_motivo)
       where id = v_solicitud;
    end if;

    if public.is_supervisor() then
      v_fin := public.decide_asset_removal(v_solicitud, true, v_motivo);
      v_aprobada := true;
      if v_fin = 'almacen_sin_articulo' then
        raise notice 'Lo sustituido vuelve al almacén, pero su tipo no tiene artículo de almacén con el que contarlo.';
      end if;
    end if;
  end if;

  -- 3 y 4 — El equipo, con su etiqueta.
  if v_reutiliza
     and v_viejo.room_id = p_room
     and v_viejo.label is not null
     and not exists (
       select 1 from assets o
        where o.room_id = p_room and o.id <> v_asset and o.status <> 'retirado'
          and o.label is not null and public.norm_text(o.label) = public.norm_text(v_viejo.label)
     ) then
    v_label := v_viejo.label;
  elsif v_propuesta is not null
     and not exists (
       select 1 from assets o
        where o.room_id = p_room and (v_asset is null or o.id <> v_asset) and o.status <> 'retirado'
          and o.label is not null and public.norm_text(o.label) = public.norm_text(v_propuesta)
     ) then
    v_label := v_propuesta;
  else
    v_label := public.next_asset_label(p_room, v_tipo_nombre, v_asset);
  end if;

  if v_reutiliza then
    update assets
       set room_id       = p_room,
           status        = 'instalado',
           asset_type_id = v_tipo,
           label         = v_label,
           brand         = coalesce(v_u.brand, brand),
           model         = coalesce(v_u.model, model)
     where id = v_asset;
  else
    -- El id que propuso el cliente, para que la fila que ya enseña en el aula
    -- sea la misma que baje después. Si ya fuera de otro equipo, que no debería,
    -- uno nuevo: la instalación es real y no se tumba por un identificador.
    v_asset := coalesce(p_asset_id, gen_random_uuid());
    if exists (select 1 from assets where id = v_asset) then
      v_asset := gen_random_uuid();
    end if;
    insert into assets (id, asset_type_id, room_id, label, serial, brand, model,
                        status, confirmed, created_by, created_at)
    values (v_asset, v_tipo, p_room, v_label, v_u.serial, v_u.brand, v_u.model,
            'instalado', true, p_quien, v_cuando);
  end if;

  -- 5 — El alta, el descuento y la unidad. `nota` es lo que lee el Historial de
  -- la sala; `motivo`, lo que escribió la persona, sin el texto fijo, como en
  -- la ficha.
  insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
  values (
    gen_random_uuid(), v_asset, p_room, 'alta', v_cuando, p_quien,
    jsonb_build_object(
      'source',    'stock_units',
      'unidad',    v_u.id,
      'serial',    v_u.serial,
      'condicion', v_u.condicion,
      'nota',      coalesce(v_nota, format('Desde el almacén: %s, S/N %s', v_u.articulo, v_u.serial)),
      'motivo',    v_nota,
      'sustituye', p_sustituye
    )
  );

  if v_u.stock_item_id is not null then
    begin
      insert into stock_movements (id, stock_item_id, qty, kind, room_id, occurred_at, by_user, source, note)
      values (gen_random_uuid(), v_u.stock_item_id, -1, 'consumo', p_room, v_cuando, p_quien, 'app',
              format('Unidad S/N %s instalada', v_u.serial));
    exception when others then
      raise warning 'No se pudo descontar la unidad % del almacén: %', v_u.serial, sqlerrm;
    end;
  end if;

  update stock_units
     set status       = 'instalado',
         asset_id     = v_asset,
         room_id      = p_room,
         installed_at = v_cuando,
         retired_at   = null,
         updated_at   = now()
   where id = v_u.id;

  -- 6 — Y lo sustituido lo cuenta en su histórico.
  if p_sustituye is not null then
    insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
    values (
      gen_random_uuid(), p_sustituye, p_room, 'sustitucion', v_cuando, p_quien,
      jsonb_build_object('source', 'stock_units', 'por', v_asset, 'serial', v_u.serial, 'nota', v_motivo)
    );
    -- La baja que acaba de escribir la aprobación dice de dónde vino, como la
    -- de la ficha: es lo que lee la lista de movimientos.
    if v_aprobada then
      update asset_events
         set meta = meta || jsonb_build_object('source', 'stock_units', 'por', v_asset)
       where asset_id = p_sustituye
         and kind = 'baja'
         and meta ->> 'solicitud' = v_solicitud::text;
    end if;
  end if;

  return v_asset;
end $$;

comment on function public.instalar_unidad_del_almacen(uuid, uuid, uuid, text, text, uuid, text, timestamptz, uuid) is
  'Interna: la instalación de una unidad del almacén en un aula, común a stock_unit_instalar_en y a stock_unit_installs. Reutiliza el equipo con el mismo número de serie o crea uno validado, deja el alta, descuenta el artículo, instala la unidad y, si sustituye un equipo, pide su retirada (la aprueba si quien instala es supervisor).';

revoke all on function public.instalar_unidad_del_almacen(uuid, uuid, uuid, text, text, uuid, text, timestamptz, uuid)
  from public, anon, authenticated;

/**
 * Instalar una unidad del almacén en un aula, en línea. Devuelve el id del
 * equipo que queda en la sala —el nuevo o el reutilizado—.
 *
 * Lo puede hacer el personal: son los técnicos los que ponen el aparato. Lo
 * que el técnico no puede es retirar lo sustituido sin que nadie lo autorice:
 * eso lo decide `instalar_unidad_del_almacen` por el rol de quien llama.
 */
create or replace function public.stock_unit_instalar_en(
  p_unit      uuid,
  p_room      uuid,
  p_sustituye uuid default null,
  p_destino   text default 'almacen',
  p_nota      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'Solo el personal instala unidades del almacén.'
      using errcode = '42501';
  end if;
  return public.instalar_unidad_del_almacen(
    p_unit, p_room, p_sustituye, p_destino, p_nota, null, null, now(), (select auth.uid()));
end $$;

comment on function public.stock_unit_instalar_en(uuid, uuid, uuid, text, text) is
  'Instala una unidad disponible del almacén en una sala activa: reutiliza el equipo con su número de serie o crea uno, deja el alta, descuenta el artículo y deja la unidad instalada. Con p_sustituye pide la retirada de ese equipo (destino almacen o baja): pendiente si llama un técnico, aprobada si llama un supervisor. Devuelve el id del equipo.';

revoke all on function public.stock_unit_instalar_en(uuid, uuid, uuid, text, text) from public, anon;
grant execute on function public.stock_unit_instalar_en(uuid, uuid, uuid, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 6c — La instalación que sube por la cola
--
-- El mismo patrón que `incident_resolutions` (`20260818000100`), y por lo
-- mismo: la cola de salida solo sabe hacer bien una cosa, insertar una fila que
-- ya nació con su identidad. La fila es la petición —qué unidad, a qué sala,
-- qué sustituye, con qué id y qué etiqueta la enseña ya el cliente— y un
-- disparador la convierte en la instalación.
--
-- Y aquí hay una trampa que no tiene el cierre de incidencia: la cola sube esta
-- fila con `on conflict (id) do nothing`, para que el reenvío de una que ya
-- llegó no haga nada. Un disparador BEFORE INSERT se ejecuta también para la
-- fila que luego choca y se descarta, así que un reenvío volvería a instalar
-- —y fallaría, porque la unidad ya no está en el almacén—. El disparador es
-- AFTER INSERT, que solo corre para las filas que de verdad entran: el reenvío
-- es un no-op silencioso, que es la verdad, porque la instalación ya está.
--
-- A diferencia del cierre, aquí una instalación imposible SÍ se rechaza, con
-- su motivo: una unidad que otro ya instaló, una sala archivada. Guardar la
-- petición sin hacerla dejaría al técnico creyendo que el aparato consta en el
-- aula, y la pantalla de pendientes es donde tiene que verlo.
--
-- `result_asset_id` lo escribe el disparador: es el equipo que quedó en la
-- sala, que no siempre es el que propuso el cliente —si el número de serie ya
-- era de un equipo, se reutiliza ese y conserva su id—.
--
-- Solo-alta: el personal inserta lo suyo y lee; nadie actualiza ni borra. La
-- fecha del dispositivo se guarda tal cual llegó, y lo que se copia al
-- histórico y al almacén va acotado a ahora.
-- -----------------------------------------------------------------------------

create table if not exists stock_unit_installs (
  -- uuid v7 del cliente: es la clave de idempotencia de la cola.
  id              uuid primary key,
  unit_id         uuid not null references stock_units(id),
  -- Si la sala se borra —solo se puede sin histórico—, la petición se va con
  -- ella; archivarla, que es lo normal, no le hace nada.
  room_id         uuid not null references rooms(id) on delete cascade,
  -- El id que el cliente le propone al equipo. Solo se usa si hay que crearlo.
  asset_id        uuid,
  -- La etiqueta que el cliente propone: si está libre en la sala, esa.
  label           text,
  sustituye       uuid references assets(id) on delete set null,
  destino         text not null default 'almacen' check (destino in ('almacen', 'baja')),
  nota            text,
  by_user         uuid not null default auth.uid() references profiles(id),
  -- El reloj del dispositivo: cuándo se instaló de verdad, aunque suba el lunes.
  occurred_at     timestamptz not null,
  -- Y el del servidor, para poder distinguir lo uno de lo otro.
  recorded_at     timestamptz not null default now(),
  result_asset_id uuid references assets(id) on delete set null
);

comment on table stock_unit_installs is
  'Peticiones de instalar una unidad del almacén en un aula, una por fila y con id de cliente. Suben por la cola de salida; un disparador AFTER INSERT hace la instalación (la misma que stock_unit_instalar_en) y apunta en result_asset_id el equipo que quedó en la sala. Solo-alta.';

create index if not exists stock_unit_installs_unit_idx
  on stock_unit_installs (unit_id);

alter table stock_unit_installs enable row level security;

drop policy if exists "personal lee instalaciones de unidades" on stock_unit_installs;
create policy "personal lee instalaciones de unidades" on stock_unit_installs
  for select to authenticated using ((select public.is_staff()));

drop policy if exists "personal pide instalar unidades" on stock_unit_installs;
create policy "personal pide instalar unidades" on stock_unit_installs
  for insert to authenticated
  with check (
    (select public.is_staff())
    -- Firmada por quien la sube. Sin esto, instalar en nombre de otro sería un
    -- campo del formulario.
    and by_user = (select auth.uid())
  );

-- No hay política de UPDATE ni de DELETE, y los permisos lo dicen también: una
-- petición escrita no se reescribe. `on conflict do nothing` no necesita
-- UPDATE, así que la cola no lo echa de menos.
revoke all on public.stock_unit_installs from anon;
revoke update, delete, truncate on public.stock_unit_installs from authenticated;
grant select, insert on public.stock_unit_installs to authenticated;

create or replace function public.aplicar_instalacion_de_unidad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_asset uuid;
begin
  v_asset := public.instalar_unidad_del_almacen(
    new.unit_id, new.room_id, new.sustituye, new.destino, new.nota,
    new.asset_id, new.label, new.occurred_at, new.by_user);

  update stock_unit_installs set result_asset_id = v_asset where id = new.id;
  return null;
end $$;

comment on function public.aplicar_instalacion_de_unidad() is
  'Disparador AFTER INSERT de stock_unit_installs: hace la instalación pedida y apunta el equipo resultante. Al ser AFTER, el reenvío con on conflict do nothing no lo dispara.';

revoke all on function public.aplicar_instalacion_de_unidad() from public, anon, authenticated;

drop trigger if exists stock_unit_installs_instalan on stock_unit_installs;
create trigger stock_unit_installs_instalan
  after insert on stock_unit_installs
  for each row execute function public.aplicar_instalacion_de_unidad();

-- -----------------------------------------------------------------------------
-- 7 — La unidad sale del almacén cuando su número de serie llega a un aula
--
-- Por cualquier camino: un técnico con una aplicación vieja que apunta el
-- aparato a mano con su número de serie, la sincronización del Excel que trae
-- el inventario de un aula, un equipo dado de baja que vuelve. El número de
-- serie va grabado en el aparato; si está en un aula, no está en la
-- estantería, y la unidad que lo nombra pasa a instalada y apunta a ese equipo.
--
-- Solo toca unidades `disponible`: una de baja es una decisión de un
-- administrador, y una instalada ya dice dónde está. Y no apunta ningún
-- movimiento: quien trae el aparato desde el almacén por la aplicación vieja
-- ya pone en la cola su −1, y descontar aquí lo descontaría dos veces.
--
-- Convive con las instalaciones de arriba sin estorbarse. Cuando el equipo lo
-- crea `stock_unit_instalar`, este disparador encuentra la unidad todavía
-- disponible y la instala, y la función la vuelve a escribir un instante
-- después con lo mismo y su nota. `instalar_unidad_del_almacen` ya la ha sacado
-- del almacén antes de crear el equipo, así que aquí no la encuentra.
-- -----------------------------------------------------------------------------

create or replace function public.stock_unit_se_instala_por_su_serie()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.serial is null or new.status = 'retirado' or new.room_id is null then
    return null;
  end if;

  update stock_units
     set status       = 'instalado',
         asset_id     = new.id,
         room_id      = new.room_id,
         installed_at = coalesce(installed_at, now()),
         updated_at   = now()
   where status = 'disponible'
     and upper(regexp_replace(serial, '[\s\-_./]', '', 'g'))
       = upper(regexp_replace(new.serial, '[\s\-_./]', '', 'g'));

  return null;
end $$;

comment on function public.stock_unit_se_instala_por_su_serie() is
  'Disparador de assets: cuando un equipo no retirado con sala lleva el número de serie de una unidad disponible, la unidad pasa a instalada y apunta a él. No apunta movimiento de almacén.';

revoke all on function public.stock_unit_se_instala_por_su_serie() from public, anon, authenticated;

drop trigger if exists stock_unit_se_instala_por_su_serie on assets;
create trigger stock_unit_se_instala_por_su_serie
  after insert or update of serial, room_id, status on assets
  for each row execute function public.stock_unit_se_instala_por_su_serie();

-- -----------------------------------------------------------------------------
-- 8 — La vuelta al almacén
--
-- Tres piezas, y las tres son de las de siempre con un añadido:
--
-- 8a — `stock_unit_sigue_al_equipo`. Lo de septiembre —el equipo se retira al
--      almacén y su unidad vuelve a `disponible`; se da de baja y su unidad
--      también— y dos cosas más:
--
--        - Lo que vuelve de un aula vuelve **usado**: si estaba «nuevo» o «sin
--          indicar», ya no lo está. Lo reacondicionado y lo averiado se quedan
--          como estaban, porque eso sí lo dijo alguien. Y deja de tener fecha de
--          instalación, que es la de un sitio donde ya no está.
--        - Si el número de serie de la unidad sigue en otro equipo vivo de un
--          aula, la unidad sigue a ESE equipo y no se mueve. Es lo que pasa al
--          fusionar un duplicado: la fila que se retira le pasa su número de
--          serie a la que se queda, el aparato sigue encima de la mesa, y hasta
--          hoy su unidad acababa «de baja».
--
-- 8b — `decide_asset_removal`. La unidad que no existía: cuando se aprueba una
--      retirada AL ALMACÉN de un equipo con número de serie y sin unidad, la
--      unidad nace —disponible, usada, en el mismo artículo que acaba de sumar
--      el +1— o, si ya había una con ese número que no está instalada, vuelve.
--      Va en la decisión y no en el disparador genérico a propósito: el
--      disparador ve igual una retirada al almacén que la sustitución vieja
--      de `stock_unit_instalar` o el equipo que pierde la sala por otro
--      motivo, y una unidad solo debe nacer cuando alguien ha autorizado que
--      el aparato vuelva a la estantería. Una fusión, un descarte o un borrado
--      no crean nada. `asset_dar_de_baja` pasa por aquí, así que la ficha
--      también lo hace.
--
-- 8c — `reject_asset`. Descartar un equipo sin validar —que es decir «esta
--      fila no debió existir»— devuelve al almacén la unidad que el disparador
--      del punto 7 le hubiera enganchado por el número de serie. Sin esto, la
--      unidad acababa de baja (si el equipo se retiraba) o instalada en ningún
--      equipo (si se borraba), y ninguna de las dos tiene vuelta desde la
--      aplicación. No apunta movimiento: no se sabe si alguien llegó a sacar
--      el aparato de la estantería, y el almacén se cuadra donde se cuadra.
-- -----------------------------------------------------------------------------

/**
 * Cuando el equipo de una unidad se retira, la unidad lo sigue: al almacén
 * (`room_id` a null, que es lo que deja la retirada con destino «almacén») vuelve
 * a `disponible` y usada; a la baja, `baja`. Salvo que su número de serie siga
 * en otro equipo vivo de un aula: entonces sigue a ese.
 */
create or replace function public.stock_unit_sigue_al_equipo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  u      record;
  v_otro uuid;
  v_sala uuid;
begin
  if new.status = 'retirado' and old.status is distinct from 'retirado' then
    for u in
      select su.id, su.serial
        from stock_units su
       where su.asset_id = new.id and su.status = 'instalado'
         for update
    loop
      v_otro := null;
      select a.id, a.room_id into v_otro, v_sala
        from assets a
       where a.id <> new.id
         and a.status <> 'retirado'
         and a.room_id is not null
         and a.serial is not null
         and upper(regexp_replace(a.serial, '[\s\-_./]', '', 'g'))
           = upper(regexp_replace(u.serial, '[\s\-_./]', '', 'g'))
       order by a.created_at desc
       limit 1;

      if v_otro is not null then
        update stock_units
           set asset_id = v_otro, room_id = v_sala, updated_at = now()
         where id = u.id;
      else
        update stock_units
           set status       = case when new.room_id is null then 'disponible' else 'baja' end,
               condicion    = case
                                when new.room_id is null and condicion in ('nuevo', 'sin_indicar') then 'usado'
                                else condicion
                              end,
               room_id      = null,
               installed_at = case when new.room_id is null then null else installed_at end,
               retired_at   = case when new.room_id is null then null else now() end,
               updated_at   = now()
         where id = u.id;
      end if;
    end loop;
  end if;
  return new;
end $$;

comment on function public.stock_unit_sigue_al_equipo() is
  'Disparador de assets: al retirarse un equipo, su unidad instalada vuelve al almacén (disponible, y usada si era nuevo o sin_indicar) o pasa a baja si el equipo conserva la sala. Si su número de serie sigue en otro equipo vivo de un aula —una fusión—, sigue a ese.';

revoke all on function public.stock_unit_sigue_al_equipo() from public, anon, authenticated;

/**
 * Autorizar o rechazar una retirada.
 *
 * Lo de siempre (`20260730000400`), sin un cambio en lo que ya hacía ni en lo
 * que devuelve —«rechazada», «baja», «almacen», «almacen_sin_articulo»—: retirar
 * el equipo, dejar el evento en el histórico de la sala, ingresar la unidad en
 * el artículo si vuelve al almacén y cerrar la solicitud. Y al final, con
 * destino almacén, la unidad con nombre del punto 8b.
 */
create or replace function public.decide_asset_removal(
  p_id      uuid,
  p_aprobar boolean,
  p_note    text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  s             record;
  v_type        uuid;
  v_item        uuid;
  v_item_nombre text;
  v_evento      uuid := gen_random_uuid();
  v_yo          uuid := (select auth.uid());
  v_equipo      assets%rowtype;
  v_unidad      stock_units%rowtype;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador autoriza una retirada'
      using errcode = 'insufficient_privilege';
  end if;

  select * into s from asset_removals where id = p_id;
  if s.id is null then
    raise exception 'Esa solicitud ya no existe';
  end if;
  if s.state <> 'pendiente' then
    raise exception 'Esa solicitud ya está %', s.state;
  end if;

  if not p_aprobar then
    update asset_removals
       set state = 'rechazada', decided_at = now(), decided_by = v_yo, decision_note = p_note
     where id = p_id;
    return 'rechazada';
  end if;

  -- El tipo se resuelve siguiendo las fusiones: si el catálogo se agrupó por
  -- medio, el artículo de almacén cuelga del tipo bueno y no de la lápida.
  select coalesce(t.merged_into, t.id) into v_type
    from assets a join asset_types t on t.id = a.asset_type_id
   where a.id = s.asset_id;

  update assets
     set status = 'retirado',
         -- De baja conserva la sala: el aparato ya no existe, y dónde estuvo es
         -- lo único que queda de él. El que vuelve al almacén sí la pierde,
         -- porque físicamente ya no está en ninguna.
         room_id = case when s.destino = 'almacen' then null else room_id end
   where id = s.asset_id;

  -- La `room_id` va en el evento y no se deja deducir del equipo: con destino
  -- almacén el equipo se queda sin sala, y `room_timeline` colgaría la baja de
  -- ninguna parte.
  insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
  values (
    v_evento, s.asset_id, s.room_id, 'baja', now(), v_yo,
    jsonb_build_object(
      'destino', s.destino,
      'solicitud', s.id,
      'solicitado_por', s.requested_by,
      'nota', coalesce(nullif(btrim(coalesce(p_note, '')), ''), s.reason)
    )
  );

  update asset_removals
     set state = 'aprobada', decided_at = now(), decided_by = v_yo, decision_note = p_note
   where id = p_id;

  if s.destino <> 'almacen' then
    return 'baja';
  end if;

  select id, name into v_item, v_item_nombre
    from stock_items
   where asset_type_id = v_type and active
   order by name
   limit 1;

  -- `devolucion` y no `compra`: no ha entrado nada nuevo en el centro, ha vuelto
  -- algo que ya era suyo. La sala queda anotada, que es lo que permite leer el
  -- movimiento como «salió de allí» en vez de como una entrada sin origen.
  if v_item is not null then
    insert into stock_movements (id, stock_item_id, qty, kind, room_id, occurred_at, by_user, note)
    values (
      gen_random_uuid(), v_item, 1, 'devolucion', s.room_id, now(), v_yo,
      'Devuelto desde el aula al retirar un equipo'
    );
  end if;

  -- La unidad con nombre. Si el equipo ya tenía la suya, la ha devuelto
  -- `stock_unit_sigue_al_equipo` al retirarlo, y aquí no hay nada que hacer.
  select * into v_equipo from assets where id = s.asset_id;
  if v_equipo.serial is not null
     and not exists (select 1 from stock_units where asset_id = s.asset_id) then
    select * into v_unidad
      from stock_units
     where upper(regexp_replace(serial, '[\s\-_./]', '', 'g'))
         = upper(regexp_replace(v_equipo.serial, '[\s\-_./]', '', 'g'))
     for update;

    if not found then
      insert into stock_units (stock_item_id, asset_type_id, articulo, brand, model, serial,
                               status, condicion, asset_id, source)
      values (v_item, v_type,
              coalesce(v_item_nombre, (select name from asset_types where id = v_type), 'Equipo'),
              v_equipo.brand, v_equipo.model, v_equipo.serial,
              'disponible', 'usado', s.asset_id, 'retirada');
    elsif v_unidad.status <> 'instalado' then
      -- Ya constaba —de baja, o en el almacén sin equipo— y el aparato vuelve
      -- a estar en la estantería: es esa unidad, no otra.
      update stock_units
         set status        = 'disponible',
             asset_id      = s.asset_id,
             room_id       = null,
             retired_at    = null,
             installed_at  = null,
             condicion     = case when condicion in ('nuevo', 'sin_indicar') then 'usado' else condicion end,
             stock_item_id = coalesce(stock_item_id, v_item),
             asset_type_id = coalesce(asset_type_id, v_type),
             updated_at    = now()
       where id = v_unidad.id;
    end if;
    -- Instalada con otro equipo: esa fila dice dónde está el aparato, y no se
    -- le enmienda la plana desde aquí.
  end if;

  return case when v_item is null then 'almacen_sin_articulo' else 'almacen' end;
end;
$$;

comment on function public.decide_asset_removal(uuid, boolean, text) is
  'Autoriza o rechaza una retirada. Al aprobar retira el equipo y, si vuelve al almacén, ingresa la unidad en su artículo y, si el equipo tiene número de serie y no tiene unidad, la crea (o devuelve la que hubiera con ese número) disponible y usada.';

grant execute on function public.decide_asset_removal(uuid, boolean, text) to authenticated;

/**
 * Descartar un equipo sin validar. Devuelve «borrado» o «retirado» según
 * cuelgue algo de él. Lo de `20260730000400`, y antes de nada devuelve al
 * almacén la unidad que se le hubiera enganchado por su número de serie.
 */
create or replace function public.reject_asset(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_confirmed boolean;
  v_atado boolean;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador descarta equipos'
      using errcode = 'insufficient_privilege';
  end if;

  select confirmed into v_confirmed from assets where id = p_id;
  if v_confirmed is null then
    raise exception 'Ese equipo ya no existe';
  end if;
  if v_confirmed then
    raise exception 'Ese equipo ya está validado: para sacarlo de la sala hace falta una solicitud de retirada';
  end if;

  -- Antes de retirarlo o borrarlo: si no, la retirada mandaría la unidad a la
  -- baja y el borrado la dejaría instalada en ningún equipo.
  update stock_units
     set status = 'disponible', asset_id = null, room_id = null,
         installed_at = null, updated_at = now()
   where asset_id = p_id and status = 'instalado';

  select exists (select 1 from inspection_checks where check_key = 'asset:' || p_id::text)
      or exists (select 1 from asset_events where asset_id = p_id)
      or exists (select 1 from incidents where asset_id = p_id)
    into v_atado;

  if v_atado then
    update assets set status = 'retirado' where id = p_id;
    return 'retirado';
  end if;

  -- El rastro no se pierde: `assets` lleva disparador de auditoría desde el
  -- principio, así que el borrado deja fila con autor y con la fila entera de
  -- antes en `old_data`.
  delete from assets where id = p_id;
  return 'borrado';
end;
$$;

comment on function public.reject_asset(uuid) is
  'Descarta un equipo sin validar. Devuelve «borrado» o «retirado» según cuelgue algo de él. La unidad del almacén que se le hubiera enganchado por su número de serie vuelve a disponible.';

grant execute on function public.reject_asset(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 9 — El Historial no cuenta dos veces la unidad que llega del almacén
--
-- `room_timeline` cuenta el alta de un equipo de dos maneras: por la fila —todo
-- equipo apuntado por alguien (`created_by`) tiene su «alta» en la fecha de
-- `created_at`— y por los eventos. La ficha ya se encontró con esto ayer y lo
-- resolvió para lo suyo (`20261027000100`): gana el evento, que es el que lleva
-- la nota, y la fila se calla.
--
-- La instalación desde el almacén tiene las dos cosas —el equipo nuevo nace
-- firmado por quien lo instala, y su alta lleva la unidad y la nota—, así que
-- el remedio es el mismo, ampliado a `source = 'stock_units'`. Y arregla de
-- paso lo que ya pasaba con el equipo reutilizado: uno que un técnico apuntó
-- hace un año en otra aula, se retiró y vuelve ahora del almacén, salía con su
-- alta de hace un año colgada de la sala nueva.
--
-- La vista va entera porque `create or replace view` no sabe sustituir media
-- definición, copiada sin un cambio de `20261027000100` salvo esa condición.
-- -----------------------------------------------------------------------------

create or replace view room_timeline as
with eventos as (

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

-- …y el cierre, como fila propia.
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
  -- La palabra que distingue una revisión de una corrección. `status` aquí es
  -- siempre 'completa' —la vista solo trae cerradas— así que no se pierde nada.
  case when ins.corrects is null then ins.status::text else 'corregida' end,
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
from inspections_vigentes ins

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
select
  a.id,
  'equipo',
  'alta',
  a.room_id,
  a.created_at,
  coalesce(a.label, t.name, 'Equipo'),
  nullif(concat_ws(' · ', a.model, a.serial), ''),
  null::int,
  a.created_by,
  a.serial,
  a.status::text
from assets a
left join asset_types t on t.id = a.asset_type_id
where a.room_id is not null and a.created_by is not null
  -- La entrada registrada desde la ficha y la unidad que llega del almacén ya
  -- cuentan su alta con un evento, con su nota: sin esto saldrían dos veces.
  -- Ver la cabecera de este bloque.
  and not exists (
    select 1 from asset_events x
     where x.asset_id = a.id and x.kind = 'alta'
       and x.meta ->> 'source' in ('ficha', 'stock_units')
  )

union all

-- Equipos: lo que les pasa después ------------------------------------------
select
  ae.id,
  'equipo',
  ae.kind::text,
  coalesce(ae.room_id, a.room_id),
  ae.occurred_at,
  coalesce(a.label, t.name, 'Equipo'),
  nullif(ae.meta ->> 'nota', ''),
  null::int,
  ae.by_user,
  a.serial,
  ae.kind::text
from asset_events ae
join assets a on a.id = ae.asset_id
left join asset_types t on t.id = a.asset_type_id
where coalesce(ae.room_id, a.room_id) is not null

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
left join public.nombres_del_personal() p on p.id = e.by_user;

alter view room_timeline set (security_invoker = on);

comment on view room_timeline is
  'El Historial de una sala: incidencias, revisiones, material, equipos e inventarios, firmados con el nombre de quien los hizo. El alta de un equipo registrado desde la ficha o instalado desde el almacén se cuenta una sola vez, por su evento.';

-- PostgREST cachea el esquema: sin esto, la tabla, la vista y las funciones
-- nuevas no existen para la aplicación hasta que alguien reinicie el servicio.
notify pgrst, 'reload schema';
