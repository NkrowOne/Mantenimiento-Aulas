-- reejecutable: si
--
-- Todo lo que hay aquí da lo mismo la segunda vez que la primera: `add column
-- if not exists`, `drop constraint if exists` y `add constraint` en la misma
-- sentencia, `create unique index if not exists`, `create or replace`, `drop
-- trigger if exists` delante de cada `create trigger`, `comment`, `grant` y
-- `revoke`, y `alter view … set (security_invoker = on)`. Ni un `update` de
-- datos: las columnas nacen vacías y se quedan vacías hasta que alguien las
-- rellena con el papel de la compra delante. La deducción automática no se fía
-- del `alter view` —y en general hace bien—, así que se dice aquí.
-- =============================================================================
-- El inventario lleva su ficha
--
-- Hasta aquí un equipo era un tipo, una sala, una etiqueta y, con suerte, una
-- marca, un modelo y un número de serie. Eso basta para revisar un aula y no
-- basta para gestionar un parque: cuándo se compró, a quién, por cuánto, hasta
-- cuándo tiene garantía, cuándo deja de tener sentido repararlo y —en los
-- ordenadores— cómo se llama en la red y qué lleva dentro. Son las preguntas
-- que se hacen desde un despacho, y hasta hoy las contestaba un Excel aparte
-- que nadie cruzaba con el inventario.
--
-- Cuatro piezas:
--
--  1. **Las columnas.** Quince en `assets` y una en `asset_types` (la vida útil
--     del tipo: «los ordenadores, cinco años»). Todas admiten el hueco y
--     ninguna se rellena a posteriori: inventar una fecha de compra plausible
--     sería fabricar justo el dato que se está pidiendo.
--
--  2. **La puerta.** Los datos de compra y de la ficha los escribe un
--     supervisor o un administrador, no el técnico desde el aula. Y la puerta
--     se cierra sin tocar lo que el técnico ya hace: la cola de salida sube
--     `id, asset_type_id, room_id, label, serial, brand, model, status,
--     created_by` y nada más, y eso tiene que seguir entrando igual.
--
--  3. **Dos vistas.** El registro —un equipo por fila, retirados incluidos, con
--     su ficha y su estado de vida— y los movimientos —un evento por fila, con
--     el nombre de quien lo firmó—. Son lo que se exporta y lo que se filtra.
--
--  4. **Cuatro operaciones del despacho.** Registrar una entrada, dar de baja,
--     trasladar y fijar la vida útil de un tipo. Van como RPC porque cada una
--     son varias escrituras que pasan juntas o no pasan, y la baja **reutiliza**
--     el camino de siempre —solicitud y autorización— en vez de copiarlo: dos
--     maneras de dar de baja que hacen cosas distintas acaban, con el tiempo,
--     en un almacén que no cuadra.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — Las columnas de la ficha
--
-- `ip_address` va como texto y no como `inet` a propósito: lo que se apunta es
-- lo que dice la etiqueta del equipo o el DHCP, a veces con la máscara, a veces
-- «dinámica», y un tipo estricto convierte cada una de esas en un rechazo en
-- vez de en un dato. La MAC llega ya normalizada desde la pantalla.
--
-- `purchase_price` en `numeric(12,2)`: es dinero, y en coma flotante 0,1 + 0,2
-- no da 0,3. El `check` impide un precio negativo; un precio cero sí vale —un
-- equipo cedido o donado tiene precio cero y es un dato, no un hueco—.
-- -----------------------------------------------------------------------------

alter table assets
  add column if not exists inventory_tag  text,
  add column if not exists acquired_at    date,
  add column if not exists supplier       text,
  add column if not exists purchase_price numeric(12,2),
  add column if not exists purchase_ref   text,
  add column if not exists warranty_until date,
  add column if not exists end_of_life    date,
  add column if not exists hostname       text,
  add column if not exists mac_address    text,
  add column if not exists ip_address     text,
  add column if not exists cpu            text,
  add column if not exists ram            text,
  add column if not exists storage        text,
  add column if not exists os             text,
  add column if not exists notes          text;

alter table assets
  drop constraint if exists assets_precio_no_negativo,
  add constraint assets_precio_no_negativo check (purchase_price >= 0);

comment on column assets.inventory_tag is
  'Número de inventario o etiqueta patrimonial del equipo. Único sin contar mayúsculas, espacios, guiones, puntos ni barras.';
comment on column assets.acquired_at is
  'Fecha de adquisición. Con la vida útil del tipo da el fin de vida calculado.';
comment on column assets.supplier is
  'Proveedor que lo vendió o lo suministró.';
comment on column assets.purchase_price is
  'Precio de compra en euros, con dos decimales. Cero vale (cedido, donado); negativo no.';
comment on column assets.purchase_ref is
  'Referencia de la compra: número de pedido, de factura o de expediente.';
comment on column assets.warranty_until is
  'Último día de garantía. La vista asset_registry dice si sigue en garantía hoy.';
comment on column assets.end_of_life is
  'Fin de vida útil fijado a mano. Gana sobre el calculado (adquisición + vida útil del tipo).';
comment on column assets.hostname is
  'Nombre del equipo en la red.';
comment on column assets.mac_address is
  'Dirección MAC, ya normalizada por la pantalla (AA:BB:CC:DD:EE:FF).';
comment on column assets.ip_address is
  'Dirección IP tal como se apunta. Texto y no inet: a veces lleva la máscara o dice «dinámica».';
comment on column assets.cpu is
  'Procesador, tal como lo describe la ficha del fabricante.';
comment on column assets.ram is
  'Memoria, con su unidad («16 GB»).';
comment on column assets.storage is
  'Almacenamiento, con su unidad y su tipo («512 GB SSD»).';
comment on column assets.os is
  'Sistema operativo y versión.';
comment on column assets.notes is
  'Observaciones de la ficha: lo que no cabe en ninguna otra columna.';

-- -----------------------------------------------------------------------------
-- La vida útil, en el tipo
--
-- Va en el tipo y no en cada equipo porque es una política, no un dato del
-- aparato: «los proyectores se renuevan a los ocho años» se decide una vez y
-- vale para los ciento setenta. El equipo que se muere antes lleva su
-- `end_of_life` a mano, que gana.
--
-- Nace vacía en todos los tipos, también en los que ya existen. Poner cinco
-- años a los ordenadores «porque es lo normal» sería decidir por el
-- administrador una cifra que aparece en un informe de renovación.
-- -----------------------------------------------------------------------------

alter table asset_types
  add column if not exists vida_util_anyos int;

alter table asset_types
  drop constraint if exists asset_types_vida_util_rango,
  add constraint asset_types_vida_util_rango check (vida_util_anyos between 1 and 50);

comment on column asset_types.vida_util_anyos is
  'Años de vida útil de los equipos de este tipo. Vacía = sin política: sus equipos salen «sin datos» salvo que lleven fin de vida a mano.';

-- -----------------------------------------------------------------------------
-- Un número de inventario es de un solo equipo
--
-- Con la misma normalización que `stock_units_serial_idx`, porque se teclea
-- igual de mal: «INV-2024/0031», «inv 2024 0031» e «INV20240031» son la misma
-- pegatina. Y SIN excluir los retirados, a diferencia de la etiqueta de sala:
-- la pegatina patrimonial va con el aparato para siempre, y que un equipo dado
-- de baja la libere permitiría poner a otro el número de uno que sigue en el
-- inventario contable.
-- -----------------------------------------------------------------------------

create unique index if not exists assets_inventory_tag_idx
  on assets (upper(regexp_replace(inventory_tag, '[\s\-_./]', '', 'g')))
  where inventory_tag is not null;

-- -----------------------------------------------------------------------------
-- 2 — La puerta: los datos de compra y de la ficha son del despacho
--
-- No se puede cerrar con la política de UPDATE de `assets`, por lo mismo que no
-- se pudo con `confirmed` (`20260730000100`): esa política tiene que seguir
-- dejando que el técnico corrija la etiqueta, la marca, el modelo, el número de
-- serie y el estado. Una política no sabe qué columnas cambian; un disparador
-- sí.
--
-- La diferencia con `assets_confirmed_guard` es que este **rechaza** en vez de
-- revertir en silencio. Allí revertir era lo correcto —el técnico no pretende
-- validar nada, y la fila tiene que entrar—; aquí quien escribe un precio está
-- intentando apuntar un precio, y guardar la fila sin él sería decirle que sí
-- y no hacerlo. Con 42501 el error es el mismo que da la RLS, y la cola de
-- salida ya sabe que eso no se arregla reintentando.
--
-- Y se aparta exactamente igual que aquel: `auth_role() = 'none'` es una sesión
-- sin token —una migración, el importador, `psql`—, que ya tiene la llave de la
-- base entera. A quien hay que frenar es al técnico autenticado, que sí trae
-- rol. Las funciones `security definer` no cambian eso: la llamada conserva los
-- claims de quien la hace, así que las operaciones del despacho de abajo pasan
-- porque las llama un supervisor, no porque se salten la puerta.
--
-- Qué no rompe, que es lo que importa:
--
--   - El alta y la corrección desde el aula. La cola sube solo las columnas de
--     siempre, y un `insert … on conflict do update` de PostgREST solo pone en
--     el `set` las que vienen en el cuerpo: las de la ficha llegan al
--     disparador con el valor que ya tenían, y `is distinct from` dice que no
--     ha cambiado nada.
--   - Las funciones que el técnico llama y que escriben en `assets`
--     (`stock_unit_instalar`, la retirada, la fusión): ninguna toca estas
--     columnas.
--
-- De paso, lo que llega en blanco se guarda como hueco. Un campo vaciado en la
-- pantalla puede llegar como cadena vacía, y dos números de inventario vacíos
-- chocarían en el índice único de arriba con un error que no explicaría nada.
--
-- El nombre lo coloca entre `assets_confirmed_guard` y `assets_label_libre` por
-- orden alfabético, y detrás va `assets_updated_at`, que tiene que ver la fila
-- ya limpia: así un espacio que se vuelve hueco no cuenta como cambio.
-- -----------------------------------------------------------------------------

create or replace function public.assets_ficha_guard()
returns trigger
language plpgsql
as $$
begin
  new.inventory_tag := nullif(btrim(new.inventory_tag), '');
  new.supplier      := nullif(btrim(new.supplier), '');
  new.purchase_ref  := nullif(btrim(new.purchase_ref), '');
  new.hostname      := nullif(btrim(new.hostname), '');
  new.mac_address   := nullif(btrim(new.mac_address), '');
  new.ip_address    := nullif(btrim(new.ip_address), '');
  new.cpu           := nullif(btrim(new.cpu), '');
  new.ram           := nullif(btrim(new.ram), '');
  new.storage       := nullif(btrim(new.storage), '');
  new.os            := nullif(btrim(new.os), '');
  new.notes         := nullif(btrim(new.notes), '');

  if public.auth_role() = 'none' or public.is_supervisor() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Un alta del técnico nace sin ficha: cualquier dato en ella es el intento.
    if num_nonnulls(
         new.inventory_tag, new.acquired_at, new.supplier, new.purchase_price,
         new.purchase_ref, new.warranty_until, new.end_of_life, new.hostname,
         new.mac_address, new.ip_address, new.cpu, new.ram, new.storage,
         new.os, new.notes
       ) = 0 then
      return new;
    end if;
  elsif (new.inventory_tag, new.acquired_at, new.supplier, new.purchase_price,
         new.purchase_ref, new.warranty_until, new.end_of_life, new.hostname,
         new.mac_address, new.ip_address, new.cpu, new.ram, new.storage,
         new.os, new.notes)
        is not distinct from
        (old.inventory_tag, old.acquired_at, old.supplier, old.purchase_price,
         old.purchase_ref, old.warranty_until, old.end_of_life, old.hostname,
         old.mac_address, old.ip_address, old.cpu, old.ram, old.storage,
         old.os, old.notes) then
    return new;
  end if;

  raise exception 'Solo un supervisor o administrador puede cambiar los datos de compra y de la ficha del equipo.'
    using errcode = '42501',
          hint = 'Desde el aula se corrigen la etiqueta, la marca, el modelo, el número de serie y el estado.';
end;
$$;

comment on function public.assets_ficha_guard() is
  'Rechaza (42501) que quien no es supervisor ni administrador ponga o cambie los datos de compra y de la ficha de un equipo. Se aparta sin token, como assets_confirmed_guard. Guarda los blancos como hueco.';

drop trigger if exists assets_ficha_guard on assets;
create trigger assets_ficha_guard
  before insert or update on assets
  for each row execute function public.assets_ficha_guard();

-- La misma puerta para la vida útil del tipo. La de UPDATE ya la cierra la RLS
-- —«supervisor gestiona tipos de equipo»—, pero el técnico puede PROPONER un
-- tipo desde el aula («personal propone tipos de equipo»), y esa política mira
-- `confirmed` y no sabe de vida útil: sin esto, un tipo nuevo podía nacer con
-- una política de renovación que nadie del despacho ha decidido.
create or replace function public.asset_types_vida_util_guard()
returns trigger
language plpgsql
as $$
begin
  if public.auth_role() = 'none' or public.is_supervisor() then
    return new;
  end if;
  if (tg_op = 'INSERT' and new.vida_util_anyos is not null)
     or (tg_op = 'UPDATE' and new.vida_util_anyos is distinct from old.vida_util_anyos) then
    raise exception 'Solo un supervisor o administrador puede fijar la vida útil de un tipo de equipo.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.asset_types_vida_util_guard() is
  'Rechaza (42501) que quien no es supervisor ni administrador fije la vida útil de un tipo, también al proponerlo desde el aula.';

drop trigger if exists asset_types_vida_util_guard on asset_types;
create trigger asset_types_vida_util_guard
  before insert or update on asset_types
  for each row execute function public.asset_types_vida_util_guard();

-- -----------------------------------------------------------------------------
-- La fecha de cambio también se mueve con la ficha, y no hace falta tocarla
--
-- El disparador `assets_updated_at` de `20260806000200` no compara una lista de
-- columnas: compara la fila entera, `to_jsonb(new) - 'updated_at'` contra
-- `to_jsonb(old) - 'updated_at'`. Así que las quince columnas nuevas ya cuentan
-- desde que existen —cambiar el precio mueve `updated_at`; reenviar el mismo
-- precio no— y reescribirlo aquí solo serviría para tener dos versiones de la
-- misma regla. La prueba de `rls-test.sql` lo comprueba con una columna de la
-- ficha, que es lo que garantiza que siga siendo verdad.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 3 — El registro: un equipo por fila, con su ficha
--
-- Retirados incluidos, porque un registro patrimonial que olvida lo que salió
-- no cuadra con la contabilidad: el equipo dado de baja tiene que seguir
-- diciendo cuándo se compró y cuándo se fue.
--
-- La sala es la **efectiva**, la misma trampa y el mismo remedio que en la hoja
-- de inventario: el equipo que vuelve al almacén pierde `room_id`, y la sala de
-- la que salió solo queda en sus eventos. Aquí se publica la del último evento
-- con sala, así que de un retirado se lee dónde estuvo. Pero los `join` son
-- exteriores —a diferencia de la hoja—: un equipo sin sala resoluble sigue
-- siendo un equipo del registro, con la sala en blanco.
--
-- El tipo, con un salto de `merged_into`, como en la hoja y por lo mismo: el
-- nombre y el id que publica son los del tipo vivo. También su vida útil: la de
-- una lápida no la mira nadie.
--
-- El fin de vida: el fijado a mano gana; si no lo hay, adquisición más vida
-- útil del tipo. `date + interval` da un `timestamp` y se vuelve a `date`. Un
-- 29 de febrero más un número de años no bisiesto cae en el 28, que es lo que
-- replica `finDeVida()` en la pantalla para que la ficha y la lista no digan
-- dos fechas distintas del mismo equipo.
--
-- El estado de vida, con una frontera de un año:
--
--   obsoleto    el fin de vida es hoy o ya pasó;
--   proximo     llega dentro del próximo año;
--   vigente     hay fecha y queda más de un año;
--   sin_datos   no hay con qué calcularla — que se vea, en vez de un «vigente»
--               que nadie ha comprobado.
--
-- La fecha de baja es la de la última baja **que sigue en pie**: la que nadie
-- deshizo con un alta posterior. Es la regla que `20261026000100` le puso a la
-- hoja, y por el mismo motivo: un equipo que se retiró y volvió está instalado,
-- y un registro que le siguiera poniendo fecha de baja diría dos cosas a la vez.
-- -----------------------------------------------------------------------------

create or replace view public.asset_registry as
select
  a.id,
  coalesce(tf.id, a.asset_type_id)  as asset_type_id,
  coalesce(tf.name, t.name)         as type_name,
  coalesce(tf.category, t.category) as category,
  a.label,
  a.brand,
  a.model,
  a.serial,
  a.inventory_tag,
  a.status,
  a.confirmed,
  r.id                              as room_id,
  r.code                            as room_code,
  r.name                            as room_name,
  z.name                            as zone_name,
  b.id                              as building_id,
  b.code                            as building_code,
  b.name                            as building_name,
  r.short_ref,
  a.created_at,
  a.updated_at,
  a.acquired_at,
  a.supplier,
  a.purchase_price,
  a.purchase_ref,
  a.warranty_until,
  a.end_of_life,
  vu.anyos                          as vida_util_anyos,
  fv.fin                            as fin_vida,
  case
    when fv.fin is null                                     then 'sin_datos'
    when fv.fin <= current_date                             then 'obsoleto'
    when fv.fin <= (current_date + interval '1 year')::date then 'proximo'
    else 'vigente'
  end                               as estado_vida,
  -- Nulo cuando no consta la garantía: «no lo sabemos» no es «no la tiene».
  a.warranty_until >= current_date  as en_garantia,
  a.hostname,
  a.mac_address,
  a.ip_address,
  a.cpu,
  a.ram,
  a.storage,
  a.os,
  a.notes,
  bj.occurred_at                    as baja_at,
  ue.occurred_at                    as ultimo_evento_at
from assets a
left join asset_types t  on t.id = a.asset_type_id
left join asset_types tf on tf.id = t.merged_into
cross join lateral (
  select case when tf.id is not null then tf.vida_util_anyos else t.vida_util_anyos end as anyos
) vu
cross join lateral (
  select coalesce(
           a.end_of_life,
           (a.acquired_at + make_interval(years => vu.anyos))::date
         ) as fin
) fv
-- Solo para los que han perdido la sala: para el resto la respuesta ya está en
-- la fila y el `where` deja el lateral vacío sin tocar `asset_events`.
left join lateral (
  select e.room_id
    from asset_events e
   where a.room_id is null
     and e.asset_id = a.id
     and e.room_id is not null
   order by e.occurred_at desc, e.recorded_at desc
   limit 1
) ev on true
left join rooms r     on r.id = coalesce(a.room_id, ev.room_id)
left join zones z     on z.id = r.zone_id
left join buildings b on b.id = z.building_id
left join lateral (
  select e.occurred_at
    from asset_events e
   where e.asset_id = a.id
     and e.kind = 'baja'
     and not exists (
       select 1
         from asset_events al
        where al.asset_id = e.asset_id
          and al.kind = 'alta'
          and (al.occurred_at, al.recorded_at) > (e.occurred_at, e.recorded_at)
     )
   order by e.occurred_at desc, e.recorded_at desc
   limit 1
) bj on true
left join lateral (
  select e.occurred_at
    from asset_events e
   where e.asset_id = a.id
   order by e.occurred_at desc
   limit 1
) ue on true;

-- Sin esto la vista correría con los privilegios de su propietario, que se
-- salta la RLS, y PostgREST la publicaría con cualquier token. Es la línea que
-- llevan todas las vistas del proyecto (`20260728000200_views.sql`).
alter view public.asset_registry set (security_invoker = on);

comment on view public.asset_registry is
  'Un equipo por fila, retirados incluidos, con su sala efectiva, su ficha de compra y técnica, su fin de vida (a mano o adquisición + vida útil del tipo) y su estado de vida.';

-- -----------------------------------------------------------------------------
-- Los movimientos: un evento por fila, firmado
--
-- La firma con `nombres_del_personal()` y no con `profiles`, por lo contado en
-- `20261015000100`: un técnico solo ve su propio perfil, y con `profiles` cada
-- movimiento de un compañero saldría sin firma.
--
-- El motivo se lee de donde lo dejan los que escriben eventos. Casi todos lo
-- dejan en `nota` —la retirada autorizada, la fusión de duplicados, el
-- ordenador de repuesto, el traslado desde el aula—; las operaciones de la
-- ficha lo dejan además en `motivo`, que es lo que escribió la persona sin el
-- texto fijo delante, y por eso va primero. `reason` cierra la lista por si un
-- cliente viejo lo mandó con el nombre de la columna de las retiradas.
--
-- Lo del equipo —etiqueta, número de serie, número de inventario— es el de
-- HOY, no el que tenía cuando pasó el evento: la base no guarda el pasado de
-- cada columna, y es justo lo que se busca en esta lista («¿qué le ha pasado al
-- INV-0031?»). La sala sí es la del evento, que es la que la guarda.
-- -----------------------------------------------------------------------------

create or replace view public.asset_movements as
select
  e.id,
  e.occurred_at,
  e.recorded_at,
  e.kind,
  e.asset_id,
  coalesce(tf.name, t.name)            as type_name,
  a.label,
  a.brand,
  a.model,
  a.serial,
  a.inventory_tag,
  coalesce(e.room_id, a.room_id)       as room_id,
  r.code                               as room_code,
  b.code                               as building_code,
  e.by_user,
  p.full_name                          as by_name,
  coalesce(
    nullif(btrim(e.meta ->> 'motivo'), ''),
    nullif(btrim(e.meta ->> 'nota'), ''),
    nullif(btrim(e.meta ->> 'reason'), '')
  )                                    as motivo,
  nullif(e.meta ->> 'destino', '')     as destino,
  nullif(e.meta ->> 'source', '')      as source,
  e.meta
from asset_events e
join assets a            on a.id = e.asset_id
left join asset_types t  on t.id = a.asset_type_id
left join asset_types tf on tf.id = t.merged_into
left join rooms r        on r.id = coalesce(e.room_id, a.room_id)
left join zones z        on z.id = r.zone_id
left join buildings b    on b.id = z.building_id
left join public.nombres_del_personal() p on p.id = e.by_user;

alter view public.asset_movements set (security_invoker = on);

comment on view public.asset_movements is
  'Un evento de equipo por fila —alta, baja, traslado, sustitución, avería— con el equipo, la sala del evento, quién lo firmó, el motivo, el destino de la baja y de dónde vino.';

-- -----------------------------------------------------------------------------
-- Permisos de las vistas
--
-- Con `security_invoker` las vistas no dan acceso a nada que las tablas no den:
-- `assets`, `asset_events`, `asset_types`, `rooms`, `zones` y `buildings` tienen
-- su «personal lee …» con `is_staff()`, así que el técnico ve el registro
-- entero —la ficha de compra no es secreta para quien tiene el aparato
-- delante— y `anon` no ve nada. El GRANT va explícito por lo mismo que en la
-- hoja: el `alter default privileges` del arranque solo cubre lo que crea el
-- mismo rol que lo declaró. Y el de `anon` se retira, que ese defecto también
-- se lo daba: no le abriría ninguna fila, pero una puerta que no hace falta no
-- se deja puesta.
-- -----------------------------------------------------------------------------

revoke all on public.asset_registry  from anon;
revoke all on public.asset_movements from anon;
grant select on public.asset_registry  to authenticated;
grant select on public.asset_movements to authenticated;

-- -----------------------------------------------------------------------------
-- 4 — Las operaciones del despacho
--
-- Las cuatro son `security definer` con `search_path` fijo, como las demás, y
-- por eso mismo la comprobación de rol va dentro y es lo primero: sin ella
-- cualquier sesión escribiría con los permisos del propietario. Los errores
-- llevan código, y es lo que lee la pantalla:
--
--   42501  no es supervisor ni administrador;
--   22023  falta un dato o no vale (sala archivada, motivo corto, fecha que no
--          es una fecha, el equipo ya está en esa sala…);
--   23505  número de serie, número de inventario o etiqueta que ya son de otro
--          equipo — y el mensaje dice de cuál y dónde está.
-- -----------------------------------------------------------------------------

/**
 * Dónde está un equipo, en palabras: «Proyector 2» en la sala 1.7 (edificio H).
 *
 * Es lo que lleva el mensaje de un duplicado. «El número de serie ya existe» no
 * se puede resolver; «ya es del Proyector 2 de la 1.7» sí, porque dice adónde
 * hay que ir a mirar. Interna: solo la llaman las funciones de abajo.
 */
create or replace function public.ficha_donde_esta(p_asset uuid)
returns text
language sql
stable
set search_path = public
as $$
  select format(
           '«%s»%s',
           coalesce(a.label, tf.name, t.name, 'Equipo'),
           case
             when r.id is null and a.status = 'retirado' then ', retirado y sin sala'
             when r.id is null then ', sin sala'
             when a.status = 'retirado' then
               format(', retirado, que estuvo en la sala %s (edificio %s)', r.code, b.code)
             else format(' en la sala %s (edificio %s)', r.code, b.code)
           end
         )
    from assets a
    left join asset_types t  on t.id = a.asset_type_id
    left join asset_types tf on tf.id = t.merged_into
    left join lateral (
      select e.room_id
        from asset_events e
       where a.room_id is null and e.asset_id = a.id and e.room_id is not null
       order by e.occurred_at desc, e.recorded_at desc
       limit 1
    ) ev on true
    left join rooms r     on r.id = coalesce(a.room_id, ev.room_id)
    left join zones z     on z.id = r.zone_id
    left join buildings b on b.id = z.building_id
   where a.id = p_asset
$$;

comment on function public.ficha_donde_esta(uuid) is
  'Describe en palabras qué equipo es y en qué sala está o estuvo. Interna: la usan los mensajes de duplicado de las operaciones de la ficha.';

revoke all on function public.ficha_donde_esta(uuid) from public, anon, authenticated;

/**
 * Registrar la entrada de un equipo desde el despacho.
 *
 *   p: {id?, asset_type_id, room_id, label?, brand, model, serial,
 *       inventory_tag, acquired_at, supplier, purchase_price, purchase_ref,
 *       warranty_until, end_of_life, hostname, mac_address, ip_address, cpu,
 *       ram, storage, os, notes, occurred_at?, motivo?}
 *
 * Crea el equipo —instalado y validado: lo apunta un supervisor con el albarán
 * delante, no hay nada que validar después— y su `alta` en el histórico, que
 * es de donde salen el informe y la lista de movimientos.
 *
 * Idempotente por `id`, como la cola de salida: si la pantalla reenvía la
 * misma entrada porque se cortó la red antes de la respuesta, se devuelve el
 * equipo que ya se creó y no nace otro. Lo que traiga la segunda vez no se
 * aplica: para cambiar la ficha está la ficha.
 *
 * La etiqueta, si no viene, es la siguiente libre del tipo en esa sala
 * —«Proyector», luego «Proyector 2»—, con la misma regla que `nextLabel()` en
 * el cliente. Si viene y ya está cogida, se rechaza en vez de recolocarla: el
 * renombrado silencioso es exactamente como nacen los duplicados que luego hay
 * que fusionar a mano (`20260731000100`), y aquí sí hay alguien delante para
 * decidir.
 *
 * `occurred_at` es cuándo entró el equipo; si viene, también es su fecha de
 * alta en la fila, que es la que imprime la hoja de inventario. Una fecha del
 * futuro no se admite: nada entra mañana.
 */
create or replace function public.asset_registrar_entrada(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo          uuid := (select auth.uid());
  v_id          uuid;
  v_tipo_pedido uuid;
  v_tipo        uuid;
  v_tipo_nombre text;
  v_sala        uuid;
  v_crudo       text;
  v_campo       text;
  v_otro        uuid;
  v_label       text;
  v_brand       text;
  v_model       text;
  v_serial      text;
  v_tag         text;
  v_supplier    text;
  v_ref         text;
  v_hostname    text;
  v_mac         text;
  v_ip          text;
  v_cpu         text;
  v_ram         text;
  v_storage     text;
  v_os          text;
  v_notes       text;
  v_motivo      text;
  v_acquired    date;
  v_warranty    date;
  v_eol         date;
  v_price       numeric(12,2);
  v_occurred    timestamptz;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor o administrador registra la entrada de un equipo.'
      using errcode = '42501';
  end if;

  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'La entrada llega vacía.' using errcode = '22023';
  end if;

  -- El id, si viene, es la clave de idempotencia.
  v_crudo := nullif(btrim(coalesce(p ->> 'id', '')), '');
  if v_crudo is not null then
    begin
      v_id := v_crudo::uuid;
    exception when invalid_text_representation then
      raise exception '«%» no es un identificador de equipo válido.', v_crudo
        using errcode = '22023';
    end;
    if exists (select 1 from assets where id = v_id) then
      return v_id;
    end if;
  else
    v_id := gen_random_uuid();
  end if;

  -- El tipo, siguiendo la fusión: el equipo nace en el tipo vivo.
  v_crudo := nullif(btrim(coalesce(p ->> 'asset_type_id', '')), '');
  if v_crudo is null then
    raise exception 'Falta el tipo de equipo.' using errcode = '22023';
  end if;
  begin
    v_tipo_pedido := v_crudo::uuid;
  exception when invalid_text_representation then
    raise exception '«%» no es un tipo de equipo.', v_crudo using errcode = '22023';
  end;
  select coalesce(tf.id, t.id), coalesce(tf.name, t.name)
    into v_tipo, v_tipo_nombre
    from asset_types t
    left join asset_types tf on tf.id = t.merged_into
   where t.id = v_tipo_pedido;
  if v_tipo is null then
    raise exception 'Ese tipo de equipo no existe.' using errcode = '22023';
  end if;

  -- La sala: viva. A una sala archivada no entra nada.
  v_crudo := nullif(btrim(coalesce(p ->> 'room_id', '')), '');
  if v_crudo is null then
    raise exception 'Falta la sala a la que entra el equipo.' using errcode = '22023';
  end if;
  begin
    v_sala := v_crudo::uuid;
  exception when invalid_text_representation then
    raise exception '«%» no es una sala.', v_crudo using errcode = '22023';
  end;
  if not exists (select 1 from rooms where id = v_sala and active) then
    raise exception 'Esa sala no existe o está archivada.' using errcode = '22023';
  end if;

  -- Lo que llega en blanco es que no hay dato.
  v_label    := nullif(btrim(coalesce(p ->> 'label', '')), '');
  v_brand    := nullif(btrim(coalesce(p ->> 'brand', '')), '');
  v_model    := nullif(btrim(coalesce(p ->> 'model', '')), '');
  v_serial   := nullif(btrim(coalesce(p ->> 'serial', '')), '');
  v_tag      := nullif(btrim(coalesce(p ->> 'inventory_tag', '')), '');
  v_supplier := nullif(btrim(coalesce(p ->> 'supplier', '')), '');
  v_ref      := nullif(btrim(coalesce(p ->> 'purchase_ref', '')), '');
  v_hostname := nullif(btrim(coalesce(p ->> 'hostname', '')), '');
  v_mac      := nullif(btrim(coalesce(p ->> 'mac_address', '')), '');
  v_ip       := nullif(btrim(coalesce(p ->> 'ip_address', '')), '');
  v_cpu      := nullif(btrim(coalesce(p ->> 'cpu', '')), '');
  v_ram      := nullif(btrim(coalesce(p ->> 'ram', '')), '');
  v_storage  := nullif(btrim(coalesce(p ->> 'storage', '')), '');
  v_os       := nullif(btrim(coalesce(p ->> 'os', '')), '');
  v_notes    := nullif(btrim(coalesce(p ->> 'notes', '')), '');
  v_motivo   := nullif(btrim(coalesce(p ->> 'motivo', '')), '');

  -- Las fechas y el precio, con el nombre del campo en el error: «invalid input
  -- syntax for type date» no le dice a nadie qué casilla está mal. Las
  -- variables conservan su valor al saltar la excepción, así que `v_campo` dice
  -- cuál fue.
  begin
    v_campo := 'fecha de adquisición';
    v_crudo := nullif(btrim(coalesce(p ->> 'acquired_at', '')), '');
    v_acquired := v_crudo::date;
    v_campo := 'fecha de fin de garantía';
    v_crudo := nullif(btrim(coalesce(p ->> 'warranty_until', '')), '');
    v_warranty := v_crudo::date;
    v_campo := 'fecha de fin de vida útil';
    v_crudo := nullif(btrim(coalesce(p ->> 'end_of_life', '')), '');
    v_eol := v_crudo::date;
    v_campo := 'fecha de entrada';
    v_crudo := nullif(btrim(coalesce(p ->> 'occurred_at', '')), '');
    v_occurred := coalesce(v_crudo::timestamptz, now());
    v_campo := 'precio de compra';
    v_crudo := nullif(btrim(coalesce(p ->> 'purchase_price', '')), '');
    -- «12,50» es como se escribe un precio en España; con punto también vale.
    if v_crudo is not null and v_crudo !~ '\.' then
      v_crudo := replace(v_crudo, ',', '.');
    end if;
    v_price := v_crudo::numeric(12,2);
  exception
    when invalid_datetime_format or datetime_field_overflow
      or invalid_text_representation or numeric_value_out_of_range then
      raise exception '«%» no vale como %.', v_crudo, v_campo using errcode = '22023';
  end;

  if v_price < 0 then
    raise exception 'El precio de compra no puede ser negativo.' using errcode = '22023';
  end if;
  if v_occurred > now() + interval '5 minutes' then
    raise exception 'La fecha de entrada no puede ser futura.' using errcode = '22023';
  end if;

  -- Los duplicados, con nombre y sitio. El número de serie se compara tal cual,
  -- que es lo que exige `assets_serial_idx`; el de inventario, normalizado como
  -- su índice.
  if v_serial is not null then
    select id into v_otro from assets where serial = v_serial limit 1;
    if v_otro is not null then
      raise exception 'El número de serie «%» ya es de otro equipo: %.',
        v_serial, public.ficha_donde_esta(v_otro)
        using errcode = '23505';
    end if;
  end if;

  if v_tag is not null then
    select id into v_otro
      from assets
     where inventory_tag is not null
       and upper(regexp_replace(inventory_tag, '[\s\-_./]', '', 'g'))
         = upper(regexp_replace(v_tag, '[\s\-_./]', '', 'g'))
     limit 1;
    if v_otro is not null then
      raise exception 'El número de inventario «%» ya es de otro equipo: %.',
        v_tag, public.ficha_donde_esta(v_otro)
        using errcode = '23505';
    end if;
  end if;

  if v_label is null then
    v_label := public.next_asset_label(v_sala, v_tipo_nombre);
  elsif exists (
    select 1 from assets
     where room_id = v_sala
       and status <> 'retirado'
       and label is not null
       and public.norm_text(label) = public.norm_text(v_label)
  ) then
    raise exception 'En esa sala ya hay un equipo que se llama «%». Elige otra etiqueta, o déjala vacía y se le pondrá la siguiente libre.',
      v_label
      using errcode = '23505';
  end if;

  insert into assets (
    id, asset_type_id, room_id, label, brand, model, serial, inventory_tag,
    acquired_at, supplier, purchase_price, purchase_ref, warranty_until, end_of_life,
    hostname, mac_address, ip_address, cpu, ram, storage, os, notes,
    status, confirmed, created_by, created_at
  )
  values (
    v_id, v_tipo, v_sala, v_label, v_brand, v_model, v_serial, v_tag,
    v_acquired, v_supplier, v_price, v_ref, v_warranty, v_eol,
    v_hostname, v_mac, v_ip, v_cpu, v_ram, v_storage, v_os, v_notes,
    'instalado', true, v_yo, v_occurred
  );

  -- `nota` es lo que lee el Historial de la sala; `motivo`, lo que escribió la
  -- persona, sin el texto fijo. `source` distingue esta entrada de la del
  -- ordenador de repuesto y de la del libro.
  insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
  values (
    gen_random_uuid(), v_id, v_sala, 'alta', v_occurred, v_yo,
    jsonb_build_object(
      'source', 'ficha',
      'motivo', v_motivo,
      'nota',   coalesce(v_motivo, 'Entrada registrada desde la ficha del equipo')
    )
  );

  return v_id;
end;
$$;

comment on function public.asset_registrar_entrada(jsonb) is
  'Registra la entrada de un equipo con su ficha: lo crea instalado y validado y deja su alta en el histórico. Idempotente por id. Rechaza con 23505 un número de serie, de inventario o una etiqueta que ya son de otro equipo, diciendo cuál y dónde.';

/**
 * Dar de baja un equipo desde la ficha, o devolverlo al almacén.
 *
 * No es una baja «directa»: es el camino de siempre, firmado y autorizado de un
 * tirón por la misma persona. Se crea la solicitud —o se reutiliza la que ya
 * estuviera pendiente— y se aprueba con `decide_asset_removal`, la MISMA
 * función que usa la bandeja. Así que los efectos son exactamente los de
 * siempre, y no por copia: el equipo se retira (y pierde la sala si va al
 * almacén), la baja queda en el histórico de la sala, el almacén suma la unidad
 * cuando el tipo tiene artículo, y la unidad de repuesto que fuera ese equipo
 * vuelve a `disponible` o pasa a `baja` por `stock_unit_sigue_al_equipo`. El día
 * que alguien cambie cómo se aprueba una retirada, este camino cambia con él.
 *
 * Si ya había una solicitud pendiente —un técnico la pidió desde el aula— no se
 * crea otra: el índice de una sola viva por equipo lo impediría, y además sería
 * mentira. Se le corrige el destino, y el motivo de quien la pidió se conserva
 * en la solicitud: el del despacho va como nota de la decisión, que es lo que
 * la aprobación copia al evento. Si la solicitud no traía motivo, se le pone
 * este.
 *
 * El evento de la baja se marca con `source = 'ficha'` y el motivo suelto. Es
 * la única escritura que añade a la de siempre, va en la misma transacción que
 * la inserción del evento y solo AÑADE dos claves a `meta`: sin ella la lista
 * de movimientos no podría decir de dónde vino la baja.
 *
 * Devuelve `void`: con destino almacén y un tipo sin artículo de almacén la
 * retirada se hace igual y no se suma unidad —`decide_asset_removal` lo
 * devuelve como `almacen_sin_articulo`—; la pantalla puede verlo en el saldo
 * del almacén, y aquí se deja dicho con un aviso.
 */
create or replace function public.asset_dar_de_baja(
  p_asset   uuid,
  p_destino text,
  p_motivo  text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo        uuid := (select auth.uid());
  v_destino   text := replace(lower(btrim(coalesce(p_destino, ''))), 'é', 'e');
  v_motivo    text := btrim(coalesce(p_motivo, ''));
  v_estado    asset_status;
  v_sala      uuid;
  v_solicitud uuid;
  v_fin       text;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor o administrador da de baja un equipo desde la ficha.'
      using errcode = '42501';
  end if;

  if v_destino not in ('baja', 'almacen') then
    raise exception 'El destino tiene que ser «baja» o «almacen», no «%».', coalesce(p_destino, '')
      using errcode = '22023';
  end if;
  if char_length(v_motivo) < 10 then
    raise exception 'El motivo es obligatorio y debe tener al menos 10 caracteres.'
      using errcode = '22023';
  end if;

  select status, room_id into v_estado, v_sala from assets where id = p_asset for update;
  if not found then
    raise exception 'Ese equipo no existe.' using errcode = '22023';
  end if;
  if v_estado = 'retirado' then
    raise exception 'Ese equipo ya está retirado.' using errcode = '22023';
  end if;

  select id into v_solicitud
    from asset_removals
   where asset_id = p_asset and state = 'pendiente'
   for update;

  if v_solicitud is null then
    v_solicitud := gen_random_uuid();
    insert into asset_removals (id, asset_id, room_id, destino, reason, requested_at, requested_by)
    values (v_solicitud, p_asset, v_sala, v_destino, v_motivo, now(), v_yo);
  else
    update asset_removals
       set destino = v_destino,
           reason  = coalesce(nullif(btrim(reason), ''), v_motivo)
     where id = v_solicitud;
  end if;

  v_fin := public.decide_asset_removal(v_solicitud, true, v_motivo);

  update asset_events
     set meta = meta || jsonb_build_object('source', 'ficha', 'motivo', v_motivo)
   where asset_id = p_asset
     and kind = 'baja'
     and meta ->> 'solicitud' = v_solicitud::text;

  if v_fin = 'almacen_sin_articulo' then
    raise notice 'El equipo vuelve al almacén, pero su tipo no tiene artículo de almacén con el que contarlo.';
  end if;
end;
$$;

comment on function public.asset_dar_de_baja(uuid, text, text) is
  'Da de baja un equipo o lo devuelve al almacén desde la ficha: crea (o reutiliza) la solicitud de retirada y la aprueba con decide_asset_removal, con los mismos efectos que la bandeja. Motivo de al menos diez caracteres.';

/**
 * Trasladar un equipo a otra sala desde la ficha.
 *
 * Lo mismo que `trasladarAsset()` en el cliente, y con su misma regla: es la
 * MISMA fila la que cambia de sitio —número de serie, ficha e histórico viajan
 * con el aparato— y la etiqueta se recalcula en el destino con la siguiente
 * libre de su tipo, para no chocar contra `assets_room_label_idx`. El evento
 * lleva las claves que escribe el cliente (`desde_room_id`, `nota`) más el
 * motivo suelto y `source = 'ficha'`.
 */
create or replace function public.asset_trasladar(
  p_asset  uuid,
  p_room   uuid,
  p_motivo text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo     uuid := (select auth.uid());
  v_motivo text := nullif(btrim(coalesce(p_motivo, '')), '');
  v_estado asset_status;
  v_origen uuid;
  v_base   text;
  v_label  text;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor o administrador traslada un equipo desde la ficha.'
      using errcode = '42501';
  end if;

  select a.status, a.room_id, coalesce(tf.name, t.name, a.label, 'Equipo')
    into v_estado, v_origen, v_base
    from assets a
    left join asset_types t  on t.id = a.asset_type_id
    left join asset_types tf on tf.id = t.merged_into
   where a.id = p_asset
   for update of a;
  if not found then
    raise exception 'Ese equipo no existe.' using errcode = '22023';
  end if;
  if v_estado = 'retirado' then
    raise exception 'Un equipo retirado no se traslada: para devolverlo a una sala hay que darlo de alta.'
      using errcode = '22023';
  end if;
  if p_room is null or not exists (select 1 from rooms where id = p_room and active) then
    raise exception 'Esa sala no existe o está archivada.' using errcode = '22023';
  end if;
  if v_origen = p_room then
    raise exception 'El equipo ya está en esa sala.' using errcode = '22023';
  end if;

  v_label := public.next_asset_label(p_room, v_base, p_asset);

  update assets set room_id = p_room, label = v_label where id = p_asset;

  insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
  values (
    gen_random_uuid(), p_asset, p_room, 'traslado', now(), v_yo,
    jsonb_build_object(
      'desde_room_id', v_origen,
      'nota', case
                when v_motivo is null then 'Trasladado desde otra sala'
                else 'Trasladado desde otra sala: ' || v_motivo
              end,
      'motivo', v_motivo,
      'source', 'ficha'
    )
  );
end;
$$;

comment on function public.asset_trasladar(uuid, uuid, text) is
  'Traslada un equipo no retirado a otra sala activa: misma fila, etiqueta recalculada con la siguiente libre de su tipo en el destino y un evento de traslado con desde_room_id, nota, motivo y source = ficha.';

/**
 * Fijar o quitar la vida útil de un tipo de equipo. `null` la quita.
 *
 * Sobre el tipo VIVO: si llega el id de una lápida de fusión se aplica al tipo
 * en el que se fundió, que es el que leen el registro y la pantalla. Ponerla en
 * la lápida sería guardar un dato que nadie va a leer nunca.
 */
create or replace function public.asset_type_vida_util(p_type uuid, p_anyos int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tipo uuid;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor o administrador fija la vida útil de un tipo de equipo.'
      using errcode = '42501';
  end if;
  if p_anyos is not null and (p_anyos < 1 or p_anyos > 50) then
    raise exception 'La vida útil va de 1 a 50 años, no %.', p_anyos using errcode = '22023';
  end if;

  select coalesce(merged_into, id) into v_tipo from asset_types where id = p_type;
  if v_tipo is null then
    raise exception 'Ese tipo de equipo no existe.' using errcode = '22023';
  end if;

  update asset_types set vida_util_anyos = p_anyos where id = v_tipo;
end;
$$;

comment on function public.asset_type_vida_util(uuid, int) is
  'Fija (1 a 50 años) o quita (null) la vida útil de un tipo de equipo, sobre el tipo vivo si llega una lápida de fusión.';

revoke all on function public.asset_registrar_entrada(jsonb)            from public, anon;
revoke all on function public.asset_dar_de_baja(uuid, text, text)        from public, anon;
revoke all on function public.asset_trasladar(uuid, uuid, text)          from public, anon;
revoke all on function public.asset_type_vida_util(uuid, int)            from public, anon;
grant execute on function public.asset_registrar_entrada(jsonb)          to authenticated;
grant execute on function public.asset_dar_de_baja(uuid, text, text)     to authenticated;
grant execute on function public.asset_trasladar(uuid, uuid, text)       to authenticated;
grant execute on function public.asset_type_vida_util(uuid, int)         to authenticated;

-- Los disparadores no los llama nadie: los ejecuta la tabla.
revoke all on function public.assets_ficha_guard()          from public, anon, authenticated;
revoke all on function public.asset_types_vida_util_guard() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5 — El Historial no cuenta dos veces la misma entrada
--
-- `room_timeline` cuenta el alta de un equipo de dos maneras: por la fila
-- —todo equipo apuntado por alguien (`created_by`) tiene su «alta» en la fecha
-- de `created_at`— y por los eventos, donde la entrada de un ordenador de
-- repuesto o la vuelta de un equipo dejan su `alta` con nota. Hasta hoy no se
-- pisaban: lo que apunta un técnico desde el aula tiene autor y no tiene
-- evento, y lo que entra del almacén tiene evento y no tiene autor.
--
-- La entrada desde la ficha tiene las dos cosas, y saldría dos veces en el
-- Historial de la sala, a la misma hora y con el mismo nombre. Gana el evento,
-- que es el que lleva el motivo; la fila se calla cuando el equipo tiene un
-- alta de la ficha.
--
-- La vista va entera porque `create or replace view` no sabe sustituir media
-- definición, copiada sin un cambio de `20261015000100` salvo esa condición.
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
  -- La entrada registrada desde la ficha ya cuenta su alta con un evento,
  -- con su motivo: sin esto saldría dos veces. Ver la cabecera de este bloque.
  and not exists (
    select 1 from asset_events x
     where x.asset_id = a.id and x.kind = 'alta' and x.meta ->> 'source' = 'ficha'
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
  'El Historial de una sala: incidencias, revisiones, material, equipos e inventarios, firmados con el nombre de quien los hizo. El alta de un equipo registrado desde la ficha se cuenta una sola vez, por su evento.';

notify pgrst, 'reload schema';
