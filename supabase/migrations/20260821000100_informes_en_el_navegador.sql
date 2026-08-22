-- =============================================================================
-- Los informes se generan en la aplicación, no en un worker
--
-- Hasta ahora, pedir un informe era esto: la pantalla llamaba a
-- `request_report`, que encolaba una petición en pg_net, que despertaba a un
-- contenedor aparte con su propio token, su propia URL en `app_config`, su
-- propia clave de Gemini en una variable de entorno y su propio WeasyPrint.
-- Seis piezas para redactar cuatro páginas, y cinco formas distintas de que no
-- llegara nunca sin un solo error a la vista — de ahí que hiciera falta una
-- pantalla de diagnóstico solo para averiguar cuál de las seis estaba rota.
--
-- Ahora el informe lo arma la propia aplicación: consulta los datos con la
-- sesión de quien lo pide, calcula las cifras, le pide la redacción a Gemini y
-- compone el documento. Lo único que hay que configurar es la clave de Gemini,
-- y se pega desde la propia pantalla.
--
-- Esta migración es lo que el navegador necesita para poder hacerlo:
--
--   1. Guardar el documento emitido en el bucket `reports`, que hasta ahora
--      solo escribía el rol de servicio.
--   2. Leer la clave de Gemini que un administrador dejó guardada.
--
-- Lo de antes NO se retira: `request_report`, `enviar_informe` y el cron del
-- viernes siguen donde estaban y siguen funcionando si el worker está
-- desplegado. Lo que deja de ser cierto es que hagan falta.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — El documento emitido, guardado desde el navegador
--
-- El bucket aceptaba `application/pdf` y nada más, porque lo llenaba
-- WeasyPrint. Un navegador no sabe fabricar un PDF, pero sí sabe imprimir uno:
-- lo que se archiva es el documento en HTML, autocontenido —los gráficos van
-- como SVG dentro del propio fichero, no hay ni una petición a la red al
-- abrirlo— y de ahí sale el PDF con «Guardar como PDF» del propio navegador.
--
-- Se conserva `application/pdf` para no invalidar lo que ya haya archivado el
-- worker: los dos tipos conviven en el mismo bucket y la extensión del fichero
-- dice cuál es cada uno.
-- -----------------------------------------------------------------------------
update storage.buckets
   set allowed_mime_types = array['application/pdf', 'text/html']
 where id = 'reports';

-- Escribir, sí; sobrescribir, no.
--
-- Un informe emitido no se regenera: se versiona. La política es solo de
-- INSERT, así que subir sobre una ruta que ya existe falla —y la ruta lleva el
-- hash del contenido, de modo que el mismo documento cae siempre en el mismo
-- sitio y otro distinto en otro—. Sin políticas de UPDATE ni DELETE: en RLS, lo
-- que no se permite explícitamente queda denegado.
drop policy if exists "supervisor archiva informes" on storage.objects;
create policy "supervisor archiva informes"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'reports' and public.is_supervisor());

-- -----------------------------------------------------------------------------
-- 2 — La clave de Gemini, para quien va a llamar a Gemini
--
-- Esto es un cambio de postura y conviene que esté escrito, no deducido.
--
-- Antes la clave no salía de la base jamás: la leía el worker, que corría en el
-- servidor, y `ia_estado()` solo decía si había una. Con el informe generándose
-- en el navegador, quien llama a Gemini es el navegador de un supervisor, así
-- que la clave tiene que llegarle. No hay forma de tener las dos cosas.
--
-- Lo que se acota:
--   · Solo supervisores y administradores, que son exactamente quienes pueden
--     emitir un informe. Un técnico no la ve.
--   · Solo por esta función, que se puede auditar. `app_config` sigue cerrada a
--     administradores por RLS y `ia_estado()` sigue sin devolver la clave: la
--     pantalla de ajustes no la enseña ni recortada.
--   · La clave viaja por la misma conexión TLS que el resto de la aplicación y
--     la aplicación no la guarda en el dispositivo.
--
-- Si eso no es aceptable para un despliegue concreto, la salida es no guardar
-- ninguna clave aquí: cada supervisor pone la suya en su propio dispositivo
-- desde la pantalla de Informes, y esta función devuelve vacío.
-- -----------------------------------------------------------------------------
create or replace function public.ia_clave()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  clave text;
begin
  if not public.is_supervisor() then
    raise exception 'Solo un supervisor puede usar la IA de los informes'
      using errcode = 'insufficient_privilege';
  end if;

  select btrim(value) into clave from app_config where key = 'ia_api_key';
  -- Cadena vacía y no nulo cuando no hay: quien llama distingue «no hay clave»
  -- de «no he podido preguntar», y son dos mensajes distintos en la pantalla.
  return coalesce(clave, '');
end;
$$;

comment on function public.ia_clave() is
  'Devuelve la clave de Gemini guardada en app_config a un supervisor, para que la aplicación pueda pedirle a Gemini la redacción del informe. Es la única función que la deja salir de la base.';

revoke execute on function public.ia_clave() from public, anon;
grant execute on function public.ia_clave() to authenticated;

notify pgrst, 'reload schema';
