-- reejecutable: si
--
-- Su bloque `do` solo renombra lo que todavía no se llama así: el `where` exige
-- que la etiqueta sea distinta de la que se le va a poner, de modo que la
-- segunda pasada no toca ni una fila. Hace falta declararlo porque la deducción
-- automática rechaza cualquier `do` de nivel raíz, y bien rechazado está.
-- =============================================================================
-- El aula de informática no son treinta ordenadores: son treinta puestos
--
-- `20260922000400` dejó la pregunta del Ideacentre abierta y la respuesta llegó
-- con un matiz que lo cambia todo: son ordenadores, sí, pero NO son Tinys, y no
-- van en la columna «S/N Ordenador» del libro, que es la del Tiny —el ordenador
-- del profesor, uno por aula—.
--
-- Los treinta Ideacentre están todos en la misma sala, «Laboratorio informatica
-- 6», y son los puestos de los alumnos. Lo que les faltaba era llamarse por lo
-- que son: la aplicación los tenía como «Ideacentre», «Ideacentre 2»,
-- «Ideacentre 3»… —el número lo puso el disparador `assets_label_libre` para
-- que no chocaran, no porque signifique nada— así que el nombre no decía en qué
-- sitio del aula está cada máquina, que es lo único que alguien necesita saber
-- cuando entra a arreglar una.
--
-- Ahora el Tiny es «Puesto profe» y los Ideacentre van del 1 al 30.
--
-- Lo que NO se toca: el tipo. El Tiny sigue siendo «Ordenador» y el Ideacentre
-- sigue siendo «Ordenador Lenovo Ideacentre», que es lo que impide que los
-- treinta se cuelen en la celda del libro donde solo cabe el del profesor.
--
-- El número, dicho claro: sale del NÚMERO DE SERIE, no de dónde está
-- físicamente cada mesa. Eso la base no lo sabe y no hay forma de que lo sepa.
--
-- Se ordena por serie y no por fecha de importación porque treinta máquinas
-- que entraron el mismo día tienen todas la misma fecha, y entonces desempata
-- el `id`, que es un uuid: un orden perfectamente estable y perfectamente sin
-- sentido. Las series sí suelen ir seguidas —se compran juntas y se instalan
-- en fila—, así que es la apuesta que más veces va a acertar.
--
-- Es un reparto estable y completo: ningún puesto se queda sin número y
-- ninguno se repite. Si la numeración no coincide con el aula, renombrar uno
-- suelto desde la ficha del aula es una línea de trabajo, no treinta.
-- =============================================================================

do $puestos$
declare
  v_profes  int := 0;
  v_puestos int := 0;
begin
  /*
   * Solo las aulas que tengan Ideacentres.
   *
   * El Tiny está en las 276 salas: es el ordenador del profesor en todas. Pero
   * «Puesto profe» solo significa algo donde hay puestos de alumnos enfrente,
   * y llamarlo así en un aula normal sería peor que el nombre de ahora.
   */
  with aulas as (
    select distinct a.room_id
      from assets a
      join asset_types t on t.id = a.asset_type_id
     where a.room_id is not null
       and a.status <> 'retirado'
       and public.norm_text(t.name) = public.norm_text('Ordenador Lenovo Ideacentre')
  )
  update assets a
     set label = 'Puesto profe'
    from aulas u
    join asset_types t on public.norm_text(t.name) = public.norm_text('Ordenador')
   where a.room_id = u.room_id
     and a.asset_type_id = t.id
     and a.status <> 'retirado'
     and a.label is distinct from 'Puesto profe';
  get diagnostics v_profes = row_count;

  /*
   * Y los puestos, numerados de una vez.
   *
   * Todas las etiquetas nuevas son distintas entre sí y ninguna existe todavía,
   * así que `assets_label_libre` las deja pasar tal cual: ese disparador solo
   * recoloca lo que choca, y aquí no choca nada. La prueba lo comprueba nombre
   * a nombre, porque si algo chocara no fallaría —se renumeraría en silencio—,
   * que es la forma más cara de equivocarse.
   */
  with numerados as (
    select a.id,
           row_number() over (partition by a.room_id
                              order by a.serial nulls last, a.created_at, a.id) as n
      from assets a
      join asset_types t on t.id = a.asset_type_id
     where a.room_id is not null
       and a.status <> 'retirado'
       and public.norm_text(t.name) = public.norm_text('Ordenador Lenovo Ideacentre')
  )
  update assets a
     set label = 'Puesto ' || m.n
    from numerados m
   where a.id = m.id
     and a.label is distinct from 'Puesto ' || m.n;
  get diagnostics v_puestos = row_count;

  if v_profes + v_puestos > 0 then
    raise notice 'Aula de informática: % del profesor y % puestos numerados.', v_profes, v_puestos;
  end if;
end
$puestos$;

notify pgrst, 'reload schema';
