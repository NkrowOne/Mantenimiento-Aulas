-- reejecutable: si
--
-- Sus dos `update` de datos se buscan a sí mismos, así que una segunda pasada
-- no encuentra ni una fila: el de Sócrates y Gaudí solo entra si el edificio
-- TODAVÍA se llama «Edificio X (sin identificar)», y el de Bellas Artes solo si
-- su nota sigue en blanco y nadie lo ha marcado. En una base donde alguien ya
-- los bautizó o ya escribió allí su propia nota, este fichero no toca nada, que
-- es lo correcto: manda quien estuvo delante. Lo demás es `create or replace`,
-- `comment on`, `revoke` y `notify`, que se repiten sin consecuencias.
--
-- Hace falta declararlo porque la deducción automática rechaza cualquier
-- `update` de datos, y bien rechazado está: el que se repite y no da error es
-- el que borra trabajo de personas en silencio.
-- =============================================================================
-- Sócrates y Gaudí tienen nombre, y el libro crea sus aulas
--
-- Tres cosas con la misma raíz: el maestro no sabía que Sócrates y Antonio
-- Gaudí eran edificios, así que sus 43 aulas no tenían dónde entrar y cada
-- pasada del libro las volvía a preguntar una por una.
--
-- -----------------------------------------------------------------------------
-- 1 — «Edificio S (sin identificar)» es SÓCRATES
--
-- `S` y `G` entraron provisionales porque aparecían en 6 y en 2 incidencias del
-- histórico y en ninguna fila de la hoja de estado. El importador no se los
-- inventó: los vio escritos y los dejó marcados para que un humano dijera qué
-- eran, que es justo lo que hay que hacer cuando no se sabe. Lo que pasa es que
-- nadie lo dijo nunca, y desde julio están en la bandeja «Edificios sin
-- identificar» con `sort_order` 999 —los últimos de cualquier lista— esperando
-- una decisión que ya está tomada fuera de la aplicación.
--
-- Ya se sabe qué son. El libro de SharePoint los escribe con el nombre entero
-- —«ED. S - SÓCRATES» y «ED. G - ANTONIO GAUDÍ»— y son edificios de verdad del
-- campus. Lo único provisional era que nadie les había puesto el nombre.
--
-- Se buscan POR CÓDIGO y no por id a propósito. Los identificadores del seed
-- son deterministas y se podrían escribir aquí, pero una base que se importó
-- con otra versión del generador, o a la que alguien creó el edificio a mano
-- antes de que llegara esta migración, tiene otros ids y el mismo código: por
-- id la migración diría «hecho» sin haber tocado nada, y eso es peor que fallar.
--
-- Y solo si el nombre SIGUE siendo el provisional. Es lo que hace que este
-- fichero se pueda volver a aplicar y que no pise a quien se adelantó: si
-- alguien ya escribió «SÓCRATES» a mano, o le puso otro nombre mejor, aquí no
-- pasa nada.
-- -----------------------------------------------------------------------------

update buildings
   set name        = 'SÓCRATES',
       needs_review = false,
       review_note  = null,
       -- 18 y 19 van detrás del 17 que ocupa el Colegio Mayor: el 999 era la
       -- marca de «provisional», no un orden, y dejarlo ahí mandaría dos
       -- edificios de verdad al final de todas las listas del maestro.
       sort_order  = 18
 where code = 'S'
   and name like 'Edificio % (sin identificar)';

update buildings
   set name        = 'ANTONIO GAUDÍ',
       needs_review = false,
       review_note  = null,
       sort_order  = 19
 where code = 'G'
   and name like 'Edificio % (sin identificar)';

-- -----------------------------------------------------------------------------
-- 2 — Y de paso se apunta qué es Bellas Artes de verdad
--
-- `BBAA` no es un edificio: son tres. Sócrates —que a partir de aquí ya está
-- fuera, con su propio código `S`— más «Artes y Diseño 1» y «Artes y Diseño 2».
-- El maestro los tiene metidos a los tres en una sola ficha desde el primer
-- importador, porque la hoja de estado los escribía juntos.
--
-- Aquí NO se crean esos dos edificios ni se mueve una sola sala, y es una
-- decisión, no una tarea a medias. Partir `BBAA` en tres es repartir sus salas
-- —con su histórico de incidencias, sus equipos y sus revisiones— entre los
-- tres destinos, y eso no lo puede adivinar una migración: hay que saber de qué
-- edificio es cada aula, y eso lo sabe quien trabaja allí. Un reparto
-- equivocado es carísimo de deshacer, porque a partir de ese momento las
-- incidencias de un aula quedan colgando de un edificio y las nuevas del otro,
-- y ninguno de los dos tiene la historia entera.
--
-- Lo que sí se puede hacer sin riesgo es que deje de ser algo que solo sabe la
-- persona que lo contó: se marca para revisión y la nota dice qué es y qué hay
-- que decidir. Así sale en «Edificios sin identificar», que es la única
-- pantalla donde alguien está mirando precisamente esto.
--
-- El precio, dicho: mientras esté marcado, `BBAA` desaparece del desplegable
-- «Fusionar con…» de esa misma bandeja, que solo ofrece edificios ya
-- identificados. Es aceptable —nadie debería estar fusionando nada CONTRA un
-- edificio que está pendiente de partirse en tres— y se acaba en cuanto alguien
-- confirme o reparta.
-- -----------------------------------------------------------------------------

update buildings
   set needs_review = true,
       review_note  = 'En realidad son tres edificios: Sócrates —ya separado como «S»—, Artes y Diseño 1 y Artes y Diseño 2. Hay que decidir si se parte en tres y a cuál de ellos va cada aula, o si se confirma como un solo edificio y se deja así.'
 where code = 'BBAA'
   -- Solo si nadie ha tocado esta ficha: `needs_review = false` con la nota en
   -- blanco es exactamente como la dejó el importador. Si alguien ya escribió
   -- ahí su propia nota —o ya lo marcó por otra razón— eso vale más que esto,
   -- y encima es lo que hace que una segunda pasada no encuentre nada.
   --
   -- Queda un caso y se dice: si alguien confirma `BBAA` desde la bandeja, la
   -- ficha vuelve a estar como la dejó el importador, y un redespliegue que
   -- reaplique este fichero volvería a escribir la nota. No se puede distinguir
   -- «confirmado» de «sin mirar», porque los dos son lo mismo en la tabla. Y
   -- entre las dos equivocaciones posibles, repetir una pregunta que ya se
   -- contestó es mucho más barato que borrar una nota que alguien escribió.
   and not needs_review
   and review_note is null;

-- -----------------------------------------------------------------------------
-- 3 — El alta de un aula que el libro tiene y el maestro no
--
-- Esta es la mitad que faltaba. En la última pasada, 23 aulas de Sócrates y 20
-- de Antonio Gaudí se quedaron sin cruzar: no existían en el maestro, y la
-- única salida era contestar 43 dudas a mano, una por una, y volver a
-- contestarlas en la pasada siguiente porque nada las había creado.
--
-- `sync_alta` ya sabía dar de alta un parte, un artículo y un ordenador de
-- repuesto. Le faltaba lo más obvio de la hoja de estado: el aula. Se añade una
-- rama `sala` y el resto de la función se copia entera —incluidos el `sin_sala`
-- del parte y el bucle de antepasados del final—, porque `create or replace`
-- reemplaza el cuerpo completo y lo que no se escriba aquí se pierde.
--
-- Qué NO hace, y por qué:
--
--  - No llama a `create_room`. Esa función exige `is_admin()` y levanta
--    `insufficient_privilege` si no lo eres; `sync_alta` es `security definer`
--    y la ejecuta el motor de la pasada, no una sesión de administrador, así
--    que llamarla desde aquí haría fallar el alta justo cuando funciona todo lo
--    demás. Se repite su lógica —la zona se busca y se crea, el código se
--    compara normalizado— que es lo que tiene que ser igual.
--
--  - No decide si el aula se puede crear. Eso se decide antes de llegar aquí,
--    sobre el código del libro: solo pasa lo que no se puede leer de dos
--    maneras. Una función de base de datos no es el sitio para adivinar si
--    «Sala Vip» falta o ya existe escrita de otra forma.
--
--  - Y no crea la segunda si ya hay una. Dos pasadas que se solapan —o la
--    misma fila vista dos veces— llegarían aquí con el mismo edificio, la
--    misma planta y el mismo código, y la segunda crearía un aula gemela con
--    otra matrícula. A partir de ahí las incidencias se reparten entre las dos
--    y ninguna tiene el histórico entero. Si ya está, se usa la que está.
-- -----------------------------------------------------------------------------

create or replace function public.sync_alta(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tipo    text := p->>'tipo';
  v_hoja    text := p->>'hoja';
  v_clave   text;
  v_numero  text;
  v_id      uuid;
  v_room    uuid := nullif(p->>'sala_id', '')::uuid;
  v_aula    text := nullif(btrim(coalesce(p->>'aula', '')), '');
  v_abierta date := nullif(p->>'abierta', '')::date;
  v_resuelta date := nullif(p->>'resuelta', '')::date;
  v_pedido  text := nullif(btrim(coalesce(p->>'numero', '')), '');
  -- «No es de ninguna sala», dicho a propósito: no hay nada que resolver.
  v_sin_sala boolean := coalesce((p->>'sin_sala')::boolean, false);
  v_nombre  text;
  v_cantidad int;
  -- El año de la bolsa y la fecha que se le pone a su compra. Ver la rama
  -- `articulo`: la compra va dentro del año que dice la hoja, no hoy.
  v_anyo    int;
  v_cuando  timestamptz;
  -- El alta de un aula: el edificio tal y como lo escribe la fila, el edificio
  -- y la planta ya resueltos del maestro, y el código con el que se crea.
  v_edificio_dicho text;
  v_edificio uuid;
  v_zona     uuid;
  v_zona_nombre text;
  v_code     text;
  c         record;
begin
  if v_tipo = 'incidencia' then
    if v_room is not null and not exists (select 1 from rooms where id = v_room) then
      raise exception 'la sala «%» no existe en el maestro', v_room;
    end if;

    insert into incidents (id, room_id, title, description, resolution, state,
                           opened_at, resolved_at, source)
    values (gen_random_uuid(), v_room,
            btrim(p->>'problema'),
            nullif(btrim(coalesce(p->>'observacion', '')), ''),
            nullif(btrim(coalesce(p->>'resolucion', '')), ''),
            case when v_resuelta is not null then 'resuelta'::incident_state else 'abierta'::incident_state end,
            coalesce(v_abierta, v_resuelta, current_date)::timestamptz,
            v_resuelta::timestamptz,
            'sharepoint')
    returning id, external_ref into v_id, v_numero;

    -- Que no es de ninguna sala y se sabe: ni cuarentena ni bandeja.
    if v_sin_sala then
      update incidents set sin_sala = true where id = v_id;
    end if;

    -- El número que la fila traía se respeta si está libre y bien formado. Si
    -- no, manda el de la base y la fila se corrige al escribir el libro.
    if v_pedido is not null
       and v_pedido ~ '^[A-Z]\d{6}_\d{4}$'
       and not exists (select 1 from incidents where external_ref = v_pedido) then
      update incidents set external_ref = v_pedido where id = v_id;
      v_numero := v_pedido;
    end if;

    if jsonb_typeof(p->'detalle') = 'array' and jsonb_array_length(p->'detalle') > 0 then
      -- Con el arranque del recuento: un parte de antes entra con su material
      -- apuntado y el almacén quieto.
      perform public.sync_material_del_parte(v_id, p->'detalle', nullif(p->>'arranque', '')::date);
    end if;

    -- El aula tal y como la escribió el técnico queda de alias de la sala: es
    -- lo que hace que la próxima vez cruce sola. Un alias que ya es de otra
    -- sala no se pisa.
    if v_room is not null and v_aula is not null then
      insert into room_aliases (room_id, alias, alias_norm)
      values (v_room, v_aula, public.norm_text(v_aula))
      on conflict (alias_norm) do nothing;
    end if;

    -- Sin sala y sin saber cuál, el texto del aula se guarda donde «Incidencias
    -- sin sala» lo busca: en la cuarentena, con el motivo que esa pantalla
    -- reconoce. Así un parte que entró sin aula se puede colocar después.
    --
    -- Sin sala A PROPÓSITO, no: no hay nada que colocar, y esa bandeja solo
    -- sabe ofrecer salas del maestro. Apuntarlo era dejar una fila que nadie
    -- puede cerrar, una por regularización y en cada pasada.
    if v_room is null and not v_sin_sala then
      perform public.cuarentena_apuntar(
        'SharePoint',
        v_numero,
        jsonb_build_object('ref', v_numero, 'aula', v_aula, 'problema', btrim(p->>'problema'),
                           'hoja', v_hoja, 'fila', p->>'fila'),
        'No se pudo identificar la sala');
    end if;

    v_clave := v_numero;

  elsif v_tipo = 'sala' then
    -- El edificio, primero: sin él no hay dónde poner el aula. Se acepta tanto
    -- el código («S») como el nombre entero («SÓCRATES»), normalizados los dos,
    -- porque la fila del libro escribe lo uno o lo otro según la hoja y según
    -- quién la rellenó, y cualquiera de las dos formas identifica lo mismo.
    v_edificio_dicho := btrim(coalesce(p->>'edificio', ''));
    if v_edificio_dicho = '' then
      raise exception 'un aula nueva necesita decir de qué edificio es';
    end if;

    -- Solo edificios vivos. Uno de la papelera aceptaría el aula perfectamente
    -- y el aula no se vería en ninguna parte, porque `room_overview` filtra por
    -- `b.active`: un alta que dice «hecho» y no aparece es peor que una que se
    -- niega.
    --
    -- Y con el código por delante del nombre en el desempate: si un edificio se
    -- llama como el código de otro, manda el código, que es el identificador.
    select id into v_edificio
      from buildings
     where active
       and (public.norm_text(code) = public.norm_text(v_edificio_dicho)
            or public.norm_text(name) = public.norm_text(v_edificio_dicho))
     order by (public.norm_text(code) = public.norm_text(v_edificio_dicho)) desc, sort_order
     limit 1;

    if v_edificio is null then
      raise exception 'no hay ningún edificio vivo que sea «%»: el aula no se crea', v_edificio_dicho;
    end if;

    -- La planta, con el mismo criterio que `create_room`: se busca normalizada
    -- y se crea si no está. Es lo que impide que «1ª PLANTA» y «1ª Planta»
    -- acaben siendo dos plantas del mismo edificio, cada una con la mitad de
    -- las aulas. Un edificio recién bautizado no tiene ninguna, así que aquí se
    -- crean las suyas.
    v_zona_nombre := btrim(coalesce(p->>'zona', ''));
    if v_zona_nombre = '' then
      v_zona_nombre := 'SIN ZONA';
    end if;

    select id into v_zona
      from zones
     where building_id = v_edificio
       and public.norm_text(name) = public.norm_text(v_zona_nombre);

    if v_zona is null then
      -- Saltos de diez, igual que en el resto del maestro: deja sitio para
      -- colocar una planta entre dos sin renumerar las demás.
      insert into zones (building_id, name, sort_order)
      select v_edificio, v_zona_nombre, coalesce(max(sort_order), 0) + 10
        from zones where building_id = v_edificio
      returning id into v_zona;
    end if;

    v_code := btrim(coalesce(p->>'code', ''));
    if v_code = '' then
      raise exception 'un aula nueva necesita código';
    end if;

    -- Si ya está, se usa la que está. Se compara normalizado y no con `=`, que
    -- es lo que hace el `unique (zone_id, code)`: ese único distingue
    -- mayúsculas, así que `a1` y `A1` entrarían como dos aulas distintas de la
    -- misma planta y en la lista se leerían como la misma repetida.
    --
    -- Esto es lo que hace que dos pasadas que se solapen no dejen un aula
    -- gemela. No es una hipótesis: la fila del libro llega aquí tantas veces
    -- como pasadas se hagan hasta que el alias cruce, y la gemela se lleva la
    -- mitad de las incidencias sin que nadie lo note.
    --
    -- De paso se recoge la MATRÍCULA, que es la clave con la que esta fila
    -- viajará a partir de ahora. Es el detalle del que cuelga todo lo demás:
    --
    --  - la instantánea de una hoja de estado se guarda «por matrícula y no por
    --    número de fila» (`sync_aplicar`), y la pasada siguiente pregunta por el
    --    antepasado de cada celda con `sala.shortRef`;
    --  - y una corrección de sala se resuelve con `rooms where short_ref =
    --    clave` (`sync_aplicar_celda`).
    --
    -- Si aquí se dejara el id, las celdas de esta fila quedarían apuntadas bajo
    -- un identificador que nadie vuelve a preguntar: la pasada siguiente
    -- encontraría el aula ya creada y SIN antepasado, y sin antepasado manda la
    -- aplicación. O sea que lo que alguien corrigiera a mano en esa fila entre
    -- las dos pasadas se sobrescribiría con los valores por defecto del aula
    -- recién creada, sin salir como choque ni como aviso. Es exactamente el
    -- fallo que el antepasado existe para evitar, y costaría el trabajo de las
    -- 43 filas que esta rama entra a resolver.
    select id, short_ref into v_id, v_clave
      from rooms
     where zone_id = v_zona
       and public.norm_text(code) = public.norm_text(v_code);

    if v_id is null then
      -- `aula` y no otra cosa: a esta rama solo llegan códigos de la
      -- nomenclatura del campus, `<planta>.<número>` con el sufijo opcional del
      -- edificio (`2.6`, `-1.3`, `0.1P`), y eso es exactamente lo que
      -- `classifyRoom` clasifica como aula. Lo que se lee de dos maneras —«Aula
      -- Demo», «Sala Vip», «Laboratorio 9»— no llega hasta aquí: sigue siendo
      -- una duda que contesta una persona.
      --
      -- El nombre se pone igual que el código porque en la hoja de estado la
      -- mayoría de las aulas se llaman como su código, y es lo mismo que hace
      -- `create_room` cuando no le dan uno.
      --
      -- Lo demás lo ponen los disparadores: la matrícula `rooms_matricula` y el
      -- equipamiento por defecto `rooms_defaults`. Por eso un aula creada desde
      -- aquí sale igual de completa que una creada a mano desde el maestro.
      insert into rooms (zone_id, code, name, kind)
      values (v_zona, v_code, v_code, 'aula')
      returning id, short_ref into v_id, v_clave;
    end if;

    -- Y el aula tal y como la escribe el libro queda de alias, exactamente como
    -- en un parte: es lo que hace que la fila cruce sola en la pasada siguiente
    -- en vez de volver a ser una duda. Un alias que ya es de otra sala no se
    -- pisa, que para eso está el único de `alias_norm`.
    if v_aula is not null then
      insert into room_aliases (room_id, alias, alias_norm)
      values (v_id, v_aula, public.norm_text(v_aula))
      on conflict (alias_norm) do nothing;
    end if;

    -- `v_clave` ya lleva la matrícula, de la creación o de la que ya estaba, y
    -- con ella el bucle del final deja el antepasado donde la pasada siguiente
    -- lo va a buscar.

  elsif v_tipo = 'articulo' then
    v_nombre := btrim(coalesce(p->>'nombre', ''));
    if v_nombre = '' then raise exception 'un artículo necesita nombre'; end if;
    select id into v_id from stock_items where public.norm_text(name) = public.norm_text(v_nombre);
    if v_id is null then
      insert into stock_items (name, aliases)
      values (v_nombre,
              case when nullif(btrim(coalesce(p->>'nombre_alternativo', '')), '') is null
                   then '{}'::text[] else array[btrim(p->>'nombre_alternativo')] end)
      returning id into v_id;
    end if;
    v_cantidad := nullif(p->>'comprado', '')::int;
    if v_cantidad is not null and v_cantidad > 0 then
      /*
       * La compra va dentro del año de la bolsa, no hoy.
       *
       * Esto lo trajo `20260916000200` y se perdió por el camino:
       * `20260921000200` volvió a declarar la función entera para la rama del
       * arranque del recuento, copió el cuerpo de una versión anterior y se
       * llevó por delante el fechado; `20260922000100` y `20260922000200`
       * arrastraron la pérdida, y este fichero la arrastraba también.
       *
       * Lo caza `supabase/rls-test.sql` («la compra del artículo nuevo se
       * fechó en 2026 y la bolsa era de 2025»), que lleva desde el 21/09
       * fallando en rojo sin que nadie mirara. El daño es de los callados: un
       * artículo que estrena la Bolsa 2025 metía su compra en 2026, y «Total
       * Comprado» de los dos años dejaba de cuadrar sin decir por qué.
       *
       * Se arregla aquí y no en un fichero propio porque este ya vuelve a
       * declarar `sync_alta` entera: separarlo dejaría dos versiones de la
       * misma función compitiendo por ser la última.
       *
       * Dentro del año y lo más cerca de hoy que se pueda, igual que en el
       * cuadre de una celda. Sin año se supone el corriente, que es lo que
       * hacía antes de que las bolsas llevaran el suyo.
       */
      v_anyo := coalesce(
        nullif(p->>'anyo', '')::int,
        extract(year from (now() at time zone 'Europe/Madrid'))::int
      );
      v_cuando := least(
        greatest(now(), make_timestamptz(v_anyo, 1, 1, 0, 0, 0, 'Europe/Madrid')),
        make_timestamptz(v_anyo, 12, 31, 23, 59, 59, 'Europe/Madrid')
      );
      insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, by_user, source, note)
      values (gen_random_uuid(), v_id, v_cantidad, 'compra', v_cuando, null, 'sharepoint',
              format('Comprado según la bolsa de %s del Excel, al dar de alta el artículo', v_anyo));
    end if;
    v_clave := v_id::text;

  elsif v_tipo = 'unidad' then
    v_id := public.stock_unit_alta(jsonb_build_object(
      'articulo', p->>'articulo', 'marca', p->>'marca', 'modelo', p->>'modelo',
      'serial', p->>'serial', 'observaciones', p->>'observaciones', 'source', 'sharepoint'));
    v_clave := v_id::text;

  else
    raise exception 'no sé dar de alta «%»', v_tipo;
  end if;

  -- El antepasado de la fila, bajo su clave nueva.
  if v_hoja is not null and jsonb_typeof(p->'celdas') = 'object' then
    for c in select key, value from jsonb_each(p->'celdas') loop
      insert into sync_celdas (hoja, ref, columna, valor_base, entidad)
      values (v_hoja, v_clave, c.key,
              case when jsonb_typeof(c.value) = 'null' then null else c.value #>> '{}' end,
              v_tipo)
      on conflict (hoja, ref, columna) do update
        set valor_base = excluded.valor_base, at = now();
    end loop;
    -- Y la columna del número, si es un parte, dice el número que la base puso.
    if v_tipo = 'incidencia' and nullif(p->>'columna_numero', '') is not null then
      insert into sync_celdas (hoja, ref, columna, valor_base, entidad)
      values (v_hoja, v_clave, p->>'columna_numero', v_numero, v_tipo)
      on conflict (hoja, ref, columna) do update
        set valor_base = excluded.valor_base, at = now();
    end if;
  end if;

  return jsonb_build_object('clave', v_clave, 'numero', v_numero, 'id', v_id);
end $$;

comment on function public.sync_alta(jsonb) is
  'Da de alta un aula, un parte, un artículo o un ordenador de repuesto que el libro tiene y la aplicación no, deja el antepasado de la fila bajo su clave nueva y devuelve esa clave. El número del parte lo pone la base. Un parte anterior al arranque del recuento entra sin mover el almacén. Un parte que no es de ninguna sala a propósito («Varias aulas», «Almacén») entra sin sala y NO va a la cuarentena: no hay nada que resolver. Un aula crea su planta si hace falta, reutiliza la que ya esté con ese código en esa planta, y devuelve su matrícula.';

revoke all on function public.sync_alta(jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';
