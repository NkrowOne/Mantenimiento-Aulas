-- =============================================================================
-- La hoja de inventario de una sala y de un edificio
--
-- Lo que se pide es un papel: marca, modelo, número de serie y las tres fechas
-- —alta, último cambio y baja— de cada equipo de un aula o de un edificio
-- entero. Se imprime con `window.print()`, como la hoja de placas, así que del
-- servidor solo hace falta una cosa: **una consulta que ya diga la verdad**, sin
-- que el cliente tenga que cruzar nada. Una hoja impresa se lleva al aula, se
-- firma y se archiva; el día que se descubre que dice otra cosa que la pantalla
-- ya no hay a quién preguntar.
--
-- Faltaban dos datos para poder escribirla, y los dos son columnas nuevas:
--
--  1. **La marca**. Nunca existió como dato propio: el importador dejó marca y
--     modelo pegados dentro de `model`, porque así venían en la hoja de cálculo.
--
--  2. **Cuándo se tocó por última vez este equipo**. La base sabía cuándo nació
--     una fila (`created_at`) y qué le fue pasando (`asset_events`), pero no
--     cuándo se corrigió: cambiar el número de serie de un proyector desde el
--     aula no deja evento ninguno, y la hoja lleva una columna que pregunta eso.
--
-- Y la vista que lo junta todo, `inventory_sheet`, que existe sobre todo por una
-- trampa que ninguna pantalla podía sortear sola y que está explicada abajo, en
-- su sitio: al aprobar una retirada con destino almacén el equipo **pierde la
-- sala**, y la consulta ingenua pierde justo los equipos por los que se imprime
-- la hoja de bajas.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 — La marca, como dato propio
--
-- Va aparte de `model` porque son dos preguntas distintas y solo una de ellas se
-- puede agrupar: «cuántos Epson tenemos» y «qué hay que pedir para sustituir
-- este» no se responden con la misma cadena. Mientras las dos vivan en el mismo
-- campo, la primera no tiene respuesta y la segunda depende de cómo tecleara
-- cada uno.
--
-- Y las 1.094 filas importadas se quedan **como están**: el campo nace vacío y
-- no se reparte a posteriori. Separar «EPSON EB-2250U» por el primer espacio
-- acierta, y falla en silencio con cualquier marca de dos palabras, con los
-- modelos que empiezan por número y con las filas donde lo que hay no es un
-- modelo sino una descripción. Una regla que acierta en la mayoría deja un par
-- de cientos de equipos con la marca equivocada **y sin manera de saber cuáles**,
-- que es peor que la casilla en blanco: la casilla en blanco se ve, se pregunta
-- y se rellena. El sitio donde se rellena es la corrección desde el aula, que es
-- el único momento en que hay alguien delante del aparato leyendo el rótulo.
-- -----------------------------------------------------------------------------

alter table assets add column if not exists brand text;

comment on column assets.brand is
  'La marca, aparte del modelo. Nace vacía: lo importado la lleva pegada dentro de model y adivinar dónde acaba sería inventar.';

-- -----------------------------------------------------------------------------
-- 2 — Cuándo se tocó por última vez
--
-- La fecha la pone **el reloj del servidor**, y no es un detalle de implementación:
-- si la escribiera el cliente, un iPad con la hora mal —o con la zona cambiada
-- de vuelta de un viaje— dejaría en el inventario una fecha de cambio anterior
-- al alta o del año que viene, y la hoja impresa lo repetiría sin pestañear. Es
-- la misma separación que ya hacen `inspections.occurred_at` y `recorded_at`: lo
-- que pasó en el aula lo fecha quien estaba allí; lo que le pasa a una fila lo
-- fecha la base.
--
-- `default now()` con `not null`: desde PostgreSQL 11 esto no reescribe la
-- tabla, se guarda el valor una vez en el catálogo y se aplica a las 1.094 filas
-- sin tocarlas. Sobre una base en producción es un bloqueo de milisegundos.
--
-- El relleno inicial va pegado al `alter` y dentro del mismo bloque, y esa es la
-- forma de que la migración se pueda repetir sin hacer daño. Sin él, el día del
-- despliegue los 1.094 equipos dirían que se tocaron todos a la vez, a la misma
-- hora, que es la clase de dato que hace desconfiar de la columna entera; suelto
-- y con la columna ya creada, una segunda pasada devolvería a la fecha de alta
-- todos los equipos corregidos desde entonces —perdiendo justo lo que la columna
-- había empezado a saber—. Preguntando primero si la columna existe, la segunda
-- pasada no hace nada.
--
-- Y va DELANTE del disparador de más abajo, tampoco por casualidad —igual que el
-- relleno de `confirmed` en `20260730000100`—: ese disparador solo mueve la
-- fecha cuando cambia alguna OTRA columna, así que con él ya instalado este
-- `update` se revertiría a sí mismo, en silencio y sin fallar.
--
-- El relleno pasa por los dos disparadores BEFORE UPDATE que `assets` ya tenía y
-- ninguno tiene nada que hacer: `assets_confirmed_guard` se aparta cuando no hay
-- token —una migración no lo lleva— y `assets_label_libre` busca un choque de
-- etiqueta que el índice único `assets_room_label_idx` garantiza que no existe.
--
-- Deja una fila de auditoría por equipo, sin autor. Se prefiere eso a apagar
-- `assets_audit` durante el relleno: las migraciones se aplican con `psql -f`,
-- sin transacción que las envuelva, así que un fallo a media pasada dejaría la
-- auditoría de `assets` desactivada para siempre y nadie se enteraría.
-- -----------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'assets'
       and column_name = 'updated_at'
  ) then
    return;
  end if;

  alter table assets add column updated_at timestamptz not null default now();

  -- La fecha de alta es la única afirmación cierta que se puede hacer de una
  -- fila que nadie ha vuelto a mirar. `coalesce` porque el importador pudo
  -- dejarla sin poner y una columna `not null` no admite el hueco.
  update assets set updated_at = coalesce(created_at, now());
end $$;

comment on column assets.updated_at is
  'Reloj del servidor: cuándo se modificó la fila por última vez. Lo pone un disparador, nunca el cliente. Igual a created_at significa que no consta que nadie la haya tocado.';

/**
 * El disparador que la mantiene.
 *
 * No es un `new.updated_at := now()` a secas, y la diferencia importa en tres
 * sitios. Un UPDATE que deja la fila igual que estaba no es un cambio: el
 * técnico que abre el formulario, no toca nada y guarda no ha «tocado» el
 * equipo, y la hoja no debe decir que sí. Y `audit_trigger` decide con
 * `to_jsonb(old) = to_jsonb(new)` si merece la pena registrar el UPDATE —mover
 * la fecha siempre haría que ninguna comparación volviera a dar igual, y esa
 * defensa dejaría de existir para `assets`, que es la tabla que más UPDATE
 * inocuos recibe: cada sincronización reenvía lo que el dispositivo ya tenía.
 *
 * La comparación quita `updated_at` de los dos lados justamente para no
 * compararse consigo misma.
 *
 * Y el tercer sitio es el INSERT, que antes no pasaba por aquí. El comentario de
 * la columna decía «lo pone un disparador, nunca el cliente» y en el alta no era
 * verdad: `default now()` solo actúa cuando la columna NO viene en la sentencia,
 * y PostgREST manda al INSERT cualquier columna que traiga el cuerpo de la
 * petición. La política de alta —«personal da de alta equipos»— mira `is_staff()`
 * y `confirmed`, y no puede mirar esto: no sabe de fechas. O sea que con el token
 * de un técnico se podía dar de alta un equipo con la fecha de cambio puesta a
 * mano, y la hoja impresa la habría repetido sin pestañear. El invariante estaba
 * cerrado por el lado del UPDATE y abierto por el del INSERT.
 */
create or replace function public.assets_tocar_updated_at()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    -- Una fila que acaba de nacer no se ha modificado, y eso es exactamente lo
    -- que la hoja lee: `inventory_sheet` publica `cambio_at` solo cuando
    -- `updated_at` va por delante de `created_at`. Se iguala al alta y no a
    -- `now()` a propósito — son el mismo instante en un alta corriente, pero un
    -- INSERT que traiga su propio `created_at` (el importador, o un rescate)
    -- nacería si no con la fecha de cambio por delante de la de alta, es decir
    -- «Modificado» el día uno.
    new.updated_at := new.created_at;
    return new;
  end if;

  if to_jsonb(new) - 'updated_at' is distinct from to_jsonb(old) - 'updated_at' then
    new.updated_at := now();
  else
    -- Ni siquiera se deja pasar lo que venga del cliente: la fecha es del
    -- servidor, y una fila que no cambia conserva la suya.
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

comment on function public.assets_tocar_updated_at() is
  'Pone assets.updated_at a la hora del servidor cuando la fila cambia de verdad. En el alta la iguala a created_at, que es como se dice que todavía no la ha tocado nadie. Un UPDATE que no cambia nada no la mueve.';

drop trigger if exists assets_updated_at on assets;
-- El nombre lo coloca detrás de `assets_confirmed_guard` y de
-- `assets_label_libre` por orden alfabético, que es lo que hace falta: los dos
-- reescriben `NEW` —uno revierte `confirmed`, el otro recoloca `label`—, y este
-- tiene que ver la fila ya definitiva. Al revés, un UPDATE que solo intentara
-- mover `confirmed` sin ser coordinador acabaría con la fila intacta y la fecha
-- movida.
--
-- `insert or update` y no `update` a secas: ver la función. En el INSERT el orden
-- da igual —la rama del alta no mira ninguna otra columna— pero la fecha tiene
-- que dejar de depender de que el cliente se porte bien.
create trigger assets_updated_at
  before insert or update on assets
  for each row execute function public.assets_tocar_updated_at();

-- -----------------------------------------------------------------------------
-- 3 — La vista
--
-- Las columnas se llaman exactamente como el tipo `FilaDeInventario` de
-- `src/features/inventory/hoja.ts`: el cliente hace `select('*')` y castea sin
-- mapear. Un mapeo por medio es un sitio más donde una columna nueva se olvida y
-- sale en blanco en el papel sin que nadie se entere.
--
-- **La trampa.** Al aprobar una retirada con destino 'almacen',
-- `decide_asset_removal` pone `assets.room_id` a NULL y guarda la sala SOLO
-- dentro del `asset_events` de la baja. Un `join rooms on rooms.id = a.room_id`
-- no falla, no avisa y no devuelve fila: perdería en silencio **justo los
-- equipos por los que se imprime la hoja de bajas**. La sala efectiva es
-- `coalesce(a.room_id, ev.room_id)`.
--
-- Y `ev` es el último evento CON sala, no el último a secas. Si mañana alguien
-- registra una avería sin `room_id` después de la baja, el último evento no
-- tendría sala y el equipo volvería a desaparecer — el mismo fallo, por la
-- puerta de al lado.
--
-- El `join` a `rooms`, `zones` y `buildings` es interior a propósito: un equipo
-- cuya sala no se puede resolver ni por la fila ni por sus eventos no pertenece
-- a ninguna hoja, porque la hoja siempre es de una sala o de un edificio. Y no
-- se filtra por `rooms.active` ni por `buildings.active`: archivar limpia la
-- lista de trabajo, no el inventario de lo que hubo allí, que es la misma regla
-- que siguen `room_timeline` y `asset_removal_queue`.
--
-- Sin `order by` dentro: ordena el cliente, que es quien sabe si está pintando
-- una sala —donde el orden es el de lectura del aula, no el alfabético— o un
-- edificio entero.
-- -----------------------------------------------------------------------------

create or replace view public.inventory_sheet as
select
  a.id                      as asset_id,
  b.id                      as building_id,
  b.code                    as building_code,
  b.name                    as building_name,
  b.sort_order              as building_sort,
  z.id                      as zone_id,
  z.name                    as zone_name,
  z.sort_order              as zone_sort,
  r.id                      as room_id,
  r.code                    as room_code,
  r.name                    as room_name,
  r.short_ref               as room_short_ref,
  lv.occurred_at            as room_last_inventory_at,
  -- Un salto de `merged_into`, el mismo que da `public.asset_type_id()`. Basta,
  -- y tiene que ser exactamente uno: `merge_asset_type` repunta todos los
  -- equipos al tipo bueno y exige que el destino no sea ya una lápida, así que
  -- la única forma de que un equipo apunte a una es que lo diera de alta un
  -- dispositivo con el catálogo viejo —el cliente deriva el id del tipo del
  -- nombre normalizado, uuid v5— y eso deja el tipo a un salto. Seguir la cadena
  -- más allá haría que el papel dijera un nombre distinto del que enseña la
  -- pantalla desde la que se imprimió, que es peor que quedarse corto.
  coalesce(tf.name, t.name) as type_name,
  a.label,
  a.brand,
  a.model,
  a.serial,
  a.status,
  a.confirmed,
  a.created_at              as alta_at,
  -- La fecha de cambio SOLO cuando hay cambio, que es lo que el cliente asume y
  -- lo que `updated_at` no puede decir sola: es `not null`, así que publicarla
  -- cruda hacía que la hoja imprimiera «Modificado» en TODAS las líneas y con la
  -- misma fecha que la columna «Alta». El relleno de arriba iguala `updated_at`
  -- a `created_at` en las 1.094 filas del parque, y un alta nueva sale igual
  -- porque los dos valores nacen del mismo instante. O sea que el papel firmado
  -- afirmaba que alguien había tocado equipos que nadie ha tocado nunca, y las
  -- ramas del hueco de `ultimoMovimiento`/`sinMovimientos` eran código
  -- inalcanzable con datos del servidor: solo se veían en la hoja del espejo.
  --
  -- «Igual que el alta» es la forma que tiene la base de decir «desde que se
  -- apuntó, no consta que nadie lo tocara», y aquí se traduce a lo único que el
  -- cliente sabe leer: NULL, que la hoja imprime como el hueco que es.
  --
  -- Con `>` y no con `nullif`: así una fila cuya fecha de cambio quedara POR
  -- DETRÁS del alta —un `created_at` puesto a mano, o del año que viene— tampoco
  -- inventa un cambio. Inventarlo es el fallo que se está arreglando.
  case
    when a.updated_at > a.created_at then a.updated_at
  end                       as cambio_at,
  -- La fecha de baja, con su caso raro. `reject_asset` retira un equipo sin
  -- dejar evento —es una propuesta descartada desde la bandeja, no un aparato
  -- que se muriera—, así que sin este `case` saldría en la hoja como una baja
  -- sin fecha: la peor de las dos mentiras posibles, porque parece un hueco de
  -- los que se rellenan preguntando y no lo es.
  --
  -- Es una aproximación y conviene saberlo: para los que ya estaban retirados
  -- antes de que `updated_at` existiera, la fecha es la del alta, y si alguien
  -- vuelve a tocar la fila después, se mueve con ella. Es lo único que la base
  -- sabe de un descarte que no dejó evento, y se dice tal cual; inventar una
  -- fecha de baja plausible sería fabricar justo el dato que se está pidiendo.
  coalesce(
    bj.occurred_at,
    case when a.status = 'retirado' then a.updated_at end
  )                         as baja_at,
  -- 'baja' o 'almacen'. Nulo en la baja que deja `fusionar_equipo_duplicado`,
  -- que retira un duplicado y no tiene destino que declarar: el aparato físico
  -- no se ha movido de la sala, era la fila la que sobraba. El motivo sí lo
  -- lleva, y es el que se lee en la hoja.
  bj.meta ->> 'destino'     as baja_destino,
  nullif(bj.meta ->> 'nota', '') as baja_motivo,
  -- Una retirada firmada y sin decidir todavía. El equipo SIGUE en la sala
  -- —eso es lo que se aprueba— y la hoja tiene que poder decir «pedida» en vez
  -- de contarlo como si ya no estuviera. Va como `exists` y no como `join`
  -- porque `asset_removals_pendiente_idx` es justo este índice, y porque un
  -- `join` a una tabla con varias solicitudes históricas duplicaría la fila.
  exists (
    select 1
      from asset_removals rm
     where rm.asset_id = a.id and rm.state = 'pendiente'
  )                         as retirada_pedida
from assets a
left join asset_types t  on t.id = a.asset_type_id
left join asset_types tf on tf.id = t.merged_into
-- Solo se pregunta por los que han perdido la sala: para el resto la respuesta
-- ya está en la fila, y el `where` de dentro deja el lateral vacío sin tocar
-- `asset_events`.
left join lateral (
  select e.room_id
    from asset_events e
   where a.room_id is null
     and e.asset_id = a.id
     and e.room_id is not null
   order by e.occurred_at desc, e.recorded_at desc
   limit 1
) ev on true
join rooms r     on r.id = coalesce(a.room_id, ev.room_id)
join zones z     on z.id = r.zone_id
join buildings b on b.id = z.building_id
-- La baja se busca por `kind` y no se supone del estado: un equipo puede estar
-- retirado sin evento (arriba) y puede tener eventos posteriores a su baja.
left join lateral (
  select e.occurred_at, e.meta
    from asset_events e
   where e.asset_id = a.id and e.kind = 'baja'
   order by e.occurred_at desc, e.recorded_at desc
   limit 1
) bj on true
-- Cuándo se levantó el inventario de esa sala. Va en cada fila porque encabeza
-- la hoja impresa: sin esa fecha, un papel con tres equipos no se distingue de
-- un aula que nadie ha mirado nunca.
left join lateral (
  select v.occurred_at
    from room_inventories v
   where v.room_id = r.id
   order by v.occurred_at desc
   limit 1
) lv on true;

-- Sin esto la vista se ejecutaría con los privilegios de su propietario, que
-- tiene BYPASSRLS, y PostgREST publica las vistas igual que las tablas: el
-- inventario entero quedaría legible con cualquier token, o sin ninguno. Es la
-- misma línea que llevan todas las vistas del proyecto y el motivo está contado
-- en `20260728000200_views.sql`.
alter view public.inventory_sheet set (security_invoker = on);

comment on view public.inventory_sheet is
  'Una fila por equipo con su sala, sus fechas de alta, cambio y baja, y si tiene una retirada pedida. Conserva los equipos que perdieron la sala al irse al almacén.';

-- -----------------------------------------------------------------------------
-- 4 — Permisos
--
-- Con `security_invoker` la vista no da acceso a nada: cada tabla de debajo
-- aplica su RLS al leer, y basta con que a UNA le falte la política de lectura
-- del personal para que la hoja salga incompleta **sin decirlo** —las bajas
-- desaparecerían justo para el técnico que las está imprimiendo, porque un
-- `left join lateral` que no puede ver ninguna fila devuelve NULL, no un error—.
-- Repasadas una a una, todas la tienen y ninguna hace falta añadirla aquí:
--
--   assets            «personal lee equipos»                 20260728000300:218
--   asset_events      «personal lee eventos de equipo»       20260728000300:226
--   asset_types       «personal lee asset_types»             20260728000300:97  (el bucle de maestros)
--   rooms/zones/buildings  idem, el mismo bucle
--   room_inventories  «personal lee levantamientos»          20260729001600:65
--   asset_removals    «personal lee solicitudes de retirada» 20260730000400:132
--
-- Todas resuelven con `public.is_staff()`, así que un técnico ve la hoja entera
-- —incluidas las bajas y las retiradas pendientes— y `anon` no ve nada.
--
-- El GRANT es explícito aunque el `alter default privileges` del bootstrap ya lo
-- cubra: ese defecto solo alcanza a lo que crea el mismo rol que lo declaró, y
-- una vista que se aplique desde otra conexión se quedaría sin él y devolvería
-- un 401 que parece un problema de sesión.
-- -----------------------------------------------------------------------------

grant select on public.inventory_sheet to authenticated;

notify pgrst, 'reload schema';
