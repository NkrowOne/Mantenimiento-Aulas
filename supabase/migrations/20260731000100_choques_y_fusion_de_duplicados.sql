-- =============================================================================
-- Los duplicados de equipo: verlos, fusionarlos y no volver a fabricarlos a ciegas
--
-- El síntoma, contado como llega: «tecleo Monitor Atril y se guarda Monitor
-- Atril 2, y en la lista no hay ningún Monitor Atril». Detrás hay una cadena
-- que cada pieza hacía razonablemente bien por separado:
--
--   1. El espejo de un dispositivo se queda incompleto (una descarga truncada
--      por el tope de filas de PostgREST, ya corregida en el cliente).
--   2. El técnico, que no ve el equipo, lo vuelve a apuntar. Tiene razón: el
--      aparato está delante.
--   3. `assets_label_libre` recibe la fila con una etiqueta que choca y, para
--      no tirar el trabajo, la guarda con el siguiente número libre.
--
-- Resultado: DOS filas para UN aparato, y nadie que pueda saberlo. El
-- renombrado del paso 3 sigue siendo la decisión correcta —rechazar la fila
-- perdía el dato, y el trigger no puede distinguir «el mismo aparato apuntado
-- dos veces» de «una segunda unidad de verdad»—. Lo que faltaba es todo lo
-- demás:
--
--   - **Rastro.** Cada renombrado por choque queda registrado, con qué se
--     pidió, qué se asignó y contra qué fila se chocó. Deja de ser un misterio
--     arqueológico y pasa a ser una lista de trabajo.
--   - **Auditoría.** Una consulta que junta los pares sospechosos —misma sala,
--     mismo tipo, misma etiqueta base— con lo que cuelga de cada uno, para que
--     una persona decida con los datos delante.
--   - **Fusión sin pérdida.** El duplicado no se borra: se retira. Su número de
--     serie y su modelo viajan al equipo bueno si le faltaban, sus incidencias
--     se le repuntan, y sus filas de revisión siguen leyéndose enteras —el
--     detalle de una revisión resuelve el aparato aunque esté retirado—. La
--     etiqueta base queda libre y vuelve al equipo bueno: el «Monitor Atril 2»
--     vuelve a llamarse «Monitor Atril».
--
-- Borrar el duplicado habría sido más limpio de contar y peor de vivir: sus
-- comprobaciones de revisión quedarían apuntando a un identificador sin nombre
-- y el histórico de la sala se volvería ilegible justo donde más se consulta.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — El rastro de cada choque de etiqueta
--
-- `asset_id` va SIN clave ajena a propósito: lo escribe un trigger BEFORE, o
-- sea antes de que la fila del equipo exista, y una clave ajena lo impediría.
-- No es un dato de integridad sino un apunte de bitácora; si el equipo se borra
-- después, el apunte sigue contando lo que pasó.
-- -----------------------------------------------------------------------------

create table if not exists asset_label_conflicts (
  id          bigint generated always as identity primary key,
  room_id     uuid references rooms(id) on delete cascade,
  -- La fila que llegó chocando (sin FK: en un INSERT todavía no existe).
  asset_id    uuid not null,
  -- La fila que ya estaba usando la etiqueta.
  choco_con   uuid references assets(id) on delete set null,
  -- Qué etiqueta traía la fila, y con cuál se guardó.
  pedida      text,
  asignada    text,
  -- `insert` y `update` los escribe el trigger. `descartado` lo escribe un
  -- coordinador para decir «este par es legítimo, dejad de enseñármelo».
  op          text not null check (op in ('insert', 'update', 'descartado')),
  at          timestamptz not null default now(),
  resolved    boolean not null default false,
  resolved_by uuid references profiles(id),
  resolved_at timestamptz
);

comment on table asset_label_conflicts is
  'Cada vez que el servidor recoloca una etiqueta que chocaba, aquí queda con qué chocó. Es la materia prima de la auditoría de duplicados.';
comment on column asset_label_conflicts.op is
  'insert/update = lo apuntó el trigger al recolocar. descartado = un coordinador revisó el par y no es un duplicado.';

-- La bandeja pregunta por lo no resuelto; lo resuelto solo se mira por historia.
create index if not exists asset_label_conflicts_vivos_idx
  on asset_label_conflicts (at desc) where not resolved;
create index if not exists asset_label_conflicts_asset_idx
  on asset_label_conflicts (asset_id);

alter table asset_label_conflicts enable row level security;

-- Lo escribe el trigger corriendo con la sesión del técnico que da el alta:
-- sin esta política, el choque de un alta legítima tumbaría el alta entera.
drop policy if exists "personal registra choques de etiqueta" on asset_label_conflicts;
create policy "personal registra choques de etiqueta" on asset_label_conflicts
  for insert to authenticated
  with check (public.is_staff());

drop policy if exists "supervisor lee choques de etiqueta" on asset_label_conflicts;
create policy "supervisor lee choques de etiqueta" on asset_label_conflicts
  for select to authenticated using (public.is_supervisor());

-- Resolver y descartar pasan por las funciones de abajo, que comprueban el rol
-- por su cuenta. No hay política de UPDATE a propósito: nadie reescribe la
-- bitácora a mano.

-- -----------------------------------------------------------------------------
-- 2 — El trigger de siempre, ahora con memoria
--
-- Mismo comportamiento que en `20260730000500`: el índice único se queda, el
-- choque se recoloca en vez de rechazarse, y el aparato nunca se pierde. La
-- única novedad es que el renombrado deja rastro. Solo puede escribirlo un
-- choque real de cliente: el equipamiento por defecto y los renombrados
-- masivos calculan la etiqueta libre ANTES de escribir, así que por aquí no
-- pasan.
-- -----------------------------------------------------------------------------

create or replace function public.assets_label_libre()
returns trigger
language plpgsql
as $$
declare
  v_base text;
  v_choca_con uuid;
  v_asignada text;
begin
  -- Solo puede chocar lo que el índice mira: en una sala, con etiqueta y sin
  -- retirar. Todo lo demás sale por aquí sin tocar nada.
  if new.room_id is null or new.label is null or new.status = 'retirado' then
    return new;
  end if;

  select a.id
    into v_choca_con
    from assets a
   where a.room_id = new.room_id
     and a.id <> new.id
     and a.status <> 'retirado'
     and a.label is not null
     and public.norm_text(a.label) = public.norm_text(new.label)
   limit 1;

  if v_choca_con is null then
    return new;
  end if;

  -- Choca. Se recoloca sobre la MISMA base, no sobre la etiqueta entera:
  -- «Pantalla 2» vuelve a ser «Pantalla» y se le busca el siguiente número
  -- libre, así que acaba en «Pantalla 3» y no en «Pantalla 2 2».
  v_base := regexp_replace(btrim(new.label), '\s+[0-9]+$', '');
  if v_base = '' then
    v_base := btrim(new.label);
  end if;

  v_asignada := public.next_asset_label(new.room_id, v_base, new.id);

  -- El apunte, antes de tocar la fila: qué se pidió, qué se asignó, contra qué.
  -- Es lo que convierte «¿de dónde ha salido este 2?» en una fila de la
  -- bandeja de duplicados con el par ya identificado.
  insert into asset_label_conflicts (room_id, asset_id, choco_con, pedida, asignada, op)
  values (new.room_id, new.id, v_choca_con, new.label, v_asignada, lower(tg_op));

  new.label := v_asignada;
  return new;
end;
$$;

comment on function public.assets_label_libre() is
  'Recoloca la etiqueta de un equipo cuando choca en su sala, en vez de rechazar la fila. Deja el choque apuntado en asset_label_conflicts.';

-- El trigger ya existe con este nombre; recrearlo mantiene el orden alfabético
-- respecto a `assets_confirmed_guard`, que sigue dando igual: uno mira
-- `confirmed` y el otro `label`.
drop trigger if exists assets_label_libre on assets;
create trigger assets_label_libre
  before insert or update on assets
  for each row execute function public.assets_label_libre();

-- -----------------------------------------------------------------------------
-- 3 — La bandeja: qué pares parecen el mismo aparato
--
-- Misma sala, mismo tipo vivo y misma etiqueta base. De cada grupo se propone
-- como «bueno» el más antiguo —suele ser el materializado o el importado— y
-- como duplicado cada uno de los demás, PERO solo si hay motivo de sospecha:
-- que lo haya apuntado una persona, o que el trigger tenga apuntado el choque.
-- Sin ese filtro, cada «Pantalla»/«Pantalla 2» legítimo del equipamiento por
-- defecto con cantidad dos saldría en la bandeja, y una bandeja que llora por
-- todo es una bandeja que nadie mira.
--
-- Con cada lado viajan sus registros —cuántas revisiones lo comprobaron,
-- cuántas incidencias le apuntan, cuántos eventos tiene— porque esa es la
-- pregunta que decide la fusión: el lado con historia es el que se queda.
-- La decisión es siempre de una persona; esto solo pone los datos delante.
-- -----------------------------------------------------------------------------

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
  order by 19 desc, b.code, r.code, t.name, d.created_at;
end;
$$;

comment on function public.auditoria_duplicados() is
  'Pares de equipos que parecen el mismo aparato apuntado dos veces, con lo que cuelga de cada lado. Solo propone: decide una persona.';

-- -----------------------------------------------------------------------------
-- 4 — Fusionar: el duplicado se retira, nada se pierde
--
-- Retirar y no borrar es la decisión que sostiene todo lo demás:
--
--   - Las comprobaciones de revisión que lo nombran siguen resolviéndose a su
--     etiqueta, su modelo y su serie — el detalle de una revisión junta el
--     aparato aunque esté retirado, y dice «retirado desde entonces».
--   - El índice único de etiquetas ignora a los retirados, así que la base
--     queda libre y el equipo bueno recupera su nombre de verdad.
--   - La descarga al dispositivo no trae retirados y la poda hace el resto:
--     el fantasma desaparece de todos los iPads en la siguiente sincronización.
--
-- Lo que el duplicado sabía y el bueno no —número de serie, modelo, su
-- validación— viaja al bueno antes de retirar. Las incidencias se repuntan:
-- hablan del aparato físico, y el aparato físico es el que se queda.
-- -----------------------------------------------------------------------------

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
  'Funde dos filas que son el mismo aparato: retira el duplicado sin borrarlo, conserva serie, modelo, incidencias e histórico, y devuelve la etiqueta final del que se queda.';

-- -----------------------------------------------------------------------------
-- 5 — Descartar: «este par es legítimo»
--
-- La bandeja propone por heurística, y una heurística se equivoca: dos
-- pantallas de verdad, apuntadas por una persona, son un par sospechoso
-- eterno. Descartar deja una lápida y el par no vuelve a proponerse. No toca
-- ningún equipo.
-- -----------------------------------------------------------------------------

create or replace function public.descartar_duplicado(
  p_duplicado uuid,
  p_bueno     uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo uuid := (select auth.uid());
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador descarta pares de la auditoría'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from assets where id = p_duplicado) then
    raise exception 'Ese equipo ya no existe';
  end if;

  insert into asset_label_conflicts
    (room_id, asset_id, choco_con, pedida, asignada, op, resolved, resolved_by, resolved_at)
  select a.room_id, p_duplicado, p_bueno, null, null, 'descartado', true, v_yo, now()
    from assets a where a.id = p_duplicado;

  -- Y los choques vivos de ese equipo quedan cerrados: ya los ha mirado alguien.
  update asset_label_conflicts
     set resolved = true, resolved_by = v_yo, resolved_at = now()
   where not resolved and asset_id = p_duplicado;
end;
$$;

comment on function public.descartar_duplicado(uuid, uuid) is
  'Marca un par de la auditoría como legítimo para que no vuelva a proponerse. No toca ningún equipo.';

-- -----------------------------------------------------------------------------
-- 6 — El resumen: cuánto hay de cada cosa, contado por el servidor
--
-- Es la mitad «auditoría» del panel: los números de verdad de la base, no los
-- del espejo de un dispositivo. Cuando el iPad dice 900 equipos y esto dice
-- 1.100, la conversación cambia de «se han perdido datos» a «ese dispositivo
-- no ha terminado de descargar» — que es la diferencia entre un susto y un
-- diagnóstico.
-- -----------------------------------------------------------------------------

create or replace function public.auditoria_inventario()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un coordinador consulta la auditoría'
      using errcode = 'insufficient_privilege';
  end if;

  select jsonb_build_object(
    'equipos', jsonb_build_object(
      'instalados', (select count(*) from assets where status = 'instalado'),
      'averiados',  (select count(*) from assets where status = 'averiado'),
      'retirados',  (select count(*) from assets where status = 'retirado'),
      'sin_sala',   (select count(*) from assets where room_id is null and status <> 'retirado'),
      'sin_validar', (select count(*) from assets where not confirmed and status <> 'retirado')
    ),
    'tipos', jsonb_build_object(
      'vivos',       (select count(*) from asset_types where merged_into is null),
      'sin_validar', (select count(*) from asset_types where merged_into is null and not confirmed),
      'fusionados',  (select count(*) from asset_types where merged_into is not null)
    ),
    'incidencias', jsonb_build_object(
      'abiertas',   (select count(*) from incidents where state = 'abierta' and kind <> 'observacion'),
      'en_curso',   (select count(*) from incidents where state = 'en_curso' and kind <> 'observacion'),
      'resueltas',  (select count(*) from incidents where state = 'resuelta' and kind <> 'observacion'),
      'borradores', (select count(*) from incidents where state = 'borrador')
    ),
    'revisiones', jsonb_build_object(
      'cerradas',   (select count(*) from inspections where status = 'completa'),
      'visitas',    (select count(distinct coalesce(corrects, id)) from inspections_vigentes),
      'borradores', (select count(*) from inspections where status = 'borrador')
    ),
    'salas', jsonb_build_object(
      'activas',    (select count(*) from rooms where active),
      'archivadas', (select count(*) from rooms where not active)
    ),
    'choques_sin_resolver', (
      select count(*) from asset_label_conflicts
       where not resolved and op in ('insert', 'update')
    ),
    'duplicados_sospechosos', (select count(*) from public.auditoria_duplicados())
  ) into v;

  return v;
end;
$$;

comment on function public.auditoria_inventario() is
  'Los recuentos de la base, contados por el servidor: equipos, tipos, incidencias, revisiones, salas y duplicados por revisar.';

-- Las cuatro se publican; cada una comprueba el rol por dentro, como el resto
-- del panel.
grant execute on function public.auditoria_duplicados()                 to authenticated;
grant execute on function public.fusionar_equipo_duplicado(uuid, uuid)  to authenticated;
grant execute on function public.descartar_duplicado(uuid, uuid)        to authenticated;
grant execute on function public.auditoria_inventario()                 to authenticated;

notify pgrst, 'reload schema';
