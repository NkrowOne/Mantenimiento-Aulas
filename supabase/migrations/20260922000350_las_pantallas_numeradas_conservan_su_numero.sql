-- =============================================================================
-- «Pantalla 2» tiene que acabar en «TV 2», no en «TV 3»
--
-- `relabel_assets_of_type` es lo que lleva el nombre nuevo de un tipo hasta las
-- etiquetas de las aulas: cuando «Pantalla» pasa a llamarse «TV», lo que en la
-- sala ponía «Pantalla» pasa a poner «TV». Con una pantalla por aula eso es
-- exacto. Con tres, no:
--
--     lo que había            lo que salía
--     Pantalla     SCR001  →  TV 3
--     Pantalla 2   SCR002  →  TV 2
--     Pantalla 3   SCR003  →  TV
--
-- El conjunto es el bueno —TV, TV 2 y TV 3, sin repetirse—, pero el número se
-- ha barajado. Y el número es lo ÚNICO que distingue una pantalla de otra
-- cuando alguien entra al aula a mirar cuál es la que no enciende: un parte que
-- decía «la 2 no da señal» pasa a señalar otro aparato, y nadie se entera
-- porque las tres siguen ahí y con nombres correctos.
--
-- Pasaba porque pedía el siguiente número LIBRE en vez de conservar el que la
-- etiqueta ya traía. `next_asset_label` está para lo contrario —colocar un
-- equipo nuevo donde no choque—, y aquí los equipos no son nuevos. El orden
-- del bucle no lo salva: las tres pantallas entraron el mismo día con el mismo
-- `created_at`, así que desempata el `id`, que es un uuid.
--
-- Ahora el sufijo se conserva tal cual. Si el nombre que sale ya estuviera
-- cogido —un aula con «Pantalla 2» y además una «TV 2» de antes— lo recoloca
-- `assets_label_libre` como siempre, que además deja el apunte en la bandeja
-- de duplicados; ahí sí hay un choque de verdad que alguien tiene que mirar.
--
-- Por qué va numerada ANTES de `20260922000400`: aquella es la que renombra
-- «Pantalla» a «TV» y «Ordenador Tiny» a «Ordenador», y el servidor todavía no
-- la ha aplicado. Las migraciones corren por orden de nombre de fichero, así
-- que esta entra primero y aquella ya conserva los números. Donde ya se haya
-- aplicado, esto no deshace nada —el número viejo no está guardado en ningún
-- sitio— pero deja bien el renombrado siguiente.
-- =============================================================================

create or replace function public.relabel_assets_of_type(
  p_type uuid,
  p_old  text,
  p_new  text
)
returns integer
language plpgsql
as $$
declare
  a record;
  v_old text := public.norm_text(p_old);
  v_sufijo text;
  v_n integer := 0;
begin
  if v_old = '' or v_old = public.norm_text(p_new) then
    return 0;
  end if;

  for a in
    select id, label
      from assets
     where asset_type_id = p_type
       and room_id is not null
       and label is not null
       and status <> 'retirado'
       and (
         public.norm_text(label) = v_old
         or (
           starts_with(public.norm_text(label), v_old || ' ')
           and substr(public.norm_text(label), length(v_old) + 2) ~ '^[0-9]+$'
         )
       )
     order by created_at, id
  loop
    -- El número que ya traía, si traía alguno. El `where` de arriba garantiza
    -- que o está vacío o son solo dígitos, así que no hace falta comprobarlo.
    v_sufijo := substr(public.norm_text(a.label), length(v_old) + 2);

    update assets
       set label = btrim(p_new) ||
                   case when v_sufijo = '' then '' else ' ' || v_sufijo end
     where id = a.id;
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

comment on function public.relabel_assets_of_type(uuid, text, text) is
  'Propaga el nombre nuevo de un tipo a las etiquetas que lo copiaban, conservando su número. Respeta las escritas a mano.';

notify pgrst, 'reload schema';
