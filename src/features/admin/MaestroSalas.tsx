import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { pullMaster } from '@/sync/pull'
import { displayRoomCode } from '@/domain/normalize'
import type { RoomKind } from '@/domain/types'

/**
 * Altas y bajas de salas y edificios.
 *
 * Hasta ahora esto se hacía escribiendo SQL contra el servidor, que es tanto
 * como decir que no se hacía: un aula nueva tardaba lo que tardara en coincidir
 * quien la necesita con quien tiene la contraseña de la base de datos. Mientras
 * tanto, esa aula no existe para la aplicación — no se revisa, no sale en el
 * buscador y sus incidencias no tienen dónde colgar.
 *
 * Vive **solo** aquí, detrás del rol de administrador, y eso no es una
 * limitación técnica sino la decisión: el maestro es lo que sostiene el resto —
 * el histórico, los informes, las placas de la puerta— y una sala creada por
 * error desde el aula, con el código mal escrito, se convierte en una sala
 * duplicada que nadie sabe cuál es la buena.
 *
 * Dar de baja no siempre es borrar, y la diferencia la decide el servidor:
 *
 *  - Sin histórico, la sala se borra de verdad.
 *  - Con revisiones, incidencias o inventarios, se **archiva**: desaparece de la
 *    lista de trabajo y del dispositivo, y lo que se hizo allí se queda entero.
 *    Borrarla sería tirar el histórico de un año para limpiar una lista.
 */

interface Edificio {
  id: string
  code: string
  name: string
  needs_review: boolean
}

interface Sala {
  room_id: string
  room_code: string
  room_name: string
  short_ref: string | null
  zone_name: string
  building_id: string
}

interface Archivada {
  room_id: string
  room_code: string
  room_name: string
  zone_name: string
  building_code: string
}

const TIPOS: Array<{ value: RoomKind; label: string }> = [
  { value: 'aula', label: 'Aula' },
  { value: 'sala_reunion', label: 'Sala de reunión' },
  { value: 'laboratorio', label: 'Laboratorio' },
  { value: 'otro', label: 'Otro' },
]

export function MaestroSalas(): React.ReactElement {
  const qc = useQueryClient()
  const [abierto, setAbierto] = useState<string | null>(null)
  const [nota, setNota] = useState<string | null>(null)

  const [codigoEd, setCodigoEd] = useState('')
  const [nombreEd, setNombreEd] = useState('')

  const [zona, setZona] = useState('')
  const [codigo, setCodigo] = useState('')
  const [nombre, setNombre] = useState('')
  const [tipo, setTipo] = useState<RoomKind>('aula')

  const { data: edificios } = useQuery({
    queryKey: ['maestro', 'buildings'],
    queryFn: async (): Promise<Edificio[]> => {
      const { data, error } = await supabase
        .from('buildings')
        .select('id, code, name, needs_review')
        .order('sort_order')
      if (error) throw error
      return (data ?? []) as Edificio[]
    },
  })

  /* Las salas vivas, del servidor y no del espejo: aquí se está decidiendo qué
     hay, y el espejo puede llevar dos minutos de retraso justo sobre lo que uno
     acaba de crear. */
  const { data: salas } = useQuery({
    queryKey: ['maestro', 'rooms'],
    queryFn: async (): Promise<Sala[]> => {
      const { data, error } = await supabase
        .from('room_overview')
        .select('room_id, room_code, room_name, short_ref, zone_name, building_id')
        .order('zone_order')
        .order('room_code')
      if (error) throw error
      return (data ?? []) as Sala[]
    },
  })

  const { data: archivadas } = useQuery({
    queryKey: ['maestro', 'archived'],
    queryFn: async (): Promise<Archivada[]> => {
      const { data, error } = await supabase
        .from('archived_rooms')
        .select('room_id, room_code, room_name, zone_name, building_code')
        .order('building_code')
      if (error) throw error
      return (data ?? []) as Archivada[]
    },
  })

  const refrescar = (mensaje: string): void => {
    setNota(mensaje)
    void qc.invalidateQueries({ queryKey: ['maestro'] })
    void qc.invalidateQueries({ queryKey: ['buildings'] })
    // Y el espejo de este dispositivo, que es donde se va a mirar dentro de un
    // minuto para comprobar que la sala nueva está.
    void pullMaster()
  }

  const act = useMutation({
    mutationFn: async (
      input:
        | { kind: 'nuevo-edificio'; code: string; name: string }
        | { kind: 'borrar-edificio'; id: string }
        | { kind: 'nueva-sala'; building: string; zone: string; code: string; name: string; tipo: RoomKind }
        | { kind: 'baja-sala'; id: string }
        | { kind: 'reactivar-sala'; id: string },
    ): Promise<string> => {
      if (input.kind === 'nuevo-edificio') {
        const { error } = await supabase.rpc('create_building', {
          p_code: input.code,
          p_name: input.name,
        })
        if (error) throw error
        return `Edificio ${input.code.toUpperCase()} creado.`
      }

      if (input.kind === 'borrar-edificio') {
        const { error } = await supabase.rpc('delete_building', { p_id: input.id })
        if (error) throw error
        return 'Edificio borrado.'
      }

      if (input.kind === 'nueva-sala') {
        const { error } = await supabase.rpc('create_room', {
          p_building: input.building,
          p_zone: input.zone,
          p_code: input.code,
          p_name: input.name,
          p_kind: input.tipo,
        })
        if (error) throw error
        return `Sala ${input.code} creada, con su matrícula y su equipamiento por defecto.`
      }

      if (input.kind === 'reactivar-sala') {
        const { error } = await supabase.rpc('restore_room', { p_id: input.id })
        if (error) throw error
        return 'Sala reactivada: vuelve a la lista de trabajo.'
      }

      const { data, error } = await supabase.rpc('delete_room', { p_id: input.id })
      if (error) throw error
      return data === 'archivada'
        ? 'Sala archivada: tenía histórico, así que se conserva entero y sale de la lista de trabajo.'
        : 'Sala borrada.'
    },
    onSuccess: (mensaje) => {
      setCodigoEd('')
      setNombreEd('')
      setCodigo('')
      setNombre('')
      refrescar(mensaje)
    },
  })

  const salasDe = (buildingId: string): Sala[] =>
    (salas ?? []).filter((s) => s.building_id === buildingId)

  return (
    <section aria-labelledby="sec-maestro" className="mt-8">
      <div className="section-head">
        <h2 id="sec-maestro" className="eyebrow">
          Salas y edificios
        </h2>
      </div>
      <p className="text-sm text-muted">
        El maestro solo se toca desde aquí. Una sala nueva nace con matrícula, QR y el equipamiento
        por defecto de su edificio.
      </p>

      <ul className="mt-3 space-y-2">
        {(edificios ?? []).map((b) => {
          const suyas = salasDe(b.id)
          const desplegado = abierto === b.id

          return (
            <li key={b.id} className="card overflow-hidden">
              <button
                type="button"
                onClick={() => setAbierto(desplegado ? null : b.id)}
                aria-expanded={desplegado}
                className="flex w-full items-center gap-3 px-4 py-3 text-left"
              >
                <span className="w-12 shrink-0 rounded-tag bg-raised py-1 text-center font-mono text-xs font-semibold text-accent">
                  {b.code}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{b.name}</span>
                  <span className="block text-xs text-muted">
                    {suyas.length === 0 ? 'sin salas' : `${suyas.length} salas`}
                  </span>
                </span>
                <span className="shrink-0 text-sm text-muted">{desplegado ? 'cerrar' : 'abrir'}</span>
              </button>

              <div className="collapse-y" data-open={desplegado} inert={!desplegado}>
                <div>
                  {desplegado && (
                    <div className="border-t border-line px-4 py-3">
                      <ul className="divide-y divide-line-soft">
                        {suyas.map((s) => (
                          <li key={s.room_id} className="flex items-center gap-2 py-2">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">
                                {displayRoomCode(s.room_code)}
                                {s.room_name !== s.room_code && (
                                  <span className="ml-2 font-normal text-muted">{s.room_name}</span>
                                )}
                              </span>
                              <span className="block truncate font-mono text-xs text-muted">
                                {[s.zone_name, s.short_ref].filter(Boolean).join(' · ')}
                              </span>
                            </span>
                            <button
                              type="button"
                              disabled={act.isPending}
                              onClick={() => {
                                if (
                                  confirm(
                                    `¿Dar de baja ${s.room_code}? Si tiene histórico se archiva en vez de borrarse.`,
                                  )
                                ) {
                                  act.mutate({ kind: 'baja-sala', id: s.room_id })
                                }
                              }}
                              className="key key-quiet min-h-11 shrink-0 px-3 text-xs text-muted"
                            >
                              Dar de baja
                            </button>
                          </li>
                        ))}
                        {suyas.length === 0 && (
                          <li className="py-2 text-sm text-muted">Este edificio no tiene salas.</li>
                        )}
                      </ul>

                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <label className="text-xs text-muted">
                          Planta o zona
                          <input
                            type="text"
                            value={zona}
                            onChange={(e) => setZona(e.target.value)}
                            placeholder="1ª PLANTA"
                            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
                          />
                        </label>
                        <label className="text-xs text-muted">
                          Código de la sala
                          <input
                            type="text"
                            value={codigo}
                            autoCapitalize="characters"
                            autoCorrect="off"
                            spellCheck={false}
                            onChange={(e) => setCodigo(e.target.value)}
                            placeholder="1.7"
                            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 font-mono text-sm text-ink"
                          />
                        </label>
                        <label className="text-xs text-muted">
                          Nombre (opcional)
                          <input
                            type="text"
                            value={nombre}
                            onChange={(e) => setNombre(e.target.value)}
                            placeholder="Se queda con el código"
                            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
                          />
                        </label>
                        <label className="text-xs text-muted">
                          Tipo
                          <select
                            value={tipo}
                            onChange={(e) => setTipo(e.target.value as RoomKind)}
                            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
                          >
                            {TIPOS.map((t) => (
                              <option key={t.value} value={t.value}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={!codigo.trim() || act.isPending}
                          onClick={() =>
                            act.mutate({
                              kind: 'nueva-sala',
                              building: b.id,
                              zone: zona.trim(),
                              code: codigo.trim(),
                              name: nombre.trim(),
                              tipo,
                            })
                          }
                          className="key key-accent min-h-11 px-3 text-sm"
                        >
                          Añadir sala
                        </button>

                        {/* Borrar el edificio solo cuando está vacío. Con salas
                            dentro el servidor lo rechaza, y enseñar un botón que
                            solo sabe fallar es peor que no enseñarlo. */}
                        {suyas.length === 0 && (
                          <button
                            type="button"
                            disabled={act.isPending}
                            onClick={() => {
                              if (confirm(`¿Borrar el edificio ${b.code}?`)) {
                                act.mutate({ kind: 'borrar-edificio', id: b.id })
                              }
                            }}
                            className="key key-quiet min-h-11 px-3 text-sm text-muted"
                          >
                            Borrar el edificio
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      <div className="card mt-4 p-4">
        <p className="text-sm font-medium">Añadir un edificio</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[6rem_1fr_auto]">
          <label className="text-xs text-muted">
            Código
            <input
              type="text"
              value={codigoEd}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setCodigoEd(e.target.value)}
              placeholder="H"
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 font-mono text-sm text-ink"
            />
          </label>
          <label className="text-xs text-muted">
            Nombre
            <input
              type="text"
              value={nombreEd}
              onChange={(e) => setNombreEd(e.target.value)}
              placeholder="Edificio H"
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
            />
          </label>
          <button
            type="button"
            disabled={!codigoEd.trim() || !nombreEd.trim() || act.isPending}
            onClick={() =>
              act.mutate({ kind: 'nuevo-edificio', code: codigoEd.trim(), name: nombreEd.trim() })
            }
            className="key key-accent mt-1 min-h-11 self-end px-3 text-sm"
          >
            Añadir
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">
          El código es el sufijo con el que las incidencias nombran sus salas —«1.7 H»—, así que
          conviene que sea el que ya se usa por escrito.
        </p>
      </div>

      {(archivadas ?? []).length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-muted">
            Salas archivadas ({archivadas?.length ?? 0})
          </summary>
          <ul className="mt-2 divide-y divide-line-soft text-sm">
            {(archivadas ?? []).map((s) => (
              <li key={s.room_id} className="flex items-center gap-2 py-2">
                <span className="min-w-0 flex-1 truncate">
                  {s.building_code} · {displayRoomCode(s.room_code)}
                  <span className="ml-2 text-xs text-muted">
                    {[s.zone_name, s.room_name].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={act.isPending}
                  onClick={() => act.mutate({ kind: 'reactivar-sala', id: s.room_id })}
                  className="key key-quiet min-h-11 shrink-0 px-3 text-xs text-muted"
                >
                  Reactivar
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {act.isError && (
        <p className="mt-3 text-sm text-crit">
          {act.error instanceof Error ? act.error.message : 'No se ha podido aplicar.'}
        </p>
      )}
      {nota && !act.isPending && !act.isError && (
        <p aria-live="polite" className="mt-3 text-sm text-ok">
          {nota}
        </p>
      )}
    </section>
  )
}
