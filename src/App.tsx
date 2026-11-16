import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Arranque } from '@/components/Arranque'
import { Esqueleto } from '@/components/Esqueleto'
import { Marco, subirArriba } from '@/components/Marco'
import { SyncChip } from '@/components/SyncChip'
import { UpdatePrompt } from '@/components/UpdatePrompt'
import { LockScreen } from '@/features/auth/LockScreen'
/* El diagnóstico del servidor va en diferido: solo se abre cuando algo falla o
   desde Datos, nunca con el dedo apoyado, y son trescientas líneas que el
   arranque de cada iPad cargaba para nada. */
const Diagnostico = lazy(() =>
  import('@/features/admin/Diagnostico').then((m) => ({ default: m.Diagnostico })),
)
import { InspectionPage } from '@/features/inspection/InspectionPage'
import type { Correccion } from '@/features/inspection/useInspection'
import { RoomListPage } from '@/features/rooms/RoomListPage'
/* La hoja de acciones del maestro no va en `lazy()`: pesa lo que pesa un
   formulario, no arrastra ninguna dependencia gorda y se abre con el dedo ya
   apoyado en la fila. Un `Suspense` ahí significaría medio segundo de nada justo
   después de un gesto que acaba de vibrar para confirmar que se ha entendido. */
/* La ficha de la sala tampoco: desde que todas las entradas pasan por ella —la
   fila de la lista, el buscador, el QR de la puerta y el enlace de la pegatina—
   es la primera pantalla de cualquier camino, o sea la más tocada del día, y se
   abre con el dedo ya apoyado. Un `Suspense` ahí era un «Cargando…» justo
   después del gesto. Lo que arrastra es un formulario y el codificador de QR de
   la placa, que es minúsculo y no tiene dependencias. */
import { RoomSheet } from '@/features/rooms/RoomSheet'
import { EdificiosPage } from '@/features/rooms/EdificiosPage'
import {
  nextRoom,
  ROOM_ORDER_LABELS,
  ROOM_ORDER_POR_DEFECTO,
  type RoomOrder,
} from '@/features/rooms/orden'

import { getSealed, lock, resumeSession, touch, watchSession } from '@/auth/session'
import { marcarTrabajoDelicado } from '@/sw'
import { db, pendingSummary, purgeSyncedInspections, requestPersistentStorage } from '@/db/dexie'
import { pullMaster, startPull, type ResultadoPull } from '@/sync/pull'
import { startSync } from '@/sync/outbox'
import { configError, supabase } from '@/lib/supabase'
import { PARAM_SALA, salaDeLaUrl, salaDeTextoQR } from '@/lib/enlace-sala'
import { olvidarEstadoDeSesion, ponerEstadoDeSesion } from '@/lib/estado-de-sesion'
import { nivelar } from '@/lib/historial'
import { ID_CONTENIDO } from '@/lib/viewport'
import { pedirInstalar, useSePuedeInstalar } from '@/lib/instalar'
import type { SealedSession } from '@/auth/pin'
import type { Building, Role, Room } from '@/domain/types'
import type { Seccion as SeccionDeDatos } from '@/features/admin/CleanupPage'
import { HojaDeMas } from '@/features/shell/HojaDeMas'
import { BarraDePestanas, MarcaDeLaApp, MenuLateral } from '@/features/shell/Navegacion'
import { EN_MAS, RANK, etiquetaDe, puedeVer, type Tab } from '@/features/shell/secciones'

/*
 * Todo lo que no es llegar a un aula y revisarla se carga aparte.
 *
 * El panel arrastra ECharts, que pesa más que todo lo demás junto. Y las otras
 * cuatro pantallas las esconde el rol —un técnico no puede abrir Informes ni
 * Datos— pero se descargaban igual: el arranque traía «Fusionar con», «Bajo
 * mínimo» y la bandeja de cuarentena a un dispositivo que nunca los va a
 * enseñar. Y el arranque ocurre justo con la peor cobertura, al llegar al
 * edificio.
 *
 * La ficha de la sala NO está en esta lista a propósito: se importa arriba, con
 * la hoja del maestro, porque es la pantalla en la que desembocan todos los
 * caminos y la que se abre con el dedo ya apoyado.
 */
const DashboardPage = lazy(() =>
  import('@/features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
)
/*
 * Las tres pestañas de la barra, además, se piden POR ADELANTADO.
 *
 * Diferidas tal cual, la primera vez que se pulsaba «Incidencias» había que
 * esperar a que bajara su trozo: poco con wifi, un par de segundos con la
 * cobertura de un pasillo, y siempre justo después de pulsar, que es cuando
 * más se nota. Son las tres pantallas que se abren todos los días, así que en
 * cuanto la aplicación ha arrancado y el navegador no tiene nada mejor que
 * hacer se le pide que las vaya trayendo (`precalentar`, más abajo). Cuando
 * llega el dedo ya están.
 *
 * El importador va en una constante porque lo usan los dos: `lazy()` para
 * pintar y `precalentar` para adelantarse. El navegador no baja dos veces el
 * mismo módulo; la segunda llamada devuelve la promesa de la primera.
 */
const traerIncidencias = (): Promise<typeof import('@/features/incidents/IncidentsPage')> =>
  import('@/features/incidents/IncidentsPage')
const traerAlmacen = (): Promise<typeof import('@/features/inventory/StockPage')> =>
  import('@/features/inventory/StockPage')
const traerHistorial = (): Promise<typeof import('@/features/history/HistorialPage')> =>
  import('@/features/history/HistorialPage')

const IncidentsPage = lazy(() => traerIncidencias().then((m) => ({ default: m.IncidentsPage })))
const StockPage = lazy(() => traerAlmacen().then((m) => ({ default: m.StockPage })))
/* El inventario entero, con la ficha de cada equipo. Se abre desde un
   despacho y no en la ronda, así que no entra en la carga inicial. */
const EquiposPage = lazy(() =>
  import('@/features/inventory/EquiposPage').then((m) => ({ default: m.EquiposPage })),
)
const CleanupPage = lazy(() =>
  import('@/features/admin/CleanupPage').then((m) => ({ default: m.CleanupPage })),
)
/* La hoja de placas solo se abre para imprimir etiquetas: una o dos veces en la
   vida del despliegue. No tiene por qué viajar en el arranque, que ocurre justo
   con la peor cobertura. Lo que se ahorra es la hoja, no el codificador de QR:
   ese ya viaja con la ficha, que pinta la misma placa en su cabecera. */
const PlateSheet = lazy(() =>
  import('@/features/rooms/PlateSheet').then((m) => ({ default: m.PlateSheet })),
)
/* La hoja de inventario se abre para descargar un PDF: una vez al trimestre y
   desde una mesa. Arrastra la tabla del parque entero de un edificio —hasta 39
   salas con sus equipos— y no la ve nadie mientras se recorre un pasillo, así
   que sigue el mismo criterio que las placas: no viaja en el arranque, que es
   cuando peor cobertura hay. */
const HojaDeInventario = lazy(() =>
  import('@/features/inventory/HojaDeInventario').then((m) => ({ default: m.HojaDeInventario })),
)
const HistorialPage = lazy(() => traerHistorial().then((m) => ({ default: m.HistorialPage })))

/**
 * Trae las pestañas de la barra cuando el navegador está ocioso.
 *
 * `requestIdleCallback` y no un `setTimeout`: lo primero es que la pantalla en
 * la que se ha aterrizado responda, y esto solo debe correr cuando ya lo hace.
 * Safari no lo tuvo hasta hace poco, así que ahí se espera un par de segundos,
 * que es peor medida pero la misma intención.
 *
 * No se hace con «ahorro de datos» activado: quien lo ha puesto ha dicho que no
 * quiere que se baje nada que no haya pedido. Y un fallo se calla —es un
 * adelanto, no una carga—: si no hay red, la pestaña se pedirá al pulsarla,
 * como antes.
 */
function precalentar(): () => void {
  const conexion = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  if (conexion?.saveData) return () => {}

  const traer = (): void => {
    for (const pedir of [traerIncidencias, traerAlmacen, traerHistorial]) {
      void pedir().catch(() => {})
    }
  }

  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(traer, { timeout: 5000 })
    return () => window.cancelIdleCallback(id)
  }
  const id = window.setTimeout(traer, 2500)
  return () => window.clearTimeout(id)
}
const Actividad = lazy(() =>
  import('@/features/admin/Actividad').then((m) => ({ default: m.Actividad })),
)
const ReportsPage = lazy(() =>
  import('@/features/reports/ReportsPage').then((m) => ({ default: m.ReportsPage })),
)
/* La cámara y el lector de QR solo se descargan cuando alguien va a escanear. */
const EscanerQR = lazy(() =>
  import('@/features/rooms/EscanerQR').then((m) => ({ default: m.EscanerQR })),
)

/*
 * Toda sala se abre por su ficha, venga el toque de donde venga.
 *
 * La fila de la lista, el buscador global, el lector de QR y el enlace de la
 * pegatina desembocan en la misma pantalla, y la revisión se empieza desde ella
 * con «Revisar esta sala». La ficha contesta lo que uno se pregunta llegando a
 * la puerta —qué hay aquí, qué falló, qué queda abierto— y eso va ANTES de
 * rellenar un formulario: la avería abierta del proyector se lee antes de
 * volver a marcarla. El botón está a un toque y ocupa el ancho, así que el
 * camino corto sigue costando un toque; y con las cuatro entradas en el mismo
 * sitio, un gesto significa una cosa.
 *
 * Por eso cada vista que se apila recuerda de dónde vino: volver tiene que
 * devolver al sitio del que se salió, no a uno que no se ha visto nunca.
 */
/** Los sitios desde los que se llega a la ficha de un aula sin venir de su revisión. */
type OrigenDeFicha = 'salas' | 'edificios' | 'incidencias'

type RoomView =
  | { name: 'edificios' }
  | { name: 'salas'; building: Building }
  | {
      name: 'revision'
      building: Building
      room: Room
      desdeFicha?: boolean
      /**
       * De dónde venía la ficha desde la que se empezó, si se empezó desde una.
       *
       * Sin esto, «Volver» desde la revisión rehacía la ficha diciendo siempre
       * que venía de la lista de salas. Quien había llegado al aula por el
       * buscador o por el QR —o desde una incidencia— volvía dos veces y
       * acababa en la lista de un edificio que no había abierto nunca, a tres
       * toques del buscador del que salió.
       */
      origen?: OrigenDeFicha
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
   * Es lo primero que se abre al tocar un aula, se toque en la lista, en un
   * resultado del buscador o en una pegatina: lo que uno se pregunta llegando a
   * la puerta —qué hay aquí, esto ya falló, queda algo abierto— viene antes que
   * rellenar comprobaciones, y desde la ficha se empieza la revisión con un
   * botón que ocupa el ancho.
   *
   * Antes el QR y el buscador entraban directos a revisar, con el argumento de
   * que quien escanea ya sabe a qué viene. Pero el mismo toque llevaba a dos
   * pantallas distintas según de dónde saliera, y lo que la ficha cuenta es
   * justo lo que hace falta saber ANTES de contestar el formulario, no después.
   *
   * `volverA` existe porque a la ficha se llega por tres sitios —la lista, la
   * pantalla de edificios (donde viven el buscador, el lector y el enlace en
   * frío) y la placa de la cabecera de la revisión— y volver tiene que devolver
   * al sitio del que se salió, no a uno que no se ha visto.
   *
   * Cuando se vuelve a la revisión, la ficha lleva consigo lo que la distingue
   * de una nueva. Antes «Volver» la rehacía solo con el edificio y la sala, y
   * quien consultaba la ficha a media corrección aterrizaba en una revisión
   * vacía de la misma sala, con la corrección perdida por el camino.
   */
  | { name: 'ficha'; building: Building; room: Room; volverA: OrigenDeFicha }
  | {
      name: 'ficha'
      building: Building
      room: Room
      volverA: 'revision'
      /** La revisión a la que se vuelve: si entró desde la ficha y qué corrige. */
      revision: { desdeFicha?: boolean; correccion?: Correccion; origen?: OrigenDeFicha }
    }
  /*
   * La hoja de placas del edificio. Vive aquí y no en «Datos» porque se imprime
   * desde donde se está trabajando: se decide etiquetar un edificio cuando se
   * está recorriendo ese edificio.
   *
   * Se abre desde la lista de salas y desde la ficha de una sala, y `volverA`
   * devuelve a la que fuera. Volvía siempre a la lista, así que quien salía de
   * una ficha a imprimir aterrizaba en una pantalla que no había pedido y tenía
   * que buscar el aula otra vez.
   */
  | { name: 'placas'; building: Building; volverA: 'salas' }
  | { name: 'placas'; building: Building; volverA: 'ficha'; room: Room }
  /*
   * La hoja de inventario, de una sala o del edificio entero.
   *
   * Hermana de la de placas: se imprime desde donde se está trabajando, porque
   * quien tiene que entregar el inventario de un edificio lo pide estando en ese
   * edificio, y esconderla en «Datos» la dejaría fuera del alcance del técnico,
   * que es quien conoce lo que hay dentro de las aulas.
   *
   * `room` opcional es lo que distingue las dos hojas —una sala o el edificio— y
   * `volverA` existe por el mismo motivo que en la ficha: se llega desde la lista
   * de salas y desde la ficha, y «Volver» tiene que devolver al sitio del que se
   * salió, no a uno que no se ha visto.
   */
  | { name: 'inventario'; building: Building; room?: Room; volverA: 'salas' | 'ficha' }

/**
 * A dónde lleva «Volver» desde esta vista. `null` en la raíz.
 *
 * Es UNA regla para los dos botones que vuelven: el de la pantalla y el atrás
 * del móvil. Antes cada pantalla llevaba la suya en línea, y el atrás del móvil
 * no existía; con dos copias volverían a discrepar.
 *
 * Al sitio del que se salió, no a uno que no se ha visto: la revisión que se
 * abrió desde la ficha vuelve a la ficha; la ficha que se abrió a media
 * revisión vuelve a ESA revisión, con su `desdeFicha` y, si era una
 * corrección, con la corrección —sin eso, volver de consultar la ficha abría
 * una revisión nueva y vacía de la misma sala—; la ficha a la que se llegó
 * desde el buscador, el QR o el enlace vuelve a la pantalla de edificios, que
 * es donde viven; y la que se abrió desde una incidencia devuelve a esa
 * pestaña, con la vista de «Revisar» en la raíz, que es lo que hay detrás.
 * Las hojas de placas e inventario vuelven a la ficha si se abrieron desde
 * una, y si no a la lista: la ficha vuelve con «Volver» hacia la lista, así
 * que la hoja no arrastra de dónde venía la ficha a su vez.
 *
 * En la ficha, la revisión se pregunta primero y en positivo: es la rama que
 * necesita `view.revision`, y TypeScript solo estrecha la unión por `volverA`
 * con una igualdad, no descartando los otros valores.
 */
function atras(view: RoomView): { view: RoomView; tab?: Tab } | null {
  switch (view.name) {
    case 'edificios':
      return null
    case 'salas':
      return { view: { name: 'edificios' } }
    case 'revision':
      return {
        view: view.desdeFicha
          ? {
              name: 'ficha',
              building: view.building,
              room: view.room,
              volverA: view.origen ?? 'salas',
            }
          : { name: 'salas', building: view.building },
      }
    case 'ficha':
      if (view.volverA === 'revision') {
        return {
          view: { name: 'revision', building: view.building, room: view.room, ...view.revision },
        }
      }
      if (view.volverA === 'incidencias') return { view: { name: 'edificios' }, tab: 'incidencias' }
      if (view.volverA === 'edificios') return { view: { name: 'edificios' } }
      return { view: { name: 'salas', building: view.building } }
    case 'placas':
      return {
        view:
          view.volverA === 'ficha'
            ? { name: 'ficha', building: view.building, room: view.room, volverA: 'salas' }
            : { name: 'salas', building: view.building },
      }
    case 'inventario':
      return {
        view:
          view.volverA === 'ficha' && view.room
            ? { name: 'ficha', building: view.building, room: view.room, volverA: 'salas' }
            : { name: 'salas', building: view.building },
      }
  }
}

/**
 * De dónde venía esta ficha, para que la revisión que se abre desde ella lo
 * recuerde. Si la ficha se abrió a media revisión, lo que vale es de dónde
 * venía ESA revisión.
 */
function origenDe(view: RoomView): OrigenDeFicha | undefined {
  if (view.name !== 'ficha') return undefined
  return view.volverA === 'revision' ? view.revision.origen : view.volverA
}

/**
 * Cuántas pantallas hacia dentro hay abiertas: las veces que se puede pulsar
 * «Volver» antes de llegar a la lista de edificios. Es lo que el botón atrás
 * del móvil tiene que poder deshacer una a una.
 */
function nivelDe(view: RoomView): number {
  let n = 0
  for (let v: RoomView | null = view; v && v.name !== 'edificios'; v = atras(v)?.view ?? null) n++
  return n
}

/**
 * ¿Es esto uno de los órdenes de la lista de salas?
 *
 * Lo que se lee de `db.meta` viene de fuera del tipo: lo escribió otra versión
 * de la aplicación, o nadie. Se comprueba contra las etiquetas y no contra una
 * lista aparte para que añadir un orden en `orden.ts` no deje aquí un nombre que
 * se descarta en silencio.
 */
function esOrdenDeSalas(valor: unknown): valor is RoomOrder {
  return typeof valor === 'string' && Object.hasOwn(ROOM_ORDER_LABELS, valor)
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
  /*
   * Si el rol de la línea de arriba ya es el de verdad o todavía es el de
   * partida.
   *
   * `tecnico` es el valor inicial mientras el perfil viaja, y sin esta distinción
   * la reconducción de pestañas de abajo echaría de «Datos» a un administrador
   * que acaba de recargar allí —la última pestaña se restaura desde Dexie antes
   * de que conteste `profiles`— y lo dejaría en «Revisar» sin explicación. Se
   * marca también cuando el perfil falla: ahí el rol se queda en técnico de
   * verdad, y reconducir es lo correcto.
   */
  const [rolResuelto, setRolResuelto] = useState(false)
  /** Se escaneó una placa cuya sala no está en este dispositivo. */
  const [escaneoFallido, setEscaneoFallido] = useState<string | null>(null)
  const [diagnostico, setDiagnostico] = useState<ResultadoPull | null>(null)

  const [tab, setTab] = useState<Tab>('revisar')
  const [view, setView] = useState<RoomView>({ name: 'edificios' })
  /* Se abre por planta: quien entra en un edificio viene a recorrerlo, y la
     lista tiene que parecerse al camino que van a hacer sus pies. El orden por
     antigüedad sigue a un toque, para el día que se persigue el retraso. */
  const [roomOrder, setRoomOrder] = useState<RoomOrder>(ROOM_ORDER_POR_DEFECTO)
  /*
   * Lo tecleado en el buscador de la lista de salas. Vive aquí para sobrevivir
   * al viaje de ida y vuelta a una ficha (ver `RoomListPage`), y se borra al
   * salir del edificio: un filtro olvidado de otro edificio dejaría la lista
   * siguiente medio vacía sin que nada explicase por qué.
   */
  const [busquedaDeSalas, setBusquedaDeSalas] = useState('')
  /* Y lo mismo para el buscador del campus, el de la pantalla de inicio. Este
     se borra al entrar en un edificio por su fila: ahí ya se ha dejado de
     buscar. */
  const [busquedaDelCampus, setBusquedaDelCampus] = useState('')
  /* La sección de Datos a la que lleva un atajo (ver `CleanupPage`). Vale para
     una visita: al salir de Datos se olvida, y la siguiente vez manda la
     sección recordada. */
  const [datosEn, setDatosEn] = useState<SeccionDeDatos | null>(null)
  useEffect(() => {
    if (tab !== 'datos') setDatosEn(null)
  }, [tab])
  const [escaneando, setEscaneando] = useState(false)
  /**
   * La hoja de «Más», y con qué cara: entera —secciones y cuenta— desde la
   * barra de abajo, o solo la cuenta desde el menú lateral, donde las secciones
   * ya están a la vista.
   */
  const [masAbierto, setMasAbierto] = useState<'mas' | 'cuenta' | null>(null)
  const instalable = useSePuedeInstalar()
  const [avisoQR, setAvisoQR] = useState<string | null>(null)
  // Hasta que se intenta rehidratar no se pinta la lista de edificios: si no,
  // se vería un parpadeo desde la raíz hasta donde estabas.
  const [restaurado, setRestaurado] = useState(false)

  /* Cuánto trabajo hay sin subir. Solo se usa para no dejar cerrar sesión a
     ciegas encima de una cola llena. */
  const sinSubir = useLiveQuery(async () => (await pendingSummary()).total, [], 0)

  /*
   * La sala que hay delante, si la hay.
   *
   * Sale de la consulta de la planta y se nombra aparte porque ya son tres las
   * vistas que enseñan una sala en su cabecera. Con la condición escrita dentro
   * de la consulta, añadir la hoja de inventario significaba dejarla fuera sin
   * que nada lo señalara: la hoja se abriría con el edificio y sin la planta.
   */
  const salaDelante: Room | undefined =
    view.name === 'revision' || view.name === 'ficha'
      ? view.room
      : view.name === 'inventario'
        ? view.room
        : undefined

  // La planta de esa sala. Va en la cabecera porque un código como `-2.1` leído
  // sin ella parece un sótano cualquiera.
  const zoneName =
    useLiveQuery(
      async () => (salaDelante ? (await db.zones.get(salaDelante.zone_id))?.name : undefined),
      [salaDelante?.zone_id],
    ) ?? ''

  /*
   * Las salas del edificio en curso, para poder saltar a «la siguiente».
   *
   * Se calcula con el MISMO orden que muestra la lista. Si cada una ordenara por
   * su cuenta, la siguiente sala sería una distinta de la que el técnico ve
   * primera, y eso solo se nota cuando ya te has equivocado de aula.
   */
  const buildingId = view.name === 'edificios' ? null : view.building.id
  useEffect(() => {
    setBusquedaDeSalas('')
  }, [buildingId])
  const rondaActual = useLiveQuery(async () => {
    if (!buildingId) return null
    const zones = await db.zones.where('building_id').equals(buildingId).toArray()
    const zoneIds = new Set(zones.map((z) => z.id))
    return {
      rooms: await db.rooms.filter((r) => zoneIds.has(r.zone_id)).toArray(),
      zones: new Map(zones.map((z) => [z.id, z])),
    }
  }, [buildingId])

  /*
   * La pantalla fantasma.
   *
   * `view` guarda el objeto `Building` por valor y nadie revalidaba que siguiera
   * existiendo. Cuando la poda de la descarga se llevaba el edificio con la
   * lista de salas abierta —porque otro dispositivo acaba de archivarlo, o
   * porque lo ha archivado este mismo— quedaba una cabecera con el nombre de un
   * edificio que ya no está y, debajo, «Este edificio no tiene salas. Conéctate
   * una vez para descargarlas»: el mensaje de un fallo de red para algo que no
   * lo era, y que invita a esperar una descarga que no va a traer nada.
   *
   * Se vigila en vivo y se vuelve a la raíz, salvo durante una revisión. Ahí no
   * se toca: es trabajo delicado —ni la instalación de una versión nueva se
   * atreve a interrumpirlo— y sacar a alguien del formulario a media aula sería
   * peor que la pantalla fantasma. No hay nada que perder por esperar: el
   * borrador y sus comprobaciones ya están en Dexie y en la cola de salida, así
   * que el parte sube igual aunque el edificio esté archivado. Al salir de la
   * revisión la vista pasa a `salas` o `ficha`, este efecto se vuelve a evaluar y
   * ahí sí devuelve a la lista. Por eso no hace falta ningún estado extra.
   */
  const edificioVive = useLiveQuery(
    async () =>
      view.name === 'edificios' ? true : (await db.buildings.get(view.building.id)) !== undefined,
    [view],
    true,
  )
  useEffect(() => {
    if (edificioVive === false && view.name !== 'revision') setView({ name: 'edificios' })
  }, [edificioVive, view.name])

  /*
   * La pestaña abierta también tiene que caber en el rol.
   *
   * Es la contrapartida de `puedeVer` en el sitio por el que se colaba: `tab` no
   * se elige solo desde la barra de abajo. Se restaura desde Dexie al arrancar
   * —un dispositivo que se quedó en «Datos» y luego se degradó a técnico abría
   * directamente en el panel de administración— y lo cambian atajos de otras
   * pantallas. Reconducir aquí cubre los tres caminos y los que vengan después,
   * que es lo que no hacía una comprobación escrita en cada llamada.
   *
   * Espera a `rolResuelto` a propósito: hasta que contesta `profiles` todo el
   * mundo es técnico, y actuar antes echaría de su pestaña a cada administrador
   * que recarga. Mientras tanto no se enseña nada de más, porque el render de
   * cada pantalla comprueba el rol por su cuenta.
   */
  useEffect(() => {
    if (rolResuelto && !puedeVer(tab, role)) setTab('revisar')
  }, [rolResuelto, role, tab])

  /*
   * La custodia se engancha ANTES de restaurar nada, y fuera del efecto que
   * depende de `unlocked`: la primera renovación del token puede ocurrir dentro
   * del propio `setSession()` de la reanudación, o sea antes de que la
   * aplicación se considere desbloqueada. Engancharla después es perderse justo
   * el token que había que guardar.
   */
  /*
   * El botón atrás del móvil.
   *
   * Cuántas pantallas hay hacia dentro se deduce de la vista —la cadena de
   * «Volver» hasta la lista de edificios— más una si la pestaña no es Revisar,
   * que es la de casa: desde cualquier otra, atrás vuelve a ella. `nivelar` deja
   * en el historial del navegador tantas entradas como pantallas, y atrás llama
   * a `volver`, que recorre el mismo camino que el botón de la pantalla. Las
   * capas que se montan encima —hojas, fichas, fotos, la cámara— entran solas.
   * Lo cuenta entero `lib/historial.ts`.
   *
   * `volver` lee dónde está de un ref y lo deja actualizado en el acto: dos
   * pulsaciones seguidas de atrás llegan antes de que React vuelva a pintar, y
   * la segunda tiene que partir de donde dejó la primera.
   */
  const donde = useRef({ tab, view })
  donde.current = { tab, view }
  const volver = useCallback((): void => {
    const actual = donde.current
    if (actual.tab !== 'revisar') {
      donde.current = { tab: 'revisar', view: actual.view }
      setTab('revisar')
      return
    }
    const destino = atras(actual.view)
    if (!destino) return
    donde.current = { tab: destino.tab ?? 'revisar', view: destino.view }
    if (destino.tab) setTab(destino.tab)
    setView(destino.view)
  }, [])
  const profundidad = unlocked ? nivelDe(view) + (tab === 'revisar' ? 0 : 1) : 0
  useEffect(() => {
    // En cada cambio, no solo cuando cambia la cuenta: atrás quita una entrada
    // y `volver` puede dejar la misma profundidad —de una pestaña a una ficha
    // abierta desde ella—, y entonces hay que reponerla.
    nivelar(profundidad, volver)
  }, [profundidad, tab, view, volver])

  useEffect(() => watchSession(), [])

  /*
   * «/» lleva al buscador de la pantalla, con teclado delante.
   *
   * En un ordenador —o en un iPad con su teclado— buscar un aula era soltar las
   * teclas, coger el ratón y pulsar en el campo. Es el atajo de siempre en la
   * web, y aquí sirve en todas las pantallas a la vez porque todas llevan su
   * buscador como `type="search"`: se enfoca el primero que haya a la vista.
   * No hace nada mientras se escribe en otro campo ni con una hoja abierta.
   */
  useEffect(() => {
    const alPulsar = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      const en = e.target
      if (
        en instanceof HTMLElement &&
        (en.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(en.tagName))
      ) {
        return
      }
      if (document.querySelector('[role="dialog"]')) return
      const campo = document.querySelector<HTMLInputElement>(`#${ID_CONTENIDO} input[type="search"]`)
      if (!campo) return
      e.preventDefault()
      campo.focus()
      campo.select()
    }
    window.addEventListener('keydown', alPulsar)
    return () => window.removeEventListener('keydown', alPulsar)
  }, [])

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

  /**
   * Abre una sala por su identificador, venga de donde venga.
   *
   * La llaman el lector de la cámara y el enlace de la pegatina al arrancar, y
   * es UNA función a propósito: la regla de a qué pantalla se entra al llegar a
   * una sala vive aquí y en la fila de la lista, y con más copias volverían a
   * discrepar. Tiene que resolver también el edificio: la ficha necesita saber
   * de quién es la sala, y la cabecera enseña el edificio y la planta.
   */
  const abrirSala = useCallback(async (roomId: string): Promise<boolean> => {
    const room = await db.rooms.get(roomId)
    if (!room) return false
    const zone = await db.zones.get(room.zone_id)
    const building = zone ? await db.buildings.get(zone.building_id) : undefined
    if (!building) return false

    setTab('revisar')
    // A la ficha, igual que al tocar la fila de la lista: quien escanea viene a
    // trabajar en esa sala, y lo primero del trabajo es saber qué hay dentro y
    // qué quedó abierto. «Revisar esta sala» está a un toque. Se vuelve a la
    // pantalla de edificios, que es donde viven el botón de escanear y el
    // buscador; y para quien entró por la cámara del móvil, la raíz es lo único
    // que hay detrás.
    setView({ name: 'ficha', building, room, volverA: 'edificios' })
    return true
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
        /*
         * El orden de la lista de salas, antes que nada y al margen de la placa.
         *
         * Es una preferencia de trabajo, no una ubicación: quien persigue el
         * retraso pone «Más antiguas» y una recarga se lo devolvía a «Por planta»
         * sin decir nada, con la lista reordenada bajo el dedo. Va delante del
         * enlace de la pegatina porque ese camino sale del efecto en cuanto abre
         * la sala, y el orden tiene que quedar puesto también entonces.
         */
        const orden = (await db.meta.get('orden-salas'))?.value
        if (esOrdenDeSalas(orden)) setRoomOrder(orden)

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
          // Con el estado que tenga la entrada: es la profundidad que apunta
          // `lib/historial.ts`, y borrarla dejaría al botón atrás sin saber
          // cuántas pantallas hay que cerrar.
          window.history.replaceState(window.history.state, '', limpia.pathname + limpia.search)

          // Por `abrirSala`, como el lector de la cámara: el enlace de la
          // pegatina es otra puerta a la misma sala, no a otra pantalla, y las
          // dos entran en la ficha con «Volver» hacia la lista de edificios.
          if (await abrirSala(escaneada)) return

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
  }, [unlocked, restaurado, abrirSala])

  useEffect(() => {
    if (!unlocked || !restaurado) return

    /*
     * Lo que se guarda no es siempre la pantalla que hay delante.
     *
     * El efecto que restaura entiende dos nombres —'ficha' y 'revision'— y con
     * cualquier otro cae a la lista de salas. Guardar aquí un nombre nuevo tal
     * cual es, según la fila, una pantalla rota o una pantalla que aparece sin
     * que nadie sepa por qué; así que cada vista dice explícitamente a dónde
     * quiere volver tras una recarga.
     *
     * Una corrección se guarda como si se estuviera en la ficha: lo que se
     * corrige viaja en memoria —qué revisión y lo que contestó—, así que
     * restaurar «revisión» abriría el formulario sin nada de eso, una revisión
     * nueva y vacía donde había una corrección a medias. La ficha, en cambio,
     * encuentra el borrador y ofrece «Continuar la corrección».
     *
     * Las hojas de inventario y de placas se guardan como el sitio del que se
     * salió, por lo mismo: lo que tienen dentro son filas recién pedidas al
     * servidor o un diálogo de impresión, nada de lo cual sobrevive a una
     * recarga. Devolver a una hoja vacía —o peor, restaurarla con `roomId` y sin
     * entenderla, que es lo que haría abrir una revisión en blanco de esa sala—
     * sería inventar trabajo. Se vuelve a la lista o a la ficha, con la hoja a
     * un toque.
     *
     * La ficha que volvería a la pantalla de edificios o a la revisión se guarda
     * como ficha sin más: al restaurar, «Volver» lleva a la lista de salas, que
     * es de donde se llega a una ficha en frío. Lo que la revisión llevaba —la
     * corrección— no se guarda, por lo dicho arriba.
     */
    const restauracion: { vista: RoomView['name']; roomId: string | null } =
      view.name === 'revision' && view.correccion
        ? { vista: 'ficha', roomId: view.room.id }
        : view.name === 'inventario'
          ? {
              vista: view.volverA,
              roomId: view.volverA === 'ficha' ? (view.room?.id ?? null) : null,
            }
          : view.name === 'placas'
            ? {
                vista: view.volverA,
                roomId: view.volverA === 'ficha' ? view.room.id : null,
              }
            : {
                vista: view.name,
                roomId: view.name === 'revision' || view.name === 'ficha' ? view.room.id : null,
              }

    void db.meta.put({
      key: 'ultima-vista',
      value: {
        tab,
        vista: restauracion.vista,
        buildingId: view.name === 'edificios' ? null : view.building.id,
        roomId: restauracion.roomId,
      },
    })
  }, [unlocked, restaurado, tab, view])

  /*
   * El orden elegido se guarda cada vez que cambia, con la misma llave que lo
   * restaura. Espera a `restaurado` por lo mismo que la última vista: antes de
   * rehidratar, `roomOrder` es el de partida, y escribirlo pisaría justo lo que
   * se quiere recuperar.
   */
  useEffect(() => {
    if (!unlocked || !restaurado) return
    void db.meta.put({ key: 'orden-salas', value: roomOrder })
  }, [unlocked, restaurado, roomOrder])

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
        setRolResuelto(true)
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
        setRolResuelto(true)
        return
      }
      if (!profile) {
        setRolError(
          'Tu cuenta no tiene perfil, así que la aplicación te trata como técnico. ' +
            'Que un administrador ejecute: alta crear <tu-email> "<tu nombre>" admin',
        )
        setRolResuelto(true)
        return
      }
      setRole(profile.role as Role)
      setRolResuelto(true)
    })()

    const stop = startSync()
    // Y los de la bajada, que no existían: lo que escribe este dispositivo subía
    // en segundos, pero lo que escribían los demás no llegaba hasta recargar.
    const stopPull = startPull(setDiagnostico)
    const soltarPrecalentado = precalentar()
    const onActivity = (): void => void touch()
    window.addEventListener('pointerdown', onActivity)
    document.addEventListener('visibilitychange', onActivity)

    return () => {
      stop()
      stopPull()
      soltarPrecalentado()
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

  /* Lo que tarda Dexie en decir si hay sesión guardada: unos milisegundos. Se
     pinta el mismo arranque que deja puesto `index.html`, así que entre el HTML
     y el candado no hay ningún fotograma distinto: ni pantalla en blanco ni un
     «Cargando…» que no da tiempo a leer. */
  if (sealed === undefined) return <Arranque />

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

  /** La pestaña abierta cuando es una de las de «Más»: la cabecera la nombra. */
  const abiertaEnMas = EN_MAS.find((t) => t === tab)
  const inspecting = tab === 'revisar' && view.name === 'revision'

  const cerrarSesion = (): void => {
    const aviso =
      sinSubir > 0
        ? `Quedan ${sinSubir} cambios sin subir. No se pierden —siguen en este ` +
          'dispositivo y subirán cuando vuelvas a entrar—, pero mientras la sesión ' +
          'esté cerrada no se sube nada. ¿Cerrar sesión igualmente?'
        : '¿Cerrar sesión?'
    if (confirm(aviso)) {
      // Con la sesión se van las búsquedas y los filtros recordados: en un iPad
      // compartido, quien entra después no hereda lo que buscaba quien salió.
      olvidarEstadoDeSesion()
      setBusquedaDelCampus('')
      void lock().then(() => setUnlocked(false))
    }
  }

  /** El nombre de pila, para el saludo: «Ana Ruiz» → «Ana». */
  const nombre = sealed?.hint.fullName ?? ''
  const nombreDePila = nombre.trim().split(/\s+/)[0] ?? ''

  /*
   * Cambiar de sección. Una sola función para la barra, el menú lateral y la
   * hoja de «Más».
   *
   * Pulsar la pestaña en la que YA se está no es un toque perdido: lleva a la
   * raíz de esa sección y arriba del todo. Es lo que hace cualquier aplicación
   * de teléfono y aquí ahorra el camino más repetido del día —de la ficha de un
   * aula a la lista de edificios eran dos «Volver»; ahora es un toque en
   * «Revisar»—. Durante una revisión no saca de ella: ahí solo sube arriba, que
   * un formulario a medias no se abandona por tocar donde ya se estaba.
   *
   * Por dónde va el desplazamiento de cada sección lo lleva el marco (ver
   * `useMemoriaDeDesplazamiento`): al cambiar de pestaña y volver se aterriza
   * donde se dejó.
   */
  const irA = (t: Tab): void => {
    setMasAbierto(null)
    if (t === tab) {
      if (t === 'revisar' && view.name !== 'revision') setView({ name: 'edificios' })
      subirArriba()
      return
    }
    setTab(t)
  }

  /*
   * El sitio, para la memoria de desplazamiento del marco. Lleva dentro el aula
   * o el edificio: dos aulas son la misma pantalla y dos sitios distintos, y la
   * segunda tiene que empezar por arriba.
   */
  const sitio =
    tab !== 'revisar'
      ? tab
      : view.name === 'edificios'
        ? 'edificios'
        : view.name === 'revision' || view.name === 'ficha'
          ? `${view.name}-${view.room.id}`
          : `${view.name}-${view.building.id}`

  return (
    <Marco
      lateral={
        <MenuLateral
          tab={tab}
          role={role}
          onTab={irA}
          nombre={nombre}
          onCuenta={() => setMasAbierto('cuenta')}
        />
      }
      cabecera={
        <>
          {/* Sin `backdrop-blur`: obliga a WebKit a recapturar y desenfocar el fondo
              en cada frame de desplazamiento —de lo más caro que se puede poner encima
              de lo que desplaza en un iPad— y aquí ni se veía: `--ground` es un color
              sólido. Tampoco es `sticky`: es el primer hijo del marco, y el contenido
              desplaza por debajo de ella. */}
          {/* `solo-pantalla`: dentro de esta cabecera se imprimen dos hojas —las
              placas y el inventario—, y sin esto el PDF que se firma y se archiva
              salía encabezado por «Aulas · admin». Chrome además repite los
              elementos fijos en cada página. */}
          <header className="solo-pantalla flex-none bg-ground">
            <div className="marco-ancho mx-auto flex h-14 w-full max-w-6xl items-center gap-2.5 px-4">
              {/* La marca, solo donde no hay menú lateral: allí ya encabeza el
                  menú, y dos veces en la misma pantalla es una de más. */}
              <span className="flex items-center gap-2.5 lg:hidden">
                <MarcaDeLaApp lado={30} />
                <span className="font-semibold tracking-tight">Aulas</span>
              </span>
              {/* Y la pantalla, cuando es una de las de «Más»: la barra solo
                  enciende «Más», y el Panel no tiene título propio. En ancho se
                  nombra siempre, porque ahí es lo único que hay en la cabecera. */}
              <span
                className={`truncate text-sm font-medium text-muted ${
                  abiertaEnMas ? '' : 'hidden lg:inline'
                }`}
              >
                <span className="lg:hidden">· </span>
                {etiquetaDe(tab)}
              </span>

              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {/* El rol, a la vista. Es lo que decide qué pestañas hay, así que
                    esconderlo convierte «no tengo el botón» en un misterio: quien es
                    admin y se ve como técnico lo detecta aquí, de un vistazo. En
                    ancho lo dice la cuenta, al pie del menú lateral.
                    «Cerrar sesión» no está aquí: vive en «Más». Ocupaba la
                    cabecera de todas las pantallas para algo que se hace al
                    acabar el turno. */}
                <span className="chip capitalize lg:hidden">{role}</span>
                <SyncChip />
              </div>
            </div>
          </header>
        </>
      }
      pie={
        /* Durante una revisión la barra de pestañas se va, por lo de siempre:
           el pulgar que busca «Guardar» no debe encontrar «Almacén». El menú
           lateral, en cambio, se queda: está al otro lado de la pantalla y no
           compite con la barra de guardar, y quitarlo movería todo el contenido
           250 px a la izquierda al entrar en un aula. */
        !inspecting && (
          <>
            <UpdatePrompt enFlujo />
            <BarraDePestanas
              tab={tab}
              role={role}
              onTab={irA}
              masAbierto={masAbierto !== null}
              onMas={() => setMasAbierto('mas')}
            />
          </>
        )
      }
      capas={
        <>
          {masAbierto && (
            <HojaDeMas
              tab={tab}
              role={role}
              nombre={nombre}
              email={sealed?.hint.email ?? ''}
              soloCuenta={masAbierto === 'cuenta'}
              instalable={instalable}
              onTab={irA}
              onInstalar={() => {
                setMasAbierto(null)
                void pedirInstalar()
              }}
              onSalir={() => {
                setMasAbierto(null)
                cerrarSesion()
              }}
              onCerrar={() => setMasAbierto(null)}
            />
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
        </>
      }
      /* Cada pantalla entra con su animación (ver `.pantalla` en index.css).
         La clave es la sección y la vista, NO la sala: «Guardar y siguiente
         sala» pasa de un aula a otra dentro de la misma pantalla, y con la sala
         en la clave el formulario se desmontaría y volvería a montarse entre
         una y otra. */
      claveDePantalla={tab === 'revisar' ? `revisar-${view.name}` : tab}
      sitio={sitio}
      avisos={
        <>
          {escaneoFallido && (
            <div className="solo-pantalla border-b border-line bg-warn-tint px-4 py-3">
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

          {/* `solo-pantalla`, como la barra de versión nueva: son diagnósticos de la
              aplicación, y la hoja de inventario los sacaba impresos en la cabecera
              de la primera página de un papel que se archiva. */}
          {rolError && (
            <div className="solo-pantalla border-b border-line px-4 py-3">
              <p className="text-sm text-crit">{rolError}</p>
              <Suspense fallback={<p className="mt-2 text-sm text-muted">Cargando el diagnóstico…</p>}>
                <Diagnostico />
              </Suspense>
            </div>
          )}
        </>
      }
    >
      {tab === 'revisar' && view.name === 'edificios' && (
        <EdificiosPage
          role={role}
          nombre={nombreDePila}
          diagnostico={diagnostico}
          onReintentar={() => void pullMaster().then(setDiagnostico)}
          onEscanear={() => {
            setAvisoQR(null)
            setEscaneando(true)
          }}
          avisoQR={avisoQR}
          busqueda={busquedaDelCampus}
          onBusqueda={setBusquedaDelCampus}
          /* Directo al formulario, que es donde estaba. Se abre «desde la
             ficha» y con origen en esta pantalla para que tanto «Volver» como
             «Guardar» acaben devolviendo aquí. */
          onContinuar={(building, room) =>
            setView({ name: 'revision', building, room, desdeFicha: true, origen: 'edificios' })
          }
          onEdificio={(building) => {
            setBusquedaDelCampus('')
            setView({ name: 'salas', building })
          }}
          /* A la ficha, como la fila de la lista y el QR. Se vuelve aquí, a la
             pantalla de edificios, que es donde está el buscador. */
          onSala={(building, room) =>
            setView({ name: 'ficha', building, room, volverA: 'edificios' })
          }
        />
      )}

      {tab === 'revisar' && view.name === 'salas' && (
        <RoomListPage
          building={view.building}
          role={role}
          order={roomOrder}
          onOrderChange={setRoomOrder}
          query={busquedaDeSalas}
          onQueryChange={setBusquedaDeSalas}
          onBack={volver}
          onPlacas={() => setView({ name: 'placas', building: view.building, volverA: 'salas' })}
          /* Sin sala: la hoja del edificio entero, que es lo que se pide desde
             aquí —estando en la lista se está mirando el edificio, no un aula—. */
          onInventario={() =>
            setView({ name: 'inventario', building: view.building, volverA: 'salas' })
          }
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
          onBack={volver}
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
            setView({
              name: 'ficha',
              building: view.building,
              room: view.room,
              volverA: 'revision',
              /* Lo que hace falta para volver a ESTA revisión y no a una nueva de
                 la misma sala: si es una corrección, la corrección. */
              revision: {
                desdeFicha: view.desdeFicha,
                correccion: view.correccion,
                origen: view.origen,
              },
            })
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
                volverA: view.origen ?? 'salas',
              })
              return
            }

            const siguiente =
              encadenar && rondaActual
                ? nextRoom(rondaActual.rooms, rondaActual.zones, roomOrder, view.room.id)
                : null

            if (siguiente) {
              setView({ name: 'revision', building: view.building, room: siguiente })
              return
            }

            /*
             * Sin siguiente sala, al sitio desde el que se llegó a esta.
             *
             * Volvía siempre a la lista del edificio, también para quien había
             * llegado por el buscador, por el QR o desde una incidencia: guardar
             * el aula le dejaba en una lista que no había abierto, y lo siguiente
             * que quería —escanear otra puerta, o seguir con las incidencias—
             * estaba a dos o tres toques. Guardar es «he terminado aquí», así
             * que devuelve a donde se estaba antes de empezar.
             */
            const origen = view.name === 'revision' ? view.origen : undefined
            if (origen === 'incidencias') setTab('incidencias')
            setView(
              origen === 'edificios' || origen === 'incidencias'
                ? { name: 'edificios' }
                : { name: 'salas', building: view.building },
            )
          }}
        />
      )}

      {tab === 'revisar' && view.name === 'ficha' && (
        <RoomSheet
          room={view.room}
          buildingName={view.building.name}
          zoneName={zoneName}
          userId={userId}
          /* Al sitio del que se salió: lo decide `atras`, arriba, que es la
             misma regla que sigue el botón atrás del móvil. */
          onBack={volver}
          onRevisar={() =>
            setView({
              name: 'revision',
              building: view.building,
              room: view.room,
              desdeFicha: true,
              origen: origenDe(view),
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
              origen: origenDe(view),
              correccion,
            })
          }
          /* Con la sala: la hoja tiene que saber que se vuelve a esta ficha y no
             a la lista. */
          onImprimir={() =>
            setView({ name: 'placas', building: view.building, volverA: 'ficha', room: view.room })
          }
          onInventario={() =>
            setView({
              name: 'inventario',
              building: view.building,
              room: view.room,
              volverA: 'ficha',
            })
          }
          /* A la pestaña Historial, con esta sala ya puesta en sus filtros y
             sin límite de fechas. «Volver» devuelve a esta ficha. */
          onHistorial={() => {
            ponerEstadoDeSesion('historial.edificio', view.building.id)
            ponerEstadoDeSesion('historial.sala', view.room.id)
            ponerEstadoDeSesion('historial.atajo', 'todo')
            ponerEstadoDeSesion('historial.familia', null)
            ponerEstadoDeSesion('historial.desde', '')
            ponerEstadoDeSesion('historial.hasta', '')
            ponerEstadoDeSesion('historial.texto', '')
            setTab('historial')
          }}
        />
      )}

      {tab === 'revisar' && view.name === 'placas' && (
        <Suspense fallback={<Esqueleto />}>
          <PlateSheet
            building={view.building}
            /* A la ficha si se abrió desde una, y si no a la lista: `atras`. */
            onBack={volver}
          />
        </Suspense>
      )}

      {tab === 'revisar' && view.name === 'inventario' && (
        <Suspense fallback={<Esqueleto />}>
          <HojaDeInventario
            /* La planta viaja con la sala: la calcula App —es quien tiene el
               `zone_id` resuelto contra el espejo— y sin ella la cabecera de la
               hoja saldría con el aula y sin decir en qué piso está, que es lo
               primero que se busca al recibir el papel. */
            alcance={
              view.room
                ? {
                    tipo: 'sala',
                    room: view.room,
                    building: view.building,
                    zoneName,
                  }
                : { tipo: 'edificio', building: view.building }
            }
            /* De la hoja de una sala se vuelve a su ficha, y de la del edificio a
               la lista. Si por el camino había una revisión a medias no se pierde
               —el borrador está en Dexie y la lista lo marca «A medias»—, igual
               que ya ocurre al salir por la hoja de placas. Lo decide `atras`. */
            onBack={volver}
            puedeCorregir={RANK[role] >= RANK.supervisor}
          />
        </Suspense>
      )}

      {tab !== 'revisar' && (
        <Suspense fallback={<Esqueleto />}>
          {tab === 'panel' && (
            <DashboardPage
              ir={{
                revisar: () => {
                  setTab('revisar')
                  setView({ name: 'edificios' })
                },
                incidencias: () => setTab('incidencias'),
                /* Solo si de verdad se puede entrar: la tarjeta ámbar «Datos
                   por revisar» se pinta en cuanto hay un edificio sin
                   identificar, y ese contador es real también para un técnico
                   —la política de lectura de `buildings` es `is_staff()`—. Sin
                   este condicional, el único atajo de la aplicación a «Datos»
                   era el que se le ofrecía a quien no puede usarlo. */
                datos: puedeVer('datos', role)
                  ? () => {
                      // A la sección donde está lo que la tarjeta anuncia.
                      setDatosEn('importacion')
                      setTab('datos')
                    }
                  : undefined,
              }}
            />
          )}
          {tab === 'incidencias' && (
            <IncidentsPage
              onAbrirSala={(roomId) => {
                void (async () => {
                  const room = await db.rooms.get(roomId)
                  const zone = room ? await db.zones.get(room.zone_id) : undefined
                  const building = zone ? await db.buildings.get(zone.building_id) : undefined
                  if (!room || !building) return
                  setTab('revisar')
                  setView({ name: 'ficha', building, room, volverA: 'incidencias' })
                })()
              }}
            />
          )}
          {tab === 'almacen' && <StockPage role={role} />}
          {tab === 'equipos' && <EquiposPage role={role} />}
          {tab === 'historial' && <HistorialPage />}
          {tab === 'actividad' && (
            <div className="mx-auto max-w-4xl p-4">
              <Actividad usuarios={role !== 'tecnico'} />
            </div>
          )}
          {/* Sin `role`: aquí dentro todo el mundo es administrador, así que la
              pantalla no tiene que decidir nada según el rol. Lo que la protege
              es el `puedeVer` de la línea de abajo. */}
          {/* El rol se comprueba TAMBIÉN aquí, y no solo en la barra de
              abajo: es lo único que hay entre un atajo —el de la tarjeta ámbar,
              o cualquiera que se añada mañana— y el panel de administración
              montado entero para quien no puede tocar nada de lo que enseña. */}
          {tab === 'informes' && puedeVer('informes', role) && <ReportsPage />}
          {tab === 'datos' && puedeVer('datos', role) && (
            <CleanupPage yo={userId} abrirEn={datosEn ?? undefined} />
          )}
        </Suspense>
      )}
    </Marco>
  )
}
