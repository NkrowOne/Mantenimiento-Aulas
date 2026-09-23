-- reejecutable: si
--
-- El `do` de abajo solo toca lo que todavía no está envuelto —el regex lleva un
-- `(?<!select )` justo delante— así que la segunda pasada no encuentra ninguna
-- política que cambiar. Hace falta declararlo porque la deducción automática
-- rechaza cualquier `do` de nivel raíz.
-- =============================================================================
-- Una política que no se puede estimar multiplica la consulta por 276
--
-- La pestaña Historial no cargaba. Ni con el filtro de equipos ni sin filtro
-- ninguno: se quedaba dando vueltas y no terminaba nunca.
--
-- No era la vista. `room_timeline` une siete consultas, y medida contra la base
-- de verificación con 7.192 eventos de equipo dentro tarda **15 ms**. La misma
-- consulta, con la misma base y los mismos datos, ejecutada como un técnico
-- —o sea con RLS puesta— tardaba **31 segundos**.
--
-- Lo que lo explica está en el plan:
--
--     Seq Scan on rooms r  (rows=5) (actual rows=276)
--       Filter: (auth_role() = ANY ('{tecnico,supervisor,admin}'))
--     ->  Nested Loop  (loops=276)
--
-- `auth_role()` es una llamada a función, y de una llamada a función el
-- planificador no tiene estadísticas: supone que filtra casi todo y estima 5
-- filas donde hay 276. Con esa estimación elige un bucle anidado y **recalcula
-- la unión entera una vez por aula**. Doscientas setenta y seis veces.
--
-- El arreglo es el conocido de PostgREST y no cambia lo que la política deja
-- pasar: envolver la llamada en un `(select ...)`. Así deja de ser un filtro por
-- fila y pasa a ser un `InitPlan` que se evalúa **una vez**, cuyo resultado el
-- planificador sí sabe tratar. Las funciones son `stable`, así que dentro de una
-- misma sentencia devuelven lo mismo llamadas una vez o un millón: la
-- equivalencia es exacta, no aproximada.
--
-- Medido después, sobre la misma base y como el mismo técnico:
--
--     sin filtro        31.118 ms  ->  14,5 ms
--     filtro de equipos 30.159 ms  ->   8,4 ms
--
-- No es solo el Historial: esas políticas están en todas las lecturas de la
-- aplicación. Lo que se ve aquí es donde primero dolía, porque es la consulta
-- que más tablas junta de un tirón.
--
-- Se reescriben desde `pg_policies` y no a mano, una por una, por dos razones:
-- son sesenta y ocho, y el texto que guarda el catálogo es el que la base ha
-- deparseado, así que reescribirlo no puede introducir una diferencia que el
-- catálogo no tuviera ya. `alter policy` solo cambia las expresiones: el
-- comando, los roles y el nombre se quedan como estaban.
--
-- Lo comprueban las 79 pruebas de `rls-test.sql`, que son las que dicen lo que
-- cada rol puede y no puede: si alguna de estas sesenta y ocho hubiera cambiado
-- de sentido, ahí se ve.
-- =============================================================================

do $envolver$
declare
  p   record;
  v_q text;
  v_c text;
  v_n int := 0;
  /*
   * Las funciones que la política llama para saber quién pregunta, y solo esas.
   *
   * `auth.uid()` y `auth.jwt()` entran por lo mismo que las de rol: leen un
   * parámetro de la sesión, son `stable` y se estaban llamando una vez por fila.
   *
   * Los tres cierres del regex son los tres intentos de envolver dos veces, y
   * cada uno costó una vuelta:
   *
   *  - `(?i)` porque Postgres guarda la política DEPARSEADA, y ahí el `select`
   *    que acabamos de escribir vuelve en mayúsculas: `( SELECT is_staff() AS
   *    is_staff)`. Con el regex en minúsculas, lo ya envuelto parecía crudo y
   *    se envolvía otra vez, y otra, sin tope.
   *  - `(?<!\.)` porque el nombre corto está DENTRO del largo: en
   *    `public.is_staff()` la coincidencia podía empezar en `is_staff` y
   *    saltarse así la comprobación del `select` de delante.
   *  - Y `uid`/`jwt` solo detrás de `auth.`, nunca sueltos: son palabras
   *    demasiado cortas para andar sueltas por un `where`.
   *
   * El `\m` ata el principio de palabra, para que `es_admin()` —si algún día
   * existe— no case por terminar igual que `is_admin()`.
   */
  v_re text := '(?i)(?<!select )(?<!\.)\m((public\.)?(auth_role|is_staff|is_admin|is_supervisor)|auth\.(uid|jwt))\(\)';
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
      from pg_policies
     where schemaname = 'public'
       and (coalesce(qual, '') ~ v_re or coalesce(with_check, '') ~ v_re)
     order by tablename, policyname
  loop
    v_q := regexp_replace(p.qual,       v_re, '(select \1())', 'g');
    v_c := regexp_replace(p.with_check, v_re, '(select \1())', 'g');

    -- Una política de INSERT no tiene `using`, y una de SELECT no tiene
    -- `with check`: se manda solo la mitad que existe.
    execute format(
      'alter policy %I on %I.%I %s %s',
      p.policyname, p.schemaname, p.tablename,
      case when v_q is null then '' else 'using (' || v_q || ')' end,
      case when v_c is null then '' else 'with check (' || v_c || ')' end);
    v_n := v_n + 1;
  end loop;

  if v_n > 0 then
    raise notice 'Políticas que dejan de llamarse por fila: %.', v_n;
  else
    raise notice 'Políticas: ya estaban todas envueltas. Nada que hacer.';
  end if;
end
$envolver$;

notify pgrst, 'reload schema';
