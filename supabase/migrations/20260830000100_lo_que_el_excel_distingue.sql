-- =============================================================================
-- Lo que el Excel distingue y la base todavía no
--
-- Para que el libro se pueda escribir entero hace falta que la base sepa decir
-- todo lo que el libro dice. Y hoy hay cuatro sitios donde no llega. No son
-- caprichos de formato: son datos que existen, que alguien mantiene a mano
-- desde hace años, y que al entrar se perderían o se mezclarían con otros.
--
-- **Uno. `TV` y `Monitor` son la misma cosa para la base y dos para el libro.**
-- La migración `20260728000700` fundió `TV` dentro de `Pantalla` y le colgó
-- `monitor` y `display` como alias, y en su momento tenía razón: se estaba
-- limpiando un catálogo con tres nombres para lo mismo. Pero la hoja de estado
-- lleva **tres columnas separadas** —`Modelo TV`, `S/N TV` y `S/N Monitor`— con
-- 212 y 79 números de serie distintos. Con un solo tipo, escribir esas dos
-- columnas de vuelta es imposible: no hay forma de saber cuál de los dos
-- aparatos de la sala va en cada una. Se separan otra vez, y sin deshacer nada
-- de lo ya fundido: lo que hoy es `Pantalla` se queda como está hasta que la
-- sincronización lo reconozca por su número de serie en una columna o en la
-- otra. `asset_type_id()` ya prefiere el nombre exacto al alias, así que en
-- cuanto existe un tipo llamado `Monitor` deja de resolverse como `Pantalla`
-- solo.
--
-- **Dos. Tres aparatos que el libro tiene y el catálogo no**: `Screenbeam`,
-- `Barco` y `Panacast 50`, con sus columnas y sus 24 números de serie entre las
-- tres. Sin tipo, esas columnas solo se pueden dejar en blanco.
--
-- **Tres. La botonera no es un sí o un no.** `capabilities.botonera` es un
-- booleano y la columna `K` del libro dice `Actualizada *` en 114 filas,
-- `Actualizada` en 65 y `No tiene` en 2. Eso no es «tiene botonera»: es en qué
-- estado está. Y el asterisco lo puso alguien queriendo decir algo, así que la
-- columna guarda **el texto tal cual**. Normalizarlo a tres estados bonitos
-- perdería la distinción entre las 114 y las 65 sin que nadie lo hubiera
-- decidido, y en la vuelta al Excel reescribiría 114 celdas que nadie tocó.
--
-- **Cuatro. Los artículos del almacén no tienen alias.** La migración
-- `20260729000200` fundió las grafías del importador, pero con una tabla
-- temporal que se borra al final: la correspondencia no queda guardada en
-- ninguna parte. Y el libro sigue escribiendo cada artículo de tres maneras —la
-- columna `A` de `Bolsa 2026` dice `Cable HDMI 3 mts`, la `Q` de la misma fila
-- dice `Cable Hdmi 3 metros`, y el material consumido de un parte dice
-- `1 Cable Hdmi 10mts Fibra`—. Sin alias persistentes, cada pasada volvería a
-- adivinar, y adivinar en el almacén es descuadrar el stock.
--
-- Nada de esto escribe en `rooms`, `assets` ni `stock_movements`: pone dónde
-- caer. Quien escriba será la sincronización, con `source = 'sharepoint'`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — TV y Monitor vuelven a ser dos
--
-- El `TV` de antes sigue en la tabla con `merged_into` apuntando a `Pantalla`:
-- se resucita en vez de crear otro, porque `name` es único y porque así los
-- pocos sitios que guardaran su id siguen valiendo.
-- -----------------------------------------------------------------------------

do $$
declare
  v_pantalla uuid;
  v_tv       uuid;
begin
  select id into v_pantalla from asset_types
   where public.norm_text(name) = public.norm_text('Pantalla') and merged_into is null;

  if v_pantalla is null then
    -- Instalación limpia sin catálogo todavía: no hay nada que separar.
    return;
  end if;

  select id into v_tv from asset_types where public.norm_text(name) = public.norm_text('TV');

  if v_tv is null then
    insert into asset_types (name, category, tracks_serial, tracks_lamp_hours, confirmed, aliases)
    values ('TV', 'av', true, false, true, array['televisor'])
    returning id into v_tv;
  else
    update asset_types
       set merged_into = null,
           confirmed    = true,
           tracks_serial = true,
           aliases      = array['televisor']
     where id = v_tv;
  end if;

  insert into asset_types (name, category, tracks_serial, tracks_lamp_hours, confirmed, aliases)
  values ('Monitor', 'av', true, false, true, array['monitor pc', 'display'])
  on conflict do nothing;

  -- `Pantalla` se queda para la pantalla de proyección y para lo que ya estaba
  -- clasificado así, pero deja de contestar por `tv`, `televisor`, `monitor` y
  -- `display`: si siguiera, `asset_type_id('Monitor')` seguiría empatando.
  update asset_types
     set aliases = array(
           select a from unnest(aliases) a
            where public.norm_text(a) not in (
              public.norm_text('tv'), public.norm_text('televisor'),
              public.norm_text('monitor'), public.norm_text('display')
            )
         )
   where id = v_pantalla;
end $$;

-- -----------------------------------------------------------------------------
-- 2 — Los tres aparatos que solo existían en una columna
--
-- `Sreenbeam` es la errata de la cabecera del libro, y va de alias a propósito:
-- corregir la cabecera es cosa de una persona, y mientras no la corrija la
-- sincronización tiene que seguir cruzando.
-- -----------------------------------------------------------------------------

insert into asset_types (name, category, tracks_serial, tracks_lamp_hours, confirmed, aliases)
values
  ('Screenbeam',  'av', true, false, true, array['sreenbeam', 'screen beam']),
  ('Barco',       'av', true, false, true, array['clickshare', 'barco clickshare']),
  ('Panacast 50', 'av', true, false, true, array['jabra panacast 50', 'panacast'])
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 3 — El estado de la botonera, con sus palabras
-- -----------------------------------------------------------------------------

alter table rooms add column if not exists botonera_estado text;

comment on column rooms.botonera_estado is
  'Lo que dice la columna «Botonera» del Excel, tal cual: «Actualizada *», «Actualizada», «No tiene». No es capabilities.botonera —eso es si la hay— sino en qué estado está. Se guarda literal para que la vuelta al libro no reescriba el asterisco que alguien puso queriendo decir algo.';

-- -----------------------------------------------------------------------------
-- 4 — Alias de artículo, que es lo que impide descuadrar el almacén
-- -----------------------------------------------------------------------------

alter table stock_items add column if not exists aliases text[] not null default '{}';

comment on column stock_items.aliases is
  'Las otras maneras de escribir este artículo: las dos columnas de nombre de las hojas Bolsa y lo que se teclea en «Material Usado». Sin esto cada pasada vuelve a adivinar, y adivinar en el almacén descuadra el stock.';

create index if not exists stock_items_aliases_idx on stock_items using gin (aliases);

/**
 * El artículo que corresponde a un nombre escrito de cualquier manera.
 *
 * Gemela de `asset_type_id()` y con la misma regla de desempate: el nombre
 * exacto gana al alias, para que dar de alta un artículo que hasta ayer era
 * alias de otro lo separe sin tener que tocar nada más.
 */
create or replace function public.stock_item_id(p_name text)
returns uuid
language sql
stable
strict
parallel safe
as $$
  select si.id
    from stock_items si
   where public.norm_text(si.name) = public.norm_text(p_name)
      or exists (
        select 1 from unnest(si.aliases) a
         where public.norm_text(a) = public.norm_text(p_name)
      )
   order by (public.norm_text(si.name) = public.norm_text(p_name)) desc,
            si.active desc,
            si.name
   limit 1
$$;

comment on function public.stock_item_id(text) is
  'Resuelve un nombre de artículo, escrito como sea, al artículo del catálogo. El nombre exacto gana al alias.';

-- -----------------------------------------------------------------------------
-- 5 — Sembrar los alias con lo que el libro escribe hoy
--
-- Solo las variantes que **ya** están en el libro, y solo si el artículo existe:
-- esto no da de alta artículos nuevos, que es decisión de una persona. Lo que no
-- cruce aquí saldrá en el parte de la primera pasada, que es donde se ve.
-- -----------------------------------------------------------------------------

do $$
declare
  v_par text[];
  v_id  uuid;
begin
  foreach v_par slice 1 in array array[
    -- variante escrita en el libro          artículo del catálogo
    array['Cable Hdmi 3 metros',             'Cable HDMI 3 m'],
    array['Cable HDMI 3 mts',                'Cable HDMI 3 m'],
    array['Cable Hdmi 5 metros',             'Cable HDMI 5 m'],
    array['Cable HDMI 7,5 metros',           'Cable HDMI 7,5 m'],
    array['Cable HDMI 7,5 mts',              'Cable HDMI 7,5 m'],
    array['Cable Hdmi 7mts',                 'Cable HDMI 7,5 m'],
    array['Cable HDMI Fibra 10 metros',      'Cable HDMI fibra 10 m'],
    array['Cable HDMI Fibra 10 mts',         'Cable HDMI fibra 10 m'],
    array['Cable Hdmi 10mts Fibra',          'Cable HDMI fibra 10 m'],
    array['Cable HDMI Fibra 15 metros',      'Cable HDMI fibra 15 m'],
    array['Cable HDMI Fibra 15 mts',         'Cable HDMI fibra 15 m'],
    array['Cable Hdmi 15mts Fibra',          'Cable HDMI fibra 15 m'],
    array['Cable HDMI Fibra 20 metros',      'Cable HDMI fibra 20 m'],
    array['Cable HDMI Fibra 20 mts',         'Cable HDMI fibra 20 m'],
    array['Cable USB 10 metros',             'Cable USB 10 mts'],
    array['Cable USB 15 metros',             'Cable USB 15 mts'],
    array['Converor DP - Hdmi',              'Converos DP a HDMI'],
    array['Convertidor DP a HDMI',           'Converos DP a HDMI'],
    array['Adaptador Dp -Hdmi',              'Converos DP a HDMI'],
    array['Adaptador DP - Hdmi',             'Converos DP a HDMI'],
    array['Conversor Usb Hdmi',              'Converso USB a  HDMI'],
    array['Adaptador usb HDMI',              'Converso USB a  HDMI'],
    array['Selector automatico Hdmi 1IN / 2 Out', 'Selector automatico Hdmi 1In / 2 Out'],
    array['Matriz Hdmi',                     'Matriz HDMI'],
    array['Monitor táctil iiyama 24,5" T2454MSC Edificio BC', 'Monitor táctil iiyama 24,5" T2454MSC'],
    array['Monitor táctil modelo Edificio BC', 'Monitor táctil iiyama 24,5" T2454MSC'],
    array['Monitor 32 "',                    'Monitor 32"'],
    array['Monitor 65"',                     'Monitor 65 "'],
    array['Monitor 75 "',                    'Monitor 75"'],
    array['raton',                           'Ratón'],
    array['Raton',                           'Ratón']
  ] loop
    select public.stock_item_id(v_par[2]) into v_id;
    if v_id is not null then
      update stock_items
         set aliases = array(select distinct unnest(aliases || v_par[1]))
       where id = v_id
         and public.norm_text(v_par[1]) <> public.norm_text(name)
         and not exists (
           select 1 from unnest(aliases) a where public.norm_text(a) = public.norm_text(v_par[1])
         );
    end if;
  end loop;
end $$;

-- Un alias que se llama igual que otro artículo es una trampa: `stock_item_id`
-- devolvería el artículo bueno por el nombre exacto y el alias no serviría de
-- nada, pero el día que ese artículo se renombre empezaría a resolver mal y sin
-- avisar. Se limpian aquí, donde se ve, en vez de dejarlo para entonces.
update stock_items si
   set aliases = array(
         select a from unnest(si.aliases) a
          where not exists (
            select 1 from stock_items otro
             where otro.id <> si.id
               and public.norm_text(otro.name) = public.norm_text(a)
          )
       )
 where exists (
   select 1 from unnest(si.aliases) a
    join stock_items otro on public.norm_text(otro.name) = public.norm_text(a)
   where otro.id <> si.id
 );
