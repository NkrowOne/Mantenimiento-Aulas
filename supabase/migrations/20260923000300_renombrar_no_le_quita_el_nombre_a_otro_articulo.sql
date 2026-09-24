-- =============================================================================
-- Renombrar un artículo no le quita el nombre a otro
--
-- `20260923000200` trajo `stock_item_renombrar`: cambia el nombre de un
-- artículo del almacén y deja el de antes como alias, para que el Excel y los
-- partes lo sigan encontrando. Esto la sustituye con la misma firma —la
-- pantalla no cambia— y le cierra los dos huecos por los que un renombrado
-- puede mandar filas del libro al artículo equivocado sin que nadie lo vea.
--
-- Los dos salen de cómo resuelve `stock_item_id()` un nombre: primero el
-- artículo que se LLAMA así, y si ninguno, el que lo tiene de alias
-- —desempatando por activo y por orden alfabético—. Es la función con la que la
-- sincronización lee la columna A de `Bolsa 2026` y el material de los partes.
--
--  - **El nombre nuevo no puede ser un alias de otro artículo.** El índice
--    único solo mira nombres, así que nada lo paraba: renombrar «Cable HDMI
--    3 m» a «Latiguillo HDMI» cuando otro artículo responde a «Latiguillo HDMI»
--    como alias hace que, desde ese momento, esas filas del Excel y ese
--    material de los partes caigan en este. En silencio: el nombre exacto gana
--    al alias. Se rechaza diciendo de quién es ese nombre, y con un código que
--    no es el de duplicado a propósito —la pantalla traduce el duplicado a «ya
--    hay otro artículo con ese nombre: búscalo en la lista», que aquí sería
--    mandar a buscar algo que no está en la lista con ese nombre—.
--
--  - **Si otro artículo tenía de alias el nombre de antes, lo pierde.** Mientras
--    este artículo se llamaba así, ese alias no servía de nada: el nombre
--    exacto le ganaba siempre. En cuanto el nombre pasa a ser alias de este,
--    los dos alias empatan y quien lo escriba cae en uno u otro según el
--    desempate. Es la trampa que ya describía `20260830000100` —«el día que ese
--    artículo se renombre empezaría a resolver mal y sin avisar»—. Quitándolo,
--    todo lo que encontraba este artículo lo sigue encontrando, y lo que
--    encontraba el otro, también. Queda en `audit_log` como cualquier edición
--    de `stock_items`.
--
-- Las dos comprobaciones se saltan cuando el cambio es solo de mayúsculas,
-- tildes o espacios: todo lo que busca normaliza, así que el artículo sigue
-- respondiendo exactamente a lo mismo y no hay nada que proteger.
--
-- Lo demás es lo de `20260923000200`, con sus mensajes y sus códigos: solo el
-- administrador, el nombre vacío no, el nombre de otro artículo —archivados
-- incluidos— tampoco, y el de antes al final de los alias.
-- =============================================================================

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
  v_otro   text;
  v_mueve  boolean;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador renombra artículos del almacén'
      using errcode = 'insufficient_privilege';
  end if;
  if v_nombre = '' then
    raise exception 'El nombre no puede quedar vacío' using errcode = 'check_violation';
  end if;

  -- `for update`: dos renombrados del mismo artículo a la vez se ponen en fila,
  -- y el segundo lee el nombre que dejó el primero, que es el que tiene que
  -- quedar de alias.
  select name, aliases into v_actual, v_alias from stock_items where id = p_item for update;
  if v_actual is null then raise exception 'Ese artículo no existe'; end if;
  if v_actual = v_nombre then return; end if;

  if exists (
    select 1 from stock_items si
     where si.id <> p_item
       and public.norm_text(si.name) = public.norm_text(v_nombre)
  ) then
    raise exception 'Ya hay otro artículo que se llama «%»', v_nombre
      using errcode = 'unique_violation';
  end if;

  -- ¿Cambia a qué responde el artículo, o solo cómo se escribe?
  v_mueve := public.norm_text(v_actual) <> public.norm_text(v_nombre);

  if v_mueve then
    select o.name into v_otro
      from stock_items o
     where o.id <> p_item
       and exists (
         select 1 from unnest(o.aliases) a
          where public.norm_text(a) = public.norm_text(v_nombre)
       )
     order by o.active desc, o.name
     limit 1;
    if v_otro is not null then
      raise exception '«%» ya es otro nombre de «%»: el Excel y los partes encuentran ese artículo por él. Elige otro nombre.',
        v_nombre, v_otro;
    end if;
  end if;

  if v_mueve
     and not exists (select 1 from unnest(v_alias) a where public.norm_text(a) = public.norm_text(v_actual)) then
    v_alias := array_append(v_alias, v_actual);
  end if;
  v_alias := array(
    select a from unnest(v_alias) a
     where public.norm_text(a) <> public.norm_text(v_nombre)
  );
  update stock_items set name = v_nombre, aliases = v_alias where id = p_item;

  -- El alias muerto del otro artículo: ver la cabecera. En su orden, y sin
  -- tocar ninguno de sus demás alias —`is distinct from` y no `<>`, para que
  -- uno que normalice a nulo no se vaya de paso—.
  if v_mueve then
    update stock_items o
       set aliases = array(
             select t.a
               from unnest(o.aliases) with ordinality as t(a, i)
              where public.norm_text(t.a) is distinct from public.norm_text(v_actual)
              order by t.i
           )
     where o.id <> p_item
       and exists (
         select 1 from unnest(o.aliases) a
          where public.norm_text(a) = public.norm_text(v_actual)
       );
  end if;
end $$;

comment on function public.stock_item_renombrar(uuid, text) is
  'Cambia el nombre de un artículo del almacén y deja el anterior como alias, para que el Excel y los partes lo sigan encontrando. Solo administrador. Rechaza un nombre que ya sea el nombre o un alias de otro artículo, y le quita a otro artículo el alias que coincida con el nombre de antes, que desde ahora empataría con este.';

revoke all on function public.stock_item_renombrar(uuid, text) from public, anon;
grant execute on function public.stock_item_renombrar(uuid, text) to authenticated;

notify pgrst, 'reload schema';
