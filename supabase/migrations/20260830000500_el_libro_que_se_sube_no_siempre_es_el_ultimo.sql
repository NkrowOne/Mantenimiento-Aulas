-- =============================================================================
-- Avisar cuando el libro que se sube no es el que salió de la última pasada
--
-- Es el accidente más fácil de cometer y el único de esta lista que no deja
-- rastro: alguien abre la carpeta de descargas, ve tres copias del mismo libro y
-- sube la de antes de ayer.
--
-- La instantánea protege de casi todo, pero no de esto. Su regla es «si solo
-- cambió un lado, ese lado manda», y un fichero viejo **parece un lado que
-- cambió**: sus celdas no coinciden con el antepasado que dejó la última pasada,
-- así que la fusión concluye —correctamente, según lo que sabe— que alguien las
-- editó en el Excel, y las mete en la base. El resultado es que una semana de
-- trabajo hecho en la aplicación se revierte sin un solo error, sin un solo
-- conflicto, y sin que nada en la pantalla lo insinúe.
--
-- Se resuelve apuntando el hash del libro **que la pasada produjo**. Con eso, la
-- vez siguiente se puede contestar la única pregunta que importa: ¿es éste el
-- que salió de aquí? Si no lo es, no se prohíbe nada —puede haber un motivo, y
-- decidir por la persona sería peor— pero se dice antes de aplicar, que es
-- cuando todavía se puede parar.
-- =============================================================================

alter table sync_partes add column if not exists salida_sha256 text;

comment on column sync_partes.salida_sha256 is
  'El hash del libro que produjo esta pasada. Es lo que permite avisar de que el fichero que se está subiendo no es el que salió de la última: un libro viejo se parece a un lado que cambió, y la fusión lo metería en la base sin dar un solo error.';

/**
 * Apunta qué libro salió de una pasada.
 *
 * Va aparte de `sync_aplicar` porque el fichero se escribe **después** de que la
 * base esté escrita, y a propósito: si el orden fuera el contrario y la base
 * fallara, el libro diría cosas que la base no sabe.
 */
create or replace function public.sync_apuntar_salida(p_parte_id bigint, p_sha256 text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth_role() <> 'admin' then
    raise exception 'Solo un administrador puede cerrar una sincronización';
  end if;
  update sync_partes set salida_sha256 = p_sha256 where id = p_parte_id;
end $$;

/**
 * El libro que salió de la última pasada que llegó a producir uno.
 *
 * Se salta las pasadas que se aplicaron y no se descargaron —el navegador se
 * cerró, alguien canceló—: de ésas no hay fichero con el que comparar, y
 * tomarlas por referencia haría saltar el aviso siempre.
 */
create or replace function public.sync_ultima_salida()
returns table (parte_id bigint, sha256 text, cuando timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select id, salida_sha256, coalesce(termino_at, comenzo_at)
    from sync_partes
   where salida_sha256 is not null
   order by id desc
   limit 1
$$;

revoke all on function public.sync_apuntar_salida(bigint, text) from public;
grant execute on function public.sync_apuntar_salida(bigint, text) to authenticated;
grant execute on function public.sync_ultima_salida() to authenticated;
