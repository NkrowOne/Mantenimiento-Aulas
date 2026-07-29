/**
 * Bandeja de borradores.
 *
 * Existe por una razón muy concreta: la ficha de sala deja guardar aportando
 * **solo la sala**, y permitir aplazar sin dar un sitio evidente donde se
 * acumule lo aplazado convierte «lo relleno luego» en «no se rellenó nunca».
 * Que es, literalmente, el problema del Excel del que se venía huyendo.
 *
 * Ordenada por antigüedad y no por fecha de creación descendente: las de arriba
 * son las que llevan más tiempo sin completarse, o sea las que corren peligro de
 * no completarse jamás. Un orden que enseñe primero lo recién creado esconde
 * exactamente lo que hay que despachar.
 *
 * Pensada para el escritorio, no para el pasillo: registrar es de pie, completar
 * es sentado.
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

export function DraftsPage(): React.ReactElement {
  const qc = useQueryClient()
  const [editando, setEditando] = useState<string | null>(null)
  const [titulo, setTitulo] = useState('')
  const [ref, setRef] = useState('')

  // El nombre de cada sala, del espejo local: la bandeja trae `room_id` y sin
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

  const { data: borradores, isPending, isError, refetch } = useQuery({
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

  return (
    <div className="mx-auto max-w-3xl p-4">
      <header className="mb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Borradores</h1>
          {pendientes.length > 0 && (
            <span className="rounded-tag bg-warn-tint px-2 py-0.5 text-xs font-semibold text-warn">
              {pendientes.length} sin completar
            </span>
          )}
        </div>
        <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-muted">
          Lo que se guardó en el pasillo con solo la sala. Las más antiguas, primero: son las que
          corren peligro de no completarse nunca.
        </p>
      </header>

      {isPending && <p className="mt-6 text-sm text-muted">Cargando…</p>}

      {isError && (
        <div className="card mt-6 p-4">
          <p className="text-sm text-crit">No se han podido leer los borradores.</p>
          <p className="mt-1 text-sm text-muted">Esta pantalla necesita conexión.</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="key key-quiet mt-3 min-h-11 px-3 text-sm"
          >
            Reintentar
          </button>
        </div>
      )}

      {!isPending && !isError && pendientes.length === 0 && (
        <p className="mt-6 text-sm text-muted">
          Nada pendiente de completar. Es exactamente donde hay que estar.
        </p>
      )}

      <ul className="divide-y divide-line border-t border-line">
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
                  className="w-full rounded-ctl border border-line bg-surface p-3 text-sm"
                />
                {/* Igual que en la ficha: una observación no genera ticket, así
                    que pedirle el código sería pedir algo que no existe. */}
                {b.kind !== 'observacion' && (
                  <input
                    value={ref}
                    onChange={(e) => setRef(e.target.value)}
                    placeholder="Código de ticket (opcional)"
                    className="mt-2 h-11 w-full rounded-ctl border border-line bg-surface px-3 font-mono text-sm"
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
    </div>
  )
}
