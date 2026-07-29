-- =============================================================================
-- No dejar el sistema sin ningún administrador
--
-- La pantalla de usuarios ya lo impide, pero eso es cortesía de la interfaz, no
-- una garantía: cualquiera con sesión de admin puede mandar el `update` a la API
-- directamente, y una pestaña abierta con la lista de hace cinco minutos manda
-- un estado que ya no es el que hay.
--
-- Y el fallo no admite un «vaya, lo deshago»: si el último administrador se
-- quita el rol, NADIE puede volver a ponérselo desde la aplicación —la pantalla
-- que lo arregla está detrás de ese mismo rol— y hay que entrar a la terminal
-- del servidor. Que es justamente de lo que esa pantalla venía a librar a nadie.
--
-- Aquí, en cambio, es una invariante: da igual quién mande el `update` ni desde
-- dónde. Es el mismo criterio que ya usan `inspections_freeze` y el signo de los
-- movimientos de stock — lo que no puede pasar nunca se impide en la base.
-- =============================================================================

create or replace function public.proteger_ultimo_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  quedan int;
begin
  -- Solo interesa la transición que quita un administrador activo. Cambiar el
  -- nombre de un admin, o ascender a alguien, no tiene que contar nada.
  if old.role = 'admin' and old.active
     and (new.role <> 'admin' or not new.active) then

    select count(*) into quedan
    from public.profiles
    where role = 'admin' and active and id <> old.id;

    if quedan = 0 then
      raise exception
        'No se puede dejar el despliegue sin ningún administrador activo. Nombra a otro primero.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger profiles_ultimo_admin
  before update on profiles
  for each row execute function public.proteger_ultimo_admin();

/*
 * Solo `update`, y a propósito.
 *
 * Borrar es la otra forma de quedarse sin administrador, pero pasa por
 * `auth.users` y llega aquí en cascada: un disparador que lance excepción en el
 * `delete` haría fallar el borrado del usuario en GoTrue con un mensaje que
 * habla de una tabla que quien ejecuta `alta borrar` no ha nombrado. Además ese
 * camino ya es deliberado y del servidor, no un clic de más en una pantalla.
 *
 * La forma frecuente de perder el rol es la de arriba, y es la que se cierra.
 */

notify pgrst, 'reload schema';
