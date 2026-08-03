-- =============================================================================
-- La corrección manda sobre la incidencia que abrió la visita
--
-- Corregir una revisión ya funcionaba para todo lo que se CUENTA —la corrección
-- reemplaza a la original en el histórico, en la fiabilidad y en el informe—
-- pero no para lo que hay que HACER. Las incidencias que abrió la visita se
-- quedaban exactamente donde estaban, y eso produce las dos situaciones que esta
-- migración viene a cerrar:
--
--   1. El técnico se equivocó, la corrección dice que el proyector estaba bien,
--      y en la pestaña de Incidencias sigue habiendo un parte de un proyector
--      que nunca estuvo roto. Alguien tiene que ir a cerrarlo a mano, sabiendo
--      que existe — o sea, casi nunca. Con 276 aulas por ronda, cada errata
--      dejaba un parte fantasma para siempre.
--   2. El proyector SÍ está roto y la corrección lo vuelve a marcar. Si el
--      espejo del dispositivo que corrige no tenía la incidencia de la ronda
--      anterior —una descarga atrasada, un alta desde otro iPad— se abre una
--      segunda para el mismo aparato: dos filas en la lista, el recuento de la
--      sala mintiendo y nadie sabiendo cuál cerrar.
--
-- LA REGLA, dicha entera: una corrección **no es una visita nueva**, es la misma
-- visita contada mejor. Así que sobre lo que abrió esa visita manda ella:
--
--   - Si vuelve a marcar el mismo aparato en falla, **no abre otra**: reescribe
--     la que ya estaba con la gravedad y la nota de ahora. La fila conserva su
--     fecha, su autor, su ticket externo y el material que se le haya apuntado,
--     que es justo lo que se perdería abriendo una nueva.
--   - Si dice que estaba bien, **la retira**. Y se llama retirar y no resolver
--     porque no es lo mismo: nadie ha arreglado nada, la revisión se equivocó.
--     Va escrito en `resolution`, que es donde se lee en el histórico.
--   - Y si ya había dos del mismo aparato, sobrevive la más antigua y la copia
--     se retira diciendo que lo era.
--
-- LA FRONTERA: solo alcanza a lo que abrió ESTA visita —`opened_from_inspection_id`
-- dentro de la cadena de versiones que la corrección reemplaza—. Una avería que
-- otra persona apuntó a mano desde la ficha, o que abrió la revisión de otro día,
-- no es de esta visita y no se toca. Corregir una errata no puede cerrarle el
-- trabajo a nadie.
--
-- POR QUÉ EN EL SERVIDOR Y NO SOLO EN EL CLIENTE. La aplicación aplica la misma
-- regla en el dispositivo —tiene que hacerlo, la sala debe decir la verdad en un
-- sótano— pero no puede hacerla llegar: `incident` viaja por la cola de salida
-- con «no pises lo que ya está», que es lo que evita que un reenvío del alta
-- choque contra el permiso de supervisor y se marque rechazado para siempre. Un
-- cambio mandado desde ahí llegaría y no haría nada, sin error. Además, cerrar
-- incidencias es de supervisor y quien corrige suele ser un técnico. Así que la
-- decisión la ejecuta el servidor cuando el cierre de la corrección sube, con la
-- cadena de versiones entera delante — que el dispositivo tampoco tiene.
-- =============================================================================

create or replace function public.conciliar_incidencias_de_correccion(p_inspection uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_corr    inspections;
  v_cadena  uuid[];
  v_tocadas integer := 0;
  v_n       integer;
begin
  select * into v_corr from inspections where id = p_inspection;

  -- Ni una revisión normal, ni un borrador. Salir en silencio y no fallar: esto
  -- lo llama un disparador, y una excepción aquí impediría cerrar la revisión.
  if not found or v_corr.status <> 'completa' or v_corr.corrects is null then
    return 0;
  end if;

  /*
   * La cadena de versiones que esta corrección reemplaza.
   *
   * Hacia atrás y no hacia delante: `corrects` apunta a lo que se corrige, y esa
   * es la dirección en la que el dato está guardado. No puede ciclar —
   * `validar_correccion()` impide que una revisión se corrija a sí misma y que
   * cambie a qué corrige después de creada, así que la cadena está cerrada desde
   * el insert—, pero se recorre por identificador y no por fecha porque dos
   * versiones de la misma visita comparten `occurred_at` por definición.
   */
  with recursive cadena(id, corrects) as (
    select i.id, i.corrects from inspections i where i.id = v_corr.corrects
    union all
    select p.id, p.corrects
      from inspections p
      join cadena c on p.id = c.corrects
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_cadena from cadena;

  -- ---------------------------------------------------------------------------
  -- 1 — La copia, si ya había dos del mismo aparato
  --
  -- Va primero para que los pasos siguientes trabajen contra la superviviente.
  -- Al revés, la corrección reescribiría la copia que está a punto de retirarse
  -- y su arreglo se iría con ella.
  -- ---------------------------------------------------------------------------
  with de_la_visita as (
    select i.id,
           i.opened_at,
           -- El aparato manda sobre la clave de comprobación: una incidencia
           -- importada del Excel apunta al equipo y no trae `check_key`, y las
           -- dos son la misma avería del mismo proyector.
           coalesce('asset:' || i.asset_id::text, i.check_key) as clave
      from incidents i
     where i.room_id = v_corr.room_id
       and i.state <> 'resuelta'
       and (i.opened_from_inspection_id = any(v_cadena)
            or i.opened_from_inspection_id = v_corr.id)
  ),
  sobran as (
    select id from (
      select d.id,
             row_number() over (partition by d.clave order by d.opened_at, d.id) as n
        from de_la_visita d
       where d.clave is not null
    ) x
     where x.n > 1
  )
  update incidents i
     set state       = 'resuelta',
         resolved_at = coalesce(v_corr.corrected_at, now()),
         resolved_by = v_corr.by_user,
         resolution  = 'Retirada al corregir la revisión: duplicaba una incidencia que ya estaba abierta para el mismo equipo.'
    from sobran s
   where i.id = s.id;

  get diagnostics v_n = row_count;
  v_tocadas := v_tocadas + v_n;

  -- ---------------------------------------------------------------------------
  -- 2 — Lo que la corrección sigue dando por roto: manda ella
  --
  -- Título, descripción y gravedad se recalculan igual que en el cliente
  -- (`tituloDeIncidencia`) y que en el rescate nocturno. Lo que NO se toca es la
  -- fecha, el autor, el ticket externo ni el estado: si un supervisor ya la puso
  -- «en curso», sigue en curso — corregir la revisión no le devuelve el trabajo
  -- a la casilla de salida.
  -- ---------------------------------------------------------------------------
  with fallos as (
    select c.check_key,
           c.severity,
           nullif(btrim(coalesce(c.note, '')), '') as nota,
           a.id as asset_id,
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
      from inspection_checks c
      left join assets a
        on c.check_key like 'asset:%'
       and a.id = public.uuid_o_nulo(nullif(substring(c.check_key from 7), ''))
      left join asset_types t on t.id = a.asset_type_id
     where c.inspection_id = v_corr.id
       and c.result = 'incidencia'
  ),
  lineas as (
    -- La primera línea de la nota, para el título; el `chr(13)` por si algún
    -- teclado coló retornos de carro.
    select f.*,
           btrim(replace(split_part(coalesce(f.nota, ''), e'\n', 1), chr(13), '')) as linea
      from fallos f
  ),
  con_titulo as (
    select l.*,
           l.etiqueta || ': ' ||
           case
             when l.linea = ''          then 'fallo detectado en la revisión'
             when length(l.linea) > 100 then rtrim(left(l.linea, 99)) || '…'
             else l.linea
           end as titulo
      from lineas l
  )
  update incidents i
     set severity                  = coalesce(f.severity, 'media'),
         description               = f.nota,
         title                     = f.titulo,
         opened_from_inspection_id = v_corr.id
    from con_titulo f
   where i.room_id = v_corr.room_id
     and i.state <> 'resuelta'
     and (i.opened_from_inspection_id = any(v_cadena)
          or i.opened_from_inspection_id = v_corr.id)
     and (i.check_key = f.check_key
          or (f.asset_id is not null and i.asset_id = f.asset_id))
     -- Solo si algo cambia de verdad: una corrección que únicamente tocó la
     -- observación de la sala no tiene por qué reescribir tres partes idénticos
     -- ni ensuciar `recorded_at`.
     and (i.severity, i.description, i.title, i.opened_from_inspection_id)
         is distinct from
         (coalesce(f.severity, 'media'), f.nota, f.titulo, v_corr.id);

  get diagnostics v_n = row_count;
  v_tocadas := v_tocadas + v_n;

  -- ---------------------------------------------------------------------------
  -- 3 — Y lo que ahora dice que estaba bien deja de ser una incidencia
  --
  -- `= any(v_cadena)` y no «o la propia corrección» a propósito: lo que abrió la
  -- corrección lo abrió porque está roto, y el paso 2 acaba de ponerle su sello.
  -- La segunda condición —que ninguna fila de la corrección la siga dando por
  -- rota— cubre el caso raro de una incidencia sin `check_key` que case a la vez
  -- con dos comprobaciones del mismo aparato.
  -- ---------------------------------------------------------------------------
  update incidents i
     set state       = 'resuelta',
         resolved_at = coalesce(v_corr.corrected_at, now()),
         resolved_by = v_corr.by_user,
         resolution  = case
           when exists (
             select 1 from inspection_checks c
              where c.inspection_id = v_corr.id
                and c.result = 'na'
                and (c.check_key = i.check_key
                     or (i.asset_id is not null and c.check_key = 'asset:' || i.asset_id::text)))
           then 'Retirada al corregir la revisión: la comprobación pasó a «No aplica».'
           else 'Retirada al corregir la revisión: el equipo estaba bien.'
         end
   where i.room_id = v_corr.room_id
     and i.state <> 'resuelta'
     and i.opened_from_inspection_id = any(v_cadena)
     and exists (
           select 1 from inspection_checks c
            where c.inspection_id = v_corr.id
              and c.result <> 'incidencia'
              and (c.check_key = i.check_key
                   or (i.asset_id is not null and c.check_key = 'asset:' || i.asset_id::text)))
     and not exists (
           select 1 from inspection_checks c
            where c.inspection_id = v_corr.id
              and c.result = 'incidencia'
              and (c.check_key = i.check_key
                   or (i.asset_id is not null and c.check_key = 'asset:' || i.asset_id::text)));

  get diagnostics v_n = row_count;
  v_tocadas := v_tocadas + v_n;

  return v_tocadas;
end;
$fn$;

comment on function public.conciliar_incidencias_de_correccion(uuid) is
  'Aplica a las incidencias lo que dice una corrección: reescribe la del equipo que sigue en falla, retira la del que estaba bien y quita la copia si había dos. Solo toca lo que abrió la cadena de versiones de esa misma visita.';

-- Interna: la ejecutan el disparador, la pasada del histórico y el cron. El
-- arranque (`bootstrap_roles`) reparte EXECUTE por defecto, así que se retira.
revoke all on function public.conciliar_incidencias_de_correccion(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- El disparador: cuando la corrección se cierra
--
-- `security definer` y no por comodidad: quien cierra la corrección es un
-- técnico, y un técnico no puede tocar `incidents` —esa es la regla, y la prueba
-- 4 de `rls-test.sql` está para que siga siéndolo—. La conciliación no es «el
-- técnico cierra un parte»: es la consecuencia automática de un dato que él sí
-- tiene derecho a escribir. Por eso la ejecuta la base con su propio permiso, y
-- por eso la función a la que llama está revocada para todos: no hay forma de
-- pedirla desde la API.
--
-- El `when` la deja fuera del camino de todas las revisiones normales, que son
-- la inmensa mayoría: sin él, cada cierre de aula pagaría una llamada a función
-- para no hacer nada.
-- -----------------------------------------------------------------------------

create or replace function public.inspections_concilia_correccion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.conciliar_incidencias_de_correccion(new.id);
  return null;
end;
$$;

drop trigger if exists inspections_concilia_correccion on inspections;
create trigger inspections_concilia_correccion
  after insert or update on inspections
  for each row
  when (new.status = 'completa' and new.corrects is not null)
  execute function public.inspections_concilia_correccion();

-- -----------------------------------------------------------------------------
-- Y la red de seguridad, por el mismo motivo que la tiene la apertura
--
-- El disparador cubre el camino normal —la cola sube la corrección como
-- borrador, luego sus comprobaciones, y el cierre al final— pero no el
-- desordenado: una corrección que llegue ya cerrada en un solo INSERT dispara
-- esto ANTES de que sus comprobaciones existan, y entonces no hay nada que
-- conciliar. Pasa con una importación, con un script de administración, o con
-- cualquier cliente que no sea esta aplicación.
--
-- Así que se repasa lo reciente cada madrugada. Es idempotente por construcción
-- —los tres pasos comprueban antes de escribir— así que repetirlo no cuesta
-- nada ni cambia nada.
-- -----------------------------------------------------------------------------

create or replace function public.conciliar_correcciones_recientes(p_dias integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_total integer := 0;
  r       record;
begin
  for r in
    select id
      from inspections
     where status = 'completa'
       and corrects is not null
       and corrected_at > now() - make_interval(days => p_dias)
     -- De la más antigua a la más reciente: si una visita se corrigió dos veces,
     -- la última tiene que ser la que deje su sello.
     order by corrected_at
  loop
    v_total := v_total + public.conciliar_incidencias_de_correccion(r.id);
  end loop;

  return v_total;
end;
$fn$;

comment on function public.conciliar_correcciones_recientes(integer) is
  'Repasa las correcciones de los últimos N días y les aplica la conciliación de incidencias. Red de seguridad del disparador para las que llegan ya cerradas en un solo INSERT.';

revoke all on function public.conciliar_correcciones_recientes(integer) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- La pasada del histórico, ahora mismo
--
-- Es la que limpia lo que ya está: los partes fantasma de las correcciones que
-- dijeron que el equipo estaba bien y las copias que quedaron por duplicado.
-- Sin límite de días —se recorre todo lo corregido— y en orden, para que la
-- última versión de cada visita sea la que mande.
-- -----------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  n := public.conciliar_correcciones_recientes(36500);
  raise notice 'Incidencias conciliadas con su corrección: %', n;
end $$;

-- -----------------------------------------------------------------------------
-- Y la nocturna, un poco antes que el rescate de fallos
--
-- El orden importa: primero se concilian las correcciones —que retiran partes y
-- reescriben otros— y después `abrir_incidencias_de_revisiones` mira qué fallo
-- se ha quedado sin incidencia. Al revés, el rescate podría abrir una incidencia
-- que la conciliación acabara de retirar.
--
-- `cron.schedule` con el mismo nombre reprograma en vez de duplicar, y sin
-- pg_cron la migración ya ha hecho su pasada — se avisa y no se rompe nada.
-- -----------------------------------------------------------------------------
do $$
begin
  perform cron.schedule('correcciones-concilian-incidencias', '5 4 * * *',
    $c$select public.conciliar_correcciones_recientes(30)$c$);
exception when others then
  raise notice 'Sin pg_cron: el repaso nocturno de correcciones no queda programado.';
end $$;

notify pgrst, 'reload schema';
