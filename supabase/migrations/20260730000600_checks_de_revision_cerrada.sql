-- =============================================================================
-- Las comprobaciones de una revisión cerrada tienen que poder llegar
-- =============================================================================
--
-- El registro de la base de datos trae 234 de estos en tres horas y media de
-- trabajo de campo:
--
--   ERROR: new row violates row-level security policy for table "inspection_checks"
--
-- No es un ataque ni una cuenta mal configurada: es el funcionamiento normal de
-- la aplicación chocando contra su propia política.
--
-- La política decía que un check solo se escribe si su revisión **sigue siendo
-- borrador**. La intención era buena y sigue estando: una revisión cerrada es un
-- registro de auditoría y no se reescribe.
--
-- Pero la cola de salida sube la revisión ANTES que sus comprobaciones, y tiene
-- que hacerlo: `inspection_checks.inspection_id` es una clave ajena, así que la
-- revisión debe existir primero. Y cuando el técnico cierra la revisión, lo que
-- sube es la revisión ya en estado `completa`.
--
-- O sea que la secuencia real, la de todos los días, es:
--
--   1. sube `inspections` con status = 'completa'   ✓
--   2. suben sus nueve `inspection_checks`          ✗ ← la revisión ya no es borrador
--
-- El paso 2 se deniega SIEMPRE. Y en el peor momento posible: sin cobertura, que
-- es cuando la revisión entera viaja junta y es la única copia que existe. El
-- técnico ve la revisión en el servidor, completa y sin una sola comprobación
-- dentro, y su iPad se queda con nueve filas rechazadas por permisos que no
-- volverán a intentarse solas. Trabajo de campo que no se puede repetir porque
-- nadie se acuerda de en qué estado estaba cada aparato.
--
-- El arreglo separa lo que la política de antes mezclaba:
--
--   · INSERT — permitido para las revisiones propias, **esté como esté la
--     revisión**. Insertar las comprobaciones que le faltan a una revisión no es
--     reescribir nada: es completarla. Es lo único que la cola necesita.
--
--   · UPDATE y DELETE — solo mientras la revisión es borrador. Aquí es donde
--     vivía de verdad la garantía de inmutabilidad, y aquí se queda intacta:
--     una comprobación ya cerrada no la cambia ni la borra su autor.
--
-- Un supervisor conserva lo que tenía en los tres casos: corregir es su trabajo.

drop policy if exists "escribir checks del borrador propio" on inspection_checks;

-- Alta: la revisión es mía (o soy supervisor). Su estado no entra en la cuenta.
drop policy if exists "insertar checks de revision propia" on inspection_checks;
create policy "insertar checks de revision propia" on inspection_checks
  for insert to authenticated
  with check (
    exists (
      select 1 from inspections i
      where i.id = inspection_id
        and (i.by_user = (select auth.uid()) or public.is_supervisor())
    )
  );

-- Cambio: solo mientras sea borrador. Es la inmutabilidad, y no se toca.
drop policy if exists "editar checks del borrador propio" on inspection_checks;
create policy "editar checks del borrador propio" on inspection_checks
  for update to authenticated
  using (
    exists (
      select 1 from inspections i
      where i.id = inspection_id
        and (i.by_user = (select auth.uid()) and i.status = 'borrador'
             or public.is_supervisor())
    )
  )
  with check (
    exists (
      select 1 from inspections i
      where i.id = inspection_id
        and (i.by_user = (select auth.uid()) and i.status = 'borrador'
             or public.is_supervisor())
    )
  );

drop policy if exists "borrar checks del borrador propio" on inspection_checks;
create policy "borrar checks del borrador propio" on inspection_checks
  for delete to authenticated
  using (
    exists (
      select 1 from inspections i
      where i.id = inspection_id
        and (i.by_user = (select auth.uid()) and i.status = 'borrador'
             or public.is_supervisor())
    )
  );
