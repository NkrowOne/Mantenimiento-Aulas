import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { displayRoomCode, norm } from '@/domain/normalize'
import { salasQueCasan, type SalaBuscable } from './busqueda'
import { AccionesDeIncidencia, type PanelDeIncidencia } from './AccionesDeIncidencia'
import { puedeCerrar } from './acciones'
import { Borradores } from './Borradores'
import {
  INCIDENT_KIND_LABELS,
  type Incident,
  type IncidentKind,
  type IncidentState,
  type Role,
} from '@/domain/types'

interface IncidentRow {
  id: string
  title: string
  description: string | null
  severity: string
  state: IncidentState
  kind: IncidentKind
  opened_at: string
  resolved_at: string | null
  external_ref: string | null
  room_id: string | null
  /** Salió de una revisión: un equipo marcado «Falla» en el aula. */
  opened_from_inspection_id: string | null
}

/**
 * Lo que se lee de una gravedad, con las mismas palabras que se eligen en el
 * aula: la revisión ofrece «Leve · Molesta · Impide la clase», y quien despacha
 * la lista tiene que leer lo que el técnico pulsó, no la clave de la enumeración.
 *
 * Va en texto teñido y no en otra etiqueta con fondo. La fila ya tiene una a la
 * izquierda con el estado, y dos rectángulos de color pegados compiten entre
 * ellos sin que ninguno gane: el estado se reconoce por la forma, la gravedad se
 * lee.
 */
const SEVERITY_LABEL: Record<string, string> = {
  alta: 'Impide la clase',
  media: 'Molesta',
  baja: 'Leve',
}

const SEVERITY_STYLE: Record<string, string> = {
  alta: 'font-semibold text-crit',
  media: 'text-warn',
  baja: '',
}

const STATE_STYLE: Record<IncidentState, string> = {
  // No llega a pintarse en esta lista —los sin completar salen arriba, en su
  // propia sección— pero el mapa se declara entero: si mañana la lista los
  // incluyera, el hueco sería una etiqueta en blanco en vez de un error.
  borrador: 'bg-raised text-muted',
  abierta: 'bg-crit-tint text-crit',
  en_curso: 'bg-warn-tint text-warn',
  resuelta: 'bg-ok-tint text-ok',
}

const STATE_LABEL: Record<IncidentState, string> = {
  borrador: 'Borrador',
  abierta: 'Abierta',
  en_curso: 'En curso',
  resuelta: 'Resuelta',
}

interface Props {
  role: Role
  userId: string | null
  /**
   * Ir a la ficha de la sala de esta incidencia.
   *
   * Es la mitad de esta pantalla que faltaba. Una incidencia dice qué pasa y
   * dónde, y hasta ahora el «dónde» era texto muerto: para ver qué más arrastra
   * esa aula —el inventario, las revisiones, si el mismo aparato ya falló tres
   * veces— había que memorizar «H 1.7», cambiar de pestaña, elegir edificio y
   * buscarla en una lista de treinta y nueve.
   */
  onSala: (roomId: string) => void
}

export function IncidentsPage({ role, userId, onSala }: Props): React.ReactElement {
  const qc = useQueryClient()
  const [showResolved, setShowResolved] = useState(false)
  const [query, setQuery] = useState('')
  /* Qué incidencia tiene abierto un panel, y cuál. Solo una: el técnico está
     apuntando lo de una avería, no llevando la contabilidad de seis. */
  const [abierta, setAbierta] = useState<{ id: string; panel: PanelDeIncidencia } | null>(null)

  /*
   * La sala de cada incidencia, resuelta desde el espejo local.
   *
   * La lista traía `room_id` y no lo pintaba, así que una incidencia decía qué
   * pasa pero no dónde — que es la mitad del dato. Se resuelve contra Dexie y no
   * con un `join` en el servidor porque así también funciona con la copia que ya
   * está en el dispositivo.
   *
   * `buscables` es la otra mitad del mismo dato: las salas con su edificio y su
   * código sueltos, para que la BÚSQUEDA pueda convertir «H» o «1.7 H» en ids
   * de sala y preguntárselos al servidor. Sin esto, buscar por sala solo
   * funcionaba sobre las filas que el texto hubiera dejado pasar, y el
   * histórico de un edificio entero podía «no existir» para el buscador.
   */
  const espejo = useLiveQuery(async () => {
    const [rooms, zones, buildings] = await Promise.all([
      db.rooms.toArray(),
      db.zones.toArray(),
      db.buildings.toArray(),
    ])
    const zoneById = new Map(zones.map((z) => [z.id, z]))
    const buildingById = new Map(buildings.map((b) => [b.id, b]))

    const etiquetas = new Map<string, string>()
    const buscables: SalaBuscable[] = []
    for (const r of rooms) {
      const zone = zoneById.get(r.zone_id)
      const building = zone ? buildingById.get(zone.building_id) : undefined
      etiquetas.set(r.id, `${building?.code ?? ''} ${displayRoomCode(r.code)}`.trim())
      buscables.push({
        id: r.id,
        edificio: building?.code ?? '',
        codigo: r.code,
        nombre: r.name,
      })
    }
    return { etiquetas, buscables }
  }, [])

  const salas = espejo?.etiquetas

  /*
   * Lo que este dispositivo ya ha decidido y todavía no ha podido contar.
   *
   * La lista la contesta el servidor, pero el cierre viaja por la cola de
   * salida: hay una ventana —segundos con cobertura, días sin ella— en la que
   * aquí está resuelta y arriba todavía no. Sin superponer nada, el supervisor
   * pulsa «Resolver», la lista se refresca y el parte sigue ahí abierto, que es
   * exactamente la pantalla que enseña a no fiarse del botón.
   *
   * Y solo lo que TIENE UN CAMBIO ESPERANDO EN LA COLA, no el espejo entero.
   * Superponiendo el espejo a secas, una incidencia que un compañero acaba de
   * poner «en curso» se vería «abierta» aquí hasta la siguiente descarga: el
   * espejo de este dispositivo es más viejo que la respuesta que se está
   * pintando, así que ganar no le corresponde. La entrada en la cola —`<id>#…`—
   * es justo la diferencia entre «esto lo sé yo antes que el servidor» y «esto
   * lo sabía yo hace un rato».
   */
  const estadoLocal = useLiveQuery(async () => {
    const claves = (await db.outbox.toCollection().primaryKeys()) as string[]
    const conCambio = claves.filter((k) => k.includes('#')).map((k) => k.slice(0, k.indexOf('#')))
    if (conCambio.length === 0) return new Map<string, Incident>()
    const filas = await db.incidents.bulkGet(conCambio)
    return new Map(filas.filter((i): i is Incident => i !== undefined).map((i) => [i.id, i]))
  }, [])

  const LIMITE = 200

  const buscado = query.trim()

  /*
   * Cuántas páginas de la lista se están enseñando.
   *
   * El tope de 200 era un recorte silencioso: con más incidencias abiertas que
   * eso, las antiguas simplemente no existían para la pantalla y el único
   * camino era adivinar qué buscar. Ahora el recorte se ve y tiene botón: «Ver
   * más antiguas» amplía la ventana. Se pide la ventana entera y no solo la
   * página nueva a propósito — son consultas de 200 filas en una pantalla de
   * administración, y una sola consulta no puede coserse mal con la anterior
   * si algo cambió entre medias.
   */
  const [paginas, setPaginas] = useState(1)
  useEffect(() => setPaginas(1), [showResolved, buscado])

  /*
   * Las salas que casan con lo tecleado, para que la consulta pregunte también
   * por `room_id`. «H» pasa a ser el edificio H entero — su histórico completo,
   * resueltas incluidas — y no solo las filas con una hache en el título.
   */
  const idsDeSala = useMemo(
    () => salasQueCasan(espejo?.buscables ?? [], buscado),
    [espejo?.buscables, buscado],
  )
  /** El trozo `room_id.in.(…)` del filtro, o vacío si ninguna sala casa. */
  const filtroSalas = idsDeSala.length > 0 ? `,room_id.in.(${idsDeSala.join(',')})` : ''

  /*
   * Cuántas hay cerradas, para poder decirlo.
   *
   * Sin este número, la pestaña es la respuesta a «se han perdido mis
   * incidencias»: el histórico importado trae 283 y 281 vienen con fecha de
   * resolución, así que la lista abre con dos o tres filas y no hay NADA en
   * pantalla que insinúe que detrás hay 281 más. La casilla «Incluir resueltas»
   * sin cifra al lado no lo dice: parece un filtro fino, no la diferencia entre
   * ver tres cosas y ver el histórico entero.
   */
  const { data: resueltas } = useQuery({
    queryKey: ['incidents-resueltas'],
    queryFn: async (): Promise<number> => {
      const { count, error } = await supabase
        .from('incidents')
        .select('id', { count: 'exact', head: true })
        .eq('state', 'resuelta')
        .neq('kind', 'observacion')
      if (error) throw error
      return count ?? 0
    },
  })

  /*
   * Y cuántas hay EN TOTAL con el filtro activo, para que el recorte nunca
   * vuelva a ser invisible: «120 de 483» dice exactamente cuánto falta por ver.
   */
  const { data: total } = useQuery({
    queryKey: ['incidents-total', showResolved, buscado, filtroSalas],
    queryFn: async (): Promise<number> => {
      let q = supabase
        .from('incidents')
        .select('id', { count: 'exact', head: true })
        .neq('state', 'borrador')
        .neq('kind', 'observacion')
      if (buscado) {
        const t = buscado.replace(/[,()*"\\]/g, ' ')
        q = q.or(
          `title.ilike.*${t}*,description.ilike.*${t}*,external_ref.ilike.*${t}*${filtroSalas}`,
        )
      } else if (!showResolved) {
        q = q.neq('state', 'resuelta')
      }
      const { count, error } = await q
      if (error) throw error
      return count ?? 0
    },
  })

  const { data: incidents, isPending, isError, refetch } = useQuery({
    /*
     * La búsqueda entra en la clave, y con eso deja de ser un filtro en memoria.
     *
     * Bajaba las 200 más recientes y filtraba sobre ese array, así que buscar una
     * referencia de hace un año contestaba «Ninguna incidencia coincide» de algo
     * que existe en la tabla — y la pantalla, encima, invitaba a hacer justo eso:
     * «Afina la búsqueda para ver el resto». Buscar tiene que ser una consulta.
     */
    queryKey: ['incidents', showResolved, buscado, paginas, filtroSalas],
    // Al ampliar la ventana se sigue enseñando la lista de antes mientras
    // llega la nueva: sin esto, pulsar «Ver más antiguas» vaciaba la pantalla
    // un instante y el desplazamiento volvía arriba.
    placeholderData: (prev: IncidentRow[] | undefined) => prev,
    queryFn: async (): Promise<IncidentRow[]> => {
      let q = supabase
        .from('incidents')
        .select('*')
        // Los borradores no son trabajo abierto: son notas a medio escribir, y
        // salen arriba en su propia sección. Mezclarlos aquí llenaría la lista
        // de «(sin describir)» y enterraría lo que sí hay que atender.
        .neq('state', 'borrador')
        /*
         * Y las observaciones tampoco.
         *
         * Esta pestaña es la lista de lo que hay que arreglar: lo que entra aquí
         * es algo que alguien tiene que ir a resolver. Una observación —«el mando
         * está en el cajón», «la persiana cuesta»— no es eso, y mezclarlas hacía
         * que la lista dejara de ser una lista de trabajo: con veinte notas de
         * seguimiento por medio, el proyector roto es una fila más y nadie
         * distingue lo que urge de lo que solo se apuntó.
         *
         * No desaparecen: se escriben en la revisión, debajo de las fotos, y se
         * consultan en la ficha del aula, que es donde significan algo. Las
         * solicitudes sí se quedan —«instalar una cámara» es trabajo pedido, va
         * marcado como tal y no hay otro sitio donde reclamarlo—.
         */
        .neq('kind', 'observacion')
        // El desempate por id hace la paginación estable: dos incidencias
        // importadas con la misma fecha no pueden bailar entre dos páginas.
        .order('opened_at', { ascending: false })
        .order('id')
        .range(0, LIMITE * paginas - 1)

      /*
       * Quien busca una referencia concreta no está triando trabajo abierto: está
       * buscando algo que sabe que existe, y casi siempre está cerrado. Así que
       * mientras haya texto, la búsqueda va al servidor y el estado deja de
       * filtrar; sin texto, la lista sigue siendo la de lo que hay que atender.
       *
       * Los caracteres con los que PostgREST separa filtros y cita valores se
       * limpian, igual que en el buscador del histórico: una coma no es un ataque
       * pero sí una consulta rota con un error incomprensible.
       */
      if (buscado) {
        const t = buscado.replace(/[,()*"\\]/g, ' ')
        // El texto O la sala: `room_id.in.(…)` sale de resolver lo tecleado
        // contra el espejo local. Es lo que hace verdad al placeholder.
        q = q.or(
          `title.ilike.*${t}*,description.ilike.*${t}*,external_ref.ilike.*${t}*${filtroSalas}`,
        )
      } else if (!showResolved) {
        q = q.neq('state', 'resuelta')
      }

      const { data, error } = await q
      // Sin esto un fallo de red devolvía lista vacía y la pantalla decía
      // «Ninguna abierta», que es exactamente lo contrario de la verdad.
      if (error) throw error
      return (data ?? []) as IncidentRow[]
    },
  })

  /*
   * La lista del servidor, con lo que el dispositivo sabe encima.
   *
   * Solo el estado y su resolución: el resto lo manda el servidor, que es quien
   * ve lo que han hecho los demás.
   */
  const conEstadoLocal = useMemo(() => {
    if (!estadoLocal || estadoLocal.size === 0) return incidents ?? []
    return (incidents ?? []).map((i) => {
      const local = estadoLocal.get(i.id)
      if (!local || local.state === i.state) return i
      return { ...i, state: local.state, resolved_at: local.resolved_at }
    })
  }, [incidents, estadoLocal])

  const visibles = useMemo(() => {
    const q = norm(query)
    if (!q) return conEstadoLocal
    // Lo que el servidor trajo POR SALA se queda: el filtro de texto de aquí
    // abajo compara contra la etiqueta «H 1.7» y no casaría «1.7 H», que es
    // justo como lo escribe el histórico. La sala ya decidió en el servidor.
    const porSala = new Set(idsDeSala)
    return conEstadoLocal.filter(
      (i) =>
        (i.room_id !== null && porSala.has(i.room_id)) ||
        norm(i.title).includes(q) ||
        // La descripción entra en la búsqueda desde que se pinta: buscar «no da
        // imagen» y no encontrar la fila que lo dice literalmente en pantalla es
        // la clase de detalle que hace que nadie vuelva a usar el buscador.
        norm(i.description ?? '').includes(q) ||
        norm(i.external_ref ?? '').includes(q) ||
        norm(i.room_id ? (salas?.get(i.room_id) ?? '') : '').includes(q),
    )
  }, [conEstadoLocal, query, salas, idsDeSala])

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">Incidencias</h1>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          {/* Con la cifra al lado. Es lo que convierte «me faltan incidencias» en
              «ah, están cerradas»: 281 filas del histórico no se intuyen desde una
              lista de tres. */}
          Incluir resueltas
          {resueltas !== undefined && resueltas > 0 && (
            <span className="rounded-tag bg-raised px-1.5 py-0.5 font-mono text-xs text-muted">
              {resueltas}
            </span>
          )}
        </label>
      </div>

      {/* Y dicho también donde se nota: debajo de la lista corta, cuando la lista
          corta es corta porque el resto está cerrado. */}
      {!showResolved && !buscado && (resueltas ?? 0) > 0 && (
        <p className="mt-2 text-xs text-muted">
          {resueltas} resuelta{resueltas === 1 ? '' : 's'} no se muestran. Marca «Incluir
          resueltas» para verlas, o busca por texto o referencia — la búsqueda mira también
          las cerradas.
        </p>
      )}

      {/*
        Lo sin terminar, antes que lo abierto, y solo si lo hay.
        Un borrador es una incidencia a medio escribir: su sitio es esta
        pantalla, no una pestaña propia en la barra de navegación. Cuando no hay
        ninguno, este componente no dibuja absolutamente nada.
      */}
      <Borradores />

      <label className="mt-4 block">
        <span className="sr-only">Buscar incidencia</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por descripción, referencia o sala"
          enterKeyHint="search"
          className="h-touch w-full rounded-ctl border border-line bg-surface px-3"
        />
      </label>

      {/*
        Quién cierra, dicho una vez y arriba.
        Antes cada fila ofrecía «Empezar» y «Resolver» a todo el mundo y a un
        técnico le fallaban las dos: el servidor no le deja, y la explicación
        aparecía al pie de la pantalla después de pulsar. Ahora los botones que
        no van a funcionar no se dibujan, y el motivo se lee antes.
      */}
      {!puedeCerrar(role) && (
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Cerrar y empezar incidencias es cosa de un supervisor. Lo que sí puedes hacer desde
          aquí es apuntar el material que has gastado, y abrir la ficha del aula tocando la
          incidencia.
        </p>
      )}

      <ul className="mt-3 divide-y divide-line">
        {visibles.map((i) => {
          const days = Math.floor((Date.now() - new Date(i.opened_at).getTime()) / 86_400_000)
          const stale = i.state !== 'resuelta' && days > 7
          const sala = i.room_id ? (salas?.get(i.room_id) ?? null) : null

          return (
            <li key={i.id} className="py-3">
              {/*
                En un móvil, tres botones y un texto no caben en la misma línea.
                `shrink-0` en el bloque de acciones dejaba al título 90 px y lo
                partía palabra a palabra —«No / duplica / la / imagen»—, que es
                justo el dato que se viene a leer. Ahora las acciones bajan a su
                propia fila hasta que hay sitio de sobra: se envuelve.
              */}
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                {/* Rectángulo, no píldora: esto es una etiqueta de un parte de
                    trabajo. La cápsula en todo es el tic más repetido. */}
                <span
                  className={`shrink-0 rounded-tag px-2 py-0.5 text-xs font-medium ${STATE_STYLE[i.state]}`}
                >
                  {STATE_LABEL[i.state]}
                </span>

                {/*
                  El texto de la fila ES el enlace al aula.

                  Va como botón hermano de las acciones y no envolviéndolas —un
                  botón dentro de otro no es HTML válido, y en iOS se traduce en
                  una zona donde el toque no se sabe de quién es—. La superficie
                  entera del texto abre la ficha, que es lo que se quiere pulsar
                  cuando lo que hace falta es contexto: qué más hay en esa aula,
                  si el mismo aparato ya falló tres veces, qué se apuntó la
                  última vez.
                */}
                <button
                  type="button"
                  disabled={i.room_id === null}
                  onClick={() => i.room_id && onSala(i.room_id)}
                  aria-label={
                    sala ? `Abrir la ficha del aula ${sala}` : 'Esta incidencia no tiene sala'
                  }
                  className="min-w-0 flex-1 basis-48 rounded-ctl text-left disabled:cursor-default disabled:opacity-100"
                >
                  <p className="font-medium">
                    {i.title}
                    {/* El galón dice «esto lleva a algún sitio» sin gastar una
                        palabra, y es el mismo de las revisiones anteriores. */}
                    {i.room_id !== null && (
                      <svg
                        aria-hidden="true"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        className="ml-1 inline-block align-[-0.15em] text-muted"
                      >
                        <path
                          d="M9 6l6 6-6 6"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {sala && <span className="font-mono font-semibold text-ink-2">{sala} · </span>}
                    {/* La importación dejó 118 sin sala identificada. Decirlo en
                        la fila es lo que permite reconocerlas — y el panel de
                        administración es donde se les asigna la suya. */}
                    {!sala && i.room_id === null && (
                      <span className="font-mono text-muted">sin sala · </span>
                    )}
                    {i.external_ref && <span className="font-mono">{i.external_ref} · </span>}
                    {/* La gravedad, en palabras: es lo que decide qué se atiende
                        primero, y «alta» a secas no dice qué está en juego.

                        Solo en las averías. Una solicitud lleva gravedad en la
                        tabla porque la columna es obligatoria, pero «Molesta»
                        aplicado a «instalar una cámara» no significa nada: es un
                        valor por defecto disfrazado de dato. */}
                    {i.kind === 'incidencia' && (
                      <>
                        <span className={SEVERITY_STYLE[i.severity] ?? ''}>
                          {SEVERITY_LABEL[i.severity] ?? i.severity}
                        </span>
                        {' · '}
                      </>
                    )}
                    {/* Una solicitud no es una avería y no puede leerse igual.
                        La incidencia no se marca: es el caso normal de esta
                        lista, y etiquetar lo normal solo añade ruido. */}
                    {i.kind !== 'incidencia' && INCIDENT_KIND_LABELS[i.kind] && (
                      <>{INCIDENT_KIND_LABELS[i.kind]} · </>
                    )}
                    {/* De dónde salió. «De la revisión» dice que alguien estuvo
                        delante del aparato y lo vio fallar, que es información
                        distinta de haberlo apuntado desde el escritorio. */}
                    {i.opened_from_inspection_id && <>de la revisión · </>}
                    abierta hace{' '}
                    <span className={stale ? 'font-semibold text-crit' : ''}>{days} días</span>
                  </p>
                  {/* Lo que el técnico escribió en el aula. Estaba guardado y no
                      se pintaba en ningún sitio: quien tiene que arreglarlo leía
                      «Proyector» y tenía que ir a preguntar. */}
                  {i.description && (
                    <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted">
                      {i.description}
                    </p>
                  )}
                </button>
              </div>

              {i.state !== 'resuelta' && (
                <div className="mt-2">
                  <AccionesDeIncidencia
                    incident={i}
                    role={role}
                    userId={userId}
                    panel={abierta?.id === i.id ? abierta.panel : null}
                    onPanel={(panel) => setAbierta(panel ? { id: i.id, panel } : null)}
                    onHecho={() => void qc.invalidateQueries({ queryKey: ['incidents-resueltas'] })}
                  />
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {isPending && <p className="mt-6 text-sm text-muted">Cargando incidencias…</p>}

      {isError && (
        <div className="card mt-6 p-4">
          <p className="text-sm text-crit">No se han podido leer las incidencias.</p>
          <p className="mt-1 text-sm text-muted">
            Esta pantalla necesita conexión. Lo que revises sin cobertura sí se guarda.
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="key key-quiet mt-3 min-h-11 px-3 text-sm"
          >
            Reintentar
          </button>
        </div>
      )}

      {!isPending && !isError && visibles.length === 0 && (
        <p className="mt-6 text-sm text-muted">
          {query
            ? `Ninguna incidencia coincide con «${query}».`
            : showResolved
              ? 'No hay incidencias.'
              : 'Ninguna abierta.'}
        </p>
      )}

      {/* Que el listado esté recortado tiene que verse Y tener salida: con 283
          incidencias, 83 desaparecían sin que nada lo dijera. Ahora el recorte
          se enseña con la cifra («200 de 283») y las antiguas se piden con un
          botón, sin tener que adivinar qué buscar. */}
      {(incidents?.length ?? 0) === LIMITE * paginas &&
        (total === undefined || (incidents?.length ?? 0) < total) && (
          <button
            type="button"
            onClick={() => setPaginas((n) => n + 1)}
            className="key key-quiet mt-4 min-h-11 w-full px-3 text-sm"
          >
            Ver más antiguas
            {total !== undefined ? ` — enseñando ${incidents?.length} de ${total}` : ''}
          </button>
        )}

    </div>
  )
}
