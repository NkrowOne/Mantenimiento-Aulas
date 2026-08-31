-- =============================================================================
-- «Comprado» no es lo comprado: es lo comprado ESE año
--
-- La columna P de «Bolsa 2026» se llama `Total Comprado` y cuadra contra la
-- base: si la hoja dice más que la aplicación, la diferencia es una compra que
-- nadie apuntó y entra como movimiento. Está bien pensado y estaba mal contado,
-- porque los dos lados no sumaban lo mismo:
--
--   la hoja  → `compradoEn(movimientos, 2026)`, solo las compras de 2026
--   la base  → `sum(qty) where kind = 'compra'`, **todas las de la historia**
--
-- Y la base tiene las de 2025, que metió el importador. Así que un artículo con
-- 32 compradas en 2026 y 40 en 2025 salía a `32 − 72 = −40`, y eso intentaba
-- entrar como un movimiento de compra de menos cuarenta unidades. Lo paraba
-- `stock_movements_signo_check` —una compra es positiva—, o sea que la celda
-- acababa en cuarentena en cada pasada y el cuadre no se hacía nunca. Si el
-- signo no hubiera estado, habría sido peor: una compra negativa fechada hoy
-- descuadrando el stock de verdad.
--
-- Tres cosas, entonces:
--
-- **El año viaja con la celda.** La hoja sabe de qué año habla —lo dice su
-- nombre— y ahora lo manda en el plan. Sin año se supone el corriente, que es
-- lo que era antes de que hubiera dos hojas.
--
-- **El movimiento se fecha dentro de su año.** `now()` valía mientras la hoja
-- del año y el año en curso fueran el mismo; sincronizar el libro de 2026 en
-- enero de 2027 metía la compra en 2027 y descuadraba las dos hojas a la vez.
--
-- **Y si la hoja dice menos que la base, no se inventa nada.** Una compra no se
-- deshace desde una celda: lo más probable es que esté apuntada dos veces en la
-- aplicación, y eso lo arregla quien sepa cuál sobra. Va a cuarentena con el
-- motivo escrito.
--
-- El año se saca en hora de Madrid en los dos lados. Una compra del 31 de
-- diciembre a las 23:30 UTC es del año siguiente aquí, y con un lado contando en
-- UTC y otro en local esa celda no cuadraría jamás.
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
  v_cuando timestamptz;
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

    select coalesce(sum(qty), 0) into v_ya
      from stock_movements
     where stock_item_id = v_item
       and kind = 'compra'
       and extract(year from (occurred_at at time zone 'Europe/Madrid')) = v_anyo;

    v_falta := v_valor::numeric - v_ya;
    if v_falta = 0 then return null; end if;

    if v_falta < 0 then
      return format(
        'la aplicación tiene %s unidades compradas en %s y la hoja dice %s: una compra no se deshace desde una celda',
        v_ya, v_anyo, v_valor);
    end if;

    -- Dentro del año del que habla la hoja, y lo más cerca de hoy que se pueda:
    -- para el año en curso es ahora mismo, y para uno cerrado, su último día.
    v_cuando := least(
      greatest(now(), make_timestamptz(v_anyo, 1, 1, 0, 0, 0, 'Europe/Madrid')),
      make_timestamptz(v_anyo, 12, 31, 23, 59, 59, 'Europe/Madrid')
    );

    insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user, source, note)
    values (gen_random_uuid(), v_item, v_falta::int, 'compra', v_cuando, null, 'sharepoint',
            format('Cuadre con «Total Comprado» del Excel: la hoja dice %s en %s y la base tenía %s',
                   v_valor, v_anyo, v_ya));
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

revoke all on function public.sync_celda_de_articulo(jsonb) from public, anon, authenticated;

comment on function public.sync_celda_de_articulo(jsonb) is
  'Una celda de la hoja de bolsa. «Comprado» se cuadra contra las compras DE SU AÑO, en hora de Madrid: contra las de todos los tiempos salía negativo y no entraba ninguna.';
