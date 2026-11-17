-- reejecutable: si
--
-- Lo único que hay aquí es un bloque `do` que relee la función y la vuelve a
-- crear con una frase cambiada, y un `comment`. La segunda vez la frase vieja
-- ya no está, el bloque no hace nada y el comentario se pone igual. Ni un
-- `update` de datos. La deducción automática no sabe leer un `do`, así que se
-- dice aquí.
-- =============================================================================
-- El ajuste dice «prevalece el Excel»
--
-- La pantalla de sincronización dejó de decir «Manda el Excel»: las tres
-- opciones son ahora «Decidir a mano», «Prevalece el Excel» y «Prevalece la
-- aplicación», y lo mismo dicen los motivos de la pasada, la hoja «Léeme» y las
-- guías. Quedaba un sitio: la nota del movimiento de ajuste con el que
-- `sync_celda_de_articulo` cuadra el almacén con «Stock Disponible», que
-- termina en «(manda el Excel)». Esa nota se lee en el histórico del artículo y
-- en la hoja «Movimientos de Almacén», al lado de una pantalla que ya no usa
-- esa palabra.
--
-- **Cómo se cambia.** No se copia aquí la función entera —ciento setenta
-- líneas, de las que cambia una— porque copiarla es la forma de devolverla sin
-- querer a como estaba el día de la copia si otra migración la toca después. Se
-- le pide a Postgres la definición que tiene HOY, se cambia la frase y se
-- vuelve a crear. `create or replace` conserva el dueño, los permisos y el
-- comentario.
--
-- **Lo que NO se toca: los ajustes ya apuntados.** `stock_movements` es un
-- libro de asientos y no se reescribe (`20260729000500`): un disparador rechaza
-- cualquier `update`, y es a propósito. Los ajustes hechos hasta hoy siguen
-- diciendo «(manda el Excel)», que es lo que decía la pantalla el día que se
-- hicieron. Cambiarles la nota pediría desactivar ese disparador, y una palabra
-- no lo vale.
-- =============================================================================

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('public.sync_celda_de_articulo(jsonb)'::regprocedure) into v_def;
  if position('(manda el Excel)' in v_def) > 0 then
    execute replace(v_def, '(manda el Excel)', '(prevalece el Excel)');
  end if;
end;
$$;

comment on function public.sync_celda_de_articulo(jsonb) is
  'Una celda de la hoja de bolsa. «Comprado» se cuadra contra las compras DE SU AÑO; «Stock Disponible», solo cuando prevalece el Excel, cuadra el saldo con un ajuste.';
