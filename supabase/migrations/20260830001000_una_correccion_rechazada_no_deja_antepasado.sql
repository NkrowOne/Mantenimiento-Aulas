-- =============================================================================
-- Una corrección rechazada no deja antepasado, y la contabilidad no tumba la
-- pasada
--
-- Dos cosas de `sync_aplicar`, las dos de la misma forma: lo que pasa **después**
-- de aplicar una celda importa tanto como aplicarla.
--
-- -----------------------------------------------------------------------------
-- 1 — El antepasado de una celda que la base rechazó
--
-- La instantánea se escribía entera, viniera la celda de una corrección que
-- entró o de una que se rechazó. Y eso borra del libro lo que alguien escribió:
--
--   pasada 1  la hoja dice «X», la base dice «Y». Manda la hoja: se intenta
--             escribir «X» en la base y la base lo rechaza —el número de serie
--             ya es de otro equipo, la fecha no vale, lo que sea—. La celda va a
--             cuarentena… y el antepasado se guarda como «X».
--
--   pasada 2  la hoja sigue diciendo «X» y la base sigue diciendo «Y». Con «X»
--             de antepasado, la cuenta sale: el Excel no se movió y la base sí,
--             o sea que **manda la app**. Se escribe «Y» encima de la celda.
--
-- Lo que alguien tecleó desaparece del libro sin un aviso, y encima con la
-- entrada de cuarentena diciendo que no se hizo nada. El antepasado es «el valor
-- de la última pasada **correcta**», y una celda que se rechazó no tuvo pasada
-- correcta: se queda sin antepasado, que es la verdad, y la pasada siguiente la
-- vuelve a intentar.
--
-- -----------------------------------------------------------------------------
-- 2 — La contabilidad, dentro de la subtransacción
--
-- Cada celda se aplica dentro de su `begin/exception` para que una mala no se
-- lleve por delante a las otras 275. Pero `import_fixes` y `cuarentena_apuntar`
-- estaban **fuera**: si el apunte fallaba —un motivo más largo de la cuenta, un
-- índice, lo que sea—, se abortaba la transacción entera y con ella la pasada,
-- que es justo lo que la subtransacción existía para impedir. Y por el peor
-- motivo posible: no por el dato, sino por la nota que se toma del dato.
-- =============================================================================

create or replace function public.sync_aplicar(p_plan jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parte_id   bigint;
  v_fichero_id bigint := nullif(p_plan->>'fichero_id', '')::bigint;
  v_origen     text   := coalesce(p_plan->>'origen', 'material_aulas');
  v_aplicadas  int := 0;
  v_rechazadas int := 0;
  r            jsonb;
  v_motivo     text;
  -- Las celdas que no entraron, por «hoja|clave|columna». La instantánea se
  -- salta las suyas.
  v_rechazos   text[] := array[]::text[];
  v_huella     text;
begin
  if auth_role() <> 'admin' then
    raise exception 'Solo un administrador puede aplicar una sincronización';
  end if;

  insert into sync_partes (origen, fichero_id, disparo, filas_leidas, sin_cambios,
                           hacia_la_base, hacia_el_excel, conflictos, descuadres, altas)
  values (
    v_origen, v_fichero_id, coalesce(p_plan->>'disparo', 'manual'),
    coalesce((p_plan#>>'{resumen,filas_leidas}')::int, 0),
    coalesce((p_plan#>>'{resumen,sin_cambios}')::int, 0),
    0,
    coalesce((p_plan#>>'{resumen,hacia_el_excel}')::int, 0),
    coalesce((p_plan#>>'{resumen,conflictos}')::int, 0),
    coalesce((p_plan#>>'{resumen,descuadres}')::int, 0),
    coalesce((p_plan#>>'{resumen,altas}')::int, 0)
  )
  returning id into v_parte_id;

  if v_fichero_id is not null then
    for r in select * from jsonb_array_elements(coalesce(p_plan->'filas', '[]'::jsonb)) loop
      insert into sync_filas (fichero_id, hoja, fila, ref, contenido, sha256)
      values (
        v_fichero_id, r->>'hoja', (r->>'fila')::int, nullif(r->>'ref', ''),
        coalesce(r->'contenido', '{}'::jsonb),
        md5(coalesce(r->'contenido', '{}'::jsonb)::text)
      )
      on conflict (fichero_id, hoja, fila) do update
        set contenido = excluded.contenido, sha256 = excluded.sha256, ref = excluded.ref;
    end loop;
  end if;

  for r in select * from jsonb_array_elements(coalesce(p_plan->'hacia_la_base', '[]'::jsonb)) loop
    begin
      v_motivo := public.sync_aplicar_celda(r);
    exception when others then
      v_motivo := format('la base lo rechazó: %s', sqlerrm);
    end;

    if v_motivo is null then
      v_aplicadas := v_aplicadas + 1;
      -- Dentro de su propia subtransacción: apuntar la corrección no puede
      -- tumbar la pasada. Si el apunte falla, la corrección ya está hecha y lo
      -- que se pierde es el renglón del registro, no el dato.
      begin
        insert into import_fixes (source, row_ref, field, original, corrected, reason)
        values ('SharePoint', r->>'clave', r->>'campo', null, r->>'valor',
                coalesce(r->>'motivo', 'sincronización'));
      exception when others then
        raise warning 'No se pudo apuntar la corrección de % %: %', r->>'clave', r->>'campo', sqlerrm;
      end;
    else
      v_rechazadas := v_rechazadas + 1;

      -- Esta celda no tuvo pasada correcta: no deja antepasado.
      if coalesce(r->>'columna', '') <> '' then
        v_rechazos := v_rechazos || format('%s|%s|%s', r->>'hoja', r->>'clave', r->>'columna');
      end if;

      begin
        perform public.cuarentena_apuntar(
          'SharePoint',
          format('%s %s', coalesce(r->>'clave', '?'), coalesce(r->>'campo', '')),
          r,
          v_motivo
        );
      exception when others then
        raise warning 'No se pudo apuntar en cuarentena % %: %', r->>'clave', r->>'campo', sqlerrm;
      end;
    end if;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_plan->'cuarentena', '[]'::jsonb)) loop
    begin
      perform public.cuarentena_apuntar(
        'SharePoint',
        format('%s %s', coalesce(r->>'clave', '?'), coalesce(r->>'campo', '')),
        r,
        coalesce(r->>'motivo', 'no se puede leer')
      );
    exception when others then
      raise warning 'No se pudo apuntar en cuarentena % %: %', r->>'clave', r->>'campo', sqlerrm;
    end;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_plan->'instantanea', '[]'::jsonb)) loop
    v_huella := format('%s|%s|%s', r->>'hoja', r->>'clave', r->>'columna');
    if v_huella = any (v_rechazos) then
      continue;
    end if;

    insert into sync_celdas (hoja, ref, columna, valor_base, entidad, entidad_id)
    values (r->>'hoja', r->>'clave', r->>'columna', r->>'valor',
            nullif(r->>'entidad', ''), nullif(r->>'entidad_id', '')::uuid)
    on conflict (hoja, ref, columna) do update
      set valor_base = excluded.valor_base, at = now();
  end loop;

  update sync_partes
     set termino_at = now(),
         hacia_la_base = v_aplicadas
   where id = v_parte_id;

  return jsonb_build_object(
    'parte_id', v_parte_id,
    'aplicadas', v_aplicadas,
    'rechazadas', v_rechazadas
  );
end $$;

comment on function public.sync_aplicar(jsonb) is
  'Aplica una pasada entera en una transacción. Cada celda va en su subtransacción, y también el apunte de lo que le pasó: ni una celda mala ni un renglón de registro pueden tumbar a las otras 275. Una celda rechazada no deja antepasado. Solo administradores.';

revoke all on function public.sync_aplicar(jsonb) from public, anon;
grant execute on function public.sync_aplicar(jsonb) to authenticated;
