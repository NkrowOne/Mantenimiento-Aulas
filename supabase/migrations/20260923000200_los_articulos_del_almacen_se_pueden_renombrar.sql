-- =============================================================================
-- Los artículos del almacén se pueden renombrar
--
-- Desde la aplicación se podía dar de alta un artículo, pero no corregirle el
-- nombre: «Cable Hdmi 3mts» se quedaba así para siempre, o alguien entraba en
-- la base de datos a cambiarlo a mano.
--
-- Y a mano es justo como no puede hacerse, porque el nombre de un artículo no
-- es una etiqueta: es la llave con la que el Excel lo encuentra. La hoja
-- `Bolsa 2026` identifica cada fila por su columna A, y el material de un parte
-- viene escrito como se escribe en un aula; las dos cosas se resuelven por
-- nombre o por alias. Un `update` del nombre a secas deja la fila del libro
-- sin artículo, y la siguiente pasada la toma por uno que la aplicación no
-- tiene: pregunta si darlo de alta —y contestar que sí es abrir una segunda
-- caja para el mismo cable, con el saldo partido entre las dos— o, si se
-- contesta que no, sus meses no se escriben nunca. El parte que lo nombre, de
-- paso, se queda sin descontar.
--
-- Por eso va como función, y hace tres cosas que un `update` no hace:
--
--  - **El nombre de antes se queda de alias.** Es lo que hace que el libro y el
--    buscador de material lo sigan encontrando por donde siempre. Salvo si el
--    cambio es solo de mayúsculas, tildes o espacios: todo lo que busca ya
--    normaliza, y ese alias no aportaría nada.
--  - **Un nombre que ya es de otro artículo, no.** Si es su nombre, el índice
--    único `stock_items_norm_idx` lo pararía igual, pero con un «duplicate key»
--    que nadie sabe leer desde un iPad. Y si es uno de sus alias, no lo pararía
--    nada: `stock_item_id()` prefiere el nombre exacto al alias, así que desde
--    ese momento las filas del Excel que hablaban del otro artículo caerían en
--    este, en silencio.
--  - **Si otro artículo tenía de alias el nombre de antes, lo pierde.** Ese alias
--    no servía de nada —el nombre exacto de este le ganaba siempre—, pero en
--    cuanto ese nombre pasa a ser alias de este, los dos alias empatan y quien lo
--    escriba cae en uno u otro según el orden en que se miren. Es la trampa que
--    ya describía `20260830000100` —«el día que ese artículo se renombre
--    empezaría a resolver mal y sin avisar»—, y este es ese día. Quitándolo,
--    cada nombre sigue resolviendo al mismo artículo que antes del cambio.
--
-- Es de administrador por lo mismo que cualquier otra escritura sobre
-- `stock_items`: la política «admin escribe stock_items» dice `is_admin()`, y
-- esta función, que es `security definer` y por tanto se salta la política,
-- repite esa misma regla en vez de inventarse otra.
--
-- El rastro lo deja `stock_items_audit`, como en cualquier otra edición: el
-- nombre de antes, el de después y quién lo cambió.
-- =============================================================================

create or replace function public.rename_stock_item(p_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nuevo       text := btrim(coalesce(p_name, ''));
  v_viejo       text;
  v_alias       text[];
  v_otro        text;
  v_otro_activo boolean;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador cambia el nombre de un artículo del almacén'
      using errcode = 'insufficient_privilege';
  end if;

  -- `for update`: dos renombrados del mismo artículo a la vez se ponen en fila,
  -- y el segundo lee el nombre que dejó el primero —que es el que tiene que
  -- quedar de alias—, no el de antes de los dos.
  select name, aliases into v_viejo, v_alias
    from stock_items
   where id = p_id
     for update;
  if not found then
    raise exception 'Ese artículo no está en el almacén';
  end if;
  if v_nuevo = '' then
    raise exception 'El nombre no puede quedar vacío';
  end if;

  -- Solo mayúsculas, tildes o espacios: el artículo responde exactamente a lo
  -- mismo que antes, así que ni hay choque que mirar ni alias que añadir.
  if public.norm_text(v_nuevo) = public.norm_text(v_viejo) then
    update stock_items set name = v_nuevo where id = p_id;
    return;
  end if;

  -- Archivados incluidos: no salen en la lista, pero el índice único los cuenta
  -- y `stock_item_id()` también los resuelve.
  select o.name, o.active into v_otro, v_otro_activo
    from stock_items o
   where o.id <> p_id
     and public.norm_text(o.name) = public.norm_text(v_nuevo);
  if found then
    raise exception 'Ya hay otro artículo que se llama «%»%', v_otro,
      case when v_otro_activo then ''
           else ', archivado: no sale en la lista, pero el nombre sigue siendo suyo' end;
  end if;

  select o.name, o.active into v_otro, v_otro_activo
    from stock_items o
   where o.id <> p_id
     and exists (
       select 1 from unnest(o.aliases) a
        where public.norm_text(a) = public.norm_text(v_nuevo)
     )
   order by o.active desc, o.name
   limit 1;
  if found then
    raise exception '«%» ya es otro nombre de «%»%: el Excel encuentra ese artículo por él. Elige otro nombre.',
      v_nuevo, v_otro, case when v_otro_activo then '' else ' (archivado)' end;
  end if;

  -- Los alias de antes, en su orden —el primero es el que la sincronización
  -- escribe como «otro nombre» en una fila nueva del libro—, con el nombre viejo
  -- al final. Sin repetidos al normalizar, y sin el nombre nuevo, que ya no es
  -- un alias: es el nombre.
  update stock_items
     set name = v_nuevo,
         aliases = array(
           select x.a
             from (
               select t.a, t.i,
                      row_number() over (partition by public.norm_text(t.a) order by t.i) as n
                 from unnest(v_alias || v_viejo) with ordinality as t(a, i)
                where nullif(btrim(t.a), '') is not null
             ) x
            where x.n = 1
              and public.norm_text(x.a) <> public.norm_text(v_nuevo)
            order by x.i
         )
   where id = p_id;

  -- El alias muerto del otro artículo: ver la cabecera.
  update stock_items o
     set aliases = array(
           select t.a
             from unnest(o.aliases) with ordinality as t(a, i)
            where public.norm_text(t.a) is distinct from public.norm_text(v_viejo)
            order by t.i
         )
   where o.id <> p_id
     and exists (
       select 1 from unnest(o.aliases) a
        where public.norm_text(a) = public.norm_text(v_viejo)
     );
end;
$$;

comment on function public.rename_stock_item(uuid, text) is
  'Cambia el nombre de un artículo del almacén. Solo un administrador. El nombre de antes se queda de alias —el Excel y el buscador de material lo siguen encontrando—, salvo que el cambio sea solo de mayúsculas, tildes o espacios. Rechaza un nombre que ya sea el nombre o un alias de otro artículo, archivados incluidos: con él, lo que hoy encuentra ese otro empezaría a caer en este.';

revoke all on function public.rename_stock_item(uuid, text) from public, anon;
grant execute on function public.rename_stock_item(uuid, text) to authenticated;

notify pgrst, 'reload schema';
