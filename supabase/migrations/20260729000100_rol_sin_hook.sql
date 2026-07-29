-- =============================================================================
-- Que el rol no dependa de una sola variable de entorno
--
-- `auth_role()` leía EXCLUSIVAMENTE el claim `app_role` del JWT, que pone el
-- hook `custom_access_token_hook` de GoTrue. Ese hook se activa con dos
-- variables de entorno del servicio de auth, y ahí está el problema: en el
-- despliegue con `docker-compose.yml` van escritas en el fichero, pero sobre una
-- plataforma (skyway, Railway, Fly…) ese fichero no se usa, así que si no se
-- copian a mano en el servicio, el token sale SIN el claim.
--
-- Y lo que pasa entonces no se parece a un fallo: `auth_role()` devuelve 'none',
-- `is_staff()` es falso, y CADA lectura de CADA tabla devuelve `200 []`.
-- PostgREST no distingue «no tienes permiso» de «no hay nada», así que la
-- aplicación arranca perfecta, entra con el PIN, no da ni un error y no enseña
-- ni una fila. Un despliegue entero indistinguible de una base vacía por culpa
-- de una variable que nadie copió.
--
-- El arreglo es quitarle la exclusividad al claim: si viene, manda —es lo
-- rápido, y sigue siendo el camino normal—; si no viene, se mira el perfil.
-- El rendimiento apenas cambia: la función es `stable`, así que el planificador
-- la evalúa una vez por sentencia, no una vez por fila.
--
-- `security definer` es imprescindible aquí, y no por comodidad: sin él, leer
-- `profiles` desde dentro de una política que está *sobre* `profiles` es
-- recursión infinita (error 42P17). Con él, la lectura se salta RLS. Es seguro
-- porque la función no acepta parámetros: solo puede devolver el rol del propio
-- llamante, el de `auth.uid()`, y no hay forma de pedirle el de otro.
-- =============================================================================

create or replace function public.auth_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    -- 1. El claim del token. Es lo que hay en un despliegue bien configurado.
    --    Ojo: cuando el hook SÍ está activo y el usuario no tiene perfil, el
    --    claim vale la cadena 'none', que no es NULL, así que el respaldo no se
    --    dispara y el usuario sigue sin ver nada. Correcto: ahí el problema es
    --    el perfil que falta, no el token.
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'app_role',
    -- 2. Respaldo: el perfil. Solo se llega aquí si el claim no existe.
    (select p.role::text from public.profiles p where p.id = auth.uid() and p.active),
    'none'
  );
$$;

-- La usan las políticas, que se evalúan como el llamante.
grant execute on function public.auth_role() to authenticated;

-- -----------------------------------------------------------------------------
-- Un parte que la propia aplicación pueda enseñar
--
-- El síntoma de todo esto se ve en un iPad, que es donde no hay consola, ni
-- `psql`, ni forma de mirar el token. Sin algo así, «no se ve ningún dato» no se
-- puede diagnosticar desde donde ocurre: hay que sospecharlo desde fuera.
--
-- Devuelve solo lo del propio llamante, así que no hace falta protegerla más
-- allá de exigir sesión.
-- -----------------------------------------------------------------------------
create or replace function public.mi_diagnostico()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'uid', auth.uid(),
    -- ¿Llega el claim del hook? Es LA pregunta cuando no se ve nada.
    'claim_app_role',
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'app_role',
    'rol_efectivo', public.auth_role(),
    'perfil_existe', exists (select 1 from public.profiles p where p.id = auth.uid()),
    'perfil_rol', (select p.role::text from public.profiles p where p.id = auth.uid()),
    'perfil_activo', (select p.active from public.profiles p where p.id = auth.uid()),
    'puede_leer', public.is_staff()
  );
$$;

grant execute on function public.mi_diagnostico() to authenticated;

-- PostgREST cachea el catálogo: sin esto, la función nueva no aparece en la API
-- hasta que alguien reinicie el servicio, y el arreglo parecería no haber hecho
-- nada.
notify pgrst, 'reload schema';
