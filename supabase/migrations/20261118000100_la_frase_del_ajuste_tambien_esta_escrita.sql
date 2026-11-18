-- =============================================================================
-- La frase del ajuste, también escrita
--
-- `20261116000100` cambió «(manda el Excel)» por «(prevalece el Excel)» en la
-- nota del ajuste de `sync_celda_de_articulo`, y lo hizo releyendo la función
-- de la base y volviéndola a crear con la frase cambiada, sin copiarla.
--
-- La base quedó bien. Lo que quedó mal es el comprobador: `migrar` no se fía
-- del registro y compara el md5 del cuerpo de cada función del repositorio con
-- `pg_proc.prosrc` (`reports-worker/src/esquema.ts`). Para él, la versión
-- vigente de una función es la del ÚLTIMO fichero que la define, y ese seguía
-- siendo `20260921000200`, con la frase vieja. Resultado: «La base no tiene las
-- migraciones que dice tener», en rojo, sobre una base que estaba al día. Y el
-- remedio que proponía —reaplicar el fichero de septiembre— devolvía la frase
-- vieja.
--
-- Aquí va la función entera, tal y como la dejó aquel bloque `do`: el cuerpo de
-- `20260921000200` con esa única frase cambiada, byte a byte. En una base que
-- ya la tiene, este `create or replace` no cambia nada; en una nueva, tampoco.
-- Lo que cambia es que el último fichero que la define vuelve a decir lo que
-- la base tiene.
--
-- Una función se cambia escribiéndola entera en su migración. Lo vigila
-- `reports-worker/src/esquema.test.ts`, y `scripts/db-verify.sh` compara ya el
-- esquema recién migrado con el repositorio.
-- =============================================================================

create or replace function public.sync_celda_de_articulo(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campo  text := p->>'campo';
  v_clave  text := p->>'clave';
  v_valor  text := p->>'valor';
  v_item   uuid;
  v_ya     numeric;
  v_falta  numeric;
  v_anyo   int;
  v_desde  date;
  v_cuando timestamptz;
  v_saldo  numeric;
begin
  begin
    v_item := v_clave::uuid;
  exception when others then
    return format('«%s» no es un artículo del almacén', v_clave);
  end;
  if not exists (select 1 from stock_items where id = v_item) then
    return format('el artículo %s ya no está en el catálogo', v_clave);
  end if;

  if v_campo = 'articulo.nombreAlternativo' then
    if v_valor is null or btrim(v_valor) = '' then return null; end if;
    if exists (select 1 from stock_items o where o.id <> v_item
                 and public.norm_text(o.name) = public.norm_text(v_valor)) then
      return format('«%s» ya es el nombre de otro artículo', v_valor);
    end if;
    update stock_items
       set aliases = array(select distinct unnest(aliases || v_valor))
     where id = v_item
       and public.norm_text(v_valor) <> public.norm_text(name)
       and not exists (select 1 from unnest(aliases) a
                        where public.norm_text(a) = public.norm_text(v_valor));
    return null;
  end if;

  if v_campo = 'articulo.comprado' then
    if v_valor is null or v_valor = '' then return null; end if;

    v_anyo := coalesce(
      nullif(p->>'anyo', '')::int,
      extract(year from (now() at time zone 'Europe/Madrid'))::int
    );
    -- Desde cuándo lleva la aplicación el almacén de ese año. Lo comprado antes
    -- es de un almacén que no llevaba: el saldo de partida ya lo cuenta.
    v_desde := nullif(p->>'arranque', '')::date;

    select coalesce(sum(qty), 0) into v_ya
      from stock_movements
     where stock_item_id = v_item
       and kind = 'compra'
       and extract(year from (occurred_at at time zone 'Europe/Madrid')) = v_anyo
       and (v_desde is null or (occurred_at at time zone 'Europe/Madrid')::date >= v_desde);

    v_falta := v_valor::numeric - v_ya;
    if v_falta = 0 then return null; end if;

    if v_falta < 0 then
      return format(
        'la aplicación tiene %s unidades compradas en %s%s y la hoja dice %s: una compra no se deshace desde una celda',
        v_ya, v_anyo,
        case when v_desde is null then '' else format(' (desde el %s)', to_char(v_desde, 'DD/MM')) end,
        v_valor);
    end if;

    -- Dentro del año del que habla la hoja —y no antes del arranque—, y lo más
    -- cerca de hoy que se pueda: para el año en curso es ahora mismo, y para
    -- uno cerrado, su último día.
    v_cuando := least(
      greatest(
        now(),
        make_timestamptz(v_anyo, 1, 1, 0, 0, 0, 'Europe/Madrid'),
        coalesce(v_desde::timestamp at time zone 'Europe/Madrid', now())
      ),
      make_timestamptz(v_anyo, 12, 31, 23, 59, 59, 'Europe/Madrid')
    );

    insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user, source, note)
    values (gen_random_uuid(), v_item, v_falta::int, 'compra', v_cuando, null, 'sharepoint',
            format('Cuadre con «Total Comprado» del Excel: la hoja dice %s en %s y la base tenía %s',
                   v_valor, v_anyo, v_ya));
    return null;
  end if;

  -- El cuadre con «Stock Disponible». Solo llega aquí cuando la persona eligió
  -- que mande el Excel: el cliente no lo manda de otra forma. Va el último de
  -- la pasada, detrás de compras y consumos, así que la diferencia que se
  -- ajusta es la que queda DESPUÉS de todo lo demás.
  if v_campo = 'articulo.disponible' then
    if v_valor is null or v_valor = '' then return null; end if;
    if v_valor::numeric < 0 then
      return format('la hoja dice %s disponibles: el almacén no puede quedar en negativo. Revisar «Total Comprado»', v_valor);
    end if;

    select coalesce(sum(qty), 0) into v_saldo
      from stock_movements where stock_item_id = v_item;

    v_falta := v_valor::numeric - v_saldo;
    if v_falta = 0 then return null; end if;

    insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user, source, note)
    values (gen_random_uuid(), v_item, v_falta::int, 'ajuste', now(), null, 'sharepoint',
            format('Cuadre con «Stock Disponible» del Excel: la hoja dice %s y la base tenía %s (prevalece el Excel)',
                   v_valor, v_saldo));
    return null;
  end if;

  -- El nombre bueno de un artículo lo decide una persona en el catálogo, no una
  -- celda: lo que venga por aquí se guarda como alias, que es lo que es.
  if v_campo = 'articulo.nombre' then
    return public.sync_celda_de_articulo(
      jsonb_set(p, '{campo}', '"articulo.nombreAlternativo"'::jsonb)
    );
  end if;

  return format('«%s» no se aplica en el almacén', v_campo);
end $$;
