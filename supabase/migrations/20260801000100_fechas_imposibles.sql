-- =============================================================================
-- Ninguna incidencia resuelta en el futuro
--
-- El Historial amanecía encabezado por «Viernes, 27 de marzo de 2296»: dos
-- incidencias del CRAI con la resolución fechada doscientos setenta años en el
-- futuro. El origen es una errata del Excel («27-03-296», un nueve colado en
-- «26») que el importador de entonces «normalizó» sumando 2000 al año de tres
-- cifras, y lo dejó dicho en import_fixes — el rastro funcionó; la regla era
-- mala. El importador ya no adivina (reconstruye el año quitando el dígito que
-- sobra, o se niega), y el seed regenerable ya está corregido; esto arregla lo
-- que quedó escrito en las bases desplegadas.
--
-- La corrección conserva día, mes y hora y trae el año al de la apertura, que
-- es lo que la propia fila dice de sí misma (las dos abrieron el 27-03-2026 y
-- se resolvieron «el mismo día», que era lo tecleado). El tope con la apertura
-- evita fabricar una resolución anterior a ella. Y como todo lo que corrige
-- datos, deja su rastro en import_fixes: nada se corrige en silencio.
-- =============================================================================

do $$
declare v_arregladas integer;
begin
  with mal as (
    select id, external_ref, resolved_at
      from incidents
     where resolved_at is not null
       and extract(year from resolved_at) > extract(year from now()) + 1
  ),
  arreglo as (
    update incidents i
       set resolved_at = greatest(
             i.opened_at,
             i.resolved_at + make_interval(years =>
               (extract(year from i.opened_at) - extract(year from i.resolved_at))::int)
           )
      from mal m
     where i.id = m.id
    returning i.id, m.external_ref, m.resolved_at as antes, i.resolved_at as despues
  )
  insert into import_fixes (source, row_ref, field, original, corrected, reason)
  select 'migracion 20260801000100',
         coalesce(a.external_ref, a.id::text),
         'Fecha resuelta',
         to_char(a.antes,   'YYYY-MM-DD'),
         to_char(a.despues, 'YYYY-MM-DD'),
         'Año imposible corregido al de la apertura'
    from arreglo a;

  get diagnostics v_arregladas = row_count;
  raise notice 'Incidencias con la resolución fechada en un futuro imposible: % corregidas', v_arregladas;
end $$;
