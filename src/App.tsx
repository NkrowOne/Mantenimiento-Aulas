import { Suspense, lazy, useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { SyncChip } from '@/components/SyncChip'
import { UpdatePrompt } from '@/components/UpdatePrompt'
import { LockScreen } from '@/features/auth/LockScreen'
import { InspectionPage } from '@/features/inspection/InspectionPage'
import { RoomListPage } from '@/features/rooms/RoomListPage'
import { IncidentsPage } from '@/features/incidents/IncidentsPage'
import { StockPage } from '@/features/inventory/StockPage'
import { CleanupPage } from '@/features/admin/CleanupPage'
import { ReportsPage } from '@/features/reports/ReportsPage'

import { getSealed, shouldRelock, touch } from '@/auth/session'
import { db, requestPersistentStorage } from '@/db/dexie'
import { pullMaster } from '@/sync/pull'
import { startSync } from '@/sync/outbox'
import { supabase } from '@/lib/supabase'
import type { SealedSession } from '@/auth/pin'
import type { Building, Role, Room } from '@/domain/types'

// El panel arrastra ECharts, que pesa más que todo lo demás junto. Cargarlo
// aparte deja el arranque ligero para quien solo va a revisar aulas, que es el
// caso mayoritario y el que ocurre con peor cobertura.
const DashboardPage = lazy(() =>
  import('@/features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
)

type Tab = 'revisar' | 'panel' | 'incidencias' | 'almacen' | 'informes' | 'datos'

type RoomView =
  | { name: 'edificios' }
  | { name: 'salas'; building: Building }
  | { name: 'revision'; building: Building; room: Room }

const TABS: Array<{ id: Tab; label: string; minRole: Role }> = [
  { id: 'revisar', label: 'Revisar', minRole: 'tecnico' },
  { id: 'panel', label: 'Panel', minRole: 'tecnico' },
  { id: 'incidencias', label: 'Incidencias', minRole: 'tecnico' },
  { id: 'almacen', label: 'Almacén', minRole: 'tecnico' },
  { id: 'informes', label: 'Informes', minRole: 'supervisor' },
  { id: 'datos', label: 'Datos', minRole: 'admin' },
]

const RANK: Record<Role, number> = { tecnico: 0, supervisor: 1, admin: 2 }

export function App(): React.ReactElement {
  const [unlocked, setUnlocked] = useState(false)
  const [sealed, setSealed] = useState<SealedSession | null | undefined>(undefined)
  const [userId, setUserId] = useState<string | null>(null)
  const [role, setRole] = useState<Role>('tecnico')
  const [tab, setTab] = useState<Tab>('revisar')
  const [view, setView] = useState<RoomView>({ name: 'edificios' })

  const buildings = useLiveQuery(() => db.buildings.orderBy('sort_order').toArray(), [])

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
    void (async () => {
      const { data } = await supabase.auth.getUser()
      if (!data.user) return
      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', data.user.id)
        .single()
      if (profile?.role) setRole(profile.role as Role)
    })()

    const stop = startSync()
    const onActivity = (): void => void touch()
    window.addEventListener('pointerdown', onActivity)
    document.addEventListener('visibilitychange', onActivity)

    return () => {
      stop()
      window.removeEventListener('pointerdown', onActivity)
      document.removeEventListener('visibilitychange', onActivity)
    }
  }, [unlocked])

  if (sealed === undefined) return <div className="p-8 text-muted">Cargando…</div>

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

  const visibleTabs = TABS.filter((t) => RANK[role] >= RANK[t.minRole])

  return (
    <div className="min-h-dvh pb-20">
      <header className="sticky top-0 z-10 border-b border-line bg-ground/95 backdrop-blur">
        <div className="flex items-center justify-between px-4 py-2">
          <span className="eyebrow">Mantenimiento de aulas</span>
          <SyncChip />
        </div>
      </header>

      {tab === 'revisar' && view.name === 'edificios' && (
        <ul className="divide-y divide-line">
          {(buildings ?? []).map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => setView({ name: 'salas', building: b })}
                className="flex w-full items-center gap-3 px-4 py-4 text-left"
              >
                <span className="w-14 shrink-0 font-mono text-sm font-semibold text-accent">
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

      {tab === 'revisar' && view.name === 'salas' && (
        <RoomListPage
          building={view.building}
          onBack={() => setView({ name: 'edificios' })}
          onPick={(room) => setView({ name: 'revision', building: view.building, room })}
        />
      )}

      {tab === 'revisar' && view.name === 'revision' && (
        <InspectionPage
          room={view.room}
          userId={userId}
          buildingName={view.building.name}
          onBack={() => setView({ name: 'salas', building: view.building })}
          onDone={() => setView({ name: 'salas', building: view.building })}
        />
      )}

      {tab === 'panel' && (
        <Suspense fallback={<p className="p-6 text-muted">Cargando el panel…</p>}>
          <DashboardPage />
        </Suspense>
      )}
      {tab === 'incidencias' && <IncidentsPage />}
      {tab === 'almacen' && <StockPage />}
      {tab === 'informes' && <ReportsPage />}
      {tab === 'datos' && <CleanupPage />}

      {/* La navegación se queda abajo: es donde llega el pulgar sin recolocar
          la mano, y respeta la zona de gestos del iPhone. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <ul className="scroll-x flex">
          {visibleTabs.map((t) => (
            <li key={t.id} className="flex-1">
              <button
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? 'page' : undefined}
                className={`w-full whitespace-nowrap px-3 py-3 text-xs font-medium ${
                  tab === t.id
                    ? 'border-t-2 border-accent -mt-px text-accent'
                    : 'text-muted'
                }`}
              >
                {t.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <UpdatePrompt />
    </div>
  )
}
