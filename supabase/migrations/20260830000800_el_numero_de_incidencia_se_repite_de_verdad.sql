-- =============================================================================
-- El número de incidencia se repite de verdad, y el índice único no se puede
-- aplicar a la base real
--
-- La migración 300 creó `unique index … on incidents (external_ref)`. Sobre una
-- base vacía pasa; sobre la de verdad **falla y deja el despliegue a medias**,
-- porque el número de incidencia no es único y no lo es por accidente. Lo dice
-- el propio importador en `scripts/import-excel.ts`:
--
--   «El id sale de la clave de deduplicación completa, no del nº de incidencia:
--    el histórico repite refs y usar solo la ref hacía que la segunda fila se
--    descartara en silencio por colisión de clave.»
--
-- Y el libro lo confirma: `I260203_0051` sale dos veces en la hoja de 2026 e
-- `I241111_0040` dos veces en la de 2025. Son una misma incidencia que afectó a
-- dos aulas y que el técnico apuntó en dos renglones, que es una forma
-- perfectamente razonable de escribirlo en una hoja de cálculo.
--
-- Así que el índice pasa a **no** ser único. Lo que se gana con eso hay que
-- devolverlo por otro lado, y son dos cosas:
--
-- **Una ref ambigua no se aplica: se dice.** Si dos incidencias comparten
-- número, `sync_celda_de_incidencia` no puede saber a cuál se refiere la fila
-- del Excel. Elegir una sería peor que no hacer nada — escribiría la resolución
-- de un aula en la de otra— así que va a cuarentena con el motivo exacto. Es la
-- misma regla que ya se aplica cuando un código de aula existe en dos edificios.
--
-- **La generación se serializa.** Sin índice único, dos incidencias abiertas a
-- la vez ya no chocan: se quedan las dos con el mismo número y nadie se entera.
-- Un cerrojo por día lo impide, y cuesta una línea.
--
-- Y de paso, `lpad` truncaba. `lpad('10001', 4, '0')` es `'1000'`, así que la
-- incidencia diez mil de un día reciclaba el número mil. Ahora falla en voz
-- alta: es un día con diez mil incidencias, y eso no se arregla en silencio.
-- =============================================================================

-- El índice ya nace no único en la migración 300, corregida en origen porque
-- todavía no se ha desplegado en ninguna parte. Aquí queda lo que hay que hacer
-- para que quitarle la unicidad no deje un agujero.

-- -----------------------------------------------------------------------------
-- 1 — Generar el número sin carreras y sin reciclar
-- -----------------------------------------------------------------------------

create or replace function public.siguiente_ref_incidencia(p_fecha timestamptz)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_dia    text := to_char(p_fecha, 'YYMMDD');
  v_ultimo int;
begin
  -- Un cerrojo por día: dos incidencias abiertas a la vez veían el mismo máximo
  -- y proponían el mismo número. Con el índice único eso daba un error feo; sin
  -- él daría dos incidencias indistinguibles, que es peor.
  perform pg_advisory_xact_lock(hashtext('incidencia:' || v_dia));

  select coalesce(max(substring(i.external_ref from '_(\d{4})$')::int), 0)
    into v_ultimo
    from incidents i
   where i.external_ref like 'I' || v_dia || '\_%';

  if v_ultimo >= 9999 then
    -- `lpad` truncaría a cuatro dígitos y el 10.000 saldría como 1.000, que ya
    -- existe. Un día con diez mil incidencias no se arregla en silencio.
    raise exception 'El día % ya tiene 9.999 incidencias: el número no cabe en cuatro dígitos', v_dia;
  end if;

  return 'I' || v_dia || '_' || lpad((v_ultimo + 1)::text, 4, '0');
end $$;

comment on function public.siguiente_ref_incidencia(timestamptz) is
  'El siguiente I<AAMMDD>_<NNNN> libre de ese día, con cerrojo para que dos a la vez no saquen el mismo. Mira lo que ya hay en vez de usar una secuencia: las incidencias importadas traen sus números.';

revoke all on function public.siguiente_ref_incidencia(timestamptz) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2 — Una ref ambigua no se aplica
--
-- Se reescribe entera la rama de incidencias para meter la comprobación donde
-- corresponde: en el momento de resolver la clave, antes de tocar nada.
-- -----------------------------------------------------------------------------

create or replace function public.sync_celda_de_incidencia(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campo   text := p->>'campo';
  v_clave   text := p->>'clave';
  v_valor   text := p->>'valor';
  v_id      uuid;
  v_cuantas int;
  v_room    uuid;
begin
  select count(*) into v_cuantas from incidents where external_ref = v_clave;

  if v_cuantas = 0 then
    return format('el parte «%s» no está en la aplicación', v_clave);
  end if;
  if v_cuantas > 1 then
    -- Elegir una escribiría la resolución de un aula en la de otra.
    return format(
      'el número «%s» está en %s incidencias distintas: hay que separarlas desde la aplicación antes de que la hoja pueda corregirlas',
      v_clave, v_cuantas);
  end if;

  select id into v_id from incidents where external_ref = v_clave;

  case v_campo
    when 'incidencia.abierta' then
      if v_valor is null or v_valor = '' then return null; end if;
      update incidents set opened_at = v_valor::date::timestamptz where id = v_id;

    when 'incidencia.resuelta' then
      if v_valor is null or v_valor = '' then
        return 'para reabrir un parte hay que hacerlo desde la aplicación';
      end if;
      update incidents
         set resolved_at = v_valor::date::timestamptz,
             state = 'resuelta'
       where id = v_id;

    when 'incidencia.problema' then
      if v_valor is null or btrim(v_valor) = '' then return null; end if;
      update incidents set title = v_valor where id = v_id;

    when 'incidencia.observacion' then
      update incidents set description = nullif(btrim(coalesce(v_valor, '')), '') where id = v_id;

    when 'incidencia.resolucion' then
      update incidents set resolution = nullif(btrim(coalesce(v_valor, '')), '') where id = v_id;

    when 'incidencia.material' then
      return public.sync_material_del_parte(v_id, coalesce(p->'detalle', '[]'::jsonb));

    when 'sala.code' then
      if v_valor is null or btrim(v_valor) = '' then return null; end if;
      if (select count(*) from rooms r
           where public.norm_text(r.code) = public.norm_text(v_valor) and r.active) > 1 then
        return format('«%s» es el código de más de una sala: hace falta el edificio', v_valor);
      end if;
      select r.id into v_room from rooms r
       where public.norm_text(r.code) = public.norm_text(v_valor) and r.active
       limit 1;
      if v_room is null then
        return format('«%s» no es ninguna sala del maestro', v_valor);
      end if;
      update incidents set room_id = v_room where id = v_id;

    else
      return format('«%s» no se aplica a un parte desde el Excel', v_campo);
  end case;

  return null;
end $$;

revoke all on function public.sync_celda_de_incidencia(jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3 — Y que se vea cuáles están repetidas
--
-- No se tocan: separarlas es una decisión de quien conoce las dos aulas. Pero
-- quedan apuntadas para que alguien pueda hacerlo, en vez de descubrirlo el día
-- que una corrección no entra.
-- -----------------------------------------------------------------------------

do $$
declare r record;
begin
  for r in
    select external_ref, count(*) as cuantas
      from incidents
     where external_ref is not null
     group by external_ref
    having count(*) > 1
  loop
    perform public.cuarentena_apuntar(
      'Importación',
      r.external_ref,
      jsonb_build_object('external_ref', r.external_ref, 'incidencias', r.cuantas),
      format('El número «%s» está en %s incidencias: la hoja no puede corregirlas hasta que se separen', r.external_ref, r.cuantas)
    );
  end loop;
end $$;
