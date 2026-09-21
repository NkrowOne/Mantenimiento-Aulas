-- =============================================================================
-- El diagnóstico dice qué migraciones tiene la base
--
-- El 21 de septiembre los cierres de avería volvían de la cola con «Could not
-- find the 'easyvista_ref' column of 'incident_resolutions' in the schema
-- cache»: la aplicación desplegada (f2b8975) escribe esa columna y la base de
-- producción no la tenía —la migración 20260916000100 no había corrido, o la
-- API no había recargado su esquema—. Desde un móvil no hay forma de saber
-- cuál de las dos, ni cuántas migraciones faltan. «Ver diagnóstico del
-- servidor» contestaba a otra pregunta (¿puedo leer?).
--
-- Ahora contesta también a esta: devuelve las migraciones anotadas en
-- `schema_migrations`, y la pantalla las compara con las que la aplicación
-- lleva compiladas. El registro se mira con `to_regclass`: en una base sin él
-- —desplegada con un script anterior— la función sigue funcionando y lo dice.
-- =============================================================================

create or replace function public.mi_diagnostico()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_migraciones jsonb := null;
begin
  if to_regclass('public.schema_migrations') is not null then
    select coalesce(jsonb_agg(m.filename order by m.filename), '[]'::jsonb)
      into v_migraciones
      from public.schema_migrations m;
  end if;

  return jsonb_build_object(
    'uid', auth.uid(),
    -- ¿Llega el claim del hook? Es LA pregunta cuando no se ve nada.
    'claim_app_role',
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'app_role',
    'rol_efectivo', public.auth_role(),
    'perfil_existe', exists (select 1 from public.profiles p where p.id = auth.uid()),
    'perfil_rol', (select p.role::text from public.profiles p where p.id = auth.uid()),
    'perfil_activo', (select p.active from public.profiles p where p.id = auth.uid()),
    'puede_leer', public.is_staff(),
    -- Las migraciones anotadas, o null si esta base no lleva registro.
    'migraciones', v_migraciones
  );
end;
$$;

comment on function public.mi_diagnostico() is
  'Qué dice el servidor de quien pregunta: rol, perfil, si puede leer, y qué migraciones tiene anotadas la base (null si no lleva registro). La pantalla de diagnóstico compara esa lista con la que la aplicación lleva compilada.';

grant execute on function public.mi_diagnostico() to authenticated;

notify pgrst, 'reload schema';
