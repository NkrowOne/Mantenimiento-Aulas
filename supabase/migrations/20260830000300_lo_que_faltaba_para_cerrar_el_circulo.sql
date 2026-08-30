-- =============================================================================
-- Los tres sitios donde la vuelta se quedaba corta, y un fleco de permisos
--
-- Con la sincronización montada de punta a punta salen a la luz tres cosas que
-- no se veían mientras el Excel era el único que escribía. Las tres tienen la
-- misma forma: **la aplicación no puede contarle al libro algo que ella misma no
-- guarda**, así que la columna del Excel se queda como estaba para siempre y la
-- sincronización parece funcionar.
--
-- **Uno. Las horas del proyector se apuntan en dos sitios que no se hablan.** La
-- revisión guarda la lectura en `inspection_checks.measure` con su fecha y su
-- autor —que es lo correcto: es una medida fechada—, y `rooms.projector_hours`
-- lleva congelado desde el día de la importación el número que traía el Excel.
-- Un `grep` lo dice sin lugar a dudas: esa columna solo se escribe en
-- `scripts/import-excel.ts`, y en toda la aplicación únicamente se lee. Así que
-- un técnico puede apuntar 4.200 horas en el móvil y la columna `F` del libro
-- seguirá diciendo 3.340 la próxima década.
--
-- **Dos. El número de incidencia no lo genera nadie.** `external_ref` es la
-- identidad de fila de las hojas `Material Instalado` —es la columna por la que
-- se cruzan— y hoy solo se rellena al importar o tecleándolo a mano; una
-- incidencia abierta desde una revisión lo deja a `null` a propósito. Sin él,
-- las incidencias de la aplicación **no se pueden escribir en el libro**, que es
-- justo la mitad de «salidas de material».
--
-- **Tres. Un fallo inesperado en una celda tumbaba la pasada entera.** La vuelta
-- ya devolvía el motivo cuando una celda no se podía aplicar, pero eso solo cubre
-- lo que estaba previsto. Una violación de índice único que no se comprobó
-- antes, un disparador que se queja: eso **lanza**, y una excepción dentro del
-- bucle aborta la transacción y con ella las otras 275 filas que iban bien. La
-- promesa era «una fila mala no puede tumbar la pasada»; con este arreglo lo es.
--
-- Y el fleco: `sync_aplicar` admitía a un supervisor y la pantalla es solo de
-- administrador (`minRole: 'admin'`). No era una puerta abierta —para llegar hay
-- que llamar a la API a mano— pero sí una trampa: escribir las observaciones de
-- una revisión cerrada choca con el disparador `inspections_freeze`, que solo
-- perdona a `admin`. Un supervisor que llamara a la función vería fallar la
-- pasada entera por una celda de texto.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — Que la lectura de la revisión llegue a la sala
--
-- Va en un disparador sobre `inspection_checks` y no en el código del cliente, y
-- no es preferencia: la revisión se sincroniza desde el móvil con la cola de
-- salida, así que el momento en que la medida existe de verdad es cuando llega
-- la fila, no cuando alguien pulsa «guardar».
--
-- **Solo si es la revisión más reciente de esa sala.** Una revisión antigua que
-- entra tarde —el móvil estuvo sin cobertura una semana— no puede hacer que la
-- sala retroceda a 3.900 horas cuando ya se apuntaron 4.200.
-- -----------------------------------------------------------------------------

create or replace function public.horas_a_la_sala()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room  uuid;
  v_fecha timestamptz;
begin
  if new.measure is null or new.measure_unit <> 'h' then
    return new;
  end if;

  select i.room_id, i.occurred_at into v_room, v_fecha
    from inspections i
   where i.id = new.inspection_id and i.status = 'completa';

  if v_room is null then return new; end if;

  -- Si hay una revisión completa posterior, la de ahora no manda.
  if exists (
    select 1 from inspections i
     where i.room_id = v_room and i.status = 'completa' and i.occurred_at > v_fecha
  ) then
    return new;
  end if;

  update rooms set projector_hours = new.measure::int where id = v_room;
  return new;
end $$;

comment on function public.horas_a_la_sala() is
  'Copia a rooms.projector_hours la lectura de horas de la revisión más reciente. Sin esto la columna lleva congelado el número de la importación y el Excel nunca se entera de una revisión hecha con el móvil.';

drop trigger if exists checks_horas_a_la_sala on inspection_checks;
create trigger checks_horas_a_la_sala
  after insert or update of measure, measure_unit on inspection_checks
  for each row execute function public.horas_a_la_sala();

-- Y una vez, para las revisiones que ya están: la columna lleva desde la
-- importación sin moverse, y hay lecturas más nuevas esperando en los checks.
update rooms r
   set projector_hours = ultima.medida::int
  from (
    select distinct on (i.room_id) i.room_id, c.measure as medida
      from inspections i
      join inspection_checks c on c.inspection_id = i.id
     where i.status = 'completa' and c.measure is not null and c.measure_unit = 'h'
     order by i.room_id, i.occurred_at desc
  ) ultima
 where r.id = ultima.room_id
   and r.projector_hours is distinct from ultima.medida::int;

-- -----------------------------------------------------------------------------
-- 2 — El número de incidencia
--
-- La forma la marca el libro: `I` + año, mes y día en dos cifras + `_` + cuatro
-- dígitos (`I260102_0007`). El contador es por día y se calcula mirando lo que
-- ya hay, no con una secuencia: las 285 incidencias importadas traen sus números
-- puestos, y una secuencia que empezara en 1 chocaría con ellos en cuanto se
-- abriera una el mismo día que uno de los importados.
--
-- El disparador **solo actúa si el campo viene vacío**. Quien teclea un número
-- porque se lo dio otro sistema sigue mandando.
-- -----------------------------------------------------------------------------

create or replace function public.siguiente_ref_incidencia(p_fecha timestamptz)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select 'I' || to_char(p_fecha, 'YYMMDD') || '_' ||
         lpad((coalesce(max(substring(i.external_ref from '_(\d{4})$')::int), 0) + 1)::text, 4, '0')
    from incidents i
   where i.external_ref like 'I' || to_char(p_fecha, 'YYMMDD') || '\_%'
$$;

comment on function public.siguiente_ref_incidencia(timestamptz) is
  'El siguiente I<AAMMDD>_<NNNN> libre de ese día. Mira lo que ya hay en vez de usar una secuencia: las incidencias importadas traen sus números y una secuencia chocaría con ellos.';

create or replace function public.poner_ref_incidencia()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.external_ref is null or btrim(new.external_ref) = '' then
    new.external_ref := public.siguiente_ref_incidencia(new.opened_at);
  end if;
  return new;
end $$;

drop trigger if exists incidents_ref on incidents;
create trigger incidents_ref
  before insert on incidents
  for each row execute function public.poner_ref_incidencia();

-- Un número repetido rompería el cruce con la hoja en silencio: dos filas del
-- libro apuntando a la misma incidencia, o al revés. Se cierra con un índice.
create unique index if not exists incidents_external_ref_idx
  on incidents (external_ref) where external_ref is not null;

comment on index incidents_external_ref_idx is
  'El número de incidencia es la identidad de fila de las hojas «Material Instalado»: repetido, el cruce falla sin avisar.';

-- Las que ya están sin número: se les pone uno con la fecha en que se abrieron,
-- que es lo que las coloca en la hoja del año que les toca.
do $$
declare
  r record;
begin
  for r in
    select id, opened_at from incidents
     where external_ref is null or btrim(external_ref) = ''
     order by opened_at, id
  loop
    update incidents
       set external_ref = public.siguiente_ref_incidencia(r.opened_at)
     where id = r.id;
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 3 — Una celda mala no tumba la pasada, pase lo que pase
--
-- El bloque `exception` de PL/pgSQL abre una subtransacción, que es exactamente
-- lo que hace falta: lo que esa celda hubiera escrito se deshace y el resto de
-- la pasada sigue dentro de la misma transacción.
--
-- Y el rol baja a `admin`, que es quien puede llegar a la pantalla.
-- -----------------------------------------------------------------------------

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
  -- `admin` y no `supervisor`: es quien ve la pestaña «Datos», y además el
  -- disparador que congela las revisiones completas solo perdona a `admin`.
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
      -- Lo que no estaba previsto también va a cuarentena, con lo que dijo la
      -- base. Es la diferencia entre una pasada que se puede repetir y una que
      -- deja la mitad escrita.
      v_motivo := format('la base lo rechazó: %s', sqlerrm);
    end;

    if v_motivo is null then
      v_aplicadas := v_aplicadas + 1;
      insert into import_fixes (source, row_ref, field, original, corrected, reason)
      values ('SharePoint', r->>'clave', r->>'campo', null, r->>'valor',
              coalesce(r->>'motivo', 'sincronización'));
    else
      v_rechazadas := v_rechazadas + 1;
      insert into import_quarantine (source, row_ref, raw, reason)
      values ('SharePoint', r->>'clave', r, v_motivo);
    end if;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_plan->'cuarentena', '[]'::jsonb)) loop
    insert into import_quarantine (source, row_ref, raw, reason)
    values ('SharePoint', r->>'clave', r, coalesce(r->>'motivo', 'no se puede leer'));
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
