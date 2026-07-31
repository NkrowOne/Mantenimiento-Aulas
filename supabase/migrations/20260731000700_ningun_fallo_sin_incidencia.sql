-- =============================================================================
-- Ningún fallo de revisión se queda sin incidencia
--
-- El caso que destapó esto es real: la revisión del 30 de julio del aula 1.5
-- (edificio H) se cerró con «HDMI Amarillo · Falla leve» y en la pestaña de
-- Incidencias no hay nada. La regla existe desde `20260730000300` —cerrar una
-- revisión con fallos abre una incidencia por fallo— pero quien la ejecuta es
-- EL CLIENTE al pulsar «Terminar», y eso deja dos huecos por los que un fallo
-- se cuela sin abrir nada:
--
--   1. Una PWA servida por un service worker viejo. La aplicación es
--      offline-first a propósito: el iPad puede pasarse días con la versión
--      anterior en caché, que guardaba el fallo en `inspection_checks` y no
--      sabía abrir incidencias.
--   2. Una cola de salida que pierde la entrada de la incidencia (borrado de
--      almacenamiento del navegador, dispositivo que no vuelve a conectarse)
--      después de haber subido la revisión.
--
-- En ambos casos la base acaba en el mismo estado: una revisión `completa`
-- cuyo checklist dice «Falla» y ninguna incidencia que lo cuente. La avería
-- queda registrada y nadie tiene que resolverla — exactamente lo que la regla
-- venía a impedir.
--
-- Esto añade la red del lado del servidor: una función que abre las
-- incidencias que faltan mirando la ÚLTIMA revisión vigente de cada sala, la
-- migración la ejecuta una vez (rescata el histórico, incluido el HDMI del
-- aula 1.5) y pg_cron la repite cada madrugada para los huecos que se abran
-- después. Con tres reglas que evitan que el rescate fabrique ruido:
--
--   - Solo la última revisión vigente por sala. Un fallo que una revisión
--     posterior marcó «Correcto» se arregló solo; abrirle hoy una incidencia
--     sería mentir. Y «vigente» resuelve las correcciones: si la corrección
--     dice que aquello estaba bien, no hay fallo que rescatar.
--   - Nada con menos de una hora en el servidor. Una revisión recién subida
--     puede traer su incidencia todavía en la cola del dispositivo (la app
--     actual las crea en el cliente); rescatarla al segundo crearía la copia
--     del servidor y luego llegaría la del cliente. Una hora después de
--     subir la revisión, lo que no llegó ya no va a llegar.
--   - Una resolución POSTERIOR a la visita cierra el asunto. Si el supervisor
--     resolvió la incidencia del proyector ayer y la última revisión es
--     anterior, reabrirla cada madrugada sería fabricar zombis.
--
-- La deduplicación es la misma que aplica el cliente (`incidenciasDeRevision`):
-- por comprobación (`check_key`) dentro de la sala y por equipo (`asset_id`)
-- venga de donde venga, contra todo lo no resuelto — borradores incluidos.
-- =============================================================================

create or replace function public.abrir_incidencias_de_revisiones()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_creadas integer;
begin
  with ultimas as (
    -- La última visita de cada sala, en su versión vigente. El empate de dos
    -- correcciones simultáneas de la misma visita lo gana la más reciente,
    -- igual que en `alerts_repeat_offenders`.
    select distinct on (v.room_id)
           v.id, v.room_id, v.occurred_at, v.by_user, v.recorded_at
      from inspections_vigentes v
     order by v.room_id, v.occurred_at desc, v.corrected_at desc nulls last,
              v.recorded_at desc
  ),
  maduras as (
    -- El filtro de la hora va DESPUÉS de elegir la última: si la más reciente
    -- aún no ha madurado, la sala espera a la siguiente pasada. Filtrar antes
    -- habría elegido la penúltima, cuyos fallos quizá ya no son verdad.
    select * from ultimas where recorded_at < now() - interval '1 hour'
  ),
  fallos as (
    select u.room_id,
           u.id          as inspection_id,
           u.occurred_at,
           u.by_user,
           c.check_key,
           c.severity,
           nullif(btrim(coalesce(c.note, '')), '') as nota,
           a.id          as asset_id,
           a.status      as asset_status,
           -- El mismo orden de nombres que usa el cliente: la etiqueta del
           -- equipo, su tipo, el vocabulario fijo de antes del inventario, y
           -- como última red la propia clave.
           coalesce(
             a.label, t.name,
             case c.check_key
               when 'red'       then 'Red'
               when 'pantallas' then 'Pantallas'
               when 'proyector' then 'Proyector'
               when 'microfono' then 'Micrófono'
               when 'sonido'    then 'Sonido'
               when 'camara'    then 'Cámara'
               when 'botonera'  then 'Botonera'
             end,
             c.check_key) as etiqueta
      from maduras u
      join inspection_checks c
        on c.inspection_id = u.id and c.result = 'incidencia'
      left join assets a
        on c.check_key like 'asset:%'
       and a.id = public.uuid_o_nulo(nullif(substring(c.check_key from 7), ''))
      left join asset_types t on t.id = a.asset_type_id
  ),
  lineas as (
    -- La primera línea de la nota, para el título; el `chr(13)` por si algún
    -- teclado coló retornos de carro.
    select f.*,
           btrim(replace(split_part(coalesce(f.nota, ''), e'\n', 1), chr(13), '')) as linea
      from fallos f
  ),
  con_titulo as (
    -- Calcado de `tituloDeIncidencia`: «Equipo: lo que escribió el técnico»,
    -- recortado a 100, y sin nota se dice que salió de la revisión.
    select l.*,
           l.etiqueta || ': ' ||
           case
             when l.linea = ''          then 'fallo detectado en la revisión'
             when length(l.linea) > 100 then rtrim(left(l.linea, 99)) || '…'
             else l.linea
           end as titulo
      from lineas l
  )
  insert into incidents
        (id, room_id, asset_id, opened_from_inspection_id, check_key,
         title, description, severity, state, kind,
         opened_at, opened_by, source)
  select gen_random_uuid(), f.room_id, f.asset_id, f.inspection_id, f.check_key,
         f.titulo, f.nota, coalesce(f.severity, 'media'), 'abierta', 'incidencia',
         -- La fecha de la revisión, no la de esta pasada: la avería se vio
         -- aquel día, y de ahí cuelga el «abierta hace N días».
         f.occurred_at, f.by_user, 'app'
    from con_titulo f
        -- Un equipo retirado ya no está en la sala: su avería se fue con él.
   where (f.asset_id is null or f.asset_status <> 'retirado')
        -- La misma comprobación no puede tener dos incidencias vivas.
     and not exists (
           select 1 from incidents i
            where i.room_id = f.room_id
              and i.check_key = f.check_key
              and i.state <> 'resuelta')
        -- Ni el mismo equipo, aunque su incidencia naciera a mano y sin
        -- `check_key` — o en otra sala, si el aparato se mudó.
     and not exists (
           select 1 from incidents i
            where f.asset_id is not null
              and i.asset_id = f.asset_id
              and i.state <> 'resuelta')
        -- Y lo resuelto DESPUÉS de la visita se queda resuelto.
     and not exists (
           select 1 from incidents i
            where ((i.room_id = f.room_id and i.check_key = f.check_key)
                or (f.asset_id is not null and i.asset_id = f.asset_id))
              and i.state = 'resuelta'
              and i.resolved_at >= f.occurred_at);

  get diagnostics v_creadas = row_count;
  return v_creadas;
end;
$fn$;

comment on function public.abrir_incidencias_de_revisiones() is
  'Abre las incidencias que faltan de revisiones ya cerradas con fallos (PWA vieja, cola perdida). Mira la última revisión vigente de cada sala, deduplica como el cliente y no resucita lo resuelto. La llama la migración una vez y pg_cron cada madrugada.';

-- Interna a propósito: la ejecutan la migración y el cron, no la API. El
-- arranque (`bootstrap_roles`) reparte EXECUTE por defecto, así que se retira
-- explícitamente.
revoke all on function public.abrir_incidencias_de_revisiones() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- La pasada del histórico, ahora mismo
--
-- Es la que rescata el fallo del aula 1.5 y cualquier otro enterrado: todo lo
-- anterior al despliegue lleva mucho más de una hora en el servidor.
-- -----------------------------------------------------------------------------
do $$
declare n integer;
begin
  n := public.abrir_incidencias_de_revisiones();
  raise notice 'Incidencias abiertas desde revisiones ya cerradas: %', n;
end $$;

-- -----------------------------------------------------------------------------
-- Y la nocturna, para los huecos que se abran a partir de hoy
--
-- Un iPad con la app en caché puede seguir cerrando revisiones sin abrir
-- incidencias durante días. `cron.schedule` con el mismo nombre reprograma en
-- vez de duplicar, y sin pg_cron la migración ya hizo su pasada — se avisa y
-- no se rompe nada.
-- -----------------------------------------------------------------------------
do $$
begin
  perform cron.schedule('incidencias-de-revisiones', '20 4 * * *',
    $c$select public.abrir_incidencias_de_revisiones()$c$);
exception when others then
  raise notice 'Sin pg_cron: el rescate nocturno de fallos de revisión no queda programado.';
end $$;
