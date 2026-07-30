/**
 * Descarga del maestro al dispositivo.
 *
 * El conjunto entero son ~276 salas, 23 edificios y un centenar de artículos:
 * cabe sobradamente en IndexedDB. Por eso no hace falta un motor de
 * sincronización — se baja todo y la interfaz lee siempre de local, sin esperar
 * nunca a la red.
 *
 * Lo que esta función NO puede volver a hacer es callarse.
 *
 * Antes ignoraba el `error` de cada respuesta y hacía `if (data) bulkPut(data)`.
 * Con eso, un token sin el claim `app_role`, una política de RLS que no deja
 * leer, o una tabla que la API no encuentra, se veían todos exactamente igual
 * que un servidor vacío: la aplicación arrancaba, no ponía ni una fila y no
 * decía nada. El técnico veía «Sin datos» y no había forma —desde el iPad, que
 * es donde ocurre— de distinguir «no hay nada que traer» de «el servidor no me
 * deja». Ahora cada consulta se mira una a una y el resultado se guarda para
 * que la interfaz pueda enseñarlo.
 */

import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import type { Asset, AssetModel, AssetType, Building, Incident, Room, StockItem,
  StockLevel, Zone } from '@/domain/types'

/** Dónde queda el parte de la última descarga, para que la interfaz lo lea. */
export const DIAGNOSTICO_PULL = 'ultimo-pull'

export interface FalloDeTabla {
  tabla: string
  mensaje: string
  code: string | null
}

export interface ResultadoPull {
  ok: boolean
  /** Filas escritas en local, sumando todas las tablas. */
  filas: number
  /** Explicación corta y accionable cuando algo ha ido mal. */
  error: string | null
  fallos: FalloDeTabla[]
  /** Cuántas tablas han contestado bien pero con cero filas. */
  vacias: string[]
  at: number
}

interface Respuesta<T> {
  data: T[] | null
  error: { message: string; code?: string } | null
}

/**
 * Cero filas sin error es la firma de RLS.
 *
 * PostgREST no distingue «no tienes permiso» de «no hay nada»: una política que
 * no te deja ver una tabla devuelve `200 []`, igual que una tabla vacía. Como
 * aquí ninguna de las tablas maestras puede estar legítimamente vacía en un
 * despliegue en uso, que TODAS vengan a cero es la única pista que hay, y vale:
 * es exactamente lo que pasa cuando el JWT llega sin el claim `app_role` y
 * `public.is_staff()` es falso para todo.
 */
function diagnosticarVacio(): string {
  return (
    'El servidor responde correctamente pero no devuelve ninguna fila. ' +
    'Suele ser el rol: el token no lleva el claim `app_role`, así que RLS ' +
    'bloquea todas las lecturas. Comprueba que GoTrue tiene activado el hook ' +
    'GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true con ' +
    'GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI=pg-functions://postgres/public/custom_access_token_hook ' +
    'y vuelve a entrar con el PIN para que se emita un token nuevo.'
  )
}

export async function pullMaster(): Promise<ResultadoPull> {
  const parte = async (r: ResultadoPull): Promise<ResultadoPull> => {
    await db.meta.put({ key: DIAGNOSTICO_PULL, value: r })
    return r
  }

  if (!navigator.onLine) {
    return parte({
      ok: false,
      filas: 0,
      error: 'Sin conexión: no hay nada que descargar.',
      fallos: [],
      vacias: [],
      at: Date.now(),
    })
  }

  // Sin sesión, PostgREST recibe solo la clave anónima y RLS no deja leer nada.
  // Merece decirse aparte: es un estado normal —aún no se ha metido el PIN—,
  // no un fallo del servidor.
  const { data: sesion } = await supabase.auth.getSession()
  if (!sesion.session) {
    return parte({
      ok: false,
      filas: 0,
      error: 'No hay sesión iniciada: desbloquea con tu PIN y vuelve a intentarlo.',
      fallos: [],
      vacias: [],
      at: Date.now(),
    })
  }

  const vacio: Respuesta<Record<string, unknown>> = { data: [], error: null }
  const consultas: Array<{ tabla: string; res: Respuesta<Record<string, unknown>> }> = (
    await Promise.all(
      [
        ['buildings', supabase.from('buildings').select('*').order('sort_order')],
        ['zones', supabase.from('zones').select('*')],
        ['room_overview', supabase.from('room_overview').select('*')],
        ['stock_items', supabase.from('stock_items').select('*').eq('active', true)],
        ['stock_levels', supabase.from('stock_levels').select('*')],
        ['incidents', supabase.from('incidents').select('*').neq('state', 'resuelta')],
        // El catálogo entero, fusionados incluidos: sin las lápidas, un elemento
        // cuyo tipo se fusionó ayer se quedaría sin nombre en el dispositivo.
        ['asset_types', supabase.from('asset_types').select('*')],
        // Y el de modelos, por lo mismo y por una razón más: elegir el modelo de
        // un proyector se hace delante del proyector, que es donde no hay línea.
        // Sin espejo, el desplegable saldría vacío justo cuando se usa.
        ['asset_models', supabase.from('asset_models').select('*')],
        ['assets', supabase.from('assets').select('*').neq('status', 'retirado')],
      ].map(async ([tabla, consulta]) => ({
        tabla: tabla as string,
        res: (await consulta) as Respuesta<Record<string, unknown>>,
      })),
    )
  ).map((c) => c)

  const de = (tabla: string): Respuesta<Record<string, unknown>> =>
    consultas.find((c) => c.tabla === tabla)?.res ?? vacio

  const fallos: FalloDeTabla[] = consultas
    .filter((c) => c.res.error)
    .map((c) => ({
      tabla: c.tabla,
      mensaje: c.res.error?.message ?? 'error desconocido',
      code: c.res.error?.code ?? null,
    }))

  const vacias = consultas.filter((c) => !c.res.error && (c.res.data?.length ?? 0) === 0).map((c) => c.tabla)

  // Se escribe lo que SÍ haya llegado aunque otra tabla falle: media descarga
  // sirve de más que ninguna, y la que falta se reintenta en la siguiente.
  let filas = 0
  const guardar = async <T>(res: Respuesta<Record<string, unknown>>, tabla: { bulkPut: (v: T[]) => Promise<unknown> }): Promise<void> => {
    if (res.error || !res.data?.length) return
    await tabla.bulkPut(res.data as T[])
    filas += res.data.length
  }

  /**
   * Y se borra lo que ya no está.
   *
   * `bulkPut` solo sabe añadir y pisar, así que el espejo era acumulativo: una
   * sala archivada desde el panel —o un edificio borrado— se quedaba en el
   * dispositivo para siempre, y el técnico la seguía viendo en su lista, la
   * seguía revisando y sus revisiones se quedaban colgando de una sala que la
   * aplicación ya no enseña en ningún otro sitio.
   *
   * Solo se poda el maestro —edificios, zonas y salas—, y esa frontera importa:
   * son las tres tablas que el dispositivo nunca crea por su cuenta, así que lo
   * que no viene del servidor es que ya no existe. Con los equipos no valdría:
   * uno recién dado de alta en el aula, todavía en la cola de salida, no está
   * aún en la respuesta del servidor y esto lo borraría antes de que llegue a
   * subir.
   *
   * Y nunca sobre una respuesta vacía o con error, que es la firma de RLS
   * bloqueando o de media descarga: eso vaciaría el dispositivo entero por un
   * token mal emitido.
   */
  const podar = async (
    res: Respuesta<Record<string, unknown>>,
    tabla: { toCollection: () => { primaryKeys: () => Promise<unknown[]> }; bulkDelete: (k: string[]) => Promise<unknown> },
    idDe: (fila: Record<string, unknown>) => string,
  ): Promise<void> => {
    if (res.error || !res.data?.length) return
    const vivos = new Set(res.data.map(idDe))
    const locales = (await tabla.toCollection().primaryKeys()) as string[]
    const sobran = locales.filter((id) => !vivos.has(id))
    if (sobran.length > 0) await tabla.bulkDelete(sobran)
  }

  await guardar<Building>(de('buildings'), db.buildings)
  await guardar<Zone>(de('zones'), db.zones)
  await guardar<StockItem>(de('stock_items'), db.stockItems)
  await guardar<StockLevel>(de('stock_levels'), db.stockLevels)
  await guardar<Incident>(de('incidents'), db.incidents)
  await guardar<AssetType>(de('asset_types'), db.assetTypes)
  await guardar<AssetModel>(de('asset_models'), db.assetModels)
  await guardar<Asset>(de('assets'), db.assets)

  const rooms = de('room_overview')
  if (!rooms.error && rooms.data?.length) {
    // `room_overview` ya trae la fecha de la última revisión resuelta por el
    // servidor, así que la lista de trabajo se puede ordenar sin consultar nada.
    const mapped: Room[] = rooms.data.map((r) => ({
      id: r['room_id'] as string,
      zone_id: r['zone_id'] as string,
      code: r['room_code'] as string,
      name: r['room_name'] as string,
      kind: r['kind'] as Room['kind'],
      capabilities: r['capabilities'] as Room['capabilities'],
      projector_hours: (r['projector_hours'] as number | null) ?? null,
      lamp_pct: (r['lamp_pct'] as number | null) ?? null,
      last_inspection_at: (r['last_inspection_at'] as string | null) ?? null,
      last_inventory_at: (r['last_inventory_at'] as string | null) ?? null,
      active: true,
      short_ref: (r['short_ref'] as string | null) ?? null,
    }))
    await db.rooms.bulkPut(mapped)
    filas += mapped.length
  }

  await podar(de('buildings'), db.buildings, (b) => b['id'] as string)
  await podar(de('zones'), db.zones, (z) => z['id'] as string)
  await podar(rooms, db.rooms, (r) => r['room_id'] as string)

  const todasVacias = fallos.length === 0 && vacias.length === consultas.length

  const error =
    fallos.length > 0
      ? `${fallos[0]?.tabla}: ${fallos[0]?.mensaje}${
          fallos.length > 1 ? ` (y ${fallos.length - 1} tabla(s) más)` : ''
        }`
      : todasVacias
        ? diagnosticarVacio()
        : null

  if (filas > 0) await db.meta.put({ key: 'last-pull', value: Date.now() })

  // Cualquier descarga cuenta para el freno del refresco automático, también la
  // que se pide a mano desde el panel: si no, pulsar «Sincronizar» y cambiar de
  // aplicación volvería a bajarlo todo un segundo después.
  ultimoIntento = Date.now()

  return parte({ ok: error === null, filas, error, fallos, vacias, at: Date.now() })
}

/** El parte de la última descarga, para pintarlo donde haga falta. */
export async function ultimoPull(): Promise<ResultadoPull | null> {
  return ((await db.meta.get(DIAGNOSTICO_PULL))?.value as ResultadoPull | undefined) ?? null
}

/**
 * Cada cuánto, como mucho, se vuelve a bajar el maestro.
 *
 * La descarga trae 276 salas, 23 edificios y un centenar de artículos: cabe de
 * sobra en el dispositivo, pero no es gratis pedirla. Sin este freno, cada
 * cambio de aplicación y vuelta —que en un iPad de campo son decenas al día—
 * dispararía siete consultas.
 *
 * Dos minutos es el punto donde deja de notarse la espera y todavía no se nota
 * el gasto: el trabajo de un compañero tarda como mucho eso en aparecer.
 */
const REFRESCO_MIN_MS = 2 * 60 * 1000

let ultimoIntento = 0

/**
 * Los disparadores de la BAJADA.
 *
 * Existían los cuatro de la subida —arranque, vuelta de la conexión, vuelta a
 * primer plano y temporizador— y ninguno de la bajada: `pullMaster()` solo
 * corría al desbloquear y al pulsar «Sincronizar» a mano.
 *
 * La asimetría se notaba en el trabajo diario y no en las pruebas: lo que
 * escribe este dispositivo sube en segundos, pero una sala que da de alta un
 * compañero, o una incidencia que cierra el supervisor, no llegaban hasta la
 * siguiente recarga de la aplicación. En un iPad que no cierra nunca la
 * pestaña, eso son días.
 *
 * Volver a primer plano es el disparador que más importa: es exactamente el
 * gesto de «llego al edificio y saco el iPad».
 */
export function startPull(alTerminar?: (r: ResultadoPull) => void): () => void {
  const intentar = (): void => {
    if (!navigator.onLine) return
    const ahora = Date.now()
    if (ahora - ultimoIntento < REFRESCO_MIN_MS) return
    ultimoIntento = ahora
    void pullMaster().then((r) => alTerminar?.(r))
  }

  const alVolverLaRed = (): void => {
    // Recuperar cobertura sí merece saltarse el freno: es el momento exacto en
    // que lo que hay en el dispositivo puede llevar horas obsoleto.
    ultimoIntento = 0
    intentar()
  }
  const alVolverAlFrente = (): void => {
    if (document.visibilityState === 'visible') intentar()
  }

  window.addEventListener('online', alVolverLaRed)
  document.addEventListener('visibilitychange', alVolverAlFrente)

  // La red de seguridad, para el iPad que se queda abierto toda la mañana sin
  // que nadie cambie de aplicación.
  const timer = setInterval(intentar, REFRESCO_MIN_MS)

  return () => {
    window.removeEventListener('online', alVolverLaRed)
    document.removeEventListener('visibilitychange', alVolverAlFrente)
    clearInterval(timer)
  }
}
