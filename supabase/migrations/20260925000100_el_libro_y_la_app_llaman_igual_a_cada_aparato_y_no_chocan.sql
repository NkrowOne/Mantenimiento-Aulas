-- reejecutable: si
--
-- El bloque `do` solo añade alias que faltan (comparados sin tildes ni
-- mayúsculas: la segunda pasada deja la lista igual) y el resto son
-- `create or replace` y `revoke`, que se repiten sin más. Hace falta declararlo
-- porque la deducción automática rechaza cualquier `do` de nivel raíz.
-- =============================================================================
-- El libro y la aplicación llaman igual a cada aparato, y no chocan
--
-- La pasada del 22/09 dejó dos avisos, uno detrás de otro:
--
--     «Ordenador» del libro está en la aplicación puesto en equipos de tipo
--     «Ordenador Tiny»: 52 números de serie, en su misma aula.
--     «Monitor» del libro está en la aplicación puesto en equipos de tipo
--     «TV»: 67 números de serie, en su misma aula.
--
-- Y la pasada siguiente los dejó otra vez, con los mismos números. La regla de
-- `20260901000100` —adoptar y reclasificar cuando el tipo pedido se separó del
-- que el equipo tiene— no entraba en ninguno de los dos casos:
--
--  - El Tiny. «Ordenador Tiny» está fundido en «Ordenador» (`merged_into`,
--    `20260922000400`), así que el tipo del equipo y el pedido son el mismo
--    aparato con dos nombres. Pero la comparación era `separado_de`, y una
--    fusión no es una separación: la función rechazaba la celda con «ya está en
--    esta aula, pero puesto en un “Ordenador Tiny” y no en un “Ordenador”».
--  - El monitor. Las 67 celdas ni llegaban: la pregunta de «equipo nuevo» se
--    las comía en el cliente (apartado 11 quinquies). Cuando llegan, cruzan por
--    `separado_de` solo si `20260922000700` encontró a quién reapuntar
--    «Monitor»; en una base donde no lo hizo, lo que une «Monitor» con el tipo
--    del equipo es un alias, y por alias no se miraba.
--
-- Una celda rechazada no deja antepasado. Así que la pasada siguiente volvía a
-- verla como cambio, volvía a mandarla, y el servidor volvía a rechazarla: 52 y
-- 67, pasada tras pasada, con `veces` subiendo en la cuarentena. Es el «sigue
-- cogiéndolo como conflicto» que se pidió arreglar.
--
-- Qué se hace, en dos partes:
--
--  1. Los tipos vivos ganan los alias con los que el libro y la gente los
--     llaman —«Pantalla» y «Televisor» para TV, «Ordenador Tiny», «Tiny» y
--     «PC Tiny» para Ordenador, «Monitor PC» para Monitor—, para que
--     `asset_type_id()` y esta función los reconozcan aunque la fusión no se
--     haya hecho en esa base. «Monitor» NO se añade a TV: es la pantalla del PC,
--     no la tele, y que compartan la palabra en el habla es justo la trampa.
--  2. `sync_aplicar_equipo` adopta y reclasifica también cuando los dos tipos
--     son equivalentes por fusión (`merged_into`, en cualquiera de los dos
--     sentidos y hasta ocho saltos, como `datosDeLaPasada`), por alias cruzado
--     (`norm_text` del nombre de uno entre los alias del otro) o por
--     `separado_de`, que es lo de siempre. El `asset_event` se apunta igual, y
--     el rechazo del caso que no es equivalente sigue diciendo lo mismo. La
--     cuenta vive en `tipos_equivalentes()`, porque hace falta también al
--     buscar el equipo vivo de la sala para escribirle el modelo: sin eso, en
--     una base sin fusionar, la celda de modelo daba de alta un equipo
--     fantasma al lado del Tiny de verdad.
--
-- El cliente hace la misma cuenta con la misma lista (`equipos.ts`): cuando los
-- dos lados dicen «es el mismo aparato», la celda ni siquiera sale del
-- navegador; esto es para las que sí salen, y para que una vez aceptadas dejen
-- antepasado y no vuelvan.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — Los alias con los que el libro y la gente llaman a cada tipo
-- -----------------------------------------------------------------------------

do $alias$
declare
  v_tipo   uuid;
  v_nombre text;
  v_alias  text[];
  v_n      integer := 0;
begin
  /*
   * Solo si el tipo existe y está vivo. En una base donde «TV» todavía no se ha
   * separado de «Pantalla» no hay «TV» al que ponerle alias, y ponérselos a
   * «Pantalla» sería adivinar la separación que otra migración hace con
   * cuidado. La lista es corta y con el nombre exacto, por lo mismo que en
   * `20260922000400`: un patrón sería más corto y mucho más peligroso.
   */
  for v_nombre, v_alias in
    select * from (values
      ('TV',        array['Pantalla', 'Televisor']),
      ('Ordenador', array['Ordenador Tiny', 'Tiny', 'PC Tiny']),
      ('Monitor',   array['Monitor PC'])
    ) as p(nombre, alias)
  loop
    select id into v_tipo
      from asset_types
     where public.norm_text(name) = public.norm_text(v_nombre)
       and merged_into is null
     limit 1;
    if v_tipo is null then continue; end if;

    -- El propio nombre del tipo no se mete de alias de sí mismo, y lo que ya
    -- estaba se queda: `distinct` es lo que hace esto repetible.
    -- Y sin repetir uno que ya estuviera escrito de otra forma: con
    -- «televisor» en la lista no entra «Televisor», que es el mismo alias.
    update asset_types t
       set aliases = array(
             select a from unnest(t.aliases) as a
              where public.norm_text(a) <> public.norm_text(t.name)
             union all
             select a from unnest(v_alias) as a
              where public.norm_text(a) <> public.norm_text(t.name)
                and not exists (
                      select 1 from unnest(t.aliases) as b
                       where public.norm_text(b) = public.norm_text(a)))
     where t.id = v_tipo
       and exists (
             select 1 from unnest(v_alias) as a
              where public.norm_text(a) <> public.norm_text(t.name)
                and not exists (
                      select 1 from unnest(t.aliases) as b
                       where public.norm_text(b) = public.norm_text(a)));
    if found then v_n := v_n + 1; end if;
  end loop;

  if v_n > 0 then
    raise notice 'Tipos de equipo con alias nuevos del libro: %.', v_n;
  else
    raise notice 'Alias del libro: nada que añadir.';
  end if;
end
$alias$;

-- -----------------------------------------------------------------------------
-- 2 — Cuándo dos tipos hablan del mismo aparato
--
-- En una función aparte porque hace falta en dos sitios de
-- `sync_aplicar_equipo`: al adoptar un número de serie puesto bajo otro tipo,
-- y al buscar el equipo vivo de la sala para escribirle el modelo. Con la
-- cuenta hecha solo en el primero, en una base sin fusionar la celda de modelo
-- («Modelo TV», «Modelo» del ordenador) no encontraba ningún «TV» ni
-- «Ordenador» —la tele seguía siendo «Pantalla», el Tiny «Ordenador Tiny»— y
-- daba de alta un equipo fantasma con modelo y sin número; el número, que va
-- detrás, reclasificaba después el de verdad. Dos aparatos por uno.
-- -----------------------------------------------------------------------------

create or replace function public.tipos_equivalentes(p_uno uuid, p_otro uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive
    del_uno as (
      select t.id, t.merged_into, 0 as salto from asset_types t where t.id = p_uno
      union all
      select t.id, t.merged_into, d.salto + 1
        from del_uno d join asset_types t on t.id = d.merged_into
       where d.salto < 8
    ),
    del_otro as (
      select t.id, t.merged_into, 0 as salto from asset_types t where t.id = p_otro
      union all
      select t.id, t.merged_into, d.salto + 1
        from del_otro d join asset_types t on t.id = d.merged_into
       where d.salto < 8
    )
  select p_uno is not null and p_otro is not null and (
       p_uno = p_otro
    -- Uno fundido en el otro, en cualquier sentido y hasta ocho saltos.
    or exists (select 1 from del_uno where id = p_otro)
    or exists (select 1 from del_otro where id = p_uno)
    -- Uno se separó del otro.
    or exists (select 1 from asset_types t where t.id = p_uno  and t.separado_de = p_otro)
    or exists (select 1 from asset_types t where t.id = p_otro and t.separado_de = p_uno)
    -- El nombre de uno entre los alias del otro.
    or exists (
         select 1
           from asset_types a, asset_types b
          where a.id = p_uno and b.id = p_otro
            and (public.norm_text(a.name) in
                   (select public.norm_text(x) from unnest(coalesce(b.aliases, '{}')) as x)
              or public.norm_text(b.name) in
                   (select public.norm_text(x) from unnest(coalesce(a.aliases, '{}')) as x)))
  )
$$;

comment on function public.tipos_equivalentes(uuid, uuid) is
  'Si dos tipos de equipo hablan del mismo aparato: el mismo, uno fundido en el otro (hasta ocho saltos), uno separado del otro, o el nombre de uno entre los alias del otro. Lo usa la sincronización del Excel.';

revoke all on function public.tipos_equivalentes(uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3 — Equivalente por fusión, por alias o por separación: se reclasifica
-- -----------------------------------------------------------------------------

create or replace function public.sync_aplicar_equipo(
  p_room uuid, p_type uuid, p_campo text, p_valor text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_asset   uuid;
  v_otro    uuid;
  v_donde   uuid;
  v_estado  asset_status;
  v_tipo    uuid;
  v_nombre  text;
  v_mio     text;
  v_mismo   boolean;
begin
  if p_valor is null or btrim(p_valor) = '' then return null; end if;

  if p_campo = 'serial' then
    select id, room_id, status, asset_type_id
      into v_otro, v_donde, v_estado, v_tipo
      from assets where serial = p_valor limit 1;

    if v_otro is not null and v_donde is distinct from p_room then
      if v_estado = 'instalado' then
        return format('el número de serie «%s» ya está en otra aula', p_valor);
      end if;
      return format(
        'el número de serie «%s» es de un equipo dado de baja: traerlo a esta aula se hace desde la aplicación, que es donde queda apuntado el traslado',
        p_valor);
    end if;

    -- Mismo aula y de baja: la hoja dice que sigue puesto, y la hoja es la que
    -- mira el aula. Se reactiva ese, no se da de alta otro con su número.
    if v_otro is not null and v_estado <> 'instalado' then
      update assets set status = 'instalado' where id = v_otro;
      insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
      values (gen_random_uuid(), v_otro, p_room, 'alta', now(), null,
              jsonb_build_object('source', 'sharepoint', 'nota', 'estaba de baja y la hoja lo sigue contando en esta aula'));
      v_asset := v_otro;
    end if;

    /*
     * Mismo aula, instalado, y de otro tipo.
     *
     * Se adopta si los dos tipos hablan del mismo aparato, y hay tres maneras
     * de que lo hagan:
     *
     *  - el pedido se separó del que el equipo tiene (`separado_de`): TV y
     *    Monitor saliendo de Pantalla, lo de `20260901000100`;
     *  - uno está fundido en el otro (`merged_into`), en cualquier sentido y
     *    hasta ocho saltos: «Ordenador Tiny» dentro de «Ordenador»;
     *  - el nombre de uno está entre los alias del otro: «Pantalla» en los de
     *    «TV» aunque la fusión no se haya hecho en esta base.
     *
     * Entonces es el mismo aparato con el nombre que le corresponde, y dárselo
     * es lo que deja antepasado y hace que la celda no vuelva. Si no, se
     * rechaza DICIENDO QUÉ PASA: es la diferencia entre «duplicate key value
     * violates unique constraint "assets_serial_idx"» y una frase con la que
     * alguien puede ir al maestro y arreglarlo.
     */
    if v_otro is not null and v_estado = 'instalado' and v_tipo is distinct from p_type then
      v_mismo := public.tipos_equivalentes(p_type, v_tipo);

      if v_mismo then
        update assets set asset_type_id = p_type where id = v_otro;
        insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
        values (gen_random_uuid(), v_otro, p_room, 'sustitucion', now(), null,
                jsonb_build_object(
                  'source', 'sharepoint',
                  'nota', 'el libro lo reclama en su columna: se le devuelve el tipo del que estaba fundido',
                  'tipo_antes', (select name from asset_types where id = v_tipo),
                  'tipo_ahora', (select name from asset_types where id = p_type)));
        v_asset := v_otro;
      else
        select name into v_nombre from asset_types where id = v_tipo;
        select name into v_mio    from asset_types where id = p_type;
        return format(
          'el número de serie «%s» ya está en esta aula, pero puesto en un «%s» y no en un «%s». Si es el mismo aparato, cámbiale el tipo desde la aplicación; si son dos, corrige el número en la hoja',
          p_valor, coalesce(v_nombre, '?'), coalesce(v_mio, '?'));
      end if;
    end if;
  end if;

  -- El equipo vivo de ese tipo en esa sala. Si hay varios, el más reciente, que
  -- es el que la hoja está enseñando.
  if v_asset is null then
    select id into v_asset from assets
     where room_id = p_room and asset_type_id = p_type and status = 'instalado'
     order by created_at desc limit 1;
  end if;

  -- Y si no hay ninguno con ese nombre exacto, uno con un nombre equivalente:
  -- el Tiny de una base sin fusionar, la tele que sigue siendo «Pantalla». Es
  -- el mismo aparato, así que se le escribe a él y se le da el tipo de la
  -- columna, con su apunte; darle de alta otro dejaba dos equipos por uno.
  if v_asset is null then
    select a.id, a.asset_type_id into v_asset, v_tipo from assets a
     where a.room_id = p_room and a.status = 'instalado'
       and a.asset_type_id <> p_type
       and public.tipos_equivalentes(p_type, a.asset_type_id)
     order by a.created_at desc limit 1;
    if v_asset is not null then
      update assets set asset_type_id = p_type where id = v_asset;
      insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
      values (gen_random_uuid(), v_asset, p_room, 'sustitucion', now(), null,
              jsonb_build_object(
                'source', 'sharepoint',
                'nota', 'el libro lo reclama en su columna: se le devuelve el tipo del que estaba fundido',
                'tipo_antes', (select name from asset_types where id = v_tipo),
                'tipo_ahora', (select name from asset_types where id = p_type)));
    end if;
  end if;

  if v_asset is null then
    insert into assets (asset_type_id, room_id, serial, model, status)
    values (p_type, p_room,
            case when p_campo = 'serial' then p_valor else null end,
            case when p_campo = 'model'  then p_valor else null end,
            'instalado')
    returning id into v_asset;

    insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
    values (gen_random_uuid(), v_asset, p_room, 'alta', now(), null,
            jsonb_build_object('source', 'sharepoint'));
    return null;
  end if;

  /*
   * El `update` del número también puede chocar, y por el mismo sitio: el aula
   * ya tiene un equipo de este tipo sin número, y el número que trae la hoja es
   * de otro aparato de la misma aula. Sin esto salía otra vez el `duplicate key`.
   */
  if p_campo = 'serial' then
    if exists (select 1 from assets where serial = p_valor and id <> v_asset) then
      return format(
        'el número de serie «%s» ya es de otro equipo: dos aparatos no pueden llevar el mismo',
        p_valor);
    end if;
    update assets set serial = p_valor where id = v_asset;
  else
    update assets set model = p_valor where id = v_asset;
  end if;
  return null;
end $$;

comment on function public.sync_aplicar_equipo(uuid, uuid, text, text) is
  'Escribe el número de serie o el modelo que la hoja enseña de un tipo de equipo en un aula. Dentro del aula el número de serie es la identidad: un equipo de baja se reactiva, y uno instalado bajo un tipo equivalente —del que este se separó, fundido con él en cualquier sentido, o con el nombre de uno entre los alias del otro— se adopta y se reclasifica. Cualquier otro choque se rechaza diciendo qué equipo lleva ese número y de qué tipo es, en vez del error crudo del índice.';

revoke all on function public.sync_aplicar_equipo(uuid, uuid, text, text) from public, anon, authenticated;

notify pgrst, 'reload schema';
