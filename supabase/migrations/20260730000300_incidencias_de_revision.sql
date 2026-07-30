-- =============================================================================
-- Un aparato que falla en la revisión ES una incidencia
--
-- Hasta aquí, marcar «Falla» en un equipo durante la revisión guardaba una fila
-- en `inspection_checks` y nada más. La incidencia no existía: no aparecía en la
-- pestaña de Incidencias, no contaba en `room_overview.open_incidents`, no
-- penalizaba la fiabilidad de la sala y nadie tenía que cerrarla. El fallo se
-- quedaba enterrado dentro de una revisión concreta, y la única forma de saber
-- que el proyector del aula 2.4 sigue roto era volver a leer la revisión de
-- aquel día.
--
-- El resultado práctico era el peor posible: la aplicación registraba averías
-- que después no le pedía a nadie resolver. Y la única forma de abrir una
-- incidencia de verdad era el formulario de la ficha de sala, es decir, apuntar
-- la avería DOS veces.
--
-- A partir de aquí, cerrar una revisión con equipos en «Falla» abre una
-- incidencia por equipo, y esa incidencia sigue abierta hasta que alguien la
-- resuelve. Que es lo que quiere decir «hasta que se solucione».
--
-- Aquí solo va la pieza que le faltaba a la tabla: saber DE QUÉ comprobación
-- nació. `opened_from_inspection_id` dice de qué revisión salió, pero no de qué
-- fila de esa revisión, y sin eso no se puede responder a la pregunta que evita
-- el duplicado: «¿este proyector ya tiene una incidencia abierta?».
-- =============================================================================

alter table incidents
  add column if not exists check_key text;

comment on column incidents.check_key is
  'Qué comprobación de la revisión la abrió: `asset:<uuid>` para un equipo, `red` para la sala. NULL en lo que se registra a mano desde la ficha.';

-- -----------------------------------------------------------------------------
-- El índice que evita apuntar la misma avería dos veces
--
-- No es un índice único a propósito, y merece explicación.
--
-- Único sería más fuerte, pero el alta viaja por la cola de salida: dos técnicos
-- sin cobertura que revisen la misma aula el mismo día enviarían dos filas
-- distintas para el mismo proyector, la segunda chocaría con un 409, y la cola
-- marca cualquier 4xx como «rechazado» y lo saca en la pantalla de pendientes.
-- El técnico vería un error rojo por algo que no es un error: su compañero ya lo
-- había apuntado.
--
-- Así que la defensa contra el duplicado es la del cliente —antes de abrir una
-- incidencia mira si esa comprobación ya tiene una abierta en el espejo local— y
-- esto es lo que hace que esa consulta sea barata. El caso que importa no es el
-- de los dos técnicos a la vez, que es raro: es el de la ronda siguiente, cuando
-- el proyector sigue roto y la revisión lo vuelve a marcar. Ese lo resuelve el
-- cliente con este índice detrás.
-- -----------------------------------------------------------------------------
create index if not exists incidents_check_abierta_idx
  on incidents(room_id, check_key)
  where check_key is not null and state <> 'resuelta';

notify pgrst, 'reload schema';
