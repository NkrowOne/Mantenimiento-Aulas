/**
 * Borradores sin completar.
 *
 * Existe por una razón muy concreta: la ficha de sala deja guardar aportando
 * **solo la sala**, y permitir aplazar sin dar un sitio evidente donde se
 * acumule lo aplazado convierte «lo relleno luego» en «no se rellenó nunca».
 * Que es, literalmente, el problema del Excel del que se venía huyendo.
 *
 * Pero eso no justifica una pestaña propia, y tenerla era un error.
 *
 * Un borrador es una incidencia a medio escribir: la misma tabla, la misma
 * pantalla, otro estado. Sacarla a la barra de navegación ponía un destino
 * permanente —visible en las seis pantallas, todo el día, para los 276 usuarios—
 * a algo que casi siempre está vacío. Una pestaña que la mayor parte del tiempo
 * lleva a «nada pendiente» enseña a no pulsarla, y el día que sí tenga algo ya
 * nadie la mira.
 *
 * Así que vive DENTRO de Incidencias, arriba, y **no se dibuja cuando no hay
 * ninguno**: sin borradores, esto no ocupa un píxel ni deja un hueco.
 *
 * Ordenados por antigüedad y no por fecha de creación descendente: los de arriba
 * son los que llevan más tiempo sin completarse, o sea los que corren peligro de
 * no completarse jamás. Un orden que enseñe primero lo recién creado esconde
 * exactamente lo que hay que despachar.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { displayRoomCode } from '@/domain/normalize'
import { fechaCorta } from '@/domain/fechas'
import { INCIDENT_KIND_LABELS, type IncidentKind } from '@/domain/types'

interface Borrador {
  id: string
  room_id: string | null
  kind: IncidentKind
  title: string | null
  external_ref: string | null
  opened_at: string
}

/**
 * Silencio absoluto cuando no hay nada.
 *
 * Ni cabecera, ni «ninguno pendiente», ni un hueco donde estaba: no hay noticia,
 * así que no hay nada que decir. Un aviso que informa de que no pasa nada es
 * exactamente el ruido que hay que quitar de una pantalla que se mira todos los
 * días — y es la razón de que esto ya no sea una pestaña.
 *
 * Tampoco se dice nada mientras carga ni si falla: esto es un añadido a la
 * pantalla de incidencias, y un tropiezo suyo no debe ensuciar la lista que el
 * usuario venía a ver. La lista de abajo ya avisa si el servidor no responde.
 *
 * Va aparte del componente para poder probarlo: es la regla que mantiene la
 * pantalla limpia, y una regla que se puede romper sin que salte nada acaba
 * rota.
 */
export function hayQueMostrar(estado: {
  cargando: boolean
  fallo: boolean
  cuantos: number
}): boolean {
  return !estado.cargando && !estado.fallo && estado.cuantos > 0
}

export function Borradores(): React.ReactElement | null {
  const qc = useQueryClient()
  const [editando, setEditando] = useState<string | null>(null)
  const [titulo, setTitulo] = useState('')
  const [ref, setRef] = useState('')

  // El nombre de cada sala, del espejo local: la consulta trae `room_id` y sin
  // resolverlo diría qué pasa pero no dónde, que es la mitad del dato.
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

  const { data: borradores, isPending, isError } = useQuery({
    queryKey: ['borradores'],
    queryFn: async (): Promise<Borrador[]> => {
      const { data, error } = await supabase
        .from('incidents')
        .select('id, room_id, kind, title, external_ref, opened_at')
        .eq('state', 'borrador')
        // Las más antiguas primero: son las que hay que despachar.
        .order('opened_at', { ascending: true })
      if (error) throw error
      return (data ?? []) as Borrador[]
    },
  })

  const completar = useMutation({
    mutationFn: async (input: { id: string; title: string; ref: string }) => {
      const { error } = await supabase
        .from('incidents')
        .update({
          title: input.title.trim(),
          external_ref: input.ref.trim() || null,
          state: 'abierta',
        })
        .eq('id', input.id)
      if (error) throw error
    },
    onSuccess: () => {
      setEditando(null)
      void qc.invalidateQueries({ queryKey: ['borradores'] })
      void qc.invalidateQueries({ queryKey: ['incidents'] })
    },
  })

  const pendientes = borradores ?? []

  if (!hayQueMostrar({ cargando: isPending, fallo: isError, cuantos: pendientes.length })) {
    return null
  }

  return (
    <section aria-labelledby="sec-borradores" className="section-tail mt-6">
      <div className="section-head">
        <h2 id="sec-borradores" className="eyebrow">
          Sin completar
        </h2>
        <span className="rounded-tag bg-warn-tint px-2 py-0.5 text-xs font-semibold text-warn">
          {pendientes.length}
        </span>
      </div>

      <p className="mb-3 max-w-prose text-sm leading-relaxed text-muted">
        Se guardaron en el pasillo con solo la sala. Los más antiguos, primero.
      </p>

      <ul className="divide-y divide-line-soft border-y border-line bg-surface px-4">
        {pendientes.map((b) => (
          <li key={b.id} className="py-4">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <span className="rounded-tag bg-raised px-2 py-0.5 text-xs font-medium text-muted">
                {INCIDENT_KIND_LABELS[b.kind]}
              </span>
              <span className="font-mono text-sm font-semibold text-accent">
                {b.room_id ? (salas?.get(b.room_id) ?? '—') : 'Sin sala'}
              </span>
              <span className="font-mono text-xs tabular text-muted">
                {fechaCorta(b.opened_at)}
              </span>
            </div>

            <p className="mt-2 text-sm leading-relaxed">
              {b.title || <span className="text-muted">Sin describir</span>}
            </p>

            {editando === b.id ? (
              <form
                className="mt-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!titulo.trim()) return
                  completar.mutate({ id: b.id, title: titulo, ref })
                }}
              >
                <textarea
                  value={titulo}
                  onChange={(e) => setTitulo(e.target.value)}
                  rows={2}
                  autoFocus
                  placeholder="Qué ocurre"
                  className="w-full rounded-ctl border border-line bg-surface p-3 text-base"
                />
                {/* Igual que en la ficha: una observación no genera ticket, así
                    que pedirle el código sería pedir algo que no existe. */}
                {b.kind !== 'observacion' && (
                  <input
                    value={ref}
                    onChange={(e) => setRef(e.target.value)}
                    placeholder="Código de ticket (opcional)"
                    className="mt-2 h-11 w-full rounded-ctl border border-line bg-surface px-3 font-mono text-base"
                  />
                )}
                {completar.isError && (
                  <p className="mt-2 text-sm text-crit">
                    {completar.error instanceof Error
                      ? completar.error.message
                      : 'No se ha podido completar.'}
                  </p>
                )}
                <div className="mt-2 flex gap-2">
                  <button
                    type="submit"
                    disabled={completar.isPending || !titulo.trim()}
                    className="key key-accent min-h-11 px-3 text-sm"
                  >
                    {completar.isPending ? 'Guardando…' : 'Completar y abrir'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditando(null)}
                    className="key key-quiet min-h-11 px-3 text-sm"
                  >
                    Cancelar
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setEditando(b.id)
                  setTitulo(b.title ?? '')
                  setRef(b.external_ref ?? '')
                }}
                className="key key-quiet mt-2 min-h-11 px-3 text-sm"
              >
                Completar
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
