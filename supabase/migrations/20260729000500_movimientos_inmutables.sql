-- =============================================================================
-- Un movimiento de almacén no se corrige: se registra el contrario
--
-- El esquema se presenta como «modelo append-only» y `stock_movements` era la
-- excepción: tenía política de `UPDATE` para supervisor y **no estaba en la
-- lista de tablas auditadas** (`auth_rls.sql`, el bucle que instala
-- `audit_trigger`). Es decir, la única tabla del sistema con consecuencias
-- económicas era también la única donde se podía cambiar una cifra sin dejar
-- rastro de quién ni de qué decía antes.
--
-- La salida evidente era auditarla. La correcta es la contraria: **impedir el
-- cambio**. Un libro de existencias en el que un asiento se puede reescribir no
-- es un libro, y auditar la reescritura solo deja constancia de un problema que
-- no debería poder ocurrir. La aplicación ya hace lo correcto —el botón
-- «Deshacer» registra el movimiento contrario, que es como se corrige un
-- asiento— y era la API la que abría la puerta por detrás.
--
-- Con esto, la nota del propio esquema pasa a ser cierta también aquí: «solo se
-- audita lo que se puede editar; las tablas append-only son su propio
-- historial». Cada fila lleva ya autor (`by_user`, que la RLS obliga a que sea
-- quien la escribe), cuándo pasó y cuándo se apuntó.
--
-- Queda una puerta, y es a propósito: un administrador con acceso directo a la
-- base puede desactivar el disparador para una reparación. Eso es lo que
-- significa «inmutable» en la práctica —hay que salirse del camino y se nota—,
-- frente a un `update` que cualquier supervisor podía lanzar desde la API sin
-- que nada lo registrara.
-- =============================================================================

-- La política que sobra. El `insert` se queda: es el único verbo que necesita
-- un libro de asientos.
drop policy if exists "supervisor corrige movimientos" on stock_movements;

create or replace function public.stock_movement_inmutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Un movimiento de almacén no se corrige: registra el contrario (id=%)', old.id
    using errcode = 'check_violation',
          hint = 'Un ajuste con el signo opuesto deja el saldo donde toca y conserva las dos filas.';
end;
$$;

comment on function public.stock_movement_inmutable() is
  'Cierra stock_movements a solo-alta. La corrección de un asiento es otro asiento.';

-- `before`, así que salta antes que `stock_movements_no_negativo`, que es
-- `after`. Las ramas de update y delete de aquel dejan de alcanzarse por la vía
-- normal y no sobran: si alguien desactiva este disparador para reparar algo a
-- mano, la comprobación del saldo sigue en pie.
drop trigger if exists stock_movements_solo_alta on stock_movements;
create trigger stock_movements_solo_alta
  before update or delete on stock_movements
  for each row execute function public.stock_movement_inmutable();
