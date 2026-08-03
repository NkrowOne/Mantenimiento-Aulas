import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { InsigniaAveria, detalleDeAverias } from '@/components/InsigniaAveria'
import { SyncChip } from '@/components/SyncChip'
import { UpdatePrompt } from '@/components/UpdatePrompt'
import { LockScreen } from '@/features/auth/LockScreen'
import { Diagnostico } from '@/features/admin/Diagnostico'
import { InspectionPage } from '@/features/inspection/InspectionPage'
import type { Correccion } from '@/features/inspection/useInspection'
import { RoomListPage } from '@/features/rooms/RoomListPage'
import { BuscadorGlobal } from '@/features/rooms/BuscadorGlobal'
import { averiasPorEdificio, averiasPorSala } from '@/features/rooms/averias'
import { nextRoom, type RoomOrder } from '@/features/rooms/orden'

import { getSealed, lock, resumeSession, touch, watchSession } from '@/auth/session'
import { marcarTrabajoDelicado } from '@/sw'
import { db, pendingSummary, purgeSyncedInspections, requestPersistentStorage } from '@/db/dexie'
import { pullMaster, startPull, type ResultadoPull } from '@/sync/pull'
import { startSync } from '@/sync/outbox'
import { configError, supabase } from '@/lib/supabase'
import { PARAM_SALA, salaDeLaUrl, salaDeTextoQR } from '@/lib/enlace-sala'
import type { SealedSession } from '@/auth/pin'
import { OVERDUE_INSPECTION_DAYS, type Building, type Role, type Room } from '@/domain/types'

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
const RoomSheet = lazy(() =>
  import('@/features/rooms/RoomSheet').then((m) => ({ default: m.RoomSheet })),
)
/* La hoja de placas arrastra el codificador de QR, y solo se abre para imprimir
   etiquetas: una o dos veces en la vida del despliegue. No tiene por qué viajar
   en el arranque, que ocurre justo con la peor cobertura. */
const PlateSheet = lazy(() =>
  import('@/features/rooms/PlateSheet').then((m) => ({ default: m.PlateSheet })),
)
const HistorialPage = lazy(() =>
  import('@/features/history/HistorialPage').then((m) => ({ default: m.HistorialPage })),
)
const ReportsPage = lazy(() =>
  import('@/features/reports/ReportsPage').then((m) => ({ default: m.ReportsPage })),
)
/* La cámara y el lector de QR solo se descargan cuando alguien va a escanear. */
const EscanerQR = lazy(() =>
  import('@/features/rooms/EscanerQR').then((m) => ({ default: m.EscanerQR })),
)

type Tab = 'revisar' | 'panel' | 'incidencias' | 'almacen' | 'historial' | 'informes' | 'datos'

/*
 * La ficha se intercala entre la lista y la revisión, pero solo por ese camino.
 * El QR de la puerta y el buscador global siguen entrando directos a revisar:
 * quien escanea una pegatina ya sabe dónde está y a qué viene, y cobrarle un
 * toque por información que no ha pedido convertiría el camino corto en uno
 * largo. Por eso la revisión recuerda de dónde vino: volver tiene que devolver
 * al sitio del que se salió, no a uno que no se ha visto nunca.
 */
type RoomView =
  | { name: 'edificios' }
  | { name: 'salas'; building: Building }
  | {
      name: 'revision'
      building: Building
      room: Room
      desdeFicha?: boolean
      /**
       * La revisión que se está corrigiendo, si esto es una corrección.
       *
       * Viaja por la vista y no por un estado aparte porque es parte de «dónde
       * estoy»: la misma pantalla, la misma sala y un trabajo distinto. Lleva
       * dentro lo que contestó aquella visita, que es lo que evita que corregir
       * sea rellenarlo todo otra vez.
       */
      correccion?: Correccion
    }
  /*
   * La ficha de la sala.
   *
   * Es lo primero que se abre al tocar un aula en la lista: lo que uno se
   * pregunta llegando a la puerta —qué hay aquí, esto ya falló, queda algo
   * abierto— viene antes que rellenar comprobaciones, y desde la ficha se
   * empieza la revisión con un botón que ocupa el ancho.
   *
   * El camino corto sigue intacto y es lo que importa: el QR de la puerta y el
   * buscador global entran DIRECTOS a revisar. Quien escanea una pegatina ya
   * sabe dónde está y a qué viene; cobrarle una pantalla intermedia convertiría
   * el atajo en un rodeo, y son 276 salas en una ronda.
   *
   * `volverA` existe porque a la ficha se llega por dos sitios —la lista y la
   * placa de la cabecera de la revisión— y volver tiene que devolver al sitio
   * del que se salió, no a uno que no se ha visto.
   */
  | {
      name: 'ficha'
      building: Building
      room: Room
      volverA: 'salas' | 'revision'
      /**
       * De dónde se ha venido, cuando se ha venido de otra pestaña.
       *
       * A la ficha se llega ahora también desde una incidencia y desde una línea
       * del historial, y volver tiene que devolver AHÍ: a la lista que se estaba
       * triando, con su búsqueda y su desplazamiento. Sin esto, «Volver» dejaría
       * al supervisor en la lista de aulas de un edificio que no había abierto, y
       * el camino de vuelta a su cola de trabajo serían tres toques.
       *
       * Guarda la vista de «Revisar» tal y como estaba para poder restituirla:
       * pasar por una incidencia no puede tirar la ronda a medias.
       */
      regreso?: { tab: Tab; view: RoomView }
      /** A qué se ha venido. Lo usa la ficha para abrir por donde toca. */
      enfocar?: 'incidencias'
    }
  /* La hoja de placas del edificio. Vive aquí y no en «Datos» porque se imprime
     desde donde se está trabajando: se decide etiquetar un edificio cuando se
     está recorriendo ese edificio. */
  | { name: 'placas'; building: Building }

const TABS: Array<{ id: Tab; label: string; minRole: Role }> = [
  { id: 'revisar', label: 'Revisar', minRole: 'tecnico' },
  { id: 'panel', label: 'Panel', minRole: 'tecnico' },
  { id: 'incidencias', label: 'Incidencias', minRole: 'tecnico' },
  { id: 'almacen', label: 'Almacén', minRole: 'tecnico' },
  { id: 'historial', label: 'Historial', minRole: 'tecnico' },
  { id: 'informes', label: 'Informes', minRole: 'supervisor' },
  { id: 'datos', label: 'Datos', minRole: 'admin' },
]

const RANK: Record<Role, number> = { tecnico: 0, supervisor: 1, admin: 2 }

/**
 * Por qué la lista está vacía.
 *
 * «Sin datos. Conéctate una vez para descargarlos.» era la respuesta a las tres
 * situaciones a la vez: sin red, servidor vacío y servidor que no deja leer. Las
 * tres piden cosas distintas de quien lo lee, y la tercera —RLS devolviendo cero
 * filas sin error— es justo la que se pasa semanas sin diagnosticar, porque
 * desde el iPad se ve idéntica a «aún no me he conectado».
 */
function SinDatos({
  diagnostico,
  onReintentar,
}: {
  diagnostico: ResultadoPull | null
  onReintentar: () => void
}): React.ReactElement {
  return (
    <div className="card p-4">
      {diagnostico?.error ? (
        <>
          <p className="text-sm font-medium text-crit">No se han podido descargar los datos.</p>
          <p className="mt-2 text-sm text-muted">{diagnostico.error}</p>
          {diagnostico.fallos.length > 0 && (
            <ul className="mt-2 space-y-1 font-mono text-xs text-muted">
              {diagnostico.fallos.map((f) => (
                <li key={f.tabla}>
                  {f.tabla}: {f.code ? `[${f.code}] ` : ''}
                  {f.mensaje}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="text-sm text-muted">
          Sin datos todavía. Conéctate una vez para descargarlos.
        </p>
      )}
      <button type="button" onClick={onReintentar} className="key key-quiet mt-3 min-h-11 px-3 text-sm">
        Reintentar descarga
      </button>
      <Diagnostico />
    </div>
  )
}

export function App(): React.ReactElement {
  const [unlocked, setUnlocked] = useState(false)
  const [sealed, setSealed] = useState<SealedSession | null | undefined>(undefined)
  const [userId, setUserId] = useState<string | null>(null)
  const [role, setRole] = useState<Role>('tecnico')
  /*
   * Por qué el rol es el que es, y por qué no hay datos.
   *
   * Los dos se resolvían en silencio: si la consulta del perfil fallaba, el rol
   * se quedaba en el `tecnico` inicial y un administrador se encontraba la
   * aplicación sin las pestañas de Informes y Datos sin una sola pista de por
   * qué. Y si el servidor no devolvía filas, la lista decía «Sin datos» tanto si
   * el servidor estaba vacío como si RLS estaba bloqueando todas las lecturas.
   * Nada de esto se puede diagnosticar desde un iPad si la aplicación no lo
   * cuenta: no hay consola donde mirar.
   */
  const [rolError, setRolError] = useState<string | null>(null)
  /** Se escaneó una placa cuya sala no está en este dispositivo. */
  const [escaneoFallido, setEscaneoFallido] = useState<string | null>(null)
  const [diagnostico, setDiagnostico] = useState<ResultadoPull | null>(null)

  const [tab, setTab] = useState<Tab>('revisar')
  const [view, setView] = useState<RoomView>({ name: 'edificios' })
  const [roomOrder, setRoomOrder] = useState<RoomOrder>('antiguedad')
  const [escaneando, setEscaneando] = useState(false)
  const [avisoQR, setAvisoQR] = useState<string | null>(null)
  // Hasta que se intenta rehidratar no se pinta la lista de edificios: si no,
  // se vería un parpadeo desde la raíz hasta donde estabas.
  const [restaurado, setRestaurado] = useState(false)

  const buildings = useLiveQuery(() => db.buildings.orderBy('sort_order').toArray(), [])

  /* Cuánto trabajo hay sin subir. Solo se usa para no dejar cerrar sesión a
     ciegas encima de una cola llena. */
  const sinSubir = useLiveQuery(async () => (await pendingSummary()).total, [], 0)

  /*
   * Cuántas salas tiene cada edificio y cuántas van con retraso.
   *
   * La lista de edificios eran veintitrés filas con un código y un nombre: la
   * misma altura, el mismo peso y ni un dato. Monótona, sí, pero sobre todo
   * MUDA — hay que entrar en cada una para saber cuál toca, que es justo lo que
   * la lista debería ahorrar.
   *
   * Con el recuento y el retraso, cada fila dice algo distinto y la vista se
   * ordena sola ante los ojos. La variedad sale de los datos, que es la única
   * que no cansa a la tercera semana.
   *
   * Se calcula en local, de una sola pasada sobre las tres tablas, y lo
   * recalcula Dexie cuando cambian.
   */
  const porEdificio = useLiveQuery(async () => {
    const [zones, rooms, incidencias] = await Promise.all([
      db.zones.toArray(),
      db.rooms.toArray(),
      db.incidents.toArray(),
    ])
    const edificioDeZona = new Map(zones.map((z) => [z.id, z.building_id]))

    const acc = new Map<string, { total: number; pendientes: number; averias: number }>()
    const limite = Date.now() - OVERDUE_INSPECTION_DAYS * 86_400_000
    // Las averías vivas por edificio, con la misma regla que el servidor
    // (`room_overview.open_incidents`): ni resueltas, ni borradores, ni
    // observaciones. El triángulo del edificio es la suma de sus salas.
    const averias = averiasPorEdificio(averiasPorSala(incidencias), rooms, edificioDeZona)

    for (const r of rooms) {
      const edificio = edificioDeZona.get(r.zone_id)
      if (!edificio) continue
      const fila = acc.get(edificio) ?? {
        total: 0,
        pendientes: 0,
        averias: averias.get(edificio) ?? 0,
      }
      fila.total++
      const revisada = r.last_inspection_at ? new Date(r.last_inspection_at).getTime() : 0
      if (revisada < limite) fila.pendientes++
      acc.set(edificio, fila)
    }
    return acc
  }, [])

  // La planta de la sala en revisión. Va en la cabecera porque un código como
  // `-2.1` leído sin ella parece un sótano cualquiera.
  const zoneName =
    useLiveQuery(
      async () =>
        view.name === 'revision' || view.name === 'ficha'
          ? (await db.zones.get(view.room.zone_id))?.name
          : undefined,
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

  /* Dónde se está ahora mismo, para poder volver aquí desde otra pestaña sin
     que ese dato entre en las dependencias de ningún callback. */
  const ubicacion = useRef<{ tab: Tab; view: RoomView }>({ tab, view })
  useEffect(() => {
    ubicacion.current = { tab, view }
  }, [tab, view])

  /*
   * La custodia se engancha ANTES de restaurar nada, y fuera del efecto que
   * depende de `unlocked`: la primera renovación del token puede ocurrir dentro
   * del propio `setSession()` de la reanudación, o sea antes de que la
   * aplicación se considere desbloqueada. Engancharla después es perderse justo
   * el token que había que guardar.
   */
  useEffect(() => watchSession(), [])

  /*
   * La revisión abierta es trabajo delicado: mientras dura, la versión nueva no
   * se instala sola (ver `@/sw`). Se marca desde aquí porque App es quien sabe
   * qué pantalla hay delante; al salir de la revisión —guardar, descartar,
   * volver— lo que estuviera esperando se instala en ese momento, que es
   * exactamente cuando la barra «reaparecía porque recargar no cuesta nada».
   *
   * La ficha abierta DESDE la revisión cuenta como parte de ella: tocar la
   * placa para consultar algo y volver es un paréntesis dentro del mismo
   * trabajo, y recargar en ese desvío devolvería a una ficha cuyo «Volver» ya
   * no sabe de la revisión a medias. La ficha llegada desde la lista —incluida
   * la vuelta tras guardar una corrección— sí es un final de verdad.
   */
  useEffect(() => {
    marcarTrabajoDelicado(
      unlocked &&
        tab === 'revisar' &&
        (view.name === 'revision' || (view.name === 'ficha' && view.volverA === 'revision')),
    )
  }, [unlocked, tab, view])

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
  /**
   * Abre una sala por su identificador, venga de donde venga.
   *
   * La usan el enlace de la pegatina y el lector de la cámara, y tiene que
   * resolver también el edificio: la revisión necesita saber a qué lista volver
   * al salir, y la cabecera enseña el edificio y la planta.
   */
  const abrirSala = useCallback(async (roomId: string): Promise<boolean> => {
    const room = await db.rooms.get(roomId)
    if (!room) return false
    const zone = await db.zones.get(room.zone_id)
    const building = zone ? await db.buildings.get(zone.building_id) : undefined
    if (!building) return false

    setTab('revisar')
    // Directo a revisar: esto lo llama el lector de la cámara, y quien escanea
    // viene a revisar. La ficha está a un toque, en la placa de la cabecera.
    setView({ name: 'revision', building, room })
    return true
  }, [])

  /*
   * Abrir la ficha de un aula desde OTRA pestaña.
   *
   * Lo llaman la lista de incidencias y el historial, que hasta ahora eran dos
   * pantallas de solo lectura: decían qué pasa y en qué aula, y el resto era
   * cosa del usuario —memorizar «H 1.7», cambiar de pestaña, elegir edificio y
   * bajar por una lista de treinta y nueve—. Con esto, la incidencia lleva al
   * sitio donde se resuelve.
   *
   * Se guarda de dónde se venía, pestaña Y vista, para que «Volver» devuelva a
   * la cola de trabajo y no a un edificio que nadie había abierto. Se lee de un
   * ref y no del estado para que el callback sea estable: con `tab` y `view` en
   * las dependencias se rehace en cada navegación, y con él las dos pantallas
   * que lo reciben.
   */
  const abrirFicha = useCallback((roomId: string): void => {
    void (async () => {
      const room = await db.rooms.get(roomId)
      const zone = room ? await db.zones.get(room.zone_id) : undefined
      const building = zone ? await db.buildings.get(zone.building_id) : undefined
      if (!room || !building) return

      setTab('revisar')
      setView({
        name: 'ficha',
        building,
        room,
        volverA: 'salas',
        regreso: { ...ubicacion.current },
        enfocar: 'incidencias',
      })
    })()
  }, [])


  useEffect(() => {
    if (!unlocked || restaurado) return
    void (async () => {
      try {
        /*
         * Si se ha llegado escaneando la placa de la puerta, manda eso.
         *
         * Es el camino más corto que existe entre llegar al aula y empezar a
         * trabajar: sin esto, el técnico elige edificio, busca la sala en una
         * lista de hasta 39 y la abre — dos toques y dos rastreos visuales, de
         * pie, en cada una de las 276 salas de la ronda.
         *
         * Va ANTES de restaurar la última vista, y por eso: quien acaba de
         * escanear una puerta quiere esa puerta, no donde estaba ayer.
         */
        const escaneada = salaDeLaUrl(window.location.search)
        if (escaneada) {
          // La URL se limpia siempre, haya funcionado o no: si se queda, cada
          // recarga vuelve a arrastrar al técnico a la misma sala y no hay forma
          // de salir de ella salvo editando la barra de direcciones.
          const limpia = new URL(window.location.href)
          limpia.searchParams.delete(PARAM_SALA)
          window.history.replaceState({}, '', limpia.pathname + limpia.search)

          const room = await db.rooms.get(escaneada)
          const zone = room ? await db.zones.get(room.zone_id) : undefined
          const building = zone ? await db.buildings.get(zone.building_id) : undefined

          if (room && building) {
            setTab('revisar')
            setView({ name: 'revision', building, room })
            return
          }

          // La placa apunta a una sala que este dispositivo no tiene todavía.
          // Decirlo es mejor que dejarlo en la lista de edificios como si no se
          // hubiera escaneado nada: el técnico está delante de la puerta.
          setEscaneoFallido(escaneada)
        }

        const guardado = (await db.meta.get('ultima-vista'))?.value as
          | { tab?: Tab; buildingId?: string; roomId?: string; vista?: RoomView['name'] }
          | undefined

        if (guardado?.tab) setTab(guardado.tab)

        if (guardado?.buildingId) {
          const building = await db.buildings.get(guardado.buildingId)
          if (building) {
            const room = guardado.roomId ? await db.rooms.get(guardado.roomId) : undefined
            setView(
              room
                ? guardado.vista === 'ficha'
                  ? // Restaurada desde la lista: es de donde se llega a la
                    // ficha en frío, y es a donde tiene que devolver «Volver».
                    ({ name: 'ficha', building, room, volverA: 'salas' } as const)
                  : { name: 'revision', building, room }
                : { name: 'salas', building },
            )
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
        /*
         * Una corrección se guarda como si se estuviera en la ficha, y es a
         * propósito.
         *
         * Lo que se corrige viaja en memoria —qué revisión y lo que contestó—, así
         * que restaurar «revisión» tras recargar abriría el formulario sin nada de
         * eso: una revisión nueva y vacía donde había una corrección a medias. La
         * ficha, en cambio, encuentra el borrador y ofrece «Continuar la
         * corrección», que es exactamente lo que hace falta.
         */
        vista: view.name === 'revision' && view.correccion ? 'ficha' : view.name,
        buildingId: view.name === 'edificios' ? null : view.building.id,
        roomId: view.name === 'revision' || view.name === 'ficha' ? view.room.id : null,
      },
    })
  }, [unlocked, restaurado, tab, view])

  useEffect(() => {
    if (!unlocked) return

    void requestPersistentStorage()
    void pullMaster().then(setDiagnostico)
    // Las revisiones cerradas y ya subidas no tienen por qué seguir aquí: nadie
    // las purgaba y crecía una fila por aula revisada, para siempre.
    void purgeSyncedInspections()
    void (async () => {
      const { data } = await supabase.auth.getUser()
      if (!data.user) {
        setRolError('No se ha podido identificar la sesión.')
        return
      }
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', data.user.id)
        // `maybeSingle`, no `single`: con cero filas —una cuenta sin perfil, o
        // RLS bloqueando— `single` devuelve error 406 y antes se descartaba sin
        // mirarlo, dejando el rol en `tecnico` como si fuera lo normal.
        .maybeSingle()

      if (error) {
        setRolError(`No se ha podido leer tu perfil: ${error.message}`)
        return
      }
      if (!profile) {
        setRolError(
          'Tu cuenta no tiene perfil, así que la aplicación te trata como técnico. ' +
            'Que un administrador ejecute: alta crear <tu-email> "<tu nombre>" admin',
        )
        return
      }
      setRole(profile.role as Role)
    })()

    const stop = startSync()
    // Y los de la bajada, que no existían: lo que escribe este dispositivo subía
    // en segundos, pero lo que escribían los demás no llegaba hasta recargar.
    const stopPull = startPull(setDiagnostico)
    const onActivity = (): void => void touch()
    window.addEventListener('pointerdown', onActivity)
    document.addEventListener('visibilitychange', onActivity)

    return () => {
      stop()
      stopPull()
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
      <>
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
        {/* La barra de versión nueva también detrás del candado: el dispositivo
            que no consigue entrar es justo el que necesita el arreglo, y sin
            esto la única activación posible ahí era la de los momentos seguros. */}
        <UpdatePrompt />
      </>
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
          {/* El rol, a la vista. Es lo que decide qué pestañas hay, así que
              esconderlo convierte «no tengo el botón» en un misterio: quien es
              admin y se ve como técnico lo detecta aquí, de un vistazo. */}
          <span className="eyebrow truncate">Aulas · {role}</span>
          <div className="flex shrink-0 items-center gap-2">
            <SyncChip />
            <button
              type="button"
              onClick={() => {
                /*
                 * Es la única forma de que la sesión termine: no caduca sola.
                 * Por eso se confirma — cerrarla sin querer obliga a teclear el
                 * PIN otra vez en mitad de una ronda.
                 *
                 * Y con la cola llena se avisa de qué se está haciendo. Cerrar
                 * sesión no borra nada —el trabajo sigue aquí y sube al volver a
                 * entrar—, pero sí para la subida en seco: sin sesión, `flush()`
                 * no puede mandar nada. Quien cierra creyendo que «así se
                 * guarda» está haciendo lo contrario de lo que quiere.
                 */
                const aviso =
                  sinSubir > 0
                    ? `Quedan ${sinSubir} cambios sin subir. No se pierden —siguen en este ` +
                      'dispositivo y subirán cuando vuelvas a entrar—, pero mientras la sesión ' +
                      'esté cerrada no se sube nada. ¿Cerrar sesión igualmente?'
                    : '¿Cerrar sesión?'
                if (confirm(aviso)) {
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

      {escaneoFallido && (
        <div className="border-b border-line bg-warn-tint px-4 py-3">
          <p className="text-sm text-warn">
            Has escaneado una placa, pero esa sala no está descargada en este dispositivo todavía.
            Sincroniza y vuelve a escanear.
          </p>
          <button
            type="button"
            onClick={() => setEscaneoFallido(null)}
            className="key key-quiet mt-2 min-h-11 px-3 text-sm"
          >
            Entendido
          </button>
        </div>
      )}

      {rolError && (
        <div className="border-b border-line px-4 py-3">
          <p className="text-sm text-crit">{rolError}</p>
          <Diagnostico />
        </div>
      )}

      {tab === 'revisar' && view.name === 'edificios' && (
        <>
          {/*
            Escanear va ANTES del buscador y de la lista, y ocupa el ancho
            entero, porque es el camino corto: el técnico ya está delante de la
            puerta. Buscar y bajar por los edificios siguen debajo para cuando no
            hay pegatina —o no hay cámara—, que es lo que impide que esto se
            convierta en un callejón.
          */}
          <div className="border-b border-line bg-surface px-4 pt-3">
            <button
              type="button"
              onClick={() => {
                setAvisoQR(null)
                setEscaneando(true)
              }}
              className="key key-accent flex min-h-touch w-full items-center justify-center gap-2 px-4 text-sm"
            >
              {/* El icono es el marco de una mirilla: cuatro esquinas y un
                  punto. Se lee como «apunta» sin necesidad de leerlo. */}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" />
              </svg>
              Escanear el QR del aula
            </button>
            {avisoQR && <p className="pt-2 text-sm text-crit">{avisoQR}</p>}
          </div>

          <BuscadorGlobal
            onPick={(building, room) => setView({ name: 'revision', building, room })}
          />
        {/* Misma regla que la lista de salas: el contenido va sobre papel. */}
        <ul className="divide-y divide-line-soft border-b border-line bg-surface">
          {(buildings ?? []).map((b) => {
            const cuenta = porEdificio?.get(b.id)
            const total = cuenta?.total ?? 0
            const pendientes = cuenta?.pendientes ?? 0
            const hechas = total - pendientes

            return (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => setView({ name: 'salas', building: b })}
                  className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors duration-100 active:bg-raised"
                >
                  {/*
                    El código, en una chapa.
                    Suelto competía con el nombre a la misma altura y el ojo no
                    sabía cuál de los dos era la entrada. Metido en su recuadro
                    monoespaciado se lee como lo que es: una matrícula.
                  */}
                  <span className="w-12 shrink-0 rounded-tag bg-raised py-1 text-center font-mono text-xs font-semibold text-accent">
                    {b.code}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{b.name}</span>
                    {total > 0 && (
                      <span className="mt-1 flex items-center gap-2">
                        {/*
                          El avance del edificio, recto y sin animar.
                          Es una medida, no una barra de carga: animarla obligaría
                          a esperar para poder leerla, y aquí se lee de pasada.
                        */}
                        <span
                          aria-hidden
                          className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-line"
                        >
                          <span
                            className={`block h-full ${pendientes === 0 ? 'bg-ok' : 'bg-warn'}`}
                            style={{ width: `${total ? (hechas / total) * 100 : 0}%` }}
                          />
                        </span>
                        <span className="truncate text-xs text-muted">
                          {pendientes === 0
                            ? `${total} salas al día`
                            : `${pendientes} de ${total} por revisar`}
                        </span>
                      </span>
                    )}
                  </span>

                  {/* El triángulo del edificio: cuántas averías vivas hay
                      puertas adentro, sumando todas sus salas. */}
                  <InsigniaAveria
                    n={cuenta?.averias ?? 0}
                    detalle={detalleDeAverias(cuenta?.averias ?? 0)}
                  />

                  {b.needs_review && (
                    <span className="shrink-0 rounded-tag bg-warn-tint px-2 py-0.5 text-xs text-warn">
                      Sin identificar
                    </span>
                  )}
                </button>
              </li>
            )
          })}
          {buildings?.length === 0 && (
            <li className="p-4">
              <SinDatos
                diagnostico={diagnostico}
                onReintentar={() => void pullMaster().then(setDiagnostico)}
              />
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
          onPlacas={() => setView({ name: 'placas', building: view.building })}
          onPick={(room) =>
            setView({ name: 'ficha', building: view.building, room, volverA: 'salas' })
          }
        />
      )}

      {tab === 'revisar' && view.name === 'revision' && (
        <InspectionPage
          room={view.room}
          userId={userId}
          buildingName={view.building.name}
          zoneName={zoneName}
          correccion={view.correccion ?? null}
          onBack={() =>
            setView(
              view.name === 'revision' && view.desdeFicha
                ? ({ name: 'ficha', building: view.building, room: view.room, volverA: 'salas' } as const)
                : { name: 'salas', building: view.building },
            )
          }
          /*
            «Guardar y siguiente sala» salta de verdad a la siguiente.
            Antes este manejador ignoraba el parámetro, así que los dos botones
            de la barra hacían exactamente lo mismo: el que ocupa dos tercios
            prometía encadenar salas y devolvía a la lista.

            Funciona porque `complete()` ya ha marcado la sala como revisada en
            local, así que con el orden por antigüedad la recién terminada cae al
            final y la primera del resto es la que toca.
          */
          onFicha={() =>
            setView({ name: 'ficha', building: view.building, room: view.room, volverA: 'revision' })
          }
          onDone={(encadenar) => {
            /*
             * Al guardar una corrección se vuelve a la ficha, no a la lista.
             *
             * De ahí se venía —leyendo las revisiones de esta sala— y ahí está el
             * resultado: la versión nueva con su marca de corregida. Devolver a la
             * lista de aulas obligaría a entrar otra vez para comprobar que se ha
             * guardado lo que se acaba de guardar.
             */
            if (view.name === 'revision' && view.correccion) {
              setView({
                name: 'ficha',
                building: view.building,
                room: view.room,
                volverA: 'salas',
              })
              return
            }

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

      {tab === 'revisar' && view.name === 'ficha' && (
        <Suspense fallback={<p className="p-6 text-muted">Cargando…</p>}>
          <RoomSheet
            room={view.room}
            buildingName={view.building.name}
            zoneName={zoneName}
            userId={userId}
            enfocar={view.enfocar ?? null}
            onBack={() => {
              if (view.name !== 'ficha') return
              /* Se vino de otra pestaña: se devuelve exactamente ahí, con la
                 vista de «Revisar» tal y como estaba. */
              if (view.regreso) {
                setTab(view.regreso.tab)
                setView(view.regreso.view)
                return
              }
              setView(
                view.volverA === 'salas'
                  ? { name: 'salas', building: view.building }
                  : { name: 'revision', building: view.building, room: view.room },
              )
            }}
            onRevisar={() =>
              setView({
                name: 'revision',
                building: view.building,
                room: view.room,
                desdeFicha: true,
              })
            }
            /* Corregir es el mismo destino con una carga distinta: el formulario
               sembrado con lo que dijo aquella visita. */
            onCorregir={(correccion) =>
              setView({
                name: 'revision',
                building: view.building,
                room: view.room,
                desdeFicha: true,
                correccion,
              })
            }
            onImprimir={() => setView({ name: 'placas', building: view.building })}
          />
        </Suspense>
      )}

      {tab === 'revisar' && view.name === 'placas' && (
        <Suspense fallback={<p className="p-6 text-muted">Cargando…</p>}>
          <PlateSheet
            building={view.building}
            onBack={() => setView({ name: 'salas', building: view.building })}
          />
        </Suspense>
      )}

      {tab !== 'revisar' && (
        <Suspense fallback={<p className="p-6 text-muted">Cargando…</p>}>
          {tab === 'panel' && (
            <DashboardPage
              ir={{
                revisar: () => {
                  setTab('revisar')
                  setView({ name: 'edificios' })
                },
                incidencias: () => setTab('incidencias'),
                datos: () => setTab('datos'),
              }}
            />
          )}
          {/* La incidencia lleva a su aula, que es donde se resuelve: la ficha
              abre por el bloque de incidencias abiertas y «Volver» devuelve
              aquí, a la cola de trabajo que se estaba triando. */}
          {tab === 'incidencias' && (
            <IncidentsPage role={role} userId={userId} onSala={abrirFicha} />
          )}
          {tab === 'almacen' && <StockPage role={role} />}
          {tab === 'historial' && <HistorialPage onSala={abrirFicha} />}
          {/* El rol llega porque la configuración de la IA —que guarda un
              secreto— es de administrador, mientras que pedir informes es de
              supervisor. La pestaña la ven los dos. */}
          {tab === 'informes' && <ReportsPage role={role} />}
          {tab === 'datos' && <CleanupPage yo={userId} />}
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

      {escaneando && (
        <Suspense fallback={<div className="fixed inset-0 z-50 bg-black" />}>
          <EscanerQR
            onCerrar={() => setEscaneando(false)}
            onLeido={(texto) => {
              setEscaneando(false)
              const sala = salaDeTextoQR(texto)
              if (!sala) {
                setAvisoQR('Ese código no es de una sala.')
                return
              }
              void abrirSala(sala).then((ok) => {
                if (!ok) setAvisoQR('Ese QR no corresponde a ninguna sala de las que puedes ver.')
              })
            }}
          />
        </Suspense>
      )}

      {/* El aviso lleva z-30 y la barra de la revisión vive en la misma esquina:
          su «Actualizar» caía justo donde está «Guardar y siguiente sala», así
          que el pulgar recargaba la aplicación en mitad de un aula. Reaparece al
          volver a la lista, que es cuando recargar no cuesta nada. */}
      {!inspecting && <UpdatePrompt />}
    </div>
  )
}
