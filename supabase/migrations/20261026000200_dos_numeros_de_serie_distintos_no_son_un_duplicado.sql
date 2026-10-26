-- =============================================================================
-- Dos números de serie distintos no son el mismo aparato
--
-- La bandeja de duplicados propone pares por el nombre: misma sala, mismo tipo
-- y misma **etiqueta base** —la etiqueta sin el número de cola—. Es la
-- heurística correcta para lo que se inventó: el «Monitor Atril 2» que nació
-- porque un iPad con el espejo atrasado volvió a apuntar el monitor que ya
-- estaba.
--
-- Pero hay aulas donde el número de cola no es un accidente del disparador:
-- **es el sitio**. En el laboratorio de informática 6 los treinta ordenadores
-- de los alumnos se llaman «Puesto 1» … «Puesto 30» desde `20260922000500`, y
-- se llaman así justamente para que alguien que entra a arreglar uno sepa a
-- qué mesa ir. Para la bandeja eran treinta filas con la misma etiqueta base y
-- las propuso como veintinueve duplicados del primero. Alguien fue pulsando
-- «Fusionar», que es lo que la pantalla le estaba pidiendo, y el aula se quedó
-- con un ordenador vivo y veintinueve retirados «en una fusión de duplicados».
-- Los treinta siguen enchufados encima de la mesa.
--
-- Lo que faltaba no es desconfiar de la heurística del nombre: es mirar el dato
-- que ya decide la identidad de un aparato en el resto del proyecto. El número
-- de serie es único en toda la base y dentro del aula manda sobre el nombre
-- (`20260901000100`). Dos filas con dos series distintas **no pueden** ser el
-- mismo aparato apuntado dos veces: son dos aparatos. No hay caso en el que
-- fusionarlas sea lo correcto, así que ni se proponen ni se dejan fusionar.
--
-- Dicho al revés, para que se vea el límite: esto NO cubre el par en el que una
-- de las dos filas no tiene serie —que es el duplicado típico, apuntado a mano
-- y sin leer la pegatina—. Ese sigue proponiéndose y sigue fusionándose, que es
-- para lo que está la bandeja.
--
-- Y una errata al teclear la serie del mismo aparato dos veces tampoco se
-- fusiona ahora: el mensaje dice las dos series y manda a corregir la mala
-- primero. Es más trabajo que antes y es el orden correcto — fusionar con una
-- serie equivocada deja la serie equivocada en el equipo que se queda, y eso ya
-- no lo ve nadie.
-- =============================================================================

create or replace function public.auditoria_duplicados()
returns table (
  room_id uuid,
  room_code text,
  room_name text,
  building_code text,
  tipo text,
  base text,
  bueno_id uuid,
  bueno_label text,
  bueno_serial text,
  bueno_model text,
  bueno_registros integer,
  dup_id uuid,
  dup_label text,
  dup_serial text,
  dup_model text,
  dup_registros integer,
  dup_creado timestamptz,
  dup_creado_por text,
  choque_registrado boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador audita los duplicados'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  with vivos as (
    select a.id,
           a.room_id as sala,
           coalesce(t.merged_into, a.asset_type_id) as tipo_id,
           a.label, a.serial, a.model, a.created_at, a.created_by,
           public.norm_text(regexp_replace(btrim(a.label), '\s+[0-9]+$', '')) as etiqueta_base
      from assets a
      join asset_types t on t.id = a.asset_type_id
     where a.room_id is not null
       and a.label is not null
       and a.status <> 'retirado'
  ),
  -- El «bueno» propuesto de cada grupo: el más antiguo. La fusión acepta los
  -- dos sentidos, así que equivocarse aquí no pierde nada — solo propone.
  cabezas as (
    select distinct on (v.sala, v.tipo_id, v.etiqueta_base) v.*
      from vivos v
     order by v.sala, v.tipo_id, v.etiqueta_base, v.created_at, v.id
  ),
  registros as (
    select v.id as asset,
           (select count(*) from inspection_checks c where c.check_key = 'asset:' || v.id::text)
         + (select count(*) from incidents i where i.asset_id = v.id)
         + (select count(*) from asset_events e where e.asset_id = v.id) as n
      from vivos v
  )
  select
    d.sala,
    r.code,
    r.name,
    b.code,
    t.name,
    d.etiqueta_base,
    c.id,
    c.label,
    c.serial,
    c.model,
    (select rg.n from registros rg where rg.asset = c.id)::integer,
    d.id,
    d.label,
    d.serial,
    d.model,
    (select rg.n from registros rg where rg.asset = d.id)::integer,
    d.created_at,
    p.full_name,
    exists (
      select 1 from asset_label_conflicts x
       where x.asset_id = d.id and x.op in ('insert', 'update') and not x.resolved
    )
  from vivos d
  join cabezas c
    on c.sala = d.sala and c.tipo_id = d.tipo_id and c.etiqueta_base = d.etiqueta_base
   and c.id <> d.id
  join rooms r      on r.id = d.sala
  join zones z      on z.id = r.zone_id
  join buildings b  on b.id = z.building_id
  join asset_types t on t.id = d.tipo_id
  left join profiles p on p.id = d.created_by
  where (
      d.created_by is not null
      or exists (
        select 1 from asset_label_conflicts x
         where x.asset_id = d.id and x.op in ('insert', 'update') and not x.resolved
      )
    )
    -- Un par que un coordinador ya revisó y declaró legítimo no vuelve a salir.
    and not exists (
      select 1 from asset_label_conflicts x
       where x.asset_id = d.id and x.op = 'descartado'
    )
    -- Y dos series distintas son dos aparatos, se llamen como se llamen. Es lo
    -- que saca de la bandeja los treinta puestos del laboratorio de
    -- informática sin tener que descartarlos uno a uno — y lo que impide que
    -- vuelvan a entrar mañana con la siguiente aula numerada.
    and (
      d.serial is null
      or c.serial is null
      or public.norm_text(d.serial) = public.norm_text(c.serial)
    )
  order by 19 desc, b.code, r.code, t.name, d.created_at;
end;
$$;

comment on function public.auditoria_duplicados() is
  'Pares de equipos que parecen el mismo aparato apuntado dos veces, con lo que cuelga de cada lado. No propone pares con dos números de serie distintos: eso son dos aparatos. Solo propone: decide una persona.';

create or replace function public.fusionar_equipo_duplicado(
  p_duplicado uuid,
  p_bueno     uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  d assets%rowtype;
  b assets%rowtype;
  v_yo uuid := (select auth.uid());
  v_base text;
  v_label text;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador fusiona equipos duplicados'
      using errcode = 'insufficient_privilege';
  end if;
  if p_duplicado = p_bueno then
    raise exception 'Un equipo no se fusiona consigo mismo';
  end if;

  select * into d from assets where id = p_duplicado;
  if not found then
    raise exception 'El duplicado ya no existe';
  end if;
  select * into b from assets where id = p_bueno;
  if not found then
    raise exception 'El equipo que se queda ya no existe';
  end if;
  if d.status = 'retirado' then
    raise exception 'Ese duplicado ya está retirado';
  end if;
  if d.room_id is null or b.room_id is null or d.room_id <> b.room_id then
    raise exception 'Solo se fusionan dos equipos de la misma sala';
  end if;
  if (select coalesce(t.merged_into, t.id) from asset_types t where t.id = d.asset_type_id)
     is distinct from
     (select coalesce(t.merged_into, t.id) from asset_types t where t.id = b.asset_type_id) then
    raise exception 'Solo se fusionan dos equipos del mismo tipo';
  end if;

  -- La identidad de un aparato es su número de serie, no su nombre. Con dos
  -- series distintas delante, el par no es un duplicado por mucho que la
  -- bandeja lo haya propuesto alguna vez: son dos máquinas, y fusionarlas
  -- retira una que está puesta. El mensaje lleva las dos series porque el
  -- siguiente paso —si de verdad es el mismo aparato— es corregir la que esté
  -- mal, y para eso hay que saber cuáles son.
  if d.serial is not null and b.serial is not null
     and public.norm_text(d.serial) is distinct from public.norm_text(b.serial) then
    raise exception
      'No son el mismo aparato: «%» y «%» son dos números de serie distintos. Si uno está mal apuntado, corrígelo en la ficha del aula y vuelve a intentarlo.',
      d.serial, b.serial;
  end if;

  -- Lo que el duplicado sabe y el bueno no, viaja antes de retirar. La serie
  -- primero se suelta y luego se asigna: es única en toda la base y moverla en
  -- dos pasos es lo que evita chocar con su propio índice.
  if d.serial is not null and b.serial is null then
    update assets set serial = null where id = p_duplicado;
    update assets set serial = d.serial where id = p_bueno;
  end if;
  if d.model is not null and b.model is null then
    update assets set model = d.model where id = p_bueno;
  end if;
  if d.confirmed and not b.confirmed then
    update assets set confirmed = true where id = p_bueno;
  end if;

  -- Las incidencias hablan del aparato físico, y el aparato físico se queda.
  update incidents set asset_id = p_bueno where asset_id = p_duplicado;

  -- Una retirada pendiente del duplicado ya no tiene objeto: el equipo del que
  -- hablaba deja de existir como fila viva. Las decididas se quedan, que son
  -- historia.
  delete from asset_removals where asset_id = p_duplicado and state = 'pendiente';

  -- El retiro libera la etiqueta y saca al fantasma de todos los dispositivos
  -- en la siguiente descarga.
  update assets set status = 'retirado' where id = p_duplicado;

  -- Y el bueno recupera la etiqueta base si el duplicado la tenía ocupada:
  -- el «Monitor Atril 2» vuelve a llamarse «Monitor Atril».
  v_base := btrim(regexp_replace(btrim(coalesce(d.label, '')), '\s+[0-9]+$', ''));
  v_label := b.label;
  if v_base <> ''
     and b.label is not null
     and public.norm_text(regexp_replace(btrim(b.label), '\s+[0-9]+$', '')) = public.norm_text(v_base)
     and public.norm_text(b.label) <> public.norm_text(v_base)
  then
    v_label := public.next_asset_label(b.room_id, v_base, p_bueno);
    update assets set label = v_label where id = p_bueno;
  end if;

  -- El rastro, en los dos sentidos: en el histórico de la sala se lee qué se
  -- retiró, por qué, y quién se quedó con su identidad.
  insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
  values
    (gen_random_uuid(), p_duplicado, d.room_id, 'baja', now(), v_yo,
     jsonb_build_object(
       'nota', 'Retirado en una fusión de duplicados',
       'fusionado_en', p_bueno)),
    (gen_random_uuid(), p_bueno, b.room_id, 'sustitucion', now(), v_yo,
     jsonb_build_object(
       'nota', 'Absorbe un equipo duplicado',
       'duplicado', p_duplicado,
       'etiqueta_del_duplicado', d.label));

  -- Los choques que hablaban de este par quedan resueltos.
  update asset_label_conflicts
     set resolved = true, resolved_by = v_yo, resolved_at = now()
   where not resolved
     and (asset_id in (p_duplicado, p_bueno) or choco_con in (p_duplicado, p_bueno));

  return v_label;
end;
$$;

comment on function public.fusionar_equipo_duplicado(uuid, uuid) is
  'Funde dos filas que son el mismo aparato: retira el duplicado sin borrarlo, conserva serie, modelo, incidencias e histórico, y devuelve la etiqueta final del que se queda. Rechaza el par cuyas dos filas tienen números de serie distintos: eso son dos aparatos.';

-- Las dos se vuelven a publicar: `create or replace function` conserva los
-- permisos, pero repetirlos cuesta dos líneas y vale para una base donde la
-- migración original no llegara a correr entera.
grant execute on function public.auditoria_duplicados()                 to authenticated;
grant execute on function public.fusionar_equipo_duplicado(uuid, uuid)  to authenticated;

notify pgrst, 'reload schema';
