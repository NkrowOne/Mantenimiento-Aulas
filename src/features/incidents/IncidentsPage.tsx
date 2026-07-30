import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { displayRoomCode, norm } from '@/domain/normalize'
import { MaterialUsado } from './MaterialUsado'
import { Borradores } from './Borradores'
import { INCIDENT_KIND_LABELS, type IncidentKind, type IncidentState } from '@/domain/types'

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

export function IncidentsPage(): React.ReactElement {
  const qc = useQueryClient()
  const [showResolved, setShowResolved] = useState(false)
  const [query, setQuery] = useState('')
  /* Qué incidencia tiene abierto el apunte de material. Solo una: el técnico
     está apuntando lo de una avería, no llevando la contabilidad de seis. */
  const [apuntando, setApuntando] = useState<string | null>(null)

  /*
   * La sala de cada incidencia, resuelta desde el espejo local.
   *
   * La lista traía `room_id` y no lo pintaba, así que una incidencia decía qué
   * pasa pero no dónde — que es la mitad del dato. Se resuelve contra Dexie y no
   * con un `join` en el servidor porque así también funciona con la copia que ya
   * está en el dispositivo.
   */
  const salas = useLiveQuery(async () => {
    const [rooms, zones, buildings] = await Promise.all([
      db.rooms.toArray(),
      db.zones.toArray(),
      db.buildings.toArray(),
    ])
    const zoneById = new Map(zones.map((z) => [z.id, z]))
    const buildingById = new Map(buildings.map((b) => [b.id, b]))

    return new Map(
      rooms.map((r) => {
        const zone = zoneById.get(r.zone_id)
        const building = zone ? buildingById.get(zone.building_id) : undefined
        return [r.id, `${building?.code ?? ''} ${displayRoomCode(r.code)}`.trim()]
      }),
    )
  }, [])

  const LIMITE = 200

  const buscado = query.trim()

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

  const { data: incidents, isPending, isError, refetch } = useQuery({
    /*
     * La búsqueda entra en la clave, y con eso deja de ser un filtro en memoria.
     *
     * Bajaba las 200 más recientes y filtraba sobre ese array, así que buscar una
     * referencia de hace un año contestaba «Ninguna incidencia coincide» de algo
     * que existe en la tabla — y la pantalla, encima, invitaba a hacer justo eso:
     * «Afina la búsqueda para ver el resto». Buscar tiene que ser una consulta.
     */
    queryKey: ['incidents', showResolved, buscado],
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
        .order('opened_at', { ascending: false })
        .limit(LIMITE)

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
        q = q.or(`title.ilike.*${t}*,description.ilike.*${t}*,external_ref.ilike.*${t}*`)
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

  const visibles = useMemo(() => {
    const q = norm(query)
    if (!q) return incidents ?? []
    return (incidents ?? []).filter(
      (i) =>
        norm(i.title).includes(q) ||
        // La descripción entra en la búsqueda desde que se pinta: buscar «no da
        // imagen» y no encontrar la fila que lo dice literalmente en pantalla es
        // la clase de detalle que hace que nadie vuelva a usar el buscador.
        norm(i.description ?? '').includes(q) ||
        norm(i.external_ref ?? '').includes(q) ||
        norm(i.room_id ? (salas?.get(i.room_id) ?? '') : '').includes(q),
    )
  }, [incidents, query, salas])

  const advance = useMutation({
    mutationFn: async (input: { id: string; state: IncidentState; resolution?: string }) => {
      const { data: user } = await supabase.auth.getUser()
      const patch: Record<string, unknown> = { state: input.state }

      if (input.state === 'resuelta') {
        patch['resolved_at'] = new Date().toISOString()
        patch['resolved_by'] = user.user?.id ?? null
        if (input.resolution) patch['resolution'] = input.resolution
      }

      /*
       * Se pide la fila de vuelta, y sin ella esto es un fallo.
       *
       * Un UPDATE que no alcanza ninguna fila **no es un error** para PostgREST:
       * responde 204 con `error` a null. Y a un técnico no le alcanza ninguna —la
       * única política de UPDATE que le sirve exige que sea su propio borrador—,
       * así que pulsar «Resolver» entraba por `onSuccess`, invalidaba la consulta,
       * la lista se redibujaba igual y la incidencia seguía abierta. Sin un
       * mensaje, sin un error, sin nada: la pantalla decía que sí y el servidor
       * decía que no. Y el aviso «Solo un supervisor cierra incidencias» que hay
       * escrito ahí abajo cuelga de `advance.isError`, o sea que nunca se pintaba.
       */
      const { data, error } = await supabase
        .from('incidents')
        .update(patch)
        .eq('id', input.id)
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) {
        throw new Error('El servidor no ha aplicado el cambio: hace falta ser supervisor.')
      }
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['incidents'] }),
  })

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

                <div className="min-w-0 flex-1 basis-48">
                  <p className="font-medium">{i.title}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {sala && <span className="font-mono font-semibold text-ink-2">{sala} · </span>}
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
                </div>

                {i.state !== 'resuelta' && (
                  <div className="ml-auto flex shrink-0 gap-2">
                    {i.state === 'abierta' && (
                      <button
                        type="button"
                        onClick={() => advance.mutate({ id: i.id, state: 'en_curso' })}
                        className="key key-quiet min-h-11 px-3 text-xs"
                      >
                        Empezar
                      </button>
                    )}
                    {/* El material se apunta antes de cerrar: después nadie
                        vuelve a la incidencia, y ese era el dato que no llegaba
                        nunca al almacén. */}
                    <button
                      type="button"
                      aria-expanded={apuntando === i.id}
                      onClick={() => setApuntando((a) => (a === i.id ? null : i.id))}
                      className="key key-quiet min-h-11 px-3 text-xs"
                    >
                      Material
                    </button>
                    <button
                      type="button"
                      onClick={() => advance.mutate({ id: i.id, state: 'resuelta' })}
                      className="key key-accent min-h-11 px-3 text-xs"
                    >
                      Resolver
                    </button>
                  </div>
                )}
              </div>

              {apuntando === i.id && <MaterialUsado incidentId={i.id} roomId={i.room_id} />}
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

      {/* Que el listado esté recortado tiene que verse: con 283 incidencias, 83
          desaparecían sin que nada lo dijera. Y ahora la frase es verdad: buscar
          pregunta al servidor, así que afinar la búsqueda SÍ encuentra el resto. */}
      {incidents?.length === LIMITE && (
        <p className="mt-4 text-xs text-muted">
          Mostrando las {LIMITE} más recientes. Busca por texto o referencia para
          encontrar cualquiera de las demás.
        </p>
      )}

      {/* `role="alert"` porque ahora sí llega: es la respuesta a un botón que
          parecía funcionar y no hacía nada. */}
      {advance.isError && (
        <p role="alert" className="mt-4 text-sm text-crit">
          No se ha podido cambiar el estado: cerrar y empezar incidencias es cosa de
          un supervisor.
        </p>
      )}
    </div>
  )
}
