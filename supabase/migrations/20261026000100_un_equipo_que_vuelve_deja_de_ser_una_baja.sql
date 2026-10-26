-- =============================================================================
-- Un equipo que volvió al aula deja de ser una baja
--
-- La hoja de inventario —la que se imprime y se archiva— decide si un equipo
-- sigue en la sala con `esBaja()`, y `esBaja()` mira dos cosas: el estado y la
-- fecha de baja. El estado lo arregla cualquiera; la fecha la publica esta
-- vista, y la publicaba mirando SOLO hacia atrás: el último `asset_events` de
-- tipo `baja` que tuviera el equipo, para siempre.
--
-- O sea que un equipo que se retiró y volvió —y vuelven: `sync_aplicar_equipo`
-- reactiva desde el libro el proyector que se quitó y se repuso, y una fusión
-- de duplicados mal decidida se deshace devolviendo el equipo a su sala—
-- quedaba instalado en la base, se veía en el aula, se contaba en la revisión…
-- y seguía saliendo del papel. La fila existía, el técnico la tenía delante en
-- el iPad, y el PDF de la sala no la traía. No hay peor forma de perder la
-- confianza en un inventario que esa: dos documentos del mismo sitio que no
-- dicen lo mismo, y ninguno que explique por qué.
--
-- La regla que faltaba es la que cualquiera diría en voz alta: **una baja
-- cuenta hasta que hay un alta posterior**. El historial ya lo sabía —el alta
-- de vuelta se apunta, con su fecha y su nota— y es lo único que hacía falta
-- mirar. Nada se borra: la baja sigue en `asset_events` y el histórico de la
-- sala la sigue contando. Lo que cambia es quién manda hoy.
--
-- El `case` del final se queda igual y por el mismo motivo de entonces:
-- `reject_asset` retira sin dejar evento, y ahí la única fecha que hay es la de
-- la propia fila.
--
-- Solo cambia el `left join lateral bj`. El resto de la vista es idéntico, y va
-- entero porque `create or replace view` no sabe sustituir media definición.
-- =============================================================================

create or replace view public.inventory_sheet as
select
  a.id                      as asset_id,
  b.id                      as building_id,
  b.code                    as building_code,
  b.name                    as building_name,
  b.sort_order              as building_sort,
  z.id                      as zone_id,
  z.name                    as zone_name,
  z.sort_order              as zone_sort,
  r.id                      as room_id,
  r.code                    as room_code,
  r.name                    as room_name,
  r.short_ref               as room_short_ref,
  lv.occurred_at            as room_last_inventory_at,
  -- Un salto de `merged_into`, el mismo que da `public.asset_type_id()`. Basta,
  -- y tiene que ser exactamente uno: `merge_asset_type` repunta todos los
  -- equipos al tipo bueno y exige que el destino no sea ya una lápida, así que
  -- la única forma de que un equipo apunte a una es que lo diera de alta un
  -- dispositivo con el catálogo viejo —el cliente deriva el id del tipo del
  -- nombre normalizado, uuid v5— y eso deja el tipo a un salto. Seguir la cadena
  -- más allá haría que el papel dijera un nombre distinto del que enseña la
  -- pantalla desde la que se imprimió, que es peor que quedarse corto.
  coalesce(tf.name, t.name) as type_name,
  a.label,
  a.brand,
  a.model,
  a.serial,
  a.status,
  a.confirmed,
  a.created_at              as alta_at,
  -- La fecha de cambio SOLO cuando hay cambio, que es lo que el cliente asume y
  -- lo que `updated_at` no puede decir sola: es `not null`, así que publicarla
  -- cruda hacía que la hoja imprimiera «Modificado» en TODAS las líneas y con la
  -- misma fecha que la columna «Alta». El relleno de arriba iguala `updated_at`
  -- a `created_at` en las 1.094 filas del parque, y un alta nueva sale igual
  -- porque los dos valores nacen del mismo instante. O sea que el papel firmado
  -- afirmaba que alguien había tocado equipos que nadie ha tocado nunca, y las
  -- ramas del hueco de `ultimoMovimiento`/`sinMovimientos` eran código
  -- inalcanzable con datos del servidor: solo se veían en la hoja del espejo.
  --
  -- «Igual que el alta» es la forma que tiene la base de decir «desde que se
  -- apuntó, no consta que nadie lo tocara», y aquí se traduce a lo único que el
  -- cliente sabe leer: NULL, que la hoja imprime como el hueco que es.
  --
  -- Con `>` y no con `nullif`: así una fila cuya fecha de cambio quedara POR
  -- DETRÁS del alta —un `created_at` puesto a mano, o del año que viene— tampoco
  -- inventa un cambio. Inventarlo es el fallo que se está arreglando.
  case
    when a.updated_at > a.created_at then a.updated_at
  end                       as cambio_at,
  -- La fecha de baja de la baja que sigue en pie —la que nadie deshizo con un
  -- alta posterior; ver el `left join lateral bj` de abajo—, con su caso raro.
  -- `reject_asset` retira un equipo sin
  -- dejar evento —es una propuesta descartada desde la bandeja, no un aparato
  -- que se muriera—, así que sin este `case` saldría en la hoja como una baja
  -- sin fecha: la peor de las dos mentiras posibles, porque parece un hueco de
  -- los que se rellenan preguntando y no lo es.
  --
  -- Es una aproximación y conviene saberlo: para los que ya estaban retirados
  -- antes de que `updated_at` existiera, la fecha es la del alta, y si alguien
  -- vuelve a tocar la fila después, se mueve con ella. Es lo único que la base
  -- sabe de un descarte que no dejó evento, y se dice tal cual; inventar una
  -- fecha de baja plausible sería fabricar justo el dato que se está pidiendo.
  coalesce(
    bj.occurred_at,
    case when a.status = 'retirado' then a.updated_at end
  )                         as baja_at,
  -- 'baja' o 'almacen'. Nulo en la baja que deja `fusionar_equipo_duplicado`,
  -- que retira un duplicado y no tiene destino que declarar: el aparato físico
  -- no se ha movido de la sala, era la fila la que sobraba. El motivo sí lo
  -- lleva, y es el que se lee en la hoja.
  bj.meta ->> 'destino'     as baja_destino,
  nullif(bj.meta ->> 'nota', '') as baja_motivo,
  -- Una retirada firmada y sin decidir todavía. El equipo SIGUE en la sala
  -- —eso es lo que se aprueba— y la hoja tiene que poder decir «pedida» en vez
  -- de contarlo como si ya no estuviera. Va como `exists` y no como `join`
  -- porque `asset_removals_pendiente_idx` es justo este índice, y porque un
  -- `join` a una tabla con varias solicitudes históricas duplicaría la fila.
  exists (
    select 1
      from asset_removals rm
     where rm.asset_id = a.id and rm.state = 'pendiente'
  )                         as retirada_pedida
from assets a
left join asset_types t  on t.id = a.asset_type_id
left join asset_types tf on tf.id = t.merged_into
-- Solo se pregunta por los que han perdido la sala: para el resto la respuesta
-- ya está en la fila, y el `where` de dentro deja el lateral vacío sin tocar
-- `asset_events`.
left join lateral (
  select e.room_id
    from asset_events e
   where a.room_id is null
     and e.asset_id = a.id
     and e.room_id is not null
   order by e.occurred_at desc, e.recorded_at desc
   limit 1
) ev on true
join rooms r     on r.id = coalesce(a.room_id, ev.room_id)
join zones z     on z.id = r.zone_id
join buildings b on b.id = z.building_id
-- La baja se busca por `kind` y no se supone del estado: un equipo puede estar
-- retirado sin evento (arriba) y puede tener eventos posteriores a su baja.
--
-- Y solo cuenta la baja que NADIE deshizo: un `alta` posterior es el equipo
-- volviendo a la sala, y a partir de ahí la baja es historia y no estado. Sin
-- el `not exists`, un equipo reactivado —por el libro, o al deshacer una fusión
-- equivocada— salía de la hoja impresa para siempre aunque estuviera instalado
-- y a la vista de todos.
--
-- El desempate es el par `(occurred_at, recorded_at)` y no `occurred_at` solo:
-- los dos eventos pueden caer en el mismo instante —una corrección que retira y
-- vuelve a dar de alta en la misma transacción— y entonces el que manda es el
-- que se apuntó después, que es justo lo que `recorded_at` guarda.
left join lateral (
  select e.occurred_at, e.meta
    from asset_events e
   where e.asset_id = a.id and e.kind = 'baja'
     and not exists (
       select 1
         from asset_events vu
        where vu.asset_id = a.id
          and vu.kind = 'alta'
          and (vu.occurred_at, vu.recorded_at) > (e.occurred_at, e.recorded_at)
     )
   order by e.occurred_at desc, e.recorded_at desc
   limit 1
) bj on true
-- Cuándo se levantó el inventario de esa sala. Va en cada fila porque encabeza
-- la hoja impresa: sin esa fecha, un papel con tres equipos no se distingue de
-- un aula que nadie ha mirado nunca.
left join lateral (
  select v.occurred_at
    from room_inventories v
   where v.room_id = r.id
   order by v.occurred_at desc
   limit 1
) lv on true;

-- Sin esto la vista se ejecutaría con los privilegios de su propietario, que
-- tiene BYPASSRLS, y PostgREST publica las vistas igual que las tablas: el
-- inventario entero quedaría legible con cualquier token, o sin ninguno. Es la
-- misma línea que llevan todas las vistas del proyecto y el motivo está contado
-- en `20260728000200_views.sql`.
alter view public.inventory_sheet set (security_invoker = on);

comment on view public.inventory_sheet is
  'Una fila por equipo con su sala, sus fechas de alta, cambio y baja, y si tiene una retirada pedida. Conserva los equipos que perdieron la sala al irse al almacén, y no cuenta como baja la que un alta posterior deshizo.';

-- El grant se repite por lo mismo que se repite el `security_invoker`: una vista
-- recreada conserva los suyos, pero una base que nunca llegó a aplicar
-- `20260806000200` entera no tendría ninguno, y el fallo saldría en el iPad
-- como un 401 que parece de sesión.
grant select on public.inventory_sheet to authenticated;

notify pgrst, 'reload schema';
