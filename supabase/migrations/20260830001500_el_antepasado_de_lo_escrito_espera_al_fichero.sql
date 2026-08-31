-- =============================================================================
-- El antepasado de una celda escrita espera a que el fichero exista
--
-- La instantánea guarda «lo que valía cada celda la última vez que esto salió
-- bien», y se escribía entera dentro de `sync_aplicar`. Para casi todas las
-- celdas está bien: son un hecho sobre el libro que se acaba de leer. Para las
-- que la pasada **escribe**, no, porque no son un hecho: son una promesa sobre
-- un libro que todavía no existe.
--
-- El orden real de una pasada es éste, y el fichero se genera **después** de que
-- la base haya hecho commit (`SincronizarExcel.tsx`: `aplicar()` y luego
-- `escribir()`):
--
--   1. entra en la base lo que venía del Excel;
--   2. se guarda la instantánea… incluidas las celdas que van a escribirse;
--   3. se generan los bytes del libro nuevo y se descargan;
--   4. alguien lo sube a SharePoint. A mano.
--
-- Si algo se cae entre el 2 y el 3 —o el navegador se cierra, o simplemente en
-- la pasada siguiente se vuelve a subir el libro de antes— la instantánea miente:
-- dice que el Excel vale A y el Excel vale V. Y con esa mentira la cuenta de la
-- fusión sale al revés: el Excel «cambió» de A a V y la base no se movió, luego
-- **manda el Excel** y la V entra en la base. La sincronización deshace el
-- trabajo de la aplicación, celda por celda, sin un aviso.
--
-- Así que esas celdas se guardan aparte y en el paso 3, junto al hash del
-- fichero que las hace ciertas. Si el fichero no llega a hacerse, no hay
-- antepasado, y la pasada siguiente vuelve a proponer las mismas escrituras —que
-- es exactamente lo que hay que hacer cuando el libro no se ha actualizado.
--
-- Queda un hueco que no se cierra desde aquí y conviene no fingir que sí: entre
-- el 3 y el 4 hay una persona. Si descarga el fichero y no lo sube, el
-- antepasado ya está guardado. Lo que hay contra eso es el aviso de la pantalla
-- cuando el libro que se sube no es el que salió de la última pasada, y es un
-- aviso, no un candado.
-- =============================================================================

create or replace function public.sync_apuntar_salida(
  p_parte_id bigint,
  p_sha256 text,
  p_instantanea jsonb default '[]'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb;
begin
  if auth_role() <> 'admin' then
    raise exception 'Solo un administrador puede cerrar una sincronización';
  end if;

  update sync_partes set salida_sha256 = p_sha256 where id = p_parte_id;

  -- Y ahora sí: el fichero existe, así que lo que dice es verdad.
  for r in select * from jsonb_array_elements(coalesce(p_instantanea, '[]'::jsonb)) loop
    insert into sync_celdas (hoja, ref, columna, valor_base, entidad, entidad_id)
    values (r->>'hoja', r->>'clave', r->>'columna', r->>'valor',
            nullif(r->>'entidad', ''), nullif(r->>'entidad_id', '')::uuid)
    on conflict (hoja, ref, columna) do update
      set valor_base = excluded.valor_base, at = now();
  end loop;
end $$;

comment on function public.sync_apuntar_salida(bigint, text, jsonb) is
  'Cierra la pasada: apunta el hash del libro que salió y guarda el antepasado de las celdas que ese libro escribe. Antes de que el fichero exista no se pueden guardar: dirían que el Excel vale algo que todavía no vale.';

revoke all on function public.sync_apuntar_salida(bigint, text, jsonb) from public, anon;
grant execute on function public.sync_apuntar_salida(bigint, text, jsonb) to authenticated;

-- La de dos argumentos se queda para no romper a un cliente viejo, y delega.
create or replace function public.sync_apuntar_salida(p_parte_id bigint, p_sha256 text)
returns void
language sql
security definer
set search_path = public
as $$ select public.sync_apuntar_salida(p_parte_id, p_sha256, '[]'::jsonb) $$;

revoke all on function public.sync_apuntar_salida(bigint, text) from public, anon;
grant execute on function public.sync_apuntar_salida(bigint, text) to authenticated;
