import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { SyncChip } from '@/components/SyncChip'
import { LockScreen } from '@/features/auth/LockScreen'
import { InspectionPage } from '@/features/inspection/InspectionPage'
import { RoomListPage } from '@/features/rooms/RoomListPage'
import { getSealed, shouldRelock, touch } from '@/auth/session'
import { db, requestPersistentStorage } from '@/db/dexie'
import { pullMaster } from '@/sync/pull'
import { startSync } from '@/sync/outbox'
import { supabase } from '@/lib/supabase'
import type { SealedSession } from '@/auth/pin'
import type { Building, Room } from '@/domain/types'

type View = { name: 'edificios' } | { name: 'salas'; building: Building } | { name: 'revision'; building: Building; room: Room }

export function App(): React.ReactElement {
  const [unlocked, setUnlocked] = useState(false)
  const [sealed, setSealed] = useState<SealedSession | null | undefined>(undefined)
  const [userId, setUserId] = useState<string | null>(null)
  const [view, setView] = useState<View>({ name: 'edificios' })

  const buildings = useLiveQuery(() => db.buildings.orderBy('sort_order').toArray(), [])

  // Al arrancar: ¿hay dispositivo dado de alta y la sesión sigue vigente?
  useEffect(() => {
    void (async () => {
      setSealed(await getSealed())
      if (!(await shouldRelock())) {
        const { data } = await supabase.auth.getSession()
        if (data.session) {
          setUserId(data.session.user.id)
          setUnlocked(true)
        }
      }
    })()
  }, [])

  useEffect(() => {
    if (!unlocked) return

    void requestPersistentStorage()
    void pullMaster()
    const stop = startSync()

    // Se marca actividad para que el bloqueo por inactividad sea justo.
    const onActivity = (): void => void touch()
    window.addEventListener('pointerdown', onActivity)
    document.addEventListener('visibilitychange', onActivity)

    return () => {
      stop()
      window.removeEventListener('pointerdown', onActivity)
      document.removeEventListener('visibilitychange', onActivity)
    }
  }, [unlocked])

  if (sealed === undefined) {
    return <div className="p-8 text-muted">Cargando…</div>
  }

  if (!unlocked) {
    return (
      <LockScreen
        sealed={sealed}
        onUnlocked={() => {
          void (async () => {
            const { data } = await supabase.auth.getSession()
            setUserId(data.session?.user.id ?? null)
            setUnlocked(true)
          })()
        }}
      />
    )
  }

  return (
    <div className="min-h-dvh">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-ground/95 px-4 py-2 backdrop-blur">
        <span className="eyebrow">Revisión de salas</span>
        <SyncChip />
      </div>

      {view.name === 'edificios' && (
        <ul className="divide-y divide-line">
          {(buildings ?? []).map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => setView({ name: 'salas', building: b })}
                className="flex w-full items-center gap-3 px-4 py-4 text-left"
              >
                <span className="w-12 shrink-0 font-mono text-sm font-semibold text-accent">
                  {b.code}
                </span>
                <span className="flex-1">{b.name}</span>
                {b.needs_review && (
                  <span className="rounded-full bg-warn/12 px-2 py-0.5 text-xs text-warn">
                    Sin identificar
                  </span>
                )}
              </button>
            </li>
          ))}
          {buildings?.length === 0 && (
            <li className="p-6 text-sm text-muted">
              Aún no hay datos en este dispositivo. Conéctate una vez para descargarlos.
            </li>
          )}
        </ul>
      )}

      {view.name === 'salas' && (
        <RoomListPage
          building={view.building}
          onBack={() => setView({ name: 'edificios' })}
          onPick={(room) => setView({ name: 'revision', building: view.building, room })}
        />
      )}

      {view.name === 'revision' && (
        <InspectionPage
          room={view.room}
          userId={userId}
          buildingName={view.building.name}
          onBack={() => setView({ name: 'salas', building: view.building })}
          onDone={() => setView({ name: 'salas', building: view.building })}
        />
      )}
    </div>
  )
}
