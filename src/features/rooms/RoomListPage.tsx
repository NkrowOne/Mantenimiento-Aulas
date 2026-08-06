import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { FilaConAcciones } from '@/components/FilaConAcciones'
import { InsigniaAveria, detalleDeAverias } from '@/components/InsigniaAveria'
import { db } from '@/db/dexie'
import { displayRoomCode } from '@/domain/normalize'
import { OVERDUE_INSPECTION_DAYS, type Building, type Role, type Room } from '@/domain/types'
import { HojaDeMaestro, type ObjetoDeMaestro } from './HojaDeMaestro'
import { averiasPorSala } from './averias'
import {
  ROOM_ORDER_LABELS,
  daysSince,
  roomMatches,
  sortRooms,
  type RoomOrder,
} from './orden'

interface Props {
  building: Building
  onPick: (room: Room) => void
  onBack: () => void
  /** Abrir la hoja de placas imprimibles de este edificio. */
  onPlacas: () => void
  /** Abrir la hoja de inventario de este edificio, lista para guardar como PDF. */
  onInventario: () => void
  order: RoomOrder
  onOrderChange: (order: RoomOrder) => void
  /**
   * El rol llega entero y `esAdmin` se deriva dentro, igual que en `StockPage` y
   * `ReportsPage`: quien decide qué se puede tocar es una sola línea de este
   * fichero, no siete llamadas del padre que podrían discrepar entre sí.
   *
   * Es una puerta cosmética, y conviene tenerlo claro: la de verdad es
   * `is_admin()` dentro de cada función del servidor. Esto solo evita enseñar a
   * un técnico botones que el servidor le va a rechazar.
   */
  role: Role
}

/** Lo que hay abierto encima de la lista, si hay algo. */
type Hoja = ObjetoDeMaestro | { tipo: 'nueva-sala' }

/**
 * Lista de salas: la ruta de trabajo del día.
 *
 * Dos cosas la hacen usable con 39 salas en un edificio y 276 en total:
 * **se puede buscar** y **se puede elegir el orden**. Antes solo había un orden
 * fijo y ningún filtro, así que llegar a un aula concreta —el caso de «falla el
 * proyector del −2.1 del H», que llega por radio— era bajar leyendo fila a fila.
 */
export function RoomListPage({
  building,
  onPick,
  onBack,
  onPlacas,
  onInventario,
  order,
  onOrderChange,
  role,
}: Props): React.ReactElement {
  const [query, setQuery] = useState('')
  const esAdmin = role === 'admin'

  /*
   * La hoja abierta NO entra en `RoomView`.
   *
   * La vista se persiste en `db.meta['ultima-vista']` para poder devolver al
   * técnico donde estaba tras una recarga, y restaurar una hoja de acciones
   * significaría reabrirla sobre una fila que quizá ya no existe —la sala que se
   * acababa de dar de baja, por ejemplo—. Lo que merece sobrevivir a una recarga
   * es dónde estás, no qué menú tenías desplegado.
   */
  const [hoja, setHoja] = useState<Hoja | null>(null)

  /*
   * Una sola consulta, y por índice.
   *
   * Eran dos, y las dos leían las zonas del edificio. Y `db.rooms.filter()` no
   * es un `where`: deserializa las 276 salas y ejecuta la lambda sobre cada una
   * teniendo el índice `zone_id` delante.
   */
  const datos = useLiveQuery(async () => {
    const zonas = await db.zones.where('building_id').equals(building.id).toArray()
    const ids = zonas.map((z) => z.id)
    return {
      zones: new Map(zonas.map((z) => [z.id, z])),
      rooms: await db.rooms.where('zone_id').anyOf(ids).toArray(),
    }
  }, [building.id])

  const zones = datos?.zones
  const rooms = datos?.rooms

  const drafts = useLiveQuery(
    () => db.inspections.where('status').equals('borrador').toArray(),
    [],
  )
  const draftRoomIds = useMemo(
    () => new Set((drafts ?? []).map((d) => d.room_id)),
    [drafts],
  )

  /*
   * Las averías vivas, para el triángulo de cada fila.
   *
   * Del espejo entero y no solo de este edificio: el espejo únicamente guarda
   * lo no resuelto —unas decenas de filas— y filtrarlas por sala aquí costaría
   * más índice del que ahorra. La regla de qué cuenta vive en `averias.ts`,
   * que es la misma que aplica el servidor en `room_overview`.
   */
  const incidencias = useLiveQuery(() => db.incidents.toArray(), [])
  const averias = useMemo(() => averiasPorSala(incidencias ?? []), [incidencias])

  const visible = useMemo(() => {
    if (!rooms || !zones) return []
    const filtered = rooms.filter((r) => roomMatches(r, query, zones.get(r.zone_id)?.name))
    return sortRooms(filtered, zones, order)
  }, [rooms, zones, order, query])

  const cargando = rooms === undefined || zones === undefined

  return (
    <div>
      <header className="border-b border-line bg-surface px-4 pb-3 pt-2">
        <button type="button" onClick={onBack} className="-ml-2 min-h-11 px-2 text-sm text-accent">
          ← Edificios
        </button>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{building.name}</h1>
          {/* Se envuelve. Con el tercer botón la fila ya no cabe en un iPhone
              —«+ Sala», «Placas de puerta» e «Inventario del edificio» miden más
              que el ancho de la pantalla siendo administrador— y sin `flex-wrap`
              el último se salía por la derecha, fuera de alcance y sin scroll
              horizontal que lo rescatara. */}
          <div className="flex flex-wrap items-center justify-end">
            {/*
              Añadir una sala tiene botón propio, y no solo la pulsación larga.
              Un aula nueva no está en la lista —esa es toda la cuestión—, así que
              no hay ninguna fila que mantener pulsada: sin este botón, dar de
              alta la sala que acaban de abrir en la primera planta obligaría a
              salir a «Datos», y eso es lo que hacía que las aulas nuevas tardaran
              semanas en existir para la aplicación.
            */}
            {esAdmin && (
              <button
                type="button"
                onClick={() => setHoja({ tipo: 'nueva-sala' })}
                className="min-h-11 px-2 text-sm text-accent"
              >
                + Sala
              </button>
            )}
            {/* Etiquetar un edificio se decide mientras se recorre ese edificio,
                así que la hoja de placas se ofrece aquí y no escondida en «Datos». */}
            <button
              type="button"
              onClick={onPlacas}
              className="min-h-11 px-2 text-sm text-accent"
            >
              Placas de puerta
            </button>
            {/* Y el inventario del edificio, al lado: las dos son hojas que se
                imprimen del edificio que se está recorriendo, y quien tiene que
                entregar el inventario de un aulario lo pide estando en él. El
                `-mr-2` viaja al último de la fila, que es el que tiene que
                alinear su texto con el borde. */}
            <button
              type="button"
              onClick={onInventario}
              className="-mr-2 min-h-11 px-2 text-sm text-accent"
            >
              Inventario del edificio
            </button>
          </div>
        </div>

        <label className="mt-2 block">
          <span className="sr-only">Buscar sala en {building.name}</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar sala"
            enterKeyHint="search"
            className="h-touch w-full rounded-ctl border border-line bg-ground px-3"
          />
        </label>

        {/* El orden se elige y se ve. Antes era fijo y solo lo decía un texto. */}
        <div className="mt-2 flex items-center justify-between gap-2">
          <div role="group" aria-label="Orden de la lista" className="flex gap-1">
            {(Object.keys(ROOM_ORDER_LABELS) as RoomOrder[]).map((o) => (
              <button
                key={o}
                type="button"
                aria-pressed={order === o}
                onClick={() => onOrderChange(o)}
                className={`key min-h-11 px-3 text-xs ${
                  order === o ? 'key-accent' : 'key-quiet text-muted'
                }`}
              >
                {ROOM_ORDER_LABELS[o]}
              </button>
            ))}
          </div>
          <span className="shrink-0 text-sm text-muted">
            {visible.length}
            {query && rooms ? ` de ${rooms.length}` : ' salas'}
          </span>
        </div>
      </header>

      {/*
        La confirmación de lo que se acaba de hacer NO se pinta aquí.
        Estuvo pegada a la cabecera —que no es `sticky`, en un documento que
        scrollea entero— y por eso no se leía: la lista mide hasta treinta y
        nueve filas, y quien acaba de renombrar un aula del final la tenía cientos
        de píxeles por encima del borde de la pantalla. Lo único que percibía era
        el salto de la lista al insertarse el bloque, porque WebKit no ancla el
        scroll. Ahora se lee dentro de la propia hoja, que es fija y está donde
        está el dedo, y no se va hasta que se pulsa «Entendido».
      */}
      {cargando && <p className="p-6 text-sm text-muted">Cargando las salas…</p>}

      {!cargando && visible.length === 0 && (
        <p className="p-6 text-sm text-muted">
          {query
            ? `Ninguna sala coincide con «${query}».`
            : 'Este edificio no tiene salas. Conéctate una vez para descargarlas.'}
        </p>
      )}

      {/*
        La lista va sobre PAPEL, no sobre el cromo del fondo.
        Estaba al revés: la cabecera en superficie y las filas sobre el fondo, o
        sea la estructura en primer plano y el trabajo detrás. Puesta así, la
        lista se lee como una hoja apoyada sobre la mesa —termina donde termina
        el contenido, y lo que queda debajo es mesa— en vez de como un campo gris
        continuo del alto de la pantalla.
      */}
      <ul className="divide-y divide-line-soft border-b border-line bg-surface">
        {visible.map((room, i) => {
          const days = daysSince(room.last_inspection_at)
          const overdue = days === null || days > OVERDUE_INSPECTION_DAYS
          const hasDraft = draftRoomIds.has(room.id)

          /*
             Cabecera de planta, solo en el orden por planta.
             Es lo que convierte la lista en un recorrido: se ve dónde acaba una
             planta y empieza la siguiente sin tener que leer la línea gris de
             cada fila. En el orden por antigüedad no se pone, porque ahí las
             plantas se mezclan a propósito.
          */
          const zona = zones?.get(room.zone_id)?.name ?? ''
          const zonaAnterior = i > 0 ? (zones?.get(visible[i - 1]!.zone_id)?.name ?? '') : null
          const abreZona = order === 'planta' && zona !== zonaAnterior

          const zonaDeLaFila = zones?.get(room.zone_id)

          return (
            <li key={room.id}>
              {/*
                La cabecera de planta también se puede renombrar, y por eso al
                ser administrador deja de ser un `<p>` suelto para ser un `<p>`
                con su `⋯` al lado dentro de la misma barra `sticky`. Para un
                técnico se pinta exactamente el mismo nodo de siempre: ni
                envoltorio, ni botón, ni manejadores de puntero.

                Y el botón se llama «Renombrar» y no «Acciones»: la hoja de una
                planta se abre directamente en su formulario, porque es su único
                verbo, y anunciar un menú que no va a salir deja a quien usa
                VoiceOver esperándolo.
              */}
              {abreZona &&
                (esAdmin && zonaDeLaFila ? (
                  <FilaConAcciones
                    esAdmin
                    etiqueta={`Renombrar la planta ${zona}`}
                    alAbrir={() =>
                      setHoja({
                        tipo: 'planta',
                        zona: zonaDeLaFila,
                        edificio: building,
                        salas: (rooms ?? []).filter((r) => r.zone_id === zonaDeLaFila.id).length,
                      })
                    }
                    className="sticky top-0 z-[1] border-y border-line bg-raised"
                  >
                    {(manejadores) => (
                      <p {...manejadores} className="eyebrow sin-lupa flex-1 px-4 py-2">
                        {zona}
                      </p>
                    )}
                  </FilaConAcciones>
                ) : (
                  <p className="eyebrow sticky top-0 z-[1] border-y border-line bg-raised px-4 py-2">
                    {zona}
                  </p>
                ))}
              <FilaConAcciones
                esAdmin={esAdmin}
                etiqueta={`Acciones de ${room.code}`}
                alAbrir={() =>
                  setHoja({ tipo: 'sala', sala: room, edificio: building, zona: zonaDeLaFila })
                }
              >
                {(manejadores) => (
                  <button
                    type="button"
                    onClick={() => onPick(room)}
                    {...manejadores}
                    /* Responde al toque. Era el objetivo más pulsado del día y el
                       único sin ninguna señal al pulsarlo.
                       `sin-lupa` solo con rol de administrador: mantener pulsado un
                       texto dentro de un `<button>` levanta la lupa de iOS y su menú
                       «Copiar» justo encima de la hoja que acaba de subir. Al técnico
                       no se le quita nada, porque no tiene gesto que proteger. */
                    className={`flex w-full flex-1 items-center gap-3.5 px-4 py-3.5 text-left transition-colors duration-100 active:bg-raised ${
                      esAdmin ? 'sin-lupa' : ''
                    }`}
                  >
                    {/* Raíl recto, no cápsula: mismo lenguaje que `StatTile`. */}
                    <span
                      aria-hidden
                      className={`h-8 w-[3px] shrink-0 ${overdue ? 'bg-warn' : 'bg-ok'}`}
                    />

                    {/*
                      Escala ancha, a propósito.
                      Antes el código y la planta medían casi lo mismo y competían:
                      cuatro filas idénticas en peso se leen como una tabla, y hay
                      que leerlas enteras para encontrar una. Con el código a 1.15rem
                      y la planta a 0.75rem, la lista se recorre saltando de código
                      en código y la planta queda de apoyo, que es su papel.
                    */}
                    <span className="min-w-0 flex-1">
                      {/* El triángulo va pegado al código: es un atributo del aula
                          («aquí hay algo roto»), no de la columna de fechas. */}
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-[1.15rem] font-semibold leading-tight tabular">
                          {displayRoomCode(room.code)}
                        </span>
                        <InsigniaAveria
                          n={averias.get(room.id) ?? 0}
                          detalle={detalleDeAverias(averias.get(room.id) ?? 0)}
                        />
                      </span>
                      {/* La planta va en cada fila: aquí el código aparece suelto,
                          y `−2.1` sin contexto se lee como una errata. */}
                      <span className="mt-0.5 block truncate text-xs text-muted">
                        {order === 'planta' ? '' : zona}
                        {room.name !== room.code && `${order === 'planta' ? '' : ' · '}${room.name}`}
                      </span>
                    </span>

                    <span className="shrink-0 text-right">
                      {hasDraft && (
                        <span className="mb-1 block rounded-tag bg-accent-tint px-2 py-0.5 text-[0.6875rem] font-medium text-accent">
                          A medias
                        </span>
                      )}
                      {/*
                        Sin inventariar, en gris. Es información para elegir por
                        dónde seguir cuando ya se está en el edificio, no un aviso:
                        son 41 salas, y en naranja competiría con «toca revisar»,
                        que es lo que de verdad manda en esta lista.
                      */}
                      {!hasDraft && room.last_inventory_at === null && (
                        <span className="mb-1 block rounded-tag bg-sunken px-2 py-0.5 text-[0.6875rem] font-medium text-muted">
                          Sin inventariar
                        </span>
                      )}
                      {/*
                        La cifra y su unidad, separadas.
                        «Hace 302 d» en una sola tirada obliga a leer la frase para
                        quedarse con el número. Con el número en monoespaciada
                        tabular y grande, y «días» debajo en pequeño, la columna se
                        lee de un vistazo de arriba abajo y las cifras alinean —que
                        es justo lo que se está comparando entre salas.
                      */}
                      {days === null ? (
                        <span className="text-xs font-medium text-warn">Sin revisar</span>
                      ) : (
                        <>
                          <span
                            className={`block font-mono text-base font-semibold leading-none tabular ${
                              overdue ? 'text-warn' : 'text-ink-2'
                            }`}
                          >
                            {days}
                          </span>
                          <span className="mt-0.5 block text-[0.625rem] uppercase tracking-[0.08em] text-muted">
                            días
                          </span>
                        </>
                      )}
                    </span>
                  </button>
                )}
              </FilaConAcciones>
            </li>
          )
        })}
      </ul>

      {/*
        La hoja se monta al final y por encima de todo (`z-40`), no dentro del
        `<li>`: dentro heredaría el `overflow` y el `sticky` de la lista, y en
        WebKit una capa fija dentro de un contenedor con `transform` deja de ser
        fija respecto a la ventana y se ancla al contenedor.

        Las salas y las zonas se le pasan enteras —no las visibles— porque el
        choque de códigos hay que comprobarlo contra lo que existe, y la lista
        puede estar filtrada por el buscador justo cuando alguien teclea el
        código que sí está ocupado.
      */}
      {hoja && rooms && zones && (
        <HojaDeMaestro
          objeto={
            hoja.tipo === 'nueva-sala'
              ? { tipo: 'edificio', edificio: building, salas: rooms.length }
              : hoja
          }
          pasoInicial={hoja.tipo === 'nueva-sala' ? 'nueva-sala' : 'menu'}
          zonas={[...zones.values()]}
          salasDelEdificio={rooms}
          onCerrar={() => setHoja(null)}
          onHecho={() => setHoja(null)}
        />
      )}
    </div>
  )
}
