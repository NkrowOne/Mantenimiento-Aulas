-- reejecutable: si
--
-- Los dos bloques `do` miran cómo está la base antes de tocar nada: el primero
-- solo reapunta `separado_de` si todavía apunta a un tipo vacío, y el segundo
-- solo retira lo que sigue instalado. La segunda pasada no toca ni una fila.
-- Hace falta declararlo porque la deducción automática rechaza cualquier `do`
-- de nivel raíz.
-- =============================================================================
-- El monitor del PC sale del «TV», y Teams deja de ser un aparato
--
-- Las dos cosas salen de la misma mesa: mirar el inventario de verdad —3.585
-- aparatos, 23 tipos— cruzado con el libro.
--
-- ## 1. 67 monitores de PC contados como TV
--
-- De los 68 números de serie de la columna «S/N Monitor», **67 ya están en la
-- aplicación, puestos en equipos de tipo «TV»**. Solo uno falta de verdad. Por
-- eso «TV» tiene 371 aparatos y TVs de verdad hay 186.
--
-- Viene de la importación: `asset_type_id('Monitor')` resolvía a «Pantalla»
-- —«monitor» era uno de sus alias— igual que `asset_type_id('TV')`, así que las
-- dos columnas del libro entraron en el mismo tipo. `20260830000100` separó
-- «TV» y «Monitor» de «Pantalla», y `20260901000100` enseñó a
-- `sync_aplicar_equipo` a deshacer la mezcla: si el libro reclama un número de
-- serie en su columna y el aparato que lo lleva es del tipo del que el suyo se
-- separó, se le devuelve el tipo.
--
-- Esa regla no se ha disparado ni una vez, por dos motivos, y los dos se
-- arreglan aquí y en la misma tanda que el cliente:
--
--  a) La celda no llegaba. La pregunta de «equipo nuevo» la retenía —el aula no
--     tiene ningún «Monitor», luego parecía un alta— y se la comía antes de que
--     el servidor pudiera mirarla. Eso es lo que cambia en `sincronizar.ts`.
--
--  b) `Monitor.separado_de` apunta a «Pantalla», y «Pantalla» ya no tiene ni un
--     aparato: los suyos están hoy en «TV», que salió de ella por la misma
--     puerta. Los monitores de PC viajaron con ellos. Así que el tipo del que
--     «Monitor» tiene que salir ya no es «Pantalla»: es «TV». Eso es el bloque
--     de abajo.
--
-- No se tocan aquí los 67 aparatos. Los mueve la sincronización, uno a uno, con
-- el libro delante diciendo cuál va en qué columna y dejando su `asset_event`.
-- Una migración que moviera 67 filas a ojo estaría adivinando justo lo que el
-- libro sabe.
--
-- ## 2. «Teams actualizado» y «Zoom actualizado» no son aparatos
--
--     tipo                  fichas   con modelo o nº de serie
--     Teams actualizado        303              0
--     Zoom actualizado         292              0
--
-- Ninguna, y no por dejadez: no hay nada que apuntar. No son cosas que se
-- puedan señalar con el dedo, son un estado del puesto. Puestos como aparatos
-- no se podían contestar «falla» —el inventario no tiene esa casilla— y
-- llenaban la ficha de cada aula con dos renglones que no dicen nada.
--
-- Pasan a ser comprobaciones de la sala, al lado de «Red», que ya lo era: la
-- revisión pregunta correcto / falla / no aplica y lo que pasa va en la
-- observación. Aquí solo se retiran las fichas.
--
-- Los tipos NO se borran: `inspection_checks` apunta a esos `assets` y las
-- revisiones viejas tienen que poder seguir leyéndose enteras. Retirados no
-- salen del inventario del aula ni de la hoja «Inventario por Sala» —las dos
-- filtran por `instalado`— que es lo que se pedía.
-- =============================================================================

do $separacion$
declare
  t        record;
  v_padre  uuid;
  v_nieto  uuid;
  v_n      integer := 0;
begin
  /*
   * Donde está hoy la mezcla, no donde estaba cuando se separó.
   *
   * La regla, general y sin nombres propios: si un tipo dice haberse separado
   * de otro que ya está vacío, y de ese otro salió además un hermano que sí
   * tiene aparatos, entonces la mezcla se fue con el hermano. Es ahí donde hay
   * que ir a buscar los suyos.
   *
   * Un solo hermano con aparatos, o no se toca: con dos no se sabría en cuál de
   * los dos está cada uno, y elegir sería inventar.
   */
  for t in
    select id, name, separado_de from asset_types
     where separado_de is not null and merged_into is null
  loop
    v_padre := t.separado_de;

    -- El padre sigue teniendo aparatos: la regla de siempre vale, no se toca.
    if exists (select 1 from assets a
                where a.asset_type_id = v_padre and a.status <> 'retirado') then
      continue;
    end if;

    select h.id into v_nieto
      from asset_types h
     where h.separado_de = v_padre
       and h.id <> t.id
       and h.merged_into is null
       and exists (select 1 from assets a
                    where a.asset_type_id = h.id and a.status <> 'retirado')
     limit 2;

    if v_nieto is null then continue; end if;
    if (select count(*) from asset_types h
         where h.separado_de = v_padre and h.id <> t.id and h.merged_into is null
           and exists (select 1 from assets a
                        where a.asset_type_id = h.id and a.status <> 'retirado')) <> 1 then
      continue;
    end if;

    update asset_types set separado_de = v_nieto where id = t.id;
    v_n := v_n + 1;
    raise notice '«%» pasa a buscar los suyos dentro de «%», que es donde acabó la mezcla.',
      t.name, (select name from asset_types where id = v_nieto);
  end loop;

  if v_n = 0 then
    raise notice 'Separaciones: nada que reapuntar.';
  end if;
end
$separacion$;

do $estados$
declare
  v_n integer := 0;
begin
  /*
   * Fuera del inventario, pero con su apunte.
   *
   * `retirado` no es exacto —nunca fueron un aparato que se pudiera retirar—
   * pero es el único estado que los saca de la ficha del aula sin romper las
   * revisiones que los comprobaron. El `asset_event` dice por qué, que es lo
   * que alguien va a querer leer dentro de un año.
   */
  with fuera as (
    update assets a
       set status = 'retirado'
      from asset_types t
     where t.id = a.asset_type_id
       and a.status <> 'retirado'
       and public.norm_text(t.name) in (
             public.norm_text('Teams actualizado'), public.norm_text('Zoom actualizado'),
             public.norm_text('Teams'),             public.norm_text('Zoom'))
    returning a.id, a.room_id, t.name
  )
  insert into asset_events (id, asset_id, room_id, kind, occurred_at, by_user, meta)
  select gen_random_uuid(), f.id, f.room_id, 'baja', now(), null,
         jsonb_build_object(
           'source', 'migracion',
           'nota', 'no es un aparato: pasa a ser una comprobación de la revisión',
           'tipo', f.name)
    from fuera f;
  get diagnostics v_n = row_count;

  -- Y el equipamiento por defecto, o la próxima sala nueva los vuelve a crear.
  delete from asset_defaults d
   using asset_types t
   where t.id = d.asset_type_id
     and public.norm_text(t.name) in (
           public.norm_text('Teams actualizado'), public.norm_text('Zoom actualizado'),
           public.norm_text('Teams'),             public.norm_text('Zoom'));

  if v_n > 0 then
    raise notice 'Teams y Zoom dejan de ser aparatos: % fichas retiradas.', v_n;
  else
    raise notice 'Teams y Zoom: no había ninguna ficha instalada. Nada que retirar.';
  end if;
end
$estados$;

notify pgrst, 'reload schema';
