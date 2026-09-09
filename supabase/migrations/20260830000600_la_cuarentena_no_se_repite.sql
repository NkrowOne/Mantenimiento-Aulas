-- =============================================================================
-- La cuarentena no se repite, y dice cuántas veces ha vuelto
--
-- Una celda que no se puede leer sigue sin poder leerse en la pasada siguiente,
-- y en la de después. Con una fila por pasada, las cinco celdas ilegibles de
-- este libro son quince a la tercera semana y quinientas al año, todas
-- diciendo lo mismo. Y el documento de diseño ya avisaba de cuál es el fallo más
-- probable de todo esto con diferencia: **que nadie vacíe la cuarentena**. Una
-- bandeja con quinientas entradas repetidas es una bandeja que nadie va a abrir
-- dos veces, así que el aviso se pierde justo por sobrarle repeticiones.
--
-- Así que la misma celda con el mismo motivo es **una** entrada. Lo que cambia
-- en cada pasada es un contador y la fecha de la última vez, que además dice
-- algo que antes no se sabía: si algo lleva cuarenta pasadas sin resolverse, o
-- si acaba de aparecer.
--
-- Y una que sí importa: resolver una entrada la cierra, y si el problema vuelve
-- **se abre otra**. Reutilizar la fila resuelta escondería una recaída detrás de
-- una casilla que alguien ya marcó.
-- =============================================================================

alter table import_quarantine add column if not exists veces int not null default 1;
alter table import_quarantine add column if not exists ultima_at timestamptz;

comment on column import_quarantine.veces is
  'Cuántas pasadas seguidas han tropezado con esto. Una celda ilegible lo sigue siendo mañana: con una fila por pasada, cinco celdas son quinientas al año y la bandeja deja de leerse.';
comment on column import_quarantine.ultima_at is
  'La última vez que apareció. Con «at» —la primera— dice si esto lleva meses o acaba de salir.';

update import_quarantine set ultima_at = at where ultima_at is null;

-- Las repeticiones que ya hay se juntan en la más antigua, que es la que lleva
-- la fecha en que apareció.
do $$
declare r record;
begin
  for r in
    select source, coalesce(row_ref, '') as ref, reason,
           min(id) as se_queda, count(*) as cuantas, max(at) as ultima
      from import_quarantine
     where not resolved
     group by 1, 2, 3
    having count(*) > 1
  loop
    update import_quarantine
       set veces = r.cuantas, ultima_at = r.ultima
     where id = r.se_queda;
    delete from import_quarantine
     where not resolved and source = r.source
       and coalesce(row_ref, '') = r.ref and reason = r.reason and id <> r.se_queda;
  end loop;
end $$;

-- La huella de un problema: de dónde viene, de qué fila y qué le pasa. No entra
-- el valor crudo a propósito: si alguien corrige `********` por `*******`, sigue
-- siendo el mismo problema y no merece una entrada nueva.
create unique index if not exists import_quarantine_abierta_idx
  on import_quarantine (source, coalesce(row_ref, ''), reason)
  where not resolved;

comment on index import_quarantine_abierta_idx is
  'Una entrada abierta por problema. Resolverla la saca del índice, así que si el problema vuelve se abre otra en vez de reabrirse la que alguien ya cerró.';

/**
 * Apunta un problema en la cuarentena.
 *
 * Si ya estaba abierto, suma una vez y actualiza la fecha; si no, lo abre. El
 * `raw` se refresca porque es lo que había en la celda **esta** vez, y es lo que
 * hace falta para resolverlo.
 */
create or replace function public.cuarentena_apuntar(
  p_source text,
  p_row_ref text,
  p_raw jsonb,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into import_quarantine (source, row_ref, raw, reason, ultima_at)
  values (p_source, p_row_ref, p_raw, p_reason, now())
  on conflict (source, coalesce(row_ref, ''), reason) where not resolved
  do update set veces = import_quarantine.veces + 1,
                ultima_at = now(),
                raw = excluded.raw;
end $$;

comment on function public.cuarentena_apuntar(text, text, jsonb, text) is
  'Una entrada por problema, con un contador. La bandeja se lee si tiene cinco filas y no si tiene quinientas iguales.';

-- Y que la sincronización la use, en sus dos sitios.
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
      insert into import_fixes (source, row_ref, field, original, corrected, reason)
      values ('SharePoint', r->>'clave', r->>'campo', null, r->>'valor',
              coalesce(r->>'motivo', 'sincronización'));
    else
      v_rechazadas := v_rechazadas + 1;
      perform public.cuarentena_apuntar(
        'SharePoint',
        format('%s %s', coalesce(r->>'clave', '?'), coalesce(r->>'campo', '')),
        r,
        v_motivo
      );
    end if;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_plan->'cuarentena', '[]'::jsonb)) loop
    perform public.cuarentena_apuntar(
      'SharePoint',
      format('%s %s', coalesce(r->>'clave', '?'), coalesce(r->>'campo', '')),
      r,
      coalesce(r->>'motivo', 'no se puede leer')
    );
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_plan->'instantanea', '[]'::jsonb)) loop
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
  'Aplica una pasada entera en una transacción. Cada celda va en su subtransacción: una que falle no se lleva por delante a las demás. Solo administradores.';
