-- =============================================================================
-- Índice de fiabilidad por sala y detección de reincidencia
--
-- Las dos piezas que el prototipo enseña en la ficha de sala y que aquí no
-- existían. Todo se calcula **con SQL, de forma determinista y auditable**:
-- cualquier cifra que salga en pantalla se puede rastrear hasta los registros
-- concretos de los que sale. Ninguna recomendación aparece sin poder explicarse.
--
-- Aviso que conviene no perder: con la base recién arrancada esto no dice nada
-- útil hasta acumular unos meses de revisiones e incidencias. Por eso las vistas
-- publican también **con cuántos registros** están hablando, y la interfaz dice
-- «datos insuficientes» en vez de inventar una conclusión sobre dos filas.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Fiabilidad
--
-- Se parte de 100 y se descuenta. Tres factores, y cada uno está por un motivo:
--
--   tipo      Una SOLICITUD no penaliza en absoluto: pedir que instalen una
--             cámara no es un fallo de la sala. Una OBSERVACIÓN pesa un cuarto:
--             es una nota de seguimiento, no una avería. Si las tres contaran
--             igual, las salas más vigiladas saldrían como las peores solo por
--             estar bien atendidas, y el ranking premiaría no registrar nada.
--   gravedad  Lo que impide dar la clase no puede pesar como lo molesto.
--   vigencia  Un mal semestre de hace dos años no puede marcar a una sala para
--             siempre. Se desvanece linealmente a lo largo de un año.
--
-- Los borradores no puntúan: todavía no se sabe qué son.
-- -----------------------------------------------------------------------------
create view room_reliability as
with penalizacion as (
  select
    i.room_id,
    case i.kind
      when 'incidencia'  then 1.0
      when 'observacion' then 0.25
      else 0.0                      -- solicitud: trabajo pedido, no un fallo
    end
    * case i.severity when 'alta' then 3.0 when 'media' then 2.0 else 1.0 end
    * greatest(
        0.0,
        1.0 - extract(epoch from (now() - i.opened_at)) / (365 * 86400)
      ) as puntos,
    i.kind
  from incidents i
  where i.state <> 'borrador'
    and i.opened_at > now() - interval '1 year'
),
agregado as (
  select
    room_id,
    coalesce(sum(puntos), 0)                                  as puntos,
    count(*) filter (where kind = 'incidencia')::int          as incidencias,
    count(*) filter (where kind = 'observacion')::int         as observaciones,
    count(*) filter (where kind = 'solicitud')::int           as solicitudes
  from penalizacion
  group by room_id
),
revisiones as (
  select room_id, count(*)::int as n
  from inspections
  where status = 'completa' and occurred_at > now() - interval '1 year'
  group by room_id
)
select
  r.id                                                        as room_id,
  -- El 6 es el factor de escala: una avería grave de hoy cuesta 18 puntos, así
  -- que hacen falta unas seis para agotar el marcador. Está elegido para que el
  -- número se mueva de forma legible, no para acertar una verdad absoluta.
  greatest(0, 100 - round(coalesce(a.puntos, 0) * 6))::int     as score,
  coalesce(a.incidencias, 0)                                  as incidencias,
  coalesce(a.observaciones, 0)                                as observaciones,
  coalesce(a.solicitudes, 0)                                  as solicitudes,
  coalesce(v.n, 0)                                            as revisiones,
  -- Con qué está hablando. Sin esto, un 100 de una sala nunca revisada se lee
  -- como «va perfecta» cuando lo que dice es «no sé nada de ella».
  (coalesce(v.n, 0) + coalesce(a.incidencias, 0) + coalesce(a.observaciones, 0)) >= 3
                                                              as hay_datos
from rooms r
left join agregado a  on a.room_id = r.id
left join revisiones v on v.room_id = r.id
where r.active;

alter view room_reliability set (security_invoker = on);

-- -----------------------------------------------------------------------------
-- Reincidencia
--
-- El hallazgo más rentable de vuestros datos: en el Excel, «no duplica la imagen
-- en el monitor» aparece decenas de veces, y la resolución es casi siempre
-- sustituir el cable HDMI. Cuando una misma sala repite el mismo consumo, poner
-- la pieza otra vez no es la respuesta — es la pregunta.
--
-- Se agrupa por **artículo de almacén consumido**, no por el texto del problema.
-- El texto es libre y cada uno lo escribe distinto; el material consumido es un
-- identificador. Es lo que hace que esto sea determinista y no un adivino.
-- -----------------------------------------------------------------------------
create view room_repeat_offenders as
select
  i.room_id,
  im.stock_item_id,
  si.name                       as item,
  count(*)::int                 as veces,
  min(i.opened_at)              as desde,
  max(i.opened_at)              as hasta,
  -- Los identificadores de los registros que sustentan el aviso. Sin esto, la
  -- recomendación no se puede abrir, y una recomendación que no se puede
  -- comprobar no debería mostrarse.
  array_agg(i.id order by i.opened_at desc) as incidencias
from incidents i
join incident_materials im on im.incident_id = i.id
join stock_items si        on si.id = im.stock_item_id
where i.kind = 'incidencia'
  and i.state <> 'borrador'
  and i.opened_at > now() - interval '6 months'
group by i.room_id, im.stock_item_id, si.name
-- Dos veces es coincidencia; tres es un patrón. Avisar a la segunda llenaría la
-- ficha de ruido y enseñaría al equipo a ignorar el aviso.
having count(*) >= 3;

alter view room_repeat_offenders set (security_invoker = on);

notify pgrst, 'reload schema';
