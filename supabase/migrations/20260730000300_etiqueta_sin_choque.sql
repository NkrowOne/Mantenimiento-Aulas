-- =============================================================================
-- Dos «Pantalla 2» ya no rechazan el trabajo: se recolocan
--
-- El síntoma, tal cual sale en el iPad:
--
--   1 rechazados. Avisa a administración.
--   409: duplicate key value violates unique constraint "assets_room_label_idx"
--
-- Es un equipo dado de alta en un aula que se queda **atascado para siempre** en
-- la cola de salida. El técnico no puede hacer nada —el mensaje le manda avisar
-- a administración— y administración tampoco: la fila está en el dispositivo de
-- otra persona.
--
-- Y la causa no es un error de nadie. La etiqueta la calcula el cliente con
-- `nextLabel()` sobre su espejo local, y ese espejo puede tener minutos u horas:
--
--  - Un administrador aplica el equipamiento por defecto y el servidor crea
--    «Pantalla» y «Pantalla 2» en 276 aulas. El iPad todavía no lo sabe, así que
--    al añadir una pantalla calcula «Pantalla 2» — que allí ya existe.
--  - O dos técnicos sin cobertura añaden el mismo aparato en la misma aula la
--    misma mañana. Los dos calculan «Pantalla 2» sobre lo que cada uno tiene.
--
-- En los dos casos el número está mal y el APARATO está bien: existe, alguien lo
-- tenía delante. Rechazar la fila entera por el sufijo es tirar el dato para
-- proteger la etiqueta, y es exactamente al revés.
--
-- El índice único se queda —dos etiquetas iguales en una sala harían la revisión
-- ilegible, que es el problema que vino a resolver—. Lo que cambia es quién
-- resuelve el choque: en vez de devolver un 409 que nadie puede atender, el
-- servidor le da a la fila la siguiente etiqueta libre y la guarda.
--
-- Es la misma regla que ya aplica `next_asset_label` en el equipamiento por
-- defecto y en el renombrado global. Aquí se convierte en la última palabra: el
-- cliente propone el número y el servidor, que es el único que ve la sala
-- entera, lo corrige si hace falta.
-- =============================================================================

create or replace function public.assets_label_libre()
returns trigger
language plpgsql
as $$
declare
  v_base text;
begin
  -- Solo puede chocar lo que el índice mira: en una sala, con etiqueta y sin
  -- retirar. Todo lo demás sale por aquí sin tocar nada.
  if new.room_id is null or new.label is null or new.status = 'retirado' then
    return new;
  end if;

  if not exists (
    select 1
      from assets a
     where a.room_id = new.room_id
       and a.id <> new.id
       and a.status <> 'retirado'
       and a.label is not null
       and public.norm_text(a.label) = public.norm_text(new.label)
  ) then
    return new;
  end if;

  -- Choca. Se recoloca sobre la MISMA base, no sobre la etiqueta entera:
  -- «Pantalla 2» vuelve a ser «Pantalla» y se le busca el siguiente número
  -- libre, así que acaba en «Pantalla 3» y no en «Pantalla 2 2».
  v_base := regexp_replace(btrim(new.label), '\s+[0-9]+$', '');
  if v_base = '' then
    v_base := btrim(new.label);
  end if;

  new.label := public.next_asset_label(new.room_id, v_base, new.id);
  return new;
end;
$$;

comment on function public.assets_label_libre() is
  'Recoloca la etiqueta de un equipo cuando choca en su sala, en vez de rechazar la fila.';

drop trigger if exists assets_label_libre on assets;
-- Después de `assets_confirmed_guard` por orden alfabético, y da igual: uno
-- mira `confirmed` y el otro `label`.
create trigger assets_label_libre
  before insert or update on assets
  for each row execute function public.assets_label_libre();

notify pgrst, 'reload schema';
