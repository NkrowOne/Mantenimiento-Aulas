import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { displayRoomCode } from '@/domain/normalize'
import { fechaCorta } from '@/domain/fechas'
import { Cargando, EstadoVacio, FalloDeCarga, Nota, Seccion, mensajeDe } from './Seccion'
import { useRefrescarPendientes } from './pendientes'
import { proponerSala } from './propuesta'

/**
 * Las incidencias importadas que quedaron sin sala, y su camino de vuelta.
 *
 * La importación no pudo identificar el aula de 118 incidencias («0.1 BC»,
 * «2.3 TM», «Ventanilla Única»…) e hizo lo correcto: guardarlas sin sala en
 * vez de inventarles una. Lo que no existía era esto: verlas con el texto que
 * traía el Excel y ponerles su sala con dos toques. Cada asignación además
 * ENSEÑA: el texto original queda como alias de la sala, así que la próxima
 * importación —y el buscador— lo resuelven solos.
 *
 * Agrupadas por el texto del aula: las 118 son unas veinte aulas escritas de
 * formas distintas, y «0.1 BC» aparece doce veces. Asignar el grupo entero de
 * una vez es doce decisiones que son la misma.
 *
 * Y cuando el texto ya dice qué sala es —«1.7 H», con un edificio y una sala
 * que el maestro conoce—, el grupo llega con los dos desplegables puestos y
 * solo queda comprobar y pulsar. Qué se propone y qué no, en `propuesta.ts`.
 */

interface SinSala {
  incidencia: string
  ref: string | null
  titulo: string
  descripcion: string | null
  estado: string
  abierta_el: string
  aula_original: string | null
}

interface SalaElegible {
  id: string
  buildingId: string
  /** El código tal cual, para casarlo con el texto del Excel. */
  codigo: string
  etiqueta: string
}

function Grupo({
  aula,
  filas,
  salas,
  edificios,
  ocupado,
  onAsignar,
}: {
  aula: string | null
  filas: SinSala[]
  salas: SalaElegible[]
  edificios: Array<{ id: string; code: string; name: string }>
  ocupado: boolean
  onAsignar: (roomId: string) => void
}): React.ReactElement {
  /*
   * Lo elegido a mano, o `null` mientras nadie haya tocado los desplegables: en
   * ese caso manda la propuesta. No se copia la propuesta al estado porque el
   * maestro llega del espejo DESPUÉS de pintar la lista, y un estado inicial
   * calculado sin salas se quedaría vacío para siempre.
   */
  const [eleccion, setEleccion] = useState<{ buildingId: string; roomId: string } | null>(null)
  const propuesta = useMemo(() => proponerSala(aula, salas, edificios), [aula, salas, edificios])
  const buildingId = eleccion ? eleccion.buildingId : (propuesta?.buildingId ?? '')
  const roomId = eleccion ? eleccion.roomId : (propuesta?.roomId ?? '')
  const propuestaALaVista = eleccion === null && propuesta !== null

  const delEdificio = salas.filter((s) => s.buildingId === buildingId)

  return (
    <li className="card p-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {/* El texto de aula del Excel, delante y destacado: es el dato con el
            que se decide, y el que se convertirá en alias al asignar. */}
        <span className="rounded-tag bg-raised px-2 py-0.5 font-mono text-sm font-semibold">
          {aula ?? '(sin aula en la cuarentena)'}
        </span>
        <span className="text-xs text-muted">
          {filas.length === 1 ? '1 incidencia' : `${filas.length} incidencias`}
        </span>
      </div>

      <ul className="mt-2 divide-y divide-line-soft">
        {filas.slice(0, 5).map((f) => (
          <li key={f.incidencia} className="py-1.5 text-sm">
            <span className="text-xs text-muted">
              {fechaCorta(f.abierta_el)}
              {f.ref ? ` · ${f.ref}` : ''} · {f.estado} ·{' '}
            </span>
            {f.titulo}
          </li>
        ))}
        {filas.length > 5 && <li className="py-1.5 text-xs text-muted">y {filas.length - 5} más.</li>}
      </ul>

      {/* Que es una propuesta se dice con palabras: dos desplegables que
          aparecen rellenos sin que nadie los haya tocado, al lado de «Asignar
          las 12», se toman por un hecho. */}
      {propuestaALaVista && (
        <p className="mt-3 text-xs text-muted">
          {propuesta.roomId
            ? 'Sala propuesta por el texto del Excel. Compruébala antes de asignar.'
            : 'Edificio propuesto por el texto del Excel. Falta elegir la sala.'}
        </p>
      )}

      {/* En un teléfono, los dos desplegables a medias y el botón debajo, a
          todo el ancho; con sitio, los tres en fila. */}
      <div className={`grid grid-cols-2 gap-2 sm:flex sm:items-center ${propuestaALaVista ? 'mt-1.5' : 'mt-3'}`}>
        <select
          value={buildingId}
          onChange={(e) => setEleccion({ buildingId: e.target.value, roomId: '' })}
          aria-label="Edificio de la sala"
          className="h-11 w-full min-w-0 rounded-ctl border border-line bg-surface px-2 text-base sm:w-auto"
        >
          <option value="">Edificio…</option>
          {edificios.map((b) => (
            <option key={b.id} value={b.id}>
              {b.code} — {b.name}
            </option>
          ))}
        </select>

        <select
          value={roomId}
          onChange={(e) => setEleccion({ buildingId, roomId: e.target.value })}
          disabled={!buildingId}
          aria-label="Sala que le corresponde"
          className="h-11 w-full min-w-0 rounded-ctl border border-line bg-surface px-2 text-base disabled:opacity-40 sm:w-auto"
        >
          <option value="">{buildingId ? 'Sala…' : '—'}</option>
          {delEdificio.map((s) => (
            <option key={s.id} value={s.id}>
              {s.etiqueta}
            </option>
          ))}
        </select>

        <button
          type="button"
          disabled={!roomId || ocupado}
          onClick={() => onAsignar(roomId)}
          className="key key-accent col-span-2 min-h-11 px-3 text-sm"
        >
          {filas.length === 1 ? 'Asignar' : `Asignar las ${filas.length}`}
        </button>
      </div>
    </li>
  )
}

export function IncidenciasSinSala(): React.ReactElement {
  const qc = useQueryClient()
  const refrescar = useRefrescarPendientes()
  const [nota, setNota] = useState<string | null>(null)

  const { data: filas, isPending, isError, error, refetch } = useQuery({
    queryKey: ['incidencias-sin-sala'],
    queryFn: async (): Promise<SinSala[]> => {
      const { data, error: err } = await supabase.rpc('incidencias_sin_sala')
      if (err) throw err
      return (data ?? []) as SinSala[]
    },
  })

  /* Salas y edificios del espejo, listos para elegir. */
  const maestro = useLiveQuery(async () => {
    const [rooms, zones, buildings] = await Promise.all([
      db.rooms.toArray(),
      db.zones.toArray(),
      db.buildings.orderBy('sort_order').toArray(),
    ])
    const zonaEdificio = new Map(zones.map((z) => [z.id, z.building_id]))
    const salas: SalaElegible[] = rooms
      .map((r) => ({
        id: r.id,
        buildingId: zonaEdificio.get(r.zone_id) ?? '',
        codigo: r.code,
        etiqueta: `${displayRoomCode(r.code)}${r.name && r.name !== r.code ? ` — ${r.name}` : ''}`,
      }))
      .sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, 'es', { numeric: true }))
    return { salas, edificios: buildings.map((b) => ({ id: b.id, code: b.code, name: b.name })) }
  }, [])

  const asignar = useMutation({
    mutationFn: async (input: { filas: SinSala[]; roomId: string }): Promise<string> => {
      let etiqueta = ''
      // Una a una y en orden: la función del servidor asigna una incidencia y
      // deja el alias; con el grupo entero la primera lo deja y las demás lo
      // encuentran ya puesto.
      for (const fila of input.filas) {
        const { data, error: err } = await supabase.rpc('asignar_sala_a_incidencia', {
          p_incidencia: fila.incidencia,
          p_room: input.roomId,
          p_alias: fila.aula_original,
        })
        if (err) throw err
        etiqueta = (data as string) ?? etiqueta
      }
      return etiqueta
    },
    onSuccess: (etiqueta, input) => {
      const aula = input.filas[0]?.aula_original ?? input.filas[0]?.titulo ?? ''
      setNota(
        `${input.filas.length === 1 ? 'Asignada' : `${input.filas.length} asignadas`} a ${etiqueta}. «${aula}» queda de alias: la próxima importación acertará sola.`,
      )
      void qc.invalidateQueries({ queryKey: ['incidencias-sin-sala'] })
      void qc.invalidateQueries({ queryKey: ['incidents'] })
      void qc.invalidateQueries({ queryKey: ['quarantine'] })
      refrescar()
    },
  })

  // Por el texto del aula, con las más numerosas primero: son las que más
  // trabajo quitan de una vez.
  const grupos = new Map<string, SinSala[]>()
  for (const f of filas ?? []) {
    const clave = f.aula_original ?? ''
    grupos.set(clave, [...(grupos.get(clave) ?? []), f])
  }
  const ordenados = [...grupos.entries()].sort((a, b) => b[1].length - a[1].length)

  return (
    <Seccion
      id="sec-sin-sala"
      titulo="Incidencias sin sala"
      texto="Incidencias importadas cuya aula no se pudo identificar."
      detalle="Se guardaron sin sala para no asignarles una incorrecta. Mientras no la tengan, no aparecen en ninguna ficha ni cuentan en ningún edificio. Al asignarla vuelven a todas las vistas, y el texto original se guarda como alias para que la próxima importación lo reconozca. Si el texto ya indica un edificio y una sala conocidos, se proponen: compruébalos antes de asignar."
      pendientes={filas?.length ?? 0}
    >
      {isPending && <Cargando texto="Buscando incidencias sin sala…" />}
      {isError && <FalloDeCarga que="las incidencias sin sala" error={error} onReintentar={() => void refetch()} />}
      {filas && filas.length === 0 && <EstadoVacio titulo="Todas las incidencias tienen su sala" />}

      <ul className="space-y-3">
        {ordenados.map(([aula, lista]) => (
          <Grupo
            key={aula || '(sin aula)'}
            aula={aula || null}
            filas={lista}
            salas={maestro?.salas ?? []}
            edificios={maestro?.edificios ?? []}
            ocupado={asignar.isPending}
            onAsignar={(roomId) => asignar.mutate({ filas: lista, roomId })}
          />
        ))}
      </ul>

      <Nota texto={asignar.isError ? mensajeDe(asignar.error, 'No se ha podido asignar.') : nota} tono={asignar.isError ? 'crit' : 'ok'} />
    </Seccion>
  )
}
