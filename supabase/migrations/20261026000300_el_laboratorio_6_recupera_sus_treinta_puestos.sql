-- reejecutable: si
--
-- No hace nada, y por eso se puede repetir cuantas veces haga falta.
-- =============================================================================
-- El laboratorio de informática 6 recupera sus treinta puestos — SIN EFECTO
--
-- Esta migración buscaba los puestos retirados por el NOMBRE de su tipo y del
-- aula, y en la base de producción no encontró ninguno: el PDF de la sala siguió
-- saliendo con un solo ordenador. Además, si los hubiera encontrado, los habría
-- renumerado por número de serie, y estos ordenadores no tienen serie: el orden
-- habría salido al azar.
--
-- La sustituye `20261026000400`, que los encuentra siguiendo la cadena de la
-- fusión y les deja el nombre que tenían.
--
-- Se vacía en vez de borrarse por el registro: `schema_migrations` guarda el
-- nombre del fichero, y una base que ya la aplicó la tiene anotada. Borrarla
-- haría que el diagnóstico la contara como una migración que sobra. Vaciarla
-- deja las dos clases de base bien:
--
--   - Donde ya corrió, no cambia nada: no encontró equipos y no tocó una fila.
--   - Donde no ha corrido todavía —un servicio sin DATABASE_URL, que no migra
--     hasta que se le pone—, ya no renumera al azar antes de que llegue la buena.
--
-- No define funciones, así que la comprobación del esquema por md5 de
-- `migrar` no la mira: vaciarla no puede hacer que «el esquema no cuadre».
-- =============================================================================

do $sin_efecto$
begin
  raise notice 'Sin efecto: la sustituye 20261026000400.';
end
$sin_efecto$;
