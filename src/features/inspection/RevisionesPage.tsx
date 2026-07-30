/**
 * El listado completo de revisiones.
 *
 * Faltaba, y se notaba en la pregunta más normal del mundo: «¿qué se ha revisado
 * esta semana, y qué se encontró?». No había forma de contestarla. Las
 * revisiones solo se veían de una en una, intercaladas en la línea de tiempo de
 * una sala entre movimientos de material y altas de equipo, y para recorrer las
 * de un edificio había que filtrar el histórico entero y aun así iban mezcladas.
 *
 * Lo que hace que esta lista sirva es que **cada fila dice qué falló**. Con el
 * nombre de los aparatos en la propia fila —«Proyector · Red»— se recorre una
 * semana de trabajo sin abrir nada, y solo se entra en las que interesan. Una
 * lista que dijera «3 fallos» obligaría a abrir las tres para saber si alguna es
 * la que se está buscando.
 *
 * Los filtros son los mismos que la pestaña Historial y en el mismo orden, con
 * una diferencia: aquí el primer filtro es el RESULTADO, porque la pregunta que
 * trae a esta pantalla casi siempre lleva un resultado dentro («las que salieron
 * mal», «las que quedaron a medias»).
 *
 * Necesita conexión: son 276 salas revisadas cada seis meses y el histórico no
 * cabe en el espejo del dispositivo, que además purga lo que ya subió.
 */

import { useMemo, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { displayRoomCode } from '@/domain/normalize'
import { ATAJOS, desdeDe, diaDe, fechaLegible, type Atajo } from '@/domain/historial'
import { textoDeFallos, tituloDeResultado, type RevisionRow } from '@/domain/revision'
import { useFichaRevision } from './useFichaRevision'

const PAGINA = 40

/**
 * Los cuatro cortes por resultado.
 *
 * «Sin cerrar» está en la misma fila y no escondido en los filtros de abajo a
 * propósito: un borrador abandonado es un aula que parece revisada y no lo está,
 * y hasta ahora no había ninguna pantalla donde se pudiera ver que existía.
 */
const RESULTADOS = [
  { id: 'todas', label: 'Todas', punto: 'bg-line' },
  { id: 'fallos', label: 'Con incidencias', punto: 'bg-crit' },
  { id: 'limpias', label: 'Sin incidencias', punto: 'bg-ok' },
  { id: 'borradores', label: 'Sin cerrar', punto: 'bg-warn' },
] as const

type Resultado = (typeof RESULTADOS)[number]['id']

export function RevisionesPage(): React.ReactElement {
  const [resultado, setResultado] = useState<Resultado>('todas')
  const [buildingId, setBuildingId] = useState('')
  const [roomId, setRoomId] = useState('')
  const [atajo, setAtajo] = useState<Atajo>('30d')
  const [desde, setDesde] = useState('')
  const [hasta, setHasta] = useState('')
  const [filtros, setFiltros] = useState(false)

  const { abrir, ficha } = useFichaRevision()

  const buildings = useLiveQuery(() => db.buildings.orderBy('sort_order').toArray(), [], [])

  const salas = useLiveQuery(
    async () => {
      if (!buildingId) return []
      const zones = await db.zones.where('building_id').equals(buildingId).toArray()
      const zoneIds = new Set(zones.map((z) => z.id))
      const rooms = await db.rooms.filter((r) => zoneIds.has(r.zone_id)).toArray()
      return rooms.sort((a, b) => a.code.localeCompare(b.code, 'es', { numeric: true }))
    },
    [buildingId],
    [],
  )

  // Igual que en Historial: una fecha escrita a mano manda sobre el atajo.
  const desdeEfectivo = useMemo(
    () => (desde ? new Date(desde).toISOString() : desdeDe(atajo)),
    [desde, atajo],
  )
  const hastaEfectivo = hasta ? new Date(`${hasta}T23:59:59`).toISOString() : null

  const consulta = useInfiniteQuery({
    queryKey: ['revisiones', resultado, buildingId, roomId, desdeEfectivo, hastaEfectivo],
    initialPageParam: 0,
    getNextPageParam: (ultima: RevisionRow[], todas) =>
      ultima.length < PAGINA ? undefined : todas.length * PAGINA,
    queryFn: async ({ pageParam }): Promise<RevisionRow[]> => {
      let q = supabase
        .from('inspection_overview')
        // Se ordena por el reloj del AULA y no por el del servidor: la lista es
        // el relato de lo que se hizo, y una revisión hecha en un sótano el
        // martes no pasa a ser del jueves por subir el jueves.
        .select('*')
        .order('occurred_at', { ascending: false })
        .range(pageParam as number, (pageParam as number) + PAGINA - 1)

      if (resultado === 'borradores') q = q.neq('status', 'completa')
      else if (resultado === 'fallos') q = q.eq('status', 'completa').eq('overall', 'con_incidencias')
      else if (resultado === 'limpias') q = q.eq('status', 'completa').eq('overall', 'ok')

      if (roomId) q = q.eq('room_id', roomId)
      else if (buildingId) q = q.eq('building_id', buildingId)
      if (desdeEfectivo) q = q.gte('occurred_at', desdeEfectivo)
      if (hastaEfectivo) q = q.lte('occurred_at', hastaEfectivo)

      const { data, error } = await q
      if (error) throw error
      return (data ?? []) as RevisionRow[]
    },
  })

  const revisiones = useMemo(() => (consulta.data?.pages ?? []).flat(), [consulta.data])

  /* Agrupadas por jornada, como el histórico: una ronda son treinta filas
     seguidas y sin el día por delante no se distingue una mañana de otra. */
  const porDia = useMemo(() => {
    const grupos: Array<{ dia: string; filas: RevisionRow[] }> = []
    for (const r of revisiones) {
      const dia = diaDe(r.occurred_at)
      const ultimo = grupos[grupos.length - 1]
      if (ultimo && ultimo.dia === dia) ultimo.filas.push(r)
      else grupos.push({ dia, filas: [r] })
    }
    return grupos
  }, [revisiones])

  const activos =
    (resultado !== 'todas' ? 1 : 0) +
    (buildingId ? 1 : 0) +
    (roomId ? 1 : 0) +
    (desde || hasta ? 1 : 0) +
    (atajo !== '30d' ? 1 : 0)

  function limpiar(): void {
    setResultado('todas')
    setBuildingId('')
    setRoomId('')
    setAtajo('30d')
    setDesde('')
    setHasta('')
  }

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">Revisiones</h2>
        {activos > 0 && (
          <button
            type="button"
            onClick={limpiar}
            className="text-sm text-accent underline-offset-4 hover:underline"
          >
            Quitar filtros
          </button>
        )}
      </div>

      {/* El resultado, siempre a la vista: es el filtro que se usa. */}
      <div className="scroll-x -mx-1 mt-3 flex gap-2 px-1 pb-1">
        {RESULTADOS.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setResultado(r.id)}
            aria-pressed={resultado === r.id}
            className={`key min-h-11 shrink-0 px-3 text-sm ${
              resultado === r.id ? 'key-accent' : 'key-quiet text-muted'
            }`}
          >
            <span className={`mr-2 inline-block h-2 w-2 rounded-full align-middle ${r.punto}`} />
            {r.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setFiltros((v) => !v)}
        aria-expanded={filtros}
        className="mt-2 flex w-full items-center justify-between rounded-ctl border border-line bg-surface px-3 py-2 text-left"
      >
        <span className="eyebrow">Sitio y fechas</span>
        <span className="text-sm text-muted">{filtros ? 'cerrar' : 'filtrar'}</span>
      </button>

      <div className="collapse-y" data-open={filtros} inert={!filtros}>
        <div>
          <div className="card mt-2 p-3">
            <div className="grid grid-cols-2 gap-2">
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

      {consulta.isPending && <p className="mt-6 text-sm text-muted">Cargando las revisiones…</p>}

      {consulta.isError && (
        <div className="card mt-6 p-4">
          <p className="text-sm text-crit">No se han podido leer las revisiones.</p>
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

      {!consulta.isPending && !consulta.isError && revisiones.length === 0 && (
        <p className="mt-6 text-sm text-muted">
          {activos > 0
            ? 'Ninguna revisión coincide con esos filtros.'
            : 'Todavía no hay revisiones registradas.'}
        </p>
      )}

      {porDia.map((grupo) => (
        <section key={grupo.dia} className="mt-5">
          <h3 className="sticky top-12 z-[1] -mx-4 bg-ground px-4 py-1.5 text-xs font-semibold capitalize text-muted">
            {grupo.dia}
          </h3>
          <ul className="divide-y divide-line-soft border-y border-line bg-surface">
            {grupo.filas.map((r) => (
              <li key={r.id}>
                <Fila revision={r} onAbrir={() => abrir(r.id)} />
              </li>
            ))}
          </ul>
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

      {!consulta.hasNextPage && revisiones.length > 0 && (
        <p className="mt-6 text-center text-xs text-muted">
          {revisiones.length} {revisiones.length === 1 ? 'revisión' : 'revisiones'} · fin de la lista
        </p>
      )}

      {ficha}
    </>
  )
}

/**
 * Una fila de la lista.
 *
 * Entera pulsable y con la altura de toque de la aplicación: se recorre de pie,
 * y un enlace de dos palabras dentro de una fila obliga a apuntar.
 *
 * Lo que lleva, y por qué en este orden: la sala —que es la respuesta a «cuál»—,
 * qué falló, y en la letra pequeña quién y cuándo. El recuento de fotos y de
 * incidencias sin resolver solo aparece cuando hay: un «0 fotos» en cada fila es
 * ruido en trescientas.
 */
function Fila({
  revision: r,
  onAbrir,
}: {
  revision: RevisionRow
  onAbrir: () => void
}): React.ReactElement {
  const marca = tituloDeResultado(r.status, r.overall)
  const fallos = textoDeFallos(r.fallos_detalle ?? [])

  return (
    <button
      type="button"
      onClick={onAbrir}
      className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-100 active:bg-raised"
    >
      <span className="w-12 shrink-0 rounded-tag bg-raised py-1 text-center font-mono text-xs font-semibold text-accent">
        {r.building_code}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{displayRoomCode(r.room_code)}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-muted">{r.room_name}</span>
        </span>

        {/* Qué falló, con nombres. Es lo que evita abrir la ficha para saber si
            esta fila es la que se está buscando.

            Y cuando la revisión salió mal pero no hay nombres que dar —las
            importadas del Excel llegaron con su resultado y sin comprobaciones—
            se dice eso y no «Sin incidencias», que sería justo lo contrario. */}
        {fallos ? (
          <span className="mt-1 block text-sm text-crit">{fallos}</span>
        ) : r.status !== 'completa' ? null : r.overall === 'ok' ? (
          <span className="mt-1 block text-sm text-muted">Sin incidencias</span>
        ) : (
          <span className="mt-1 block text-sm text-crit">
            Con incidencias, sin comprobaciones guardadas
          </span>
        )}

        <span className="mt-1 block font-mono text-xs text-muted">
          {[
            fechaLegible(r.occurred_at),
            r.who,
            r.fotos > 0 ? `${r.fotos} ${r.fotos === 1 ? 'foto' : 'fotos'}` : null,
            r.sin_resolver > 0 ? `${r.sin_resolver} sin resolver` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>

      {/* El veredicto en una palabra, con el número cuando lo hay: es lo que se
          reconoce sin leer al recorrer treinta filas. */}
      <span className={`shrink-0 rounded-tag px-2 py-0.5 text-xs font-medium ${marca.clase}`}>
        {r.status !== 'completa'
          ? 'a medias'
          : r.overall === 'ok'
            ? 'OK'
            : r.fallos === 1
              ? '1 falla'
              : r.fallos > 1
                ? `${r.fallos} fallan`
                : 'falla'}
      </span>
    </button>
  )
}
