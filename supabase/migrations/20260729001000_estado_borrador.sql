-- =============================================================================
-- El estado `borrador` de una incidencia, y nada más
--
-- Va SOLO en este fichero a propósito. Postgres permite añadir un valor a un
-- enum dentro de una transacción desde la 12, pero **no permite usarlo** hasta
-- que esa transacción confirma: cualquier `where state = 'borrador'` en el mismo
-- envío muere con «unsafe use of new value of enum type».
--
-- Y `reports-worker/src/migraciones.ts` manda cada fichero entero en una sola
-- transacción implícita (`.simple()`), justamente para que una migración que
-- falla a la mitad se deshaga entera. O sea que la única forma de tener el valor
-- disponible para la migración siguiente es que este fichero termine aquí.
--
-- `before 'abierta'` para que el orden del enum siga el ciclo de vida real: un
-- borrador es anterior a estar abierta. Eso hace que cualquier `order by state`
-- ordene por avance del trabajo sin tener que enumerar los casos a mano.
-- =============================================================================

alter type incident_state add value if not exists 'borrador' before 'abierta';
