-- =============================================================================
-- El puente entre el almacén y el catálogo de equipos, y los índices del
-- histórico
--
-- `stock_items.asset_type_id` existe desde el primer esquema y estaba a NULL en
-- los 68 artículos: se definió la columna y nunca se rellenó. Sin ella, el
-- almacén y el inventario de las aulas son dos mundos que no se tocan, y dar de
-- alta un proyector en un aula no tiene forma de saber que ese proyector salió
-- de una caja que había en el almacén.
--
-- La línea de tiempo de la sala vive en la migración siguiente: se funde con la
-- que ya creó `registros_y_borradores`, y para eso necesita que exista antes la
-- tabla de levantamientos.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Índices que la vista necesita
--
-- Los de sala ya estaban (`inspections_room_idx`, `incidents_room_idx`,
-- `assets_room_idx`, `stock_movements_room_idx`). Faltan los de fecha, que es
-- como se ordena y como filtra la pantalla de Historial: sin ellos, cada
-- consulta ordena de nuevo las cinco tablas enteras.
-- -----------------------------------------------------------------------------

create index if not exists incidents_resolved_idx on incidents(resolved_at desc)
  where resolved_at is not null;
create index if not exists assets_created_idx on assets(created_at desc);
create index if not exists asset_events_room_idx on asset_events(room_id, occurred_at desc)
  where room_id is not null;
create index if not exists asset_events_occurred_idx on asset_events(occurred_at desc);

-- -----------------------------------------------------------------------------
-- El puente entre el almacén y el catálogo de equipos
--
-- `stock_items.asset_type_id` existe desde el primer esquema y está a NULL en
-- los 68 artículos: se definió la columna y nunca se rellenó. Sin ella, el
-- almacén y el inventario de las aulas son dos mundos que no se tocan, y dar de
-- alta un proyector en un aula no tiene forma de saber que ese proyector salió
-- de una caja que había en el almacén.
--
-- Solo se enlaza lo que **es** un equipo de la sala. Una lámpara de proyector se
-- consume en un proyector pero no es un proyector, y un cable no es nada del
-- inventario: enlazarlos haría que al añadir «Proyector» a un aula se ofreciera
-- descontar una lámpara.
-- -----------------------------------------------------------------------------

create or replace function public.enlazar_almacen_con_catalogo()
returns integer
language plpgsql
as $$
declare
  v_enlazados integer;
begin
  update stock_items si
     set asset_type_id = public.asset_type_id(m.tipo)
    from (values
      ('Proyector Epson',                       'Proyector'),
      ('Proyector Epson (Ed. Antonio Gaudí)',   'Proyector'),
      ('Monitor 86" (edificio BC)',             'Pantalla'),
      ('Monitor NEC 49"',                       'Pantalla'),
      ('Monitor táctil iiyama T2454MSC 24,5"',  'Pantalla'),
      ('Altavoces',                             'Altavoces'),
      ('Micrófono Jabra con soporte de mesa',   'Micrófono'),
      ('Jabra Panacast 50',                     'Cámara'),
      ('Cámara Aver',                           'Cámara'),
      ('Botonera',                              'Botonera'),
      ('Ordenador Tiny M70Q',                   'Ordenador'),
      ('Ordenador Tiny M710Q',                  'Ordenador'),
      ('Ordenador Tiny M720Q',                  'Ordenador'),
      ('Ordenador Tiny Neo 50Q',                'Ordenador')
    ) as m(articulo, tipo)
   where public.norm_text(si.name) = public.norm_text(m.articulo)
     and si.asset_type_id is null
     and public.asset_type_id(m.tipo) is not null;

  get diagnostics v_enlazados = row_count;
  return v_enlazados;
end;
$$;

comment on function public.enlazar_almacen_con_catalogo() is
  'Enlaza cada artículo de almacén que ES un equipo con su tipo. Idempotente: solo toca los que están a NULL.';

comment on column stock_items.asset_type_id is
  'Qué tipo de equipo es este artículo, si es que es uno. NULL en los consumibles.';

-- Va como función y se llama dos veces por el orden de arranque, igual que
-- `backfill_room_assets`: en una instalación limpia las migraciones corren
-- **antes** del seed, así que aquí `stock_items` está vacía y esta llamada no
-- hace nada —el trabajo lo hace la llamada que el importador deja al final del
-- seed—. En una base que ya está en producción es al revés: es esta.
select public.enlazar_almacen_con_catalogo();
