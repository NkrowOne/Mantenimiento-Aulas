-- =============================================================================
-- Las 118 incidencias sin sala dejan de ser invisibles
--
-- La importación del histórico no pudo identificar la sala de 118 incidencias
-- (de 283): aulas que el maestro no conoce —el edificio BC entero, TM, S,
-- laboratorios con nombre propio, «Ventanilla Única»—. Hizo lo correcto: las
-- guardó SIN sala en vez de inventarles una, y dejó el texto original en la
-- cuarentena.
--
-- Lo que faltó fue el camino de vuelta. La cuarentena solo se podía «marcar
-- revisada», que es taparla; la incidencia sin sala no sale en la ficha de
-- ningún aula, no la encuentra la búsqueda por sala y no cuenta en ningún
-- edificio. Guardada pero perdida para todas las vistas — la misma clase de
-- agujero que los equipos duplicados, en la otra tabla.
--
-- Dos funciones lo cierran:
--
--  1. `incidencias_sin_sala()` — cada incidencia huérfana CON el texto de aula
--     que traía el Excel, cruzando la cuarentena por la referencia externa (la
--     tienen 117 de 118) y por el texto del problema como red.
--  2. `asignar_sala_a_incidencia()` — le pone su sala, deja el texto original
--     como ALIAS de esa sala (la próxima importación acertará sola), y cierra
--     la fila de cuarentena. Decide una persona; el sistema solo aprende.
-- =============================================================================

create or replace function public.incidencias_sin_sala()
returns table (
  incidencia uuid,
  ref text,
  titulo text,
  descripcion text,
  estado text,
  abierta_el timestamptz,
  aula_original text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor rescata incidencias sin sala'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select i.id,
         i.external_ref,
         coalesce(i.title, '(sin describir)'),
         i.description,
         i.state::text,
         i.opened_at,
         q.aula
    from incidents i
    left join lateral (
      -- El texto de aula vive en la cuarentena. La referencia externa es la
      -- llave buena; el texto del problema, la red para la única fila sin ref.
      select iq.raw->>'aula' as aula
        from import_quarantine iq
       where iq.reason = 'No se pudo identificar la sala'
         and (
           (nullif(i.external_ref, '') is not null and iq.raw->>'ref' = i.external_ref)
           or (nullif(i.external_ref, '') is null
               and iq.raw->>'problema' is not null
               and iq.raw->>'problema' in (i.title, i.description))
         )
       limit 1
    ) q on true
   where i.room_id is null
     and i.source = 'import'
   order by i.opened_at desc;
end;
$$;

comment on function public.incidencias_sin_sala() is
  'Las incidencias importadas que quedaron sin sala, con el texto de aula que traía el Excel. Para asignarles la suya desde el panel.';

create or replace function public.asignar_sala_a_incidencia(
  p_incidencia uuid,
  p_room       uuid,
  p_alias      text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inc incidents%rowtype;
  v_yo uuid := (select auth.uid());
  v_etiqueta text;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor asigna la sala de una incidencia'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_inc from incidents where id = p_incidencia;
  if not found then
    raise exception 'Esa incidencia no existe';
  end if;
  -- Solo huérfanas: mover de sala una incidencia que YA tiene la suya es otra
  -- operación, con otras consecuencias, y no la hace esta función.
  if v_inc.room_id is not null then
    raise exception 'Esa incidencia ya tiene sala';
  end if;

  select b.code || ' ' || r.code into v_etiqueta
    from rooms r
    join zones z on z.id = r.zone_id
    join buildings b on b.id = z.building_id
   where r.id = p_room;
  if v_etiqueta is null then
    raise exception 'Esa sala no existe';
  end if;

  update incidents set room_id = p_room where id = p_incidencia;

  /*
   * El texto original se queda de alias de la sala: es lo que convierte una
   * corrección manual en conocimiento. «0.1 BC» apuntado una vez significa que
   * la próxima importación —y el buscador— resuelven «0.1 BC» solos. Si el
   * alias ya es de otra sala no se pisa: un alias ambiguo es peor que ninguno.
   */
  if btrim(coalesce(p_alias, '')) <> '' then
    insert into room_aliases (room_id, alias, alias_norm)
    values (p_room, btrim(p_alias), public.norm_text(p_alias))
    on conflict (alias_norm) do nothing;
  end if;

  -- Y la fila de cuarentena que hablaba de esta incidencia queda cerrada, con
  -- autor: se resolvió de verdad, no se tapó.
  update import_quarantine iq
     set resolved = true, resolved_by = v_yo, resolved_at = now()
   where iq.resolved = false
     and iq.reason = 'No se pudo identificar la sala'
     and (
       (nullif(v_inc.external_ref, '') is not null and iq.raw->>'ref' = v_inc.external_ref)
       or (nullif(v_inc.external_ref, '') is null
           and iq.raw->>'problema' is not null
           and iq.raw->>'problema' in (v_inc.title, v_inc.description))
     );

  return v_etiqueta;
end;
$$;

comment on function public.asignar_sala_a_incidencia(uuid, uuid, text) is
  'Asigna sala a una incidencia huérfana de la importación, aprende el alias y cierra su cuarentena. Devuelve la etiqueta de la sala.';

grant execute on function public.incidencias_sin_sala()                       to authenticated;
grant execute on function public.asignar_sala_a_incidencia(uuid, uuid, text) to authenticated;
revoke execute on function public.incidencias_sin_sala()                       from public, anon;
revoke execute on function public.asignar_sala_a_incidencia(uuid, uuid, text) from public, anon;

notify pgrst, 'reload schema';
