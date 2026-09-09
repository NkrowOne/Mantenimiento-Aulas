-- =============================================================================
-- Las funciones de la sincronización no las puede llamar un anónimo
--
-- `revoke all on function … from public` no basta, y este repositorio ya lo
-- sabía: el comentario de `20260728000500_reports_integrations.sql` lo deja
-- escrito con todas las letras. `alter default privileges … grant execute on
-- functions to anon, authenticated` del bootstrap hace que **toda función nazca
-- ejecutable por anónimos**, y ese permiso está concedido a `anon` y a
-- `authenticated` por su nombre, no a `PUBLIC`: quitárselo a `PUBLIC` no le
-- quita nada a nadie.
--
-- El resultado, comprobado ejecutándolo: con la clave anónima —la que va dentro
-- del bundle que sirve la PWA, o sea la que tiene cualquiera que abra la
-- página— un `POST /rest/v1/rpc/sync_celda_de_sala` escribe en `rooms`. Son
-- funciones `security definer`, así que se saltan la RLS entera, y la única
-- comprobación de rol estaba en `sync_aplicar`, que es justo la que no hace
-- falta llamar para llegar a las de dentro.
--
-- Se arregla como dice ese comentario: **por partida doble**. El permiso, porque
-- es la barrera de verdad; y la comprobación dentro, porque el `alter default
-- privileges` volverá a conceder execute a la próxima función que alguien
-- escriba y entonces solo quedará lo de dentro.
--
-- Y se separan en dos grupos, que es lo que hacía falta desde el principio:
--
--  - Las **de dentro** no las llama nadie de fuera. `sync_aplicar` las invoca
--    como dueño, así que no necesitan ni un permiso: se les quita a los tres.
--  - Las **de fuera** —cuatro— son la superficie de la pantalla. Se les deja el
--    permiso a `authenticated` y se les pone la comprobación de administrador.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — Las de dentro: sin permiso para nadie
--
-- Ninguna necesita grant. `sync_aplicar` es `security definer` y las llama
-- siendo `postgres`, que es su dueño.
-- -----------------------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array[
    'public.sync_aplicar_celda(jsonb)',
    'public.sync_celda_de_sala(jsonb)',
    'public.sync_celda_de_articulo(jsonb)',
    'public.sync_celda_de_incidencia(jsonb)',
    'public.sync_material_del_parte(uuid, jsonb)',
    'public.sync_aplicar_equipo(uuid, uuid, text, text)',
    'public.sync_mover_sala(uuid, text, text)',
    'public.sync_revision_desde_el_excel(uuid, date, text)',
    'public.cuarentena_apuntar(text, text, jsonb, text)',
    'public.horas_a_la_sala()',
    'public.poner_ref_incidencia()',
    'public.siguiente_ref_incidencia(timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 2 — Y la comprobación dentro de las que escriben
--
-- No sustituye al permiso: lo acompaña. Si mañana alguien añade una función
-- hermana y se olvida del `revoke`, esto es lo único que quedará en pie.
--
-- Los disparadores quedan fuera a propósito: `poner_ref_incidencia` tiene que
-- funcionar cuando un técnico abre una incidencia desde el móvil, que es su
-- trabajo. Lo que los protege es que un disparador no se puede invocar como
-- función normal.
-- -----------------------------------------------------------------------------

create or replace function public.sync_solo_admin()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth_role() <> 'admin' then
    raise exception 'Esta función es parte de la sincronización y solo la ejecuta un administrador'
      using errcode = 'insufficient_privilege';
  end if;
end $$;

comment on function public.sync_solo_admin() is
  'La comprobación que acompaña al permiso. Va aparte para que añadirla a una función nueva sea una línea y no se olvide.';

revoke all on function public.sync_solo_admin() from public, anon, authenticated;

create or replace function public.sync_aplicar_celda(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entidad text := coalesce(p->>'entidad', '');
  v_campo   text := p->>'campo';
begin
  perform public.sync_solo_admin();

  if v_entidad = '' then
    v_entidad := case
      when v_campo like 'articulo.%' then 'articulo'
      when v_campo like 'incidencia.%' then 'incidencia'
      else 'sala'
    end;
  end if;

  if v_entidad = 'articulo'   then return public.sync_celda_de_articulo(p);   end if;
  if v_entidad = 'incidencia' then return public.sync_celda_de_incidencia(p); end if;
  return public.sync_celda_de_sala(p);
end $$;

revoke all on function public.sync_aplicar_celda(jsonb) from public, anon, authenticated;

-- Las tres ramas que escriben (`sync_celda_de_sala`, `…_articulo`,
-- `…_incidencia`) no llevan la comprobación repetida y no es un descuido: solo
-- se llega a ellas por `sync_aplicar_celda`, que ya la hace, y por un `POST`
-- directo, que el `revoke` de arriba acaba de cerrar. Copiar sus cuerpos enteros
-- aquí para añadirles una línea sería duplicar 200 líneas de SQL que a partir de
-- mañana pueden divergir de las de la migración 400, y una rama que se queda
-- atrás es exactamente el fallo que acabamos de arreglar en el otro lado.
--
-- Lo que sí queda escrito, para quien añada la cuarta: `perform
-- public.sync_solo_admin();` es la primera línea de cualquier función nueva de
-- esta familia, y el `revoke` va con ella.

-- -----------------------------------------------------------------------------
-- 3 — Las cuatro de fuera: permiso a `authenticated` y comprobación dentro
-- -----------------------------------------------------------------------------

create or replace function public.sync_registrar_fichero(
  p_origen text,
  p_nombre text,
  p_sha256 text,
  p_bytes  bigint,
  p_ctag   text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  perform public.sync_solo_admin();

  -- Lo que llega es del cliente entero: si no se comprueba la forma, cualquiera
  -- que pueda llamarla siembra la tabla de procedencia con lo que quiera, y esa
  -- tabla es lo que contesta «¿de dónde salió este dato?» seis meses después.
  if p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'El hash del fichero no tiene la forma de un sha256';
  end if;
  if p_bytes <= 0 then
    raise exception 'Un fichero de % bytes no es un fichero', p_bytes;
  end if;
  if p_origen not in ('material_aulas', 'aulas_revision') then
    raise exception '«%» no es uno de los dos libros', p_origen;
  end if;

  insert into sync_ficheros (origen, nombre, sha256, bytes, ctag, subido_por)
  values (p_origen, p_nombre, p_sha256, p_bytes, p_ctag, auth.uid())
  on conflict (origen, sha256) do update set nombre = excluded.nombre
  returning id into v_id;

  return v_id;
end $$;

create or replace function public.sync_instantanea(p_hoja text)
returns table (ref text, columna text, valor_base text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- `sync_celdas` la lee solo un administrador por RLS, y esta función se la
  -- saltaba entera: enseñaba el estado de las 276 aulas a cualquiera.
  perform public.sync_solo_admin();
  return query select c.ref, c.columna, c.valor_base from sync_celdas c where c.hoja = p_hoja;
end $$;

create or replace function public.sync_ultima_salida()
returns table (parte_id bigint, sha256 text, cuando timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.sync_solo_admin();
  return query
    select p.id, p.salida_sha256, coalesce(p.termino_at, p.comenzo_at)
      from sync_partes p
     where p.salida_sha256 is not null
     order by p.id desc
     limit 1;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.sync_aplicar(jsonb)',
    'public.sync_registrar_fichero(text, text, text, bigint, text)',
    'public.sync_instantanea(text)',
    'public.sync_ultima_salida()',
    'public.sync_apuntar_salida(bigint, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

comment on function public.sync_registrar_fichero(text, text, text, bigint, text) is
  'Aterriza el .xlsx con su hash antes de interpretarlo. Comprueba el rol y la forma de lo que llega: la tabla de procedencia es lo que contesta «¿de dónde salió este dato?», y sembrarla de basura la inutiliza.';
comment on function public.sync_instantanea(text) is
  'El antepasado de cada celda de una hoja, de golpe. Solo administradores: es el estado entero del parque.';
