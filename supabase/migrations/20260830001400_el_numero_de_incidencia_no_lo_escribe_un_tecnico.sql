-- =============================================================================
-- El número de incidencia no lo escribe un técnico, y las horas del proyector
-- las escribe la lectura de un proyector
--
-- Dos escrituras que un técnico podía hacer y no debía. Ninguna de las dos por
-- un fallo de la RLS: las dos rodeándola.
--
-- -----------------------------------------------------------------------------
-- 1 — «I261231_9999» y ese día ya no se abren incidencias
--
-- `siguiente_ref_incidencia` mira el mayor número del día y suma uno; el
-- disparador solo lo genera si el campo viene vacío, y la política «personal
-- abre incidencias» deja a cualquier `is_staff()` insertar con el número puesto
-- a mano. Basta una fila con `_9999` —y con la fecha que se quiera, incluso una
-- futura— para que ese día se quede sin números: la migración 800 hace que la
-- función falle en voz alta al llegar a 9.999 en vez de reciclar el 1.000, que
-- es mejor que corromper, pero sigue siendo un día entero sin poder abrir
-- incidencias, activable por el rol más bajo y en un solo `insert`.
--
-- El arreglo es quitarle el bolígrafo a quien no tiene que escribir ahí: **el
-- número lo pone el disparador, siempre**, y lo que traiga una sesión se
-- descarta. No se hace desde la política de alta, y eso tiene su porqué: el
-- `with check` de la RLS se evalúa sobre la fila **final**, después de los
-- disparadores `before`, así que un `external_ref is null` ahí sería imposible
-- de cumplir —el disparador acaba de rellenarlo— y no dejaría abrir ni una
-- incidencia. Va donde se escribe, que es el disparador.
--
-- Y el importador sigue trayendo los suyos, porque entra como dueño y sin
-- sesión: `auth.uid()` es nulo y ésa es la diferencia que se mira. Un técnico
-- **siempre** tiene sesión, así que su número siempre se descarta.
--
-- Con un `check` de formato al lado, porque una sola barrera se olvida. La letra
-- de delante no se fija en «I»: el histórico trae 27 números con «S» que el
-- técnico escribió así y son igual de válidos —y además
-- `siguiente_ref_incidencia` solo cuenta los que empiezan por «I», así que un
-- «S» no le afecta.
--
-- -----------------------------------------------------------------------------
-- 2 — Un `inspection_check` cualquiera escribiendo en `rooms`
--
-- `rooms` solo la escribe un administrador. Pero el disparador de las horas es
-- `security definer` y se disparaba con **cualquier** fila de comprobación que
-- llevara `measure` y `measure_unit = 'h'`, sin mirar de qué comprobación se
-- trata. Un técnico puede crear una revisión de cualquier sala —eso es su
-- trabajo— y colgarle una comprobación inventada con la medida que quiera: dos
-- `insert` y `rooms.projector_hours` de esa sala vale lo que él diga. Y esa
-- columna es justo la que la sincronización devuelve a la columna F del Excel.
--
-- Una comprobación de horas de verdad no es «cualquiera que diga 'h'»: es la de
-- un elemento concreto —su clave es `asset:<id>`—, de un tipo que lleva horas de
-- lámpara, y **instalado en la sala que se está revisando**. Con eso, lo que
-- llega a `rooms` es una lectura de un proyector de esa aula, que es lo que la
-- columna dice ser. Lo demás se ignora en silencio, que es lo que corresponde a
-- una comprobación que no es de esto.
--
-- Y un margen, que además evita que un `1e20` reviente el `::int` y se lleve por
-- delante el `insert` entero: por encima de 200.000 horas no hay lámpara, hay
-- un dedo que ha resbalado.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — El número de incidencia
-- -----------------------------------------------------------------------------

alter table incidents drop constraint if exists incidents_external_ref_formato;
alter table incidents add constraint incidents_external_ref_formato
  check (external_ref is null or external_ref ~ '^[A-Z]\d{6}_\d{4}$');

comment on constraint incidents_external_ref_formato on incidents is
  '<letra><AAMMDD>_<NNNN> o nada. La letra no se fija en «I» porque el histórico trae 27 con «S», que el técnico escribió así y son igual de válidas; lo que se fija es la forma, para que «el mayor del día» siga siendo una cuenta y no lo que alguien escribiera.';

create or replace function public.poner_ref_incidencia()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Con sesión, el número lo pone la base: escrito a mano, un `_9999` deja el
  -- día entero sin números que dar, y eso lo puede hacer el rol más bajo en un
  -- solo `insert`. El importador entra como dueño, sin sesión, y sí trae los
  -- suyos: son los que están escritos en el libro desde hace dos años.
  if auth.uid() is not null then
    new.external_ref := public.siguiente_ref_incidencia(new.opened_at);
  elsif new.external_ref is null or btrim(new.external_ref) = '' then
    new.external_ref := public.siguiente_ref_incidencia(new.opened_at);
  end if;
  return new;
end $$;

comment on function public.poner_ref_incidencia() is
  'El número de la incidencia. Con sesión lo pone la base y lo que venga se descarta; sin sesión —el importador, que entra como dueño— se respeta el que traiga.';

revoke all on function public.poner_ref_incidencia() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2 — Las horas, solo desde la lectura de un proyector de esa aula
-- -----------------------------------------------------------------------------

/**
 * ¿Es esta comprobación la lectura de horas de un elemento de esa revisión?
 *
 * Su clave es `asset:<id>` —la pone `assetCheckKey` en el cliente—, el elemento
 * lleva horas de lámpara y está instalado en la sala que se revisa. Cualquier
 * otra fila con `measure_unit = 'h'` es una fila con `measure_unit = 'h'`, y no
 * una lectura de nada.
 */
create or replace function public.es_lectura_de_lampara(p_check uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from inspection_checks c
      join inspections i on i.id = c.inspection_id
      join assets a on a.id = nullif(substring(c.check_key from '^asset:(.+)$'), '')::uuid
      join asset_types t on t.id = a.asset_type_id
     where c.id = p_check
       and c.measure_unit = 'h'
       and c.measure is not null
       and c.measure >= 0
       and c.measure <= 200000
       and t.tracks_lamp_hours
       and a.room_id = i.room_id
  );
$$;

comment on function public.es_lectura_de_lampara(uuid) is
  'Si esa comprobación es de verdad la lectura de horas de un proyector del aula que se revisa. Sin esto, cualquier fila que dijera «h» escribía en rooms saltándose «admin escribe rooms».';

revoke all on function public.es_lectura_de_lampara(uuid) from public, anon, authenticated;

create or replace function public.horas_de_la_revision(p_inspection uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room  uuid;
  v_fecha timestamptz;
  v_horas int;
begin
  select i.room_id, i.occurred_at into v_room, v_fecha
    from inspections i
   where i.id = p_inspection and i.status = 'completa';

  if v_room is null then return; end if;

  if exists (
    select 1 from inspections i
     where i.room_id = v_room and i.status = 'completa' and i.occurred_at > v_fecha
  ) then
    return;
  end if;

  select c.measure::int into v_horas
    from inspection_checks c
   where c.inspection_id = p_inspection
     and public.es_lectura_de_lampara(c.id)
   limit 1;

  if v_horas is null then return; end if;

  update rooms set projector_hours = v_horas where id = v_room;
end $$;

comment on function public.horas_de_la_revision(uuid) is
  'Copia a rooms.projector_hours la lectura de horas de una revisión, si es la más reciente de su sala y la comprobación es de verdad la de un proyector de esa aula. La llaman los dos disparadores: la regla de cuál manda tiene que ser una sola.';

revoke all on function public.horas_de_la_revision(uuid) from public, anon, authenticated;

create or replace function public.horas_a_la_sala()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Este es el camino de la corrección: una comprobación que se rehace cuando la
  -- revisión ya estaba cerrada. En el camino normal la revisión todavía está en
  -- borrador cuando llega esto, y quien copia es el disparador de `inspections`.
  if new.measure is not null and new.measure_unit = 'h' then
    perform public.horas_de_la_revision(new.inspection_id);
  end if;
  return new;
end $$;

revoke all on function public.horas_a_la_sala() from public, anon, authenticated;
