import { Suspense, lazy, useMemo, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { displayRoomCode } from '@/domain/normalize'
import {
  ATAJOS,
  FAMILIAS,
  FAMILIA_ESTILO,
  TIPOS_DE_FAMILIA,
  desdeDe,
  diaDe,
  type Atajo,
  type EventoSala,
  type Familia,
} from '@/domain/historial'
import { useFichaRevision } from '@/features/inspection/useFichaRevision'
import { LineaTiempo } from './LineaTiempo'

/*
 * El listado de revisiones se carga aparte.
 *
 * Es la otra mitad de esta pestaña y no la que se abre primero: quien entra en
 * Historial viene casi siempre a la línea de tiempo. Traer las dos en el mismo
 * paquete encarecería la que sí se usa.
 */
const RevisionesPage = lazy(() =>
  import('@/features/inspection/RevisionesPage').then((m) => ({ default: m.RevisionesPage })),
)

/**
 * Historial.
 *
 * Es la vista de quien pregunta hacia atrás: cuánto material se llevó el
 * edificio H este trimestre, qué pasó la semana que se cayeron tres aulas
 * seguidas, si el proyector de la 1.7 lleva tres averías o una. Hasta ahora eso
 * solo se podía contestar cruzando a mano la pestaña de Incidencias con la de
 * Almacén, y el Excel de antes ni eso.
 *
 * El diseño responde a que casi todas esas preguntas empiezan por **el tipo** y
 * siguen por **el sitio**:
 *
 *  - Las familias van como fila de teclas siempre visible. Es el filtro que se
 *    usa nueve de cada diez veces y no puede costar un toque de más.
 *  - Todo lo demás —edificio, sala, fechas, texto— vive plegado. Una pantalla
 *    que abre con siete controles obliga a leerlos todos antes de empezar; esta
 *    abre con la lista puesta y los filtros a un toque.
 *  - Los atajos de fecha son los que se piden en voz alta («este mes», «este
 *    curso»); las fechas exactas están debajo para el caso raro.
 *
 * Y tiene dos vistas, no una. La línea de tiempo de siempre —**Actividad**— y el
 * listado completo de **Revisiones**, porque son dos preguntas que no se sirven
 * con la misma lista: aquí una revisión es una fila entre veinte movimientos de
 * material, y quien quiere recorrer lo revisado esta semana no viene a esto.
 *
 * Necesita conexión, como Incidencias: es una consulta sobre todo el histórico y
 * no cabe en el espejo local del dispositivo.
 */

const PAGINA = 50

interface EventoConSala extends EventoSala {
  room_code: string
  room_name: string
  building_id: string
  building_code: string
}

/**
 * Las dos maneras de mirar hacia atrás.
 *
 * La línea de tiempo contesta «¿qué ha pasado?» y el listado de revisiones
 * contesta «¿qué se revisó, y qué se encontró?». Son dos preguntas distintas y
 * no se pueden servir con la misma lista: en la línea de tiempo una revisión es
 * una fila entre veinte movimientos de material, y para recorrer las revisiones
 * de un edificio hay que filtrarlo todo y aun así van intercaladas.
 *
 * Va como conmutador aquí y no como pestaña nueva en la barra de abajo: son
 * cinco destinos para un técnico y el sexto empieza a costar leerlos. Las dos
 * vistas son «el pasado», así que comparten puerta.
 */
type Vista = 'actividad' | 'revisiones'

export function HistorialPage(): React.ReactElement {
  const [vista, setVista] = useState<Vista>('actividad')
  const [familia, setFamilia] = useState<Familia | null>(null)
  const [buildingId, setBuildingId] = useState('')
  const [roomId, setRoomId] = useState('')
  const [atajo, setAtajo] = useState<Atajo>('30d')
  const [desde, setDesde] = useState('')
  const [hasta, setHasta] = useState('')
  const [texto, setTexto] = useState('')
  const [filtros, setFiltros] = useState(false)

  const buildings = useLiveQuery(() => db.buildings.orderBy('sort_order').toArray(), [], [])

  const salas = useLiveQuery(async () => {
    if (!buildingId) return []
    const zones = await db.zones.where('building_id').equals(buildingId).toArray()
    const zoneIds = new Set(zones.map((z) => z.id))
    const rooms = await db.rooms.filter((r) => zoneIds.has(r.zone_id)).toArray()
    return rooms.sort((a, b) => a.code.localeCompare(b.code, 'es', { numeric: true }))
  }, [buildingId], [])

  // Las fechas escritas a mano mandan sobre el atajo: si alguien se molesta en
  // teclear un día concreto, es que quiere ese y no «los últimos 30».
  const desdeEfectivo = useMemo(
    () => (desde ? new Date(desde).toISOString() : desdeDe(atajo)),
    [desde, atajo],
  )
  const hastaEfectivo = hasta ? new Date(`${hasta}T23:59:59`).toISOString() : null

  const consulta = useInfiniteQuery({
    queryKey: ['historial', familia, buildingId, roomId, desdeEfectivo, hastaEfectivo, texto],
    // Con el listado de revisiones delante, la línea de tiempo no se pide: son
    // dos consultas paginadas sobre todo el histórico y solo una está en
    // pantalla.
    enabled: vista === 'actividad',
    initialPageParam: 0,
    getNextPageParam: (ultima: EventoConSala[], todas) =>
      ultima.length < PAGINA ? undefined : todas.length * PAGINA,
    queryFn: async ({ pageParam }): Promise<EventoConSala[]> => {
      let q = supabase
        .from('room_timeline')
        .select('*')
        .order('at', { ascending: false })
        .range(pageParam as number, (pageParam as number) + PAGINA - 1)

      // Una familia agrupa varios tipos —«Revisión» son las que salieron bien y
      // las que no—, así que el filtro va por lista y no por igualdad.
      if (familia) q = q.in('kind', TIPOS_DE_FAMILIA[familia])
      if (roomId) q = q.eq('room_id', roomId)
      else if (buildingId) q = q.eq('building_id', buildingId)
      if (desdeEfectivo) q = q.gte('at', desdeEfectivo)
      if (hastaEfectivo) q = q.lte('at', hastaEfectivo)
      if (texto.trim()) {
        // El asterisco es el comodín de PostgREST, y la coma separa las
        // alternativas: se busca en el título, en el detalle y en el código de
        // aula, que es como la gente nombra las cosas («lo del 1.7»).
        // Se limpian los caracteres con los que PostgREST separa filtros y cita
        // valores. Sin esto, escribir una coma en el buscador no es un ataque
        // pero sí una consulta rota que devuelve un error incomprensible.
        const t = texto.trim().replace(/[,()*"\\]/g, ' ')
        q = q.or(`title.ilike.*${t}*,detail.ilike.*${t}*,room_code.ilike.*${t}*`)
      }

      const { data, error } = await q
      if (error) throw error
      return (data ?? []) as EventoConSala[]
    },
  })

  const eventos = useMemo(
    () => (consulta.data?.pages ?? []).flat(),
    [consulta.data],
  )

  /* Agrupado por jornada. Una lista de doscientas filas seguidas no se lee; con
     el día por delante, el ojo salta de bloque en bloque. */
  const porDia = useMemo(() => {
    const grupos: Array<{ dia: string; eventos: EventoConSala[] }> = []
    for (const e of eventos) {
      const dia = diaDe(e.at)
      const ultimo = grupos[grupos.length - 1]
      if (ultimo && ultimo.dia === dia) ultimo.eventos.push(e)
      else grupos.push({ dia, eventos: [e] })
    }
    return grupos
  }, [eventos])

  const nombreDeSala = useMemo(() => {
    const porId = new Map(eventos.map((e) => [e.room_id, `${e.building_code} ${displayRoomCode(e.room_code)}`]))
    return (id: string): string | null => porId.get(id) ?? null
  }, [eventos])

  const activos =
    (familia ? 1 : 0) +
    (buildingId ? 1 : 0) +
    (roomId ? 1 : 0) +
    (texto.trim() ? 1 : 0) +
    (desde || hasta ? 1 : 0) +
    (atajo !== '30d' ? 1 : 0)

  function limpiar(): void {
    setFamilia(null)
    setBuildingId('')
    setRoomId('')
    setAtajo('30d')
    setDesde('')
    setHasta('')
    setTexto('')
  }

  const { abrir, ficha } = useFichaRevision()

  return (
    <div className="mx-auto max-w-4xl p-4">
      <h1 className="text-xl font-semibold">Historial</h1>

      {/*
        El conmutador entre las dos vistas.

        Va justo debajo del título, antes de cualquier filtro: es lo que decide
        QUÉ se está mirando, y un control que cambia el significado de todo lo de
        abajo no puede estar por debajo de ello.
      */}
      <div className="mt-3 flex gap-2" role="tablist" aria-label="Qué mirar del pasado">
        {(
          [
            { id: 'actividad', label: 'Actividad' },
            { id: 'revisiones', label: 'Revisiones' },
          ] as Array<{ id: Vista; label: string }>
        ).map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={vista === v.id}
            onClick={() => setVista(v.id)}
            className={`key min-h-11 flex-1 px-3 text-sm ${
              vista === v.id ? 'key-accent' : 'key-quiet text-muted'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {vista === 'revisiones' && (
        <div className="mt-4">
          <Suspense fallback={<p className="text-sm text-muted">Cargando…</p>}>
            <RevisionesPage />
          </Suspense>
        </div>
      )}

      {vista === 'actividad' && (
      <>
      {activos > 0 && (
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={limpiar} className="text-sm text-accent underline-offset-4 hover:underline">
            Quitar filtros
          </button>
        </div>
      )}

      {/* Las familias, siempre a la vista. */}
      <div className="scroll-x -mx-1 mt-3 flex gap-2 px-1 pb-1">
        <button
          type="button"
          onClick={() => setFamilia(null)}
          aria-pressed={familia === null}
          className={`key min-h-11 shrink-0 px-3 text-sm ${
            familia === null ? 'key-accent' : 'key-quiet text-muted'
          }`}
        >
          Todo
        </button>
        {FAMILIAS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFamilia(familia === f ? null : f)}
            aria-pressed={familia === f}
            className={`key min-h-11 shrink-0 px-3 text-sm ${
              familia === f ? 'key-accent' : 'key-quiet text-muted'
            }`}
          >
            <span className={`mr-2 inline-block h-2 w-2 rounded-full align-middle ${FAMILIA_ESTILO[f].punto}`} />
            {FAMILIA_ESTILO[f].etiqueta}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setFiltros((v) => !v)}
        aria-expanded={filtros}
        className="mt-2 flex w-full items-center justify-between rounded-ctl border border-line bg-surface px-3 py-2 text-left"
      >
        <span className="eyebrow">Sitio, fechas y búsqueda</span>
        <span className="text-sm text-muted">{filtros ? 'cerrar' : 'filtrar'}</span>
      </button>

      <div className="collapse-y" data-open={filtros} inert={!filtros}>
        <div>
          <div className="card mt-2 p-3">
            <label className="block">
              <span className="sr-only">Buscar en el histórico</span>
              <input
                type="search"
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                placeholder="Buscar por descripción, material o aula"
                enterKeyHint="search"
                className="h-touch w-full rounded-ctl border border-line bg-sunken px-3 text-sm"
              />
            </label>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="text-xs text-muted">
                Edificio
                <select
                  value={buildingId}
                  onChange={(e) => {
                    setBuildingId(e.target.value)
                    setRoomId('')
                  }}
                  className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
                >
                  <option value="">Todos</option>
                  {buildings.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.code} — {b.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-xs text-muted">
                Sala
                <select
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                  disabled={!buildingId}
                  className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink disabled:opacity-40"
                >
                  <option value="">{buildingId ? 'Todas' : 'Elige edificio'}</option>
                  {salas.map((r) => (
                    <option key={r.id} value={r.id}>
                      {displayRoomCode(r.code)} — {r.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="scroll-x -mx-1 mt-3 flex gap-2 px-1 pb-1">
              {ATAJOS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    setAtajo(a.id)
                    setDesde('')
                    setHasta('')
                  }}
                  aria-pressed={atajo === a.id && !desde && !hasta}
                  className={`key min-h-11 shrink-0 px-3 text-xs ${
                    atajo === a.id && !desde && !hasta ? 'key-accent' : 'key-quiet text-muted'
                  }`}
                >
                  {a.label}
                </button>
              ))}
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-xs text-muted">
                Desde
                <input
                  type="date"
                  value={desde}
                  onChange={(e) => setDesde(e.target.value)}
                  className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
                />
              </label>
              <label className="text-xs text-muted">
                Hasta
                <input
                  type="date"
                  value={hasta}
                  onChange={(e) => setHasta(e.target.value)}
                  className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
                />
              </label>
            </div>
          </div>
        </div>
      </div>

      {consulta.isPending && <p className="mt-6 text-sm text-muted">Cargando el historial…</p>}

      {consulta.isError && (
        <div className="card mt-6 p-4">
          <p className="text-sm text-crit">No se ha podido leer el historial.</p>
          <p className="mt-1 text-sm text-muted">Esta pantalla necesita conexión.</p>
          <button
            type="button"
            onClick={() => void consulta.refetch()}
            className="key key-quiet mt-3 min-h-11 px-3 text-sm"
          >
            Reintentar
          </button>
        </div>
      )}

      {!consulta.isPending && !consulta.isError && eventos.length === 0 && (
        <p className="mt-6 text-sm text-muted">
          {activos > 0
            ? 'Nada coincide con esos filtros.'
            : 'Todavía no hay nada en el historial.'}
        </p>
      )}

      {porDia.map((grupo) => (
        <section key={grupo.dia} className="mt-5">
          {/* El día se queda pegado arriba al desplazar: en una lista larga, sin
              esto se pierde de vista en cuanto pasan cuatro filas y deja de
              saberse de cuándo es lo que se está leyendo. */}
          <h2 className="sticky top-12 z-[1] -mx-4 bg-ground px-4 py-1.5 text-xs font-semibold capitalize text-muted">
            {grupo.dia}
          </h2>
          <LineaTiempo
            eventos={grupo.eventos}
            salaDe={roomId ? undefined : nombreDeSala}
            onRevision={abrir}
          />
        </section>
      ))}

      {consulta.hasNextPage && (
        <button
          type="button"
          onClick={() => void consulta.fetchNextPage()}
          disabled={consulta.isFetchingNextPage}
          className="key key-quiet mt-6 min-h-touch w-full px-4 text-sm"
        >
          {consulta.isFetchingNextPage ? 'Cargando…' : 'Ver más'}
        </button>
      )}

      {!consulta.hasNextPage && eventos.length > 0 && (
        <p className="mt-6 text-center text-xs text-muted">
          {eventos.length} {eventos.length === 1 ? 'entrada' : 'entradas'} · fin del historial
        </p>
      )}
      </>
      )}

      {/* La ficha de la revisión que se haya abierto, sea desde la línea de
          tiempo o desde el listado. Se monta una vez aquí y no dentro de cada
          fila. */}
      {ficha}
    </div>
  )
}
