-- =============================================================================
-- La papelera de edificios, y poder corregir un nombre donde se ve mal
--
-- Dos agujeros del maestro que se notan desde el aula y que hasta hoy solo se
-- tapaban abriendo una consola de `psql` contra el servidor — es decir, no se
-- tapaban:
--
--  1. **Un edificio no se podía dar de baja.** `delete_building` contaba sus
--     salas y, con una sola, reventaba con «El edificio todavía tiene N
--     sala(s). Dalas de baja o fusiónalo con otro.». El comentario de bloque de
--     `20260730000100:885-894` explicaba por qué no había archivado: «`buildings`
--     no tiene `active`, y añadírselo obligaría a tocar `room_overview` y las
--     tres vistas de alertas que cuelgan de ella». **Ese párrafo deja de ser
--     cierto aquí**, y el coste resultó menor de lo que parecía: añadir
--     `and b.active` al `where` de `room_overview` no cambia ni una de sus 19
--     columnas, así que `create or replace view` vale, y las cuatro alertas
--     —`alerts_lamp_low`, `alerts_overdue_rooms`, `alerts_stale_incidents` y
--     `alerts_repeat_offenders`— heredan el filtro sin que haya que tocarlas.
--     El precio real era un `create or replace view` bien copiado, no una
--     cascada de cuatro.
--
--     Mientras tanto, la única salida que quedaba era vaciar el edificio sala a
--     sala —39 confirmaciones para el edificio grande— o fusionarlo con otro,
--     que es una respuesta distinta a una pregunta distinta.
--
--  2. **La nomenclatura no se podía corregir.** Un edificio mal tecleado, un
--     aula que en la placa pone `1.7` y en la lista `17`, una planta importada
--     como «1a planta» conviviendo con «1ª PLANTA»: todo eso se ve desde la
--     lista de «Revisar», con el iPad en la mano, y no había ninguna manera de
--     arreglarlo desde ahí. Un error de nomenclatura que no se puede corregir
--     enseña a desconfiar de la lista entera, que es lo caro.
--
-- Y una regla que atraviesa el fichero: **archivar un edificio no toca sus
-- salas**. Sus 39 filas se quedan con `rooms.active = true` debajo de un
-- edificio con `active = false`. Restaurar tiene que devolver exactamente lo
-- que había, y voltear 39 `rooms.active` y volver a voltearlos borraría para
-- siempre la distinción entre «esta aula concreta está de baja» y «el edificio
-- entero está de baja»: al restaurar volverían a la vida también las que
-- alguien había archivado a mano meses antes.
--
-- Eso obliga a arreglar de paso un agujero que ya existía en potencia:
-- `archived_rooms` filtraba `where not r.active`, así que las salas de un
-- edificio archivado saldrían de `room_overview` **sin** aparecer en la
-- papelera del panel. Invisibles en los dos lados y sin forma de recuperarlas.
-- Ahora la vista las arrastra con una columna `motivo` que dice por qué están
-- ahí, que es lo que decide si el panel ofrece «Reactivar» o «se restaura con
-- su edificio».
--
-- Lo que NO se filtra por `b.active`, a propósito: `room_timeline`,
-- `room_inspections`, `incidents_by_building`, `asset_removal_queue`,
-- `auditoria_duplicados` y `room_repeat_offenders`. Archivar limpia la lista de
-- trabajo; el pasado se sigue leyendo entero. Es exactamente la razón por la
-- que `delete_room` archiva en vez de borrar.
--
-- Todo lo que decide va detrás de `is_admin()` con `errcode =
-- 'insufficient_privilege'`, que es lo que el cliente sabe distinguir de un
-- error de validación. La RLS de `buildings`, `zones` y `rooms` ya era «solo
-- admin escribe»: aquí no se abre nada, se le da una puerta a lo que ya estaba
-- permitido.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — La columna
--
-- Con default, así que `seed.sql` —que inserta con lista de columnas explícita—
-- sigue funcionando sin tocar una línea, y el disparador `buildings_audit`, que
-- ya existe desde `20260728000300`, registra el archivado y el restaurado como
-- dos UPDATE normales sin que haya que enseñarle nada.
--
-- El `unique (code)` de `buildings` sigue siendo **global**, sin filtro por
-- `active`: el código de un edificio archivado sigue ocupado. Es deliberado —el
-- código va impreso en las placas y en el histórico de incidencias, y reciclarlo
-- mientras el original se puede restaurar sería fabricar dos edificios «H»—, y
-- de decirlo con una frase que ayude se encarga `create_building`.
-- -----------------------------------------------------------------------------

alter table buildings add column if not exists active boolean not null default true;

comment on column buildings.active is
  'False = en la papelera. Sus salas conservan active = true: restaurar devuelve lo que había.';

-- -----------------------------------------------------------------------------
-- 2 — `room_overview`, que es la lista de trabajo
--
-- La vista se reescribe entera porque una vista no se parchea por trozos. Lo
-- que sigue es la definición vigente de `20260731000200_recuentos_sin_
-- observaciones.sql:25-70` copiada sin un cambio —con `inspections_vigentes`,
-- con el `left join lateral` de `room_inventories` y con el `kind <>
-- 'observacion'` del recuento— y con la última línea, y solo la última línea,
-- distinta: `where r.active and b.active`.
--
-- Copiar aquí una versión anterior (la de `20260729001300` o la de
-- `20260730000700`) revertiría en silencio dos correcciones ya hechas: la
-- insignia volvería a contar observaciones y la fecha de la última revisión
-- volvería a leerse de las revisiones reemplazadas en vez de las vigentes.
--
-- Esta línea es la que hace que archivar limpie de verdad: `room_overview` es
-- la lista de salas, el buscador y lo que baja al espejo de los 23 iPads.
-- -----------------------------------------------------------------------------

create or replace view room_overview as
select
  r.id                as room_id,
  r.code              as room_code,
  r.name              as room_name,
  r.kind,
  r.capabilities,
  r.projector_hours,
  r.lamp_pct,
  z.id                as zone_id,
  z.name              as zone_name,
  b.id                as building_id,
  b.code              as building_code,
  b.name              as building_name,
  b.sort_order        as building_order,
  z.sort_order        as zone_order,
  li.occurred_at      as last_inspection_at,
  li.overall          as last_inspection_overall,
  coalesce(oi.open_count, 0)::int as open_incidents,
  r.short_ref,
  lv.occurred_at      as last_inventory_at
from rooms r
join zones z     on z.id = r.zone_id
join buildings b on b.id = z.building_id
left join lateral (
  select i.occurred_at, i.overall
  from inspections_vigentes i
  where i.room_id = r.id
  order by i.occurred_at desc, i.corrected_at desc nulls first
  limit 1
) li on true
left join lateral (
  select v.occurred_at
  from room_inventories v
  where v.room_id = r.id
  order by v.occurred_at desc
  limit 1
) lv on true
left join lateral (
  select count(*) as open_count
  from incidents inc
  where inc.room_id = r.id
    and inc.state not in ('resuelta', 'borrador')
    and inc.kind <> 'observacion'
) oi on true
where r.active and b.active;

alter view room_overview set (security_invoker = on);

comment on view room_overview is
  'Las salas activas de los edificios activos con su contexto. open_incidents cuenta averías y solicitudes vivas: ni borradores ni observaciones, igual que la pestaña de Incidencias.';

-- -----------------------------------------------------------------------------
-- 3 — `archived_rooms`: la papelera tiene que saber POR QUÉ está cada sala
--
-- Filtraba `where not r.active`. Como archivar un edificio no toca sus salas,
-- sus 39 filas se quedaban con `r.active = true`: fuera de `room_overview` por
-- el `b.active` de arriba y fuera de aquí por el `not r.active` — invisibles en
-- los dos lados del panel y sin ninguna manera de recuperarlas.
--
-- La columna `motivo` va al final porque es lo único que `create or replace
-- view` permite añadir sin tirar la vista, y dice justo lo que el panel
-- necesita para no ofrecer un fallo: con `motivo = 'edificio'` no se pinta
-- «Reactivar» sino «Se restaura con su edificio», porque reactivar esa sala
-- sola no la devolvería a ningún sitio —seguiría colgando de un edificio que
-- `room_overview` no enseña— y `restore_room` lo rechaza explícitamente.
--
-- Y son TRES valores, no dos, porque son tres las cosas que le pueden pasar a
-- una sala que no está en la lista de trabajo. El caso que se cuela entre las
-- dos evidentes es el de la sala archivada a mano DENTRO de un edificio
-- archivado: `restore_building` no toca `rooms` —es la regla de la cabecera de
-- este fichero, y es deliberada—, así que esa sala no vuelve al restaurar el
-- edificio; pero tampoco se puede reactivar mientras el edificio siga en la
-- papelera, porque `restore_room` lo rechaza. Marcarla `'edificio'` le
-- prometería una vuelta que no ocurre, y marcarla `'sala'` le daría un
-- «Reactivar» que solo sabe fallar. Necesita frase propia:
--
--   'sala'            — la archivaron a ella. Vuelve con «Reactivar».
--   'edificio'        — está viva debajo de un edificio archivado. Vuelve sola
--                       al restaurar el edificio, y por eso no lleva botón.
--   'sala-y-edificio' — las dos cosas. Ni una ni otra hasta que vuelva el
--                       edificio, y entonces se reactiva a mano.
--
-- Con esto el recuento `salas` de `archived_buildings` —que cuenta solo las
-- `r.active`, o sea las que de verdad vuelven— deja de contradecir a esta
-- lista: lo que sobra aquí es justo lo marcado `'sala-y-edificio'`.
-- -----------------------------------------------------------------------------

create or replace view archived_rooms as
select r.id   as room_id,
       r.code as room_code,
       r.name as room_name,
       r.short_ref,
       z.name as zone_name,
       b.id   as building_id,
       b.code as building_code,
       b.name as building_name,
       case
         when not b.active and r.active then 'edificio'
         when not b.active              then 'sala-y-edificio'
         else 'sala'
       end as motivo
from rooms r
join zones z     on z.id = r.zone_id
join buildings b on b.id = z.building_id
where not r.active or not b.active;

alter view archived_rooms set (security_invoker = on);

comment on view archived_rooms is
  'Las salas que no están en la lista de trabajo. motivo dice qué las sacó: «sala» (se reactiva), «edificio» (vuelve al restaurarlo) o «sala-y-edificio» (ni una cosa ni la otra hasta que vuelva el edificio).';

-- -----------------------------------------------------------------------------
-- 4 — `archived_buildings`: la papelera de edificios
--
-- Los dos recuentos no son adorno: son lo que convierte «Restaurar» en una
-- decisión en vez de en una apuesta. Un edificio en la papelera es un nombre y
-- poco más; «39 salas · 412 revisiones» es lo que se recupera al pulsar, y es
-- también lo que hace evidente que no se ha perdido nada.
--
-- `salas` cuenta solo las activas —las que volverán a la lista de trabajo— y
-- `revisiones` cuenta todas, incluidas las de las salas archivadas a mano: el
-- histórico no se pierde ni cuando la sala no vuelve.
-- -----------------------------------------------------------------------------

create or replace view archived_buildings as
select b.id   as building_id,
       b.code as building_code,
       b.name as building_name,
       b.sort_order,
       (select count(*) from rooms r join zones z on z.id = r.zone_id
         where z.building_id = b.id and r.active)::int  as salas,
       (select count(*) from inspections i
          join rooms r on r.id = i.room_id
          join zones z on z.id = r.zone_id
         where z.building_id = b.id)::int               as revisiones
from buildings b
where not b.active;

alter view archived_buildings set (security_invoker = on);

comment on view archived_buildings is
  'La papelera de edificios. Los recuentos son lo que se recupera al restaurarlo.';

-- -----------------------------------------------------------------------------
-- 5 — El equipamiento por defecto no entra en la papelera
--
-- `materializar_defaults` recorría todas las salas activas del campus sin mirar
-- de qué edificio cuelgan. Aplicar el equipamiento por defecto desde el panel
-- —un botón que se pulsa «por si acaso» después de tocar el catálogo— habría
-- creado proyectores y pantallas dentro de un edificio que está en la papelera:
-- equipos que nadie ve, que nadie va a instalar y que aparecerían de golpe el
-- día que alguien restaure el edificio, fechados el día equivocado.
--
-- Es copia literal de `20260730000100:373-425` con dos líneas más en el `from`
-- del bucle: el `join buildings` y el `and b.active`. Todo lo demás —el
-- `distinct on` que hace que el defecto del edificio gane al global, el seguir
-- `merged_into` para no materializar una lápida, el `confirmed = true` y el
-- `created_by` nulo que la mantienen fuera de `room_timeline`— queda igual.
--
-- `create or replace function` conserva los ACL, pero el `revoke` se repite
-- igualmente: el fichero tiene que decir que esta función sigue sin publicarse.
-- La puerta con permisos es `apply_asset_defaults`, y no comprueba roles aquí
-- porque la llama también el disparador de alta de sala, que corre desde el
-- importador sin ningún JWT.
-- -----------------------------------------------------------------------------

create or replace function public.materializar_defaults(
  p_building uuid default null,
  p_room     uuid default null
)
returns integer
language plpgsql
as $$
declare
  d record;
  v_faltan int;
  v_total int := 0;
  i int;
begin
  for d in
    select distinct on (r.id, coalesce(t.merged_into, t.id))
           r.id as room_id,
           coalesce(t.merged_into, t.id) as type_id,
           def.qty
      from rooms r
      join zones z           on z.id = r.zone_id
      join buildings b       on b.id = z.building_id
      join asset_defaults def on (def.building_id is null or def.building_id = z.building_id)
      join asset_types t     on t.id = def.asset_type_id
     where r.active
       and b.active
       and (p_room is null or r.id = p_room)
       and (p_building is null or z.building_id = p_building)
     order by r.id, coalesce(t.merged_into, t.id), (def.building_id is not null) desc
  loop
    select d.qty - count(*)
      into v_faltan
      from assets a
     where a.room_id = d.room_id
       and a.asset_type_id = d.type_id
       and a.status <> 'retirado';

    for i in 1..greatest(v_faltan, 0) loop
      insert into assets (asset_type_id, room_id, label, status, confirmed)
      select d.type_id,
             d.room_id,
             public.next_asset_label(d.room_id, t.name),
             'instalado',
             true
        from asset_types t
       where t.id = d.type_id;

      v_total := v_total + 1;
    end loop;
  end loop;

  return v_total;
end;
$$;

revoke execute on function public.materializar_defaults(uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6 — Las tres altas que ahora tienen que contar con la papelera
--
-- Las tres son la misma historia: un edificio archivado sigue existiendo, con
-- su código ocupado y sus salas dentro, y las funciones que se escribieron
-- cuando `active` no existía se lo encuentran de frente. Ninguna cambia de
-- firma; lo que cambia es que ahora saben decir lo que pasa.
--
-- El criterio de todos los mensajes: un `raise exception` es lo único que llega
-- a la pantalla del iPad, así que tiene que decir qué ha pasado y qué hacer.
-- «duplicate key value violates unique constraint buildings_code_key» no dice
-- ninguna de las dos cosas.
-- -----------------------------------------------------------------------------

create or replace function public.create_building(p_code text, p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_activo boolean;
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_name text := btrim(coalesce(p_name, ''));
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador da de alta edificios'
      using errcode = 'insufficient_privilege';
  end if;
  if v_code = '' or v_name = '' then
    raise exception 'El edificio necesita código y nombre';
  end if;

  -- El `unique (code)` no distingue entre vivo y archivado, así que sin este
  -- desdoble el administrador que intenta recrear el edificio que él mismo dio
  -- de baja recibe «Ya existe un edificio con el código H» mirando una lista
  -- donde no está — y lo siguiente que hace es inventarse «H2».
  select active into v_activo from buildings where upper(code) = v_code;
  if found and v_activo then
    raise exception 'Ya existe un edificio con el código %', v_code;
  elsif found then
    raise exception 'El código % es de un edificio que está en la papelera. Restáuralo desde Datos en vez de crearlo otra vez.', v_code;
  end if;

  -- Al final de la lista, y con hueco: el orden de la pantalla de edificios se
  -- retoca a mano y dejar saltos de diez evita tener que renumerar los 23.
  insert into buildings (code, name, sort_order, needs_review)
  select v_code, v_name, coalesce(max(sort_order), 0) + 10, false from buildings
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.create_building(text, text) is
  'Da de alta un edificio. Distingue el código ocupado por uno vivo del ocupado por uno de la papelera.';

create or replace function public.create_room(
  p_building uuid,
  p_zone     text,
  p_code     text,
  p_name     text,
  p_kind     room_kind default 'aula'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_zone uuid;
  v_room uuid;
  v_activo boolean;
  v_zone_name text := btrim(coalesce(p_zone, ''));
  v_code text := btrim(coalesce(p_code, ''));
  v_name text := btrim(coalesce(p_name, ''));
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador da de alta salas'
      using errcode = 'insufficient_privilege';
  end if;
  if v_code = '' then
    raise exception 'La sala necesita un código';
  end if;

  -- Existe pero está en la papelera: la sala se crearía perfectamente y no
  -- aparecería en ninguna parte, porque `room_overview` filtra por `b.active`.
  -- Un alta que dice «hecho» y no se ve es peor que un alta que se niega.
  select active into v_activo from buildings where id = p_building;
  if not found then
    raise exception 'Ese edificio no existe';
  end if;
  if not v_activo then
    raise exception 'Ese edificio está en la papelera. Restáuralo antes de añadirle salas.';
  end if;

  if v_zone_name = '' then
    v_zone_name := 'SIN ZONA';
  end if;
  -- El nombre descriptivo es opcional: en la hoja de estado la mayoría de las
  -- aulas se llaman como su código, y repetirlo a mano solo produce erratas.
  if v_name = '' then
    v_name := v_code;
  end if;

  -- La zona se busca normalizada y se crea si no está. Es lo que impide que
  -- «1ª PLANTA» y «1ª Planta» acaben siendo dos plantas del mismo edificio.
  select id into v_zone
    from zones
   where building_id = p_building
     and public.norm_text(name) = public.norm_text(v_zone_name);

  if v_zone is null then
    insert into zones (building_id, name, sort_order)
    select p_building, v_zone_name, coalesce(max(sort_order), 0) + 10
      from zones where building_id = p_building
    returning id into v_zone;
  end if;

  -- Se compara normalizado y no con `=`, que es lo que hace el `unique
  -- (zone_id, code)`: ese único es sensible a mayúsculas, así que `a1` y `A1`
  -- entrarían las dos como salas distintas de la misma planta y en la lista se
  -- leerían como la misma repetida.
  if exists (select 1 from rooms
              where zone_id = v_zone
                and public.norm_text(code) = public.norm_text(v_code)) then
    raise exception 'Ya hay una sala % en esa planta', v_code;
  end if;

  -- La matrícula la pone `rooms_matricula` y el equipamiento `rooms_defaults`:
  -- los dos son disparadores, así que una sala creada por cualquier otro camino
  -- —el importador, un script— sale igual de completa que esta.
  insert into rooms (zone_id, code, name, kind)
  values (v_zone, v_code, v_name, p_kind)
  returning id into v_room;

  return v_room;
end;
$$;

comment on function public.create_room(uuid, text, text, text, room_kind) is
  'Da de alta una sala resolviendo su planta por nombre normalizado. Devuelve el id. Rechaza los edificios de la papelera.';

create or replace function public.restore_room(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_edificio_vivo boolean;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador reactiva salas'
      using errcode = 'insufficient_privilege';
  end if;

  -- Reactivar una sala cuyo edificio está en la papelera es una operación que
  -- se ejecuta con éxito y no hace nada visible: la sala sale de
  -- `archived_rooms` y no entra en `room_overview`, porque quien la esconde es
  -- el `b.active`. La vista ya la marca con `motivo = 'edificio'` para que el
  -- panel ni siquiera ofrezca el botón; esto es la red por debajo.
  select b.active into v_edificio_vivo
    from rooms r
    join zones z     on z.id = r.zone_id
    join buildings b on b.id = z.building_id
   where r.id = p_id;

  if not found then
    raise exception 'Esa sala no existe';
  end if;
  if not v_edificio_vivo then
    raise exception 'Esa sala está en un edificio archivado: restaura el edificio.';
  end if;

  update rooms set active = true where id = p_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7 — La baja de un edificio: archivar si hay algo que conservar
-- -----------------------------------------------------------------------------

/**
 * La baja de un edificio, gemela exacta de `delete_room`.
 *
 * Pasa de `returns void` a `returns text` y devuelve «archivado» o «borrado»,
 * que es el mismo contrato que `delete_room` estableció y por el mismo motivo:
 * **la decisión no la puede tomar la interfaz**. Desde el iPad no se sabe si
 * ese edificio tiene 412 revisiones colgando; eso solo lo sabe el servidor. Por
 * eso no se añade un `archive_building` aparte que conviva con este: obligaría
 * a la pantalla a elegir a cuál de los dos llama, y elegiría mal.
 *
 * Archivar y no borrar en cascada porque `inspections.room_id` es `on delete
 * restrict`: cualquier camino que acabe en un `delete from rooms` de un
 * edificio revisado muere con un error de clave ajena que desde un iPad es
 * ruido. Y porque el histórico de un edificio que se archiva por error es
 * exactamente lo que hay que poder devolver.
 *
 * Las salas **no se tocan**. Se quedan con `active = true` debajo de un
 * edificio con `active = false`: `room_overview` ya no las enseña, la descarga
 * al dispositivo ya no las trae, y `restore_building` las devuelve tal cual
 * estaban. Voltearlas aquí y volver a voltearlas al restaurar resucitaría las
 * que alguien archivó a mano.
 *
 * Un edificio completamente vacío sí se borra de verdad, y con él sus zonas:
 * no hay nada que restaurar, y su `code` —`unique` global, sin filtro por
 * `active`— queda libre otra vez. La papelera guarda lo que merece
 * restaurarse, no la errata de tecleo de hace un minuto.
 *
 * Como Postgres no admite cambiar el tipo devuelto de una función existente,
 * hay que tirarla antes. El `drop` se lleva por delante su `grant execute` y su
 * `comment`: los dos se reponen abajo, y esa es la razón de que
 * `delete_building` aparezca en la lista de grants del final aunque ya lo
 * tuviera concedido desde `20260730000100`.
 */
drop function if exists public.delete_building(uuid);

create or replace function public.delete_building(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rooms int;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador da de baja edificios'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from buildings where id = p_id) then
    raise exception 'Ese edificio no existe';
  end if;

  -- Todas las salas, archivadas incluidas: lo que decide si hay algo que
  -- conservar no es lo que se ve hoy en la lista, es lo que hubo alguna vez.
  select count(*) into v_rooms
    from rooms r join zones z on z.id = r.zone_id
   where z.building_id = p_id;

  if v_rooms > 0 then
    update buildings set active = false where id = p_id;
    return 'archivado';
  end if;

  delete from zones where building_id = p_id;
  delete from buildings where id = p_id;
  return 'borrado';
end;
$$;

-- -----------------------------------------------------------------------------
-- 8 — Y la vuelta
-- -----------------------------------------------------------------------------

/**
 * Restaurar un edificio de la papelera.
 *
 * No hay colisión de código posible: el `unique` de `buildings.code` es global
 * y nunca se liberó mientras el edificio estuvo archivado — de eso se encarga
 * `create_building`, que se niega a reutilizar el código y dice dónde está el
 * original.
 *
 * Y no toca `rooms` por lo mismo que no lo tocaba la baja: una sala que alguien
 * archivó a mano antes de archivar el edificio sigue archivada al restaurarlo.
 * El edificio vuelve como estaba, no como estaba al principio de los tiempos.
 */
create or replace function public.restore_building(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador restaura edificios'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from buildings where id = p_id) then
    raise exception 'Ese edificio no existe';
  end if;

  update buildings set active = true where id = p_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 9 — Renombrar un edificio
-- -----------------------------------------------------------------------------

/**
 * Cambia el código y el nombre de un edificio.
 *
 * El patrón es el de `rename_asset_type` (`20260730000100:537`): comprobar el
 * rol, validar que no queda vacío, guardar el valor viejo como alias y
 * propagar. Aquí «propagar» es la parte que no se ve.
 *
 * **La red de rescate del renombrado.** Las incidencias del histórico y las
 * importaciones de Excel se cruzan con las salas por una referencia con la
 * forma `«<código de sala> <código de edificio>»` — `1.7 H`, `Sotano -1.5 BC` —,
 * que es lo que `splitIncidentKey` produce y lo que `room_aliases` resuelve. Si
 * el edificio H pasa a llamarse HUM, todas esas referencias dejan de resolver
 * de golpe y la siguiente importación deja 38 filas en `import_quarantine` sin
 * que nadie relacione una cosa con la otra. Por eso cada sala del edificio se
 * queda con su referencia vieja registrada como alias.
 *
 * El `on conflict (alias_norm) do nothing` no es prudencia: `alias_norm` es
 * `unique` **global**, y si `1.7 H` ya apuntaba a otra sala, un alias ambiguo
 * es peor que ninguno — resolvería mal y en silencio, que es lo contrario de
 * dejarlo sin resolver y verlo en la cuarentena.
 *
 * Nota de mantenimiento: `src/domain/normalize.ts` lleva una tabla `BUILDING_
 * CODES` escrita a mano que mapea nombres del Excel a códigos. Renombrar el
 * código de un edificio la deja vieja y aquí no se puede tocar; los alias
 * cubren la resolución mientras tanto.
 */
create or replace function public.rename_building(p_id uuid, p_code text, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code     text := upper(btrim(coalesce(p_code, '')));
  v_name     text := btrim(coalesce(p_name, ''));
  v_old_code text;
  v_otro     boolean;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador corrige el nombre de un edificio'
      using errcode = 'insufficient_privilege';
  end if;
  if v_code = '' or v_name = '' then
    raise exception 'El edificio necesita código y nombre';
  end if;

  select code into v_old_code from buildings where id = p_id;
  if not found then
    raise exception 'Ese edificio no existe';
  end if;

  if upper(v_old_code) <> v_code then
    select active into v_otro
      from buildings
     where id <> p_id and upper(code) = v_code;

    if found and v_otro then
      raise exception 'Ya existe un edificio con el código %', v_code;
    elsif found then
      raise exception 'El código % es de un edificio que está en la papelera. Restáuralo o dale otro código a este.', v_code;
    end if;
  end if;

  update buildings set code = v_code, name = v_name where id = p_id;

  if v_old_code <> v_code then
    insert into room_aliases (room_id, alias, alias_norm)
    select r.id,
           r.code || ' ' || v_old_code,
           public.norm_text(r.code || ' ' || v_old_code)
      from rooms r
      join zones z on z.id = r.zone_id
     where z.building_id = p_id
    on conflict (alias_norm) do nothing;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 10 — Renombrar una sala, y de paso poder moverla de planta
-- -----------------------------------------------------------------------------

/**
 * Cambia el código y el nombre de una sala, y opcionalmente la mueve de planta.
 *
 * Devuelve «renombrada» o «movida». Que lo diga importa: mover un aula de
 * planta cambia dónde la busca el técnico que va a subir a revisarla, y un
 * mensaje de éxito que no distingue las dos cosas deja al administrador sin
 * saber cuál de las dos ha hecho.
 *
 * Tres detalles que no se ven pero deciden si esto funciona:
 *
 *  - **El signo menos.** `displayRoomCode` pinta `−2.1` con un U+2212 porque el
 *    guion se lee como una errata de maquetación. Si ese texto vuelve por un
 *    campo editable —o alguien lo pega— el U+2212 acaba en la columna `code`, y
 *    a partir de ahí `roomMatches` (que quita `^-`, no `^−`), `cleanRoomRef`,
 *    `splitIncidentKey` y el cruce con `room_aliases` dejan de encontrar la
 *    sala. El cliente ya lo sanea; se repite aquí porque el que guarda es el
 *    servidor y esta es la última puerta.
 *
 *  - **La planta vacía no es «SIN ZONA».** `p_zone` nulo o en blanco significa
 *    *no mover*. `'SIN ZONA'` es el valor por defecto de un alta, donde no hay
 *    planta previa que respetar; aplicarlo aquí mandaría a la papelera de las
 *    plantas cada aula que alguien renombra sin tocar el desplegable.
 *
 *  - **El choque se mide con `norm_text`.** El `unique (zone_id, code)` es
 *    sensible a mayúsculas: con una comparación exacta, `a1` y `A1` conviven
 *    como dos salas distintas de la misma planta y en la lista se leen como la
 *    misma repetida dos veces.
 *
 * `short_ref` no se recalcula nunca: va grabada en la placa atornillada a la
 * puerta y el QR codifica el UUID, no el código. Renombrar no invalida ni una
 * de las 276 placas.
 */
create or replace function public.rename_room(
  p_id   uuid,
  p_code text,
  p_name text,
  p_zone text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code        text := btrim(replace(coalesce(p_code, ''), U&'\2212', '-'));
  v_name        text := btrim(coalesce(p_name, ''));
  v_zone_name   text := btrim(coalesce(p_zone, ''));
  v_old_code    text;
  v_zone_vieja  uuid;
  v_zone        uuid;
  v_building    uuid;
  v_build_code  text;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador corrige el nombre de una sala'
      using errcode = 'insufficient_privilege';
  end if;
  if v_code = '' then
    raise exception 'La sala necesita un código';
  end if;

  select r.code, r.zone_id, z.building_id, b.code
    into v_old_code, v_zone_vieja, v_building, v_build_code
    from rooms r
    join zones z     on z.id = r.zone_id
    join buildings b on b.id = z.building_id
   where r.id = p_id;

  if not found then
    raise exception 'Esa sala no existe';
  end if;

  -- Misma regla que `create_room`: la mayoría de las aulas se llaman como su
  -- código y obligar a repetirlo a mano solo produce erratas.
  if v_name = '' then
    v_name := v_code;
  end if;

  v_zone := v_zone_vieja;

  if v_zone_name <> '' then
    -- Se resuelve dentro del MISMO edificio y por nombre normalizado, copiando
    -- el bloque de `create_room`: es lo que impide que escribir «1ª Planta»
    -- donde ya existe «1ª PLANTA» cree una segunda planta idéntica en vez de
    -- mover el aula a la que ya estaba.
    select id into v_zone
      from zones
     where building_id = v_building
       and public.norm_text(name) = public.norm_text(v_zone_name);

    if v_zone is null then
      insert into zones (building_id, name, sort_order)
      select v_building, v_zone_name, coalesce(max(sort_order), 0) + 10
        from zones where building_id = v_building
      returning id into v_zone;
    end if;
  end if;

  if exists (select 1 from rooms
              where zone_id = v_zone
                and id <> p_id
                and public.norm_text(code) = public.norm_text(v_code)) then
    raise exception 'Ya hay una sala % en esa planta', v_code;
  end if;

  update rooms
     set zone_id = v_zone,
         code    = v_code,
         name    = v_name
   where id = p_id;

  -- El código viejo se queda de alias con la forma cualificada que produce
  -- `splitIncidentKey`. Desnudo —solo `1.7`— sería ambiguo entre edificios, y
  -- `alias_norm` es unique global: el primero que entrase se quedaría con la
  -- referencia de todos los demás.
  if v_old_code <> v_code then
    insert into room_aliases (room_id, alias, alias_norm)
    values (p_id,
            v_old_code || ' ' || v_build_code,
            public.norm_text(v_old_code || ' ' || v_build_code))
    on conflict (alias_norm) do nothing;
  end if;

  if v_zone <> v_zone_vieja then
    -- La planta de origen que se queda sin aulas se borra a propósito. Es
    -- invisible en todas las vistas —nada llega hasta ella sin una sala— pero
    -- mantiene su nombre reservado bajo el `unique (building_id, name)`, así
    -- que renombrar otra planta a ese nombre chocaría contra un fantasma; y
    -- sigue bajando al espejo de los 23 iPads en cada descarga. `merge_building`
    -- ya estableció que una zona que se queda vacía se borra.
    delete from zones
     where id = v_zone_vieja
       and not exists (select 1 from rooms where zone_id = v_zone_vieja);

    return 'movida';
  end if;

  return 'renombrada';
end;
$$;

-- -----------------------------------------------------------------------------
-- 11 — Renombrar una planta, que a veces es fusionarla
-- -----------------------------------------------------------------------------

/**
 * Cambia el nombre de una planta. Devuelve «renombrada» o «fusionada».
 *
 * El caso interesante es el segundo. El importador dejó plantas que son la
 * misma escritas de dos maneras que `norm_text` no une —«1ª PLANTA» y «PLANTA
 * 1»—, y la única forma de arreglarlo desde la lista es escribir en una el
 * nombre de la otra. Ahí caben dos respuestas:
 *
 *  - Rechazar con «ya existe una planta con ese nombre». Deja al administrador
 *    delante de un callejón: para juntarlas tendría que mover las aulas una a
 *    una, y no existe ninguna herramienta para eso.
 *  - Fusionar: mover las aulas a la planta de destino y borrar la de origen.
 *    Es lo que `merge_building` ya hace con las zonas de dos edificios que se
 *    fusionan, con el mismo argumento.
 *
 * Se fusiona. Pero fusionar mueve aulas de sitio, y hacerlo sin decirlo sería
 * silenciar un error caro: por eso devuelve «fusionada» en vez de un `void`, y
 * por eso el aviso de verdad llega **antes**, desde el cliente, que ve las
 * zonas del edificio en su espejo local y confirma la consecuencia con el
 * número de aulas que van a moverse.
 *
 * La corrección de grafía —«1a planta» → «1ª PLANTA»— no es una fusión aunque
 * lo parezca: si el nombre nuevo normaliza igual que el viejo, la planta de
 * destino sería ella misma. Se comprueba primero, y ese caso es el que hace
 * falta a diario.
 */
create or replace function public.rename_zone(p_id uuid, p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name     text := btrim(coalesce(p_name, ''));
  v_old      text;
  v_building uuid;
  v_destino  uuid;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador corrige el nombre de una planta'
      using errcode = 'insufficient_privilege';
  end if;
  if v_name = '' then
    raise exception 'La planta necesita un nombre';
  end if;

  select name, building_id into v_old, v_building from zones where id = p_id;
  if not found then
    raise exception 'Esa planta no existe';
  end if;

  -- Solo cambia la grafía: es ella misma, no hay nada que fusionar.
  if public.norm_text(v_old) = public.norm_text(v_name) then
    update zones set name = v_name where id = p_id;
    return 'renombrada';
  end if;

  select id into v_destino
    from zones
   where building_id = v_building
     and id <> p_id
     and public.norm_text(name) = public.norm_text(v_name);

  if found then
    -- Antes de mover nada: dos aulas con el mismo código en la misma planta
    -- violarían el `unique (zone_id, code)` a mitad del traslado y el error
    -- que llegaría al iPad sería el del índice. Se comprueba normalizado por
    -- lo mismo de siempre: ese único distingue `a1` de `A1` y la lista no.
    if exists (
      select 1
        from rooms a
        join rooms d on public.norm_text(a.code) = public.norm_text(d.code)
       where a.zone_id = p_id
         and d.zone_id = v_destino
    ) then
      raise exception 'No se puede fusionar: «%» ya tiene una sala con ese código', v_name;
    end if;

    update rooms set zone_id = v_destino where zone_id = p_id;
    delete from zones where id = p_id;
    return 'fusionada';
  end if;

  update zones set name = v_name where id = p_id;
  return 'renombrada';
end;
$$;

-- -----------------------------------------------------------------------------
-- 12 — Fusionar edificios: ni desde la papelera ni hacia ella
--
-- `merge_building` se escribió en `20260728000500` para resolver «el `BC` del
-- Excel era en realidad el CRAI», cuando un edificio archivado no podía existir.
-- Con la papelera puesta, la única defensa contra fusionar hacia dentro de ella
-- sería el `.eq('active', true)` del desplegable de `CleanupPage` — o sea, el
-- cliente, sirviéndose de una caché de react-query de sesenta segundos que
-- ningún otro iPad invalida. A abre «Datos», B archiva el edificio H desde
-- «Revisar», y A todavía tiene H en su desplegable: si lo elige, la función
-- mueve las zonas y las 12 salas del edificio provisional bajo un H invisible en
-- `room_overview` y borra la fila del origen. Doce aulas desaparecen de la lista
-- de trabajo y de los 23 dispositivos, el origen ya no existe para restaurarlo y
-- no salta ni un error.
--
-- Se comprueban los DOS lados. Fusionar un origen archivado tampoco es inocente:
-- sacaría de la papelera unas salas por la puerta de atrás, sin pasar por
-- `restore_building`, y borraría el edificio que alguien mandó allí justamente
-- para poder recuperarlo.
--
-- Las dos lecturas van juntas y ANTES del bucle: a mitad del traslado no hay
-- vuelta atrás que no sea el `rollback` de la transacción, y un mensaje que llega
-- con las zonas ya movidas no es un mensaje, es un parte de daños. El resto es
-- copia literal de `20260728000500:268-302`.
--
-- La voz de los `raise` es la de `create_room` («Ese edificio está en la
-- papelera. Restáuralo antes de…»), a propósito: es el mismo obstáculo, y quien
-- lo lee en dos pantallas distintas tiene que reconocerlo como el mismo
-- obstáculo y no como dos averías.
-- -----------------------------------------------------------------------------

create or replace function public.merge_building(from_building uuid, into_building uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  z record;
  target_zone uuid;
  v_origen_vivo  boolean;
  v_destino_vivo boolean;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede fusionar edificios'
      using errcode = 'insufficient_privilege';
  end if;

  if from_building = into_building then
    raise exception 'No se puede fusionar un edificio consigo mismo';
  end if;

  select active into v_origen_vivo from buildings where id = from_building;
  if not found then
    raise exception 'El edificio que quieres fusionar ya no existe';
  end if;

  select active into v_destino_vivo from buildings where id = into_building;
  if not found then
    raise exception 'El edificio de destino ya no existe';
  end if;

  -- El destino primero: es el caso que llega desde el desplegable con la caché
  -- vieja, y el que se lleva por delante las salas del origen.
  if not v_destino_vivo then
    raise exception 'Ese edificio está en la papelera. Restáuralo antes de fusionar nada con él.';
  end if;
  if not v_origen_vivo then
    raise exception 'El edificio de origen está en la papelera. Restáuralo antes de fusionarlo, o déjalo donde está.';
  end if;

  for z in select * from zones where building_id = from_building loop
    select id into target_zone
    from zones
    where building_id = into_building and name = z.name;

    if target_zone is null then
      update zones set building_id = into_building where id = z.id;
    else
      update rooms set zone_id = target_zone where zone_id = z.id;
      delete from zones where id = z.id;
    end if;
  end loop;

  delete from buildings where id = from_building;
end;
$$;

-- -----------------------------------------------------------------------------
-- 13 — Lo que se publica
--
-- El `notify` de la última línea no es ceremonia: sin él PostgREST sigue
-- sirviendo el esquema que cargó al arrancar y `supabase.rpc('rename_building')`
-- devuelve un 404 que desde la aplicación parece un fallo de la aplicación.
-- -----------------------------------------------------------------------------

comment on function public.delete_building(uuid) is
  'Da de baja un edificio. Devuelve «archivado» (tenía salas: se conserva entero y se restaura desde Datos) o «borrado» (estaba vacío).';
comment on function public.restore_building(uuid) is
  'Devuelve un edificio de la papelera a la lista de trabajo con sus salas y su histórico. No reactiva las salas archivadas a mano.';
comment on function public.rename_building(uuid, text, text) is
  'Corrige el código y el nombre de un edificio. Deja la referencia vieja de cada sala en room_aliases para que el histórico y el Excel sigan cruzando.';
comment on function public.rename_room(uuid, text, text, text) is
  'Renombra o mueve de planta una sala. Devuelve «renombrada» o «movida». Conserva la matrícula y deja el código viejo de alias.';
comment on function public.rename_zone(uuid, text) is
  'Renombra una planta. Devuelve «fusionada» si el nombre nuevo ya existía en ese edificio y sus aulas se han movido allí.';
comment on function public.merge_building(uuid, uuid) is
  'Fusiona un edificio provisional con el correcto. Rechaza los dos lados si están en la papelera: la fusión borra el origen y las salas acabarían en un edificio invisible.';

grant execute on function public.delete_building(uuid)                to authenticated;
grant execute on function public.restore_building(uuid)               to authenticated;
grant execute on function public.rename_building(uuid, text, text)    to authenticated;
grant execute on function public.rename_room(uuid, text, text, text)  to authenticated;
grant execute on function public.rename_zone(uuid, text)              to authenticated;
-- `create or replace function` conserva los permisos, pero el `grant` se repite
-- igualmente: el fichero tiene que decir quién puede llamar a esto sin obligar a
-- ir a buscarlo tres migraciones atrás.
grant execute on function public.merge_building(uuid, uuid)           to authenticated;

notify pgrst, 'reload schema';
