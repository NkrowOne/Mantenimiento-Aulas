-- =============================================================================
-- Una foto se puede dejar fuera del informe, sin borrarla
--
-- El informe recoge las fotos del periodo y las imprime con su pie: es lo que
-- convierte «se cambió el cable» en una prueba. Pero la cámara del móvil no
-- distingue, y en la ronda de un aula se cuela lo que se cuela: un compañero de
-- espaldas ajustando el proyector, alguien sentado al fondo, una pantalla con
-- el correo de otro abierto. Nada de eso es un fallo del que la hizo —se hace
-- una foto en dos segundos, con una mano, mientras se sujeta un cable— y nada
-- de eso tiene por qué acabar en un documento que se manda a dirección.
--
-- Hasta hoy no había forma de arreglarlo. Las fotos NO se borran, y a propósito:
-- `20260728000600_storage.sql` deja el bucket sin políticas de UPDATE ni de
-- DELETE, que en RLS es la manera de decir «esto no pasa». Una foto es la
-- prueba de cómo se encontró un aula, y una prueba que cualquiera puede hacer
-- desaparecer no prueba nada. Esa regla se queda.
--
-- Lo que faltaba es lo de en medio: **retirarla de lo que se publica sin tocar
-- lo que se guarda**. La foto sigue en su sitio, en la ficha de la sala, con su
-- hora y su autor; lo único que cambia es que el informe deja de imprimirla.
-- Es la misma idea que el resto del sistema: aquí no se borra nada, se apunta
-- lo que pasó —quién la retiró y cuándo— y se sigue.
--
-- Se deshace igual de fácil, que es lo que la hace segura de usar: volver a
-- ponerla es dejar `hidden_at` en nulo otra vez.
--
-- -----------------------------------------------------------------------------
-- Quién puede
--
-- Cualquiera del equipo. Quien hace la foto es quien ve lo que salió en ella, y
-- suele darse cuenta en el momento; obligar a avisar a un supervisor para que
-- retire la foto de un compañero es la clase de trámite que termina en «pues no
-- hago fotos». Y el permiso está acotado por columnas: sobre `attachments`, un
-- usuario autenticado solo puede escribir en `hidden_at` y `hidden_by`. La
-- ruta, la hora y el autor de la foto siguen siendo inmutables para todo el
-- mundo, como lo eran ayer.
-- =============================================================================

alter table attachments
  add column if not exists hidden_at timestamptz,
  add column if not exists hidden_by uuid references profiles(id);

comment on column attachments.hidden_at is
  'Retirada de los informes. La foto sigue guardada y visible en la ficha de la sala.';

-- Las dos columnas van juntas: una foto retirada sin autor no se puede explicar
-- en una reunión, y un autor sin fecha no dice nada.
alter table attachments drop constraint if exists attachments_retirada_completa;
alter table attachments add constraint attachments_retirada_completa
  check ((hidden_at is null) = (hidden_by is null));

-- Las consultas del informe piden siempre las publicables. Sin esto, el índice
-- por entidad las trae todas y el filtro se hace después, fila a fila.
create index if not exists attachments_publicables_idx
  on attachments(entity_type, entity_id)
  where hidden_at is null;

-- -----------------------------------------------------------------------------
-- El permiso, columna a columna
-- -----------------------------------------------------------------------------
-- `alter default privileges` del bootstrap concede UPDATE sobre todo lo de
-- `public`, así que sin este par de líneas la política de abajo abriría la fila
-- entera: `storage_path` incluido. Se retira el permiso de tabla y se devuelve
-- solo el de las dos columnas que esta migración añade.
revoke update on attachments from authenticated;
grant update (hidden_at, hidden_by) on attachments to authenticated;

drop policy if exists "personal retira una foto del informe" on attachments;
create policy "personal retira una foto del informe" on attachments
  for update to authenticated
  using (public.is_staff())
  with check (
    public.is_staff()
    -- Retirar se firma. Volver a ponerla deja las dos columnas en nulo, y
    -- entonces no hay nada que firmar.
    and (hidden_at is null or hidden_by = (select auth.uid()))
  );
