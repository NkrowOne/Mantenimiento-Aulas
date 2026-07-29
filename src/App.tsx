import { Suspense, lazy, useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { SyncChip } from '@/components/SyncChip'
import { UpdatePrompt } from '@/components/UpdatePrompt'
import { LockScreen } from '@/features/auth/LockScreen'
import { InspectionPage } from '@/features/inspection/InspectionPage'
import { RoomListPage } from '@/features/rooms/RoomListPage'
import { BuscadorGlobal } from '@/features/rooms/BuscadorGlobal'
import { nextRoom, type RoomOrder } from '@/features/rooms/orden'

import { getSealed, lock, resumeSession, touch } from '@/auth/session'
import { db, purgeSyncedInspections, requestPersistentStorage } from '@/db/dexie'
import { pullMaster } from '@/sync/pull'
import { startSync } from '@/sync/outbox'
import { configError, supabase } from '@/lib/supabase'
import type { SealedSession } from '@/auth/pin'
import type { Building, Role, Room } from '@/domain/types'

/*
 * Todo lo que no es revisar un aula se carga aparte.
 *
 * El panel arrastra ECharts, que pesa más que todo lo demás junto. Y las otras
 * cuatro pantallas las esconde el rol —un técnico no puede abrir Informes ni
 * Datos— pero se descargaban igual: el arranque traía «Fusionar con», «Bajo
 * mínimo» y la bandeja de cuarentena a un dispositivo que nunca los va a
 * enseñar. Y el arranque ocurre justo con la peor cobertura, al llegar al
 * edificio.
 */
const DashboardPage = lazy(() =>
  import('@/features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
)
const IncidentsPage = lazy(() =>
  import('@/features/incidents/IncidentsPage').then((m) => ({ default: m.IncidentsPage })),
)
const StockPage = lazy(() =>
  import('@/features/inventory/StockPage').then((m) => ({ default: m.StockPage })),
)
const CleanupPage = lazy(() =>
  import('@/features/admin/CleanupPage').then((m) => ({ default: m.CleanupPage })),
)
const ReportsPage = lazy(() =>
  import('@/features/reports/ReportsPage').then((m) => ({ default: m.ReportsPage })),
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
  const [roomOrder, setRoomOrder] = useState<RoomOrder>('antiguedad')
  // Hasta que se intenta rehidratar no se pinta la lista de edificios: si no,
  // se vería un parpadeo desde la raíz hasta donde estabas.
  const [restaurado, setRestaurado] = useState(false)

  const buildings = useLiveQuery(() => db.buildings.orderBy('sort_order').toArray(), [])

  // La planta de la sala en revisión. Va en la cabecera porque un código como
  // `-2.1` leído sin ella parece un sótano cualquiera.
  const zoneName =
    useLiveQuery(
      async () =>
        view.name === 'revision' ? (await db.zones.get(view.room.zone_id))?.name : undefined,
      [view],
    ) ?? ''

  /*
   * Las salas del edificio en curso, para poder saltar a «la siguiente».
   *
   * Se calcula con el MISMO orden que muestra la lista. Si cada una ordenara por
   * su cuenta, la siguiente sala sería una distinta de la que el técnico ve
   * primera, y eso solo se nota cuando ya te has equivocado de aula.
   */
  const buildingId = view.name === 'edificios' ? null : view.building.id
  const rondaActual = useLiveQuery(async () => {
    if (!buildingId) return null
    const zones = await db.zones.where('building_id').equals(buildingId).toArray()
    const zoneIds = new Set(zones.map((z) => z.id))
    return {
      rooms: await db.rooms.filter((r) => zoneIds.has(r.zone_id)).toArray(),
      zones: new Map(zones.map((z) => [z.id, z])),
    }
  }, [buildingId])

  useEffect(() => {
    void (async () => {
      setSealed(await getSealed())
      // Reanuda sin PIN si la pestaña sigue viva y no se ha superado el tiempo
      // de inactividad. Antes esto no funcionaba nunca: el cliente de Supabase
      // va sin persistencia, así que getSession() devolvía null tras cualquier
      // recarga y la app volvía a pedir el PIN una y otra vez.
      if (await resumeSession()) {
        const { data } = await supabase.auth.getUser()
        setUserId(data.user?.id ?? null)
        setUnlocked(true)
      }
    })()
  }, [])

  /*
   * Recuperar el sitio.
   *
   * Toda la navegación era estado en memoria: cerrar la pestaña, que iOS
   * descargue la aplicación de fondo o simplemente recargar dejaba al técnico en
   * la raíz. Con 23 edificios y hasta 39 salas por edificio, volver a donde
   * estabas eran dos toques y dos rastreos visuales — de pie, cada vez.
   *
   * Se guarda solo la ubicación, que es lo barato y lo que se pierde. El trabajo
   * en sí ya sobrevive por otro camino: está en Dexie y respaldado en el servidor.
   */
  useEffect(() => {
    if (!unlocked || restaurado) return

    void (async () => {
      try {
        const guardado = (await db.meta.get('ultima-vista'))?.value as
          | { tab?: Tab; buildingId?: string; roomId?: string }
          | undefined

        if (guardado?.tab) setTab(guardado.tab)

        if (guardado?.buildingId) {
          const building = await db.buildings.get(guardado.buildingId)
          if (building) {
            const room = guardado.roomId ? await db.rooms.get(guardado.roomId) : undefined
            setView(room ? { name: 'revision', building, room } : { name: 'salas', building })
          }
        }
      } finally {
        setRestaurado(true)
      }
    })()
  }, [unlocked, restaurado])

  useEffect(() => {
    if (!unlocked || !restaurado) return
    void db.meta.put({
      key: 'ultima-vista',
      value: {
        tab,
        buildingId: view.name === 'edificios' ? null : view.building.id,
        roomId: view.name === 'revision' ? view.room.id : null,
      },
    })
  }, [unlocked, restaurado, tab, view])

  useEffect(() => {
    if (!unlocked) return

    void requestPersistentStorage()
    void pullMaster()
    // Las revisiones cerradas y ya subidas no tienen por qué seguir aquí: nadie
    // las purgaba y crecía una fila por aula revisada, para siempre.
    void purgeSyncedInspections()
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

  // Sin configuración no hay nada que hacer, y decirlo es infinitamente mejor
  // que una página en blanco: quien despliega sabe al instante qué falta.
  if (configError) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-8">
        <div className="card max-w-md p-6">
          <h1 className="font-semibold text-crit">Configuración incompleta</h1>
          <p className="mt-2 text-sm text-muted">{configError}</p>
          <p className="mt-3 text-sm text-muted">
            Estas variables se compilan dentro de la aplicación: añádelas al
            <span className="font-mono"> .env</span> y vuelve a construirla con
            <span className="font-mono"> npm run build</span>.
          </p>
        </div>
      </div>
    )
  }

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
  const inspecting = tab === 'revisar' && view.name === 'revision'

  return (
    <div className={`min-h-dvh ${inspecting ? '' : 'pb-20'}`}>
      {/* Sin `backdrop-blur`: obliga a WebKit a recapturar y desenfocar el fondo
          en cada frame de desplazamiento —de lo más caro que se puede poner en un
          `sticky` de un iPad— y aquí ni se veía: `--ground` es un color sólido y
          el 95% dejaba pasar un 5% de nada. */}
      <header className="sticky top-0 z-10 border-b border-line bg-ground">
        <div className="flex items-center justify-between gap-2 px-4 py-2">
          <span className="eyebrow truncate">Aulas</span>
          <div className="flex shrink-0 items-center gap-2">
            <SyncChip />
            <button
              type="button"
              onClick={() => {
                // Es la única forma de que la sesión termine: no caduca sola.
                // Por eso se confirma — cerrarla sin querer obliga a teclear el
                // PIN otra vez en mitad de una ronda.
                if (confirm('¿Cerrar sesión?')) {
                  void lock().then(() => setUnlocked(false))
                }
              }}
              className="key key-quiet px-3 py-1.5 text-xs font-medium text-muted"
              title="La sesión no caduca sola: solo termina aquí."
            >
              Cerrar sesión
            </button>
          </div>
        </div>
      </header>

      {tab === 'revisar' && view.name === 'edificios' && (
        <>
          <BuscadorGlobal
            onPick={(building, room) => setView({ name: 'revision', building, room })}
          />
        <ul className="divide-y divide-line">
          {(buildings ?? []).map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => setView({ name: 'salas', building: b })}
                className="flex w-full items-center gap-3 px-4 py-4 text-left transition-colors duration-100 active:bg-raised"
              >
                <span className="w-14 shrink-0 font-mono text-sm font-semibold text-accent">
                  {b.code}
                </span>
                <span className="flex-1">{b.name}</span>
                {b.needs_review && (
                  <span className="rounded-tag bg-warn-tint px-2 py-0.5 text-xs text-warn">
                    Sin identificar
                  </span>
                )}
              </button>
            </li>
          ))}
          {buildings?.length === 0 && (
            <li className="p-6 text-sm text-muted">
              Sin datos. Conéctate una vez para descargarlos.
            </li>
          )}
        </ul>
        </>
      )}

      {tab === 'revisar' && view.name === 'salas' && (
        <RoomListPage
          building={view.building}
          order={roomOrder}
          onOrderChange={setRoomOrder}
          onBack={() => setView({ name: 'edificios' })}
          onPick={(room) => setView({ name: 'revision', building: view.building, room })}
        />
      )}

      {tab === 'revisar' && view.name === 'revision' && (
        <InspectionPage
          room={view.room}
          userId={userId}
          buildingName={view.building.name}
          zoneName={zoneName}
          onBack={() => setView({ name: 'salas', building: view.building })}
          /*
            «Guardar y siguiente sala» salta de verdad a la siguiente.
            Antes este manejador ignoraba el parámetro, así que los dos botones
            de la barra hacían exactamente lo mismo: el que ocupa dos tercios
            prometía encadenar salas y devolvía a la lista.

            Funciona porque `complete()` ya ha marcado la sala como revisada en
            local, así que con el orden por antigüedad la recién terminada cae al
            final y la primera del resto es la que toca.
          */
          onDone={(encadenar) => {
            const siguiente =
              encadenar && rondaActual
                ? nextRoom(rondaActual.rooms, rondaActual.zones, roomOrder, view.room.id)
                : null

            setView(
              siguiente
                ? { name: 'revision', building: view.building, room: siguiente }
                : { name: 'salas', building: view.building },
            )
          }}
        />
      )}

      {tab !== 'revisar' && (
        <Suspense fallback={<p className="p-6 text-muted">Cargando…</p>}>
          {tab === 'panel' && <DashboardPage />}
          {tab === 'incidencias' && <IncidentsPage />}
          {tab === 'almacen' && <StockPage />}
          {tab === 'informes' && <ReportsPage />}
          {tab === 'datos' && <CleanupPage />}
        </Suspense>
      )}

      {/* La navegación se queda abajo: es donde llega el pulgar sin recolocar
          la mano, y respeta la zona de gestos del iPhone.
          Se oculta durante la revisión, que tiene su propia barra de acción en
          esa misma posición: con las dos, los botones de guardar quedaban
          debajo y no se podían pulsar. */}
      {!inspecting && (
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
                className={`flex h-touch w-full items-center justify-center whitespace-nowrap px-3 text-xs font-medium ${
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
      )}

      {/* El aviso lleva z-30 y la barra de la revisión vive en la misma esquina:
          su «Actualizar» caía justo donde está «Guardar y siguiente sala», así
          que el pulgar recargaba la aplicación en mitad de un aula. Reaparece al
          volver a la lista, que es cuando recargar no cuesta nada. */}
      {!inspecting && <UpdatePrompt />}
    </div>
  )
}
