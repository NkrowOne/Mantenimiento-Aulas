/**
 * Descarga del maestro al dispositivo.
 *
 * El conjunto entero son ~276 salas, 23 edificios y un centenar de artículos:
 * cabe sobradamente en IndexedDB. Por eso no hace falta un motor de
 * sincronización — se baja todo y la interfaz lee siempre de local, sin esperar
 * nunca a la red.
 *
 * «Todo» se dice pronto, y costó datos aprenderlo: PostgREST puede traer un
 * tope de filas por respuesta y lo aplica sin avisar, así que cada tabla se
 * baja **por páginas** (`descargaEntera`) hasta la página corta que confirma el
 * final. Sin eso, el inventario creció por encima del tope y las descargas
 * llegaban truncadas: equipos e incidencias perfectamente guardados dejaban de
 * verse en el dispositivo — y la poda, leyendo la ausencia como borrado, los
 * quitaba del espejo.
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
import { descargaEntera, type Descarga, type Pagina } from './paginada'
import type { Asset, AssetRemoval, AssetType, Building, Incident, Room, StockItem,
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

/**
 * La respuesta de una tabla, ya juntada de todas sus páginas.
 *
 * `completa` es la pieza nueva y la que importa: PostgREST puede llevar un tope
 * de filas por respuesta (el Supabase gestionado trae 1.000 de fábrica) y lo
 * aplica sin avisar. Antes de paginar, ese tope hacía que `assets` llegara a
 * trozos en cuanto el inventario creció —los equipos por defecto «desaparecían»
 * del dispositivo— y, mucho peor, la poda leía la ausencia como borrado y
 * eliminaba del espejo equipos e incidencias que estaban perfectamente
 * guardados. Ahora todo se pide por páginas (`descargaEntera`) y **la poda solo
 * actúa sobre un conjunto completo**.
 */
type Respuesta<T> = Descarga<T>

/** Cómo se pide cada página de una tabla. El `order` estable es obligatorio:
    sin él PostgREST no garantiza el orden entre peticiones y dos páginas
    podrían solaparse o dejar un hueco. */
type PorPagina = (desde: number, hasta: number) => PromiseLike<Pagina<Record<string, unknown>>>

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

  const vacio: Respuesta<Record<string, unknown>> = { data: [], error: null, completa: false }
  const tablas: Array<[string, PorPagina]> = [
    ['buildings', (d, h) => supabase.from('buildings').select('*').order('sort_order').order('id').range(d, h)],
    ['zones', (d, h) => supabase.from('zones').select('*').order('id').range(d, h)],
    ['room_overview', (d, h) => supabase.from('room_overview').select('*').order('room_id').range(d, h)],
    ['stock_items', (d, h) => supabase.from('stock_items').select('*').eq('active', true).order('id').range(d, h)],
    ['stock_levels', (d, h) => supabase.from('stock_levels').select('*').order('stock_item_id').range(d, h)],
    ['incidents', (d, h) => supabase.from('incidents').select('*').neq('state', 'resuelta').order('id').range(d, h)],
    // El catálogo entero, fusionados incluidos: sin las lápidas, un elemento
    // cuyo tipo se fusionó ayer se quedaría sin nombre en el dispositivo.
    ['asset_types', (d, h) => supabase.from('asset_types').select('*').order('id').range(d, h)],
    ['assets', (d, h) => supabase.from('assets').select('*').neq('status', 'retirado').order('id').range(d, h)],
    // Solo las vivas: una retirada ya decidida no tiene nada que enseñar en
    // el aula —el equipo ya se fue, o sigue ahí— y las decididas crecen sin
    // parar.
    ['asset_removals', (d, h) => supabase.from('asset_removals').select('*').eq('state', 'pendiente').order('id').range(d, h)],
  ]

  const consultas: Array<{ tabla: string; res: Respuesta<Record<string, unknown>> }> =
    await Promise.all(
      tablas.map(async ([tabla, porPagina]) => ({
        tabla,
        res: await descargaEntera(porPagina),
      })),
    )

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
   * Y nunca sobre una respuesta vacía, con error o **incompleta**, que es la
   * firma de RLS bloqueando o de media descarga: eso vaciaría el dispositivo
   * entero por un token mal emitido. Lo de incompleta es la lección más cara de
   * este fichero: con el tope de filas de PostgREST, una descarga truncada a
   * 1.000 equipos hacía «desaparecer» del dispositivo los equipos que quedaban
   * fuera de la ventana — incluidos los del equipamiento por defecto que sí
   * estaban sincronizados.
   */
  const podar = async (
    res: Respuesta<Record<string, unknown>>,
    tabla: { toCollection: () => { primaryKeys: () => Promise<unknown[]> }; bulkDelete: (k: string[]) => Promise<unknown> },
    idDe: (fila: Record<string, unknown>) => string,
    /** Los que no se tocan aunque el servidor no los mencione. */
    conservar?: (candidatos: string[]) => Promise<Set<string>>,
  ): Promise<void> => {
    if (res.error || !res.completa || !res.data?.length) return
    const vivos = new Set(res.data.map(idDe))
    const locales = (await tabla.toCollection().primaryKeys()) as string[]
    let sobran = locales.filter((id) => !vivos.has(id))
    if (sobran.length > 0 && conservar) {
      const salvados = await conservar(sobran)
      sobran = sobran.filter((id) => !salvados.has(id))
    }
    if (sobran.length > 0) await tabla.bulkDelete(sobran)
  }

  /**
   * La red de seguridad para podar lo que el dispositivo SÍ crea por su cuenta.
   *
   * Con los equipos y las retiradas no basta con «no está en la respuesta, se
   * borra», y por dos motivos distintos:
   *
   *  - Lo que espera en la cola de salida todavía no ha llegado al servidor, así
   *    que por definición no puede venir en su respuesta. Borrarlo sería tirar
   *    el trabajo del técnico antes de que suba.
   *  - Y hay una carrera estrecha pero real: si la descarga sale un instante
   *    antes de que termine la subida, la respuesta no trae el equipo que acaba
   *    de guardarse y su entrada en la cola ya se ha borrado. Sin margen, el
   *    aparato desaparecería de la pantalla y volvería dos minutos después.
   *
   * De ahí el cuarto de hora de gracia: lo recién creado no se juzga.
   */
  const margen = Date.now() - 15 * 60_000
  const enCola = new Set((await db.outbox.toCollection().primaryKeys()) as string[])
  const salvarRecientes = (fecha: (id: string) => Promise<string | null>) =>
    async (candidatos: string[]): Promise<Set<string>> => {
      const salvados = new Set<string>()
      for (const id of candidatos) {
        if (enCola.has(id)) {
          salvados.add(id)
          continue
        }
        const at = await fecha(id)
        if (at === null || new Date(at).getTime() > margen) salvados.add(id)
      }
      return salvados
    }

  await guardar<Building>(de('buildings'), db.buildings)
  await guardar<Zone>(de('zones'), db.zones)
  await guardar<StockItem>(de('stock_items'), db.stockItems)
  await guardar<StockLevel>(de('stock_levels'), db.stockLevels)
  await guardar<Incident>(de('incidents'), db.incidents)
  await guardar<AssetType>(de('asset_types'), db.assetTypes)
  await guardar<Asset>(de('assets'), db.assets)
  await guardar<AssetRemoval>(de('asset_removals'), db.assetRemovals)

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

  /*
   * Y los equipos, que es lo que hace que retirar signifique algo.
   *
   * La consulta pide los que NO están retirados, así que un equipo que un
   * coordinador retira —o descarta— deja de venir. Sin podar, se quedaba en el
   * dispositivo con el estado de antes: seguía saliendo en la sala, seguía
   * apareciendo en el formulario de revisión y no había forma de que se fuera.
   * La decisión del panel no llegaba al aula, que es el único sitio donde
   * importa.
   */
  await podar(
    de('assets'),
    db.assets,
    (a) => a['id'] as string,
    salvarRecientes(async (id) => (await db.assets.get(id))?.created_at ?? null),
  )

  // Lo mismo con las retiradas: al decidirse dejan de ser pendientes, y la
  // marca «retirada solicitada» tiene que desaparecer del equipo.
  await podar(
    de('asset_removals'),
    db.assetRemovals,
    (r) => r['id'] as string,
    salvarRecientes(async (id) => (await db.assetRemovals.get(id))?.requested_at ?? null),
  )

  const todasVacias = fallos.length === 0 && vacias.length === consultas.length

  /*
   * Y las incidencias que alguien ya resolvió.
   *
   * No pasa por `podar` porque necesita lo contrario que las tres de arriba: la
   * consulta pide solo las que NO están resueltas, así que la respuesta vacía es
   * la buena noticia —no queda ninguna abierta— y hay que actuar sobre ella. Con
   * `podar`, que se planta ante una respuesta vacía, la incidencia resuelta se
   * quedaba en el dispositivo con su estado de ayer para siempre.
   *
   * Y eso no era cosmético desde que la revisión abre incidencias: el espejo es
   * lo que responde a «¿este proyector ya tiene una abierta?». Con una resuelta
   * fosilizada dentro, la respuesta era «sí» eternamente y el aparato no volvía a
   * aparecer en Incidencias por mucho que siguiera roto.
   *
   * Dos salvaguardas. Nunca sobre un error ni sobre la firma de RLS bloqueando
   * —todas las tablas vacías—, que borraría por un token mal emitido. Y nunca lo
   * que está en la cola de salida: una incidencia recién abierta en un aula sin
   * cobertura todavía no está en la respuesta del servidor, y esto la borraría
   * antes de que llegue a subir.
   */
  /*
   * Y la tercera salvaguarda, que es la que le faltaba: **el mismo cuarto de hora
   * de gracia que tienen los equipos**.
   *
   * Estar en la cola deja de protegerla en el instante en que sube: la entrada se
   * borra. Si una descarga salió un momento antes —o si PostgREST todavía no ve la
   * fila recién insertada— esa incidencia no viene en la respuesta y ya no está en
   * la cola, así que se borraba del espejo. Y el espejo es lo que contesta a «¿este
   * proyector ya tiene una incidencia abierta?»: sin ella, la revisión de la ronda
   * siguiente abre una segunda para la misma avería. Dos filas en la pestaña para
   * el mismo proyector y el recuento de la sala mintiendo.
   *
   * Lo recién abierto no se juzga, igual que con los equipos y las retiradas.
   */
  // Y con el mismo requisito de conjunto completo que `podar`: si la lista de
  // abiertas llegó truncada, la ausencia de una incidencia no significa nada y
  // borrarla del espejo sería repetir el fallo del tope de filas.
  const incidencias = de('incidents')
  if (!incidencias.error && incidencias.completa && !todasVacias) {
    const vivas = new Set((incidencias.data ?? []).map((i) => i['id'] as string))
    const enCola = new Set((await db.outbox.toCollection().primaryKeys()) as string[])
    const locales = await db.incidents.toArray()
    const cerradas = locales
      .filter((i) => {
        if (vivas.has(i.id) || enCola.has(i.id)) return false
        const abierta = i.opened_at ? new Date(i.opened_at).getTime() : 0
        return abierta <= margen
      })
      .map((i) => i.id)
    if (cerradas.length > 0) await db.incidents.bulkDelete(cerradas)
  }

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

// -----------------------------------------------------------------------------
// Reconciliación dirigida: los equipos de UNA sala
// -----------------------------------------------------------------------------

/** Cuándo se reconcilió cada sala por última vez, para no repetirlo por
    entrar y salir de la misma revisión. */
const ultimoRefrescoDeSala = new Map<string, number>()

/**
 * Pone al día los equipos de una sala con lo que el servidor sabe de ella.
 *
 * Se llama al abrir la revisión, y existe por una promesa concreta: **la
 * siguiente revisión tiene que traer todos los equipos que trajo la última**.
 * El formulario construye sus filas con el espejo local, así que cualquier
 * cosa que le falte al espejo —una descarga truncada de hace días, un equipo
 * dado de alta desde otro dispositivo esta mañana— es una fila que la revisión
 * pierde sin decirlo. La descarga global ya se defiende del tope de filas;
 * esto cierra la ventana que queda entre descargas, con una consulta pequeña
 * y solo de la sala que se tiene delante.
 *
 * Sin red no hace nada y no molesta: la revisión sigue funcionando con el
 * espejo, que es el contrato de toda la aplicación.
 *
 * La poda local respeta las tres salvaguardas de la descarga global —cola de
 * salida, cuarto de hora de gracia y nunca sobre una respuesta vacía o
 * incompleta— porque el riesgo es el mismo: borrar del dispositivo el trabajo
 * que todavía no ha subido, o leer un fallo de permisos como una sala vacía.
 */
export async function pullSala(roomId: string): Promise<void> {
  if (!navigator.onLine) return

  const ahora = Date.now()
  if (ahora - (ultimoRefrescoDeSala.get(roomId) ?? 0) < 60_000) return
  ultimoRefrescoDeSala.set(roomId, ahora)

  const { data: sesion } = await supabase.auth.getSession()
  if (!sesion.session) return

  const res = await descargaEntera<Record<string, unknown>>((d, h) =>
    supabase
      .from('assets')
      .select('*')
      .eq('room_id', roomId)
      .neq('status', 'retirado')
      .order('id')
      .range(d, h),
  )
  // Una respuesta vacía no poda: no se distingue de RLS bloqueando, y la
  // descarga global —que sí tiene la firma para diagnosticarlo— ya se encarga.
  if (res.error || !res.completa || !res.data || res.data.length === 0) return

  await db.assets.bulkPut(res.data as unknown as Asset[])

  const vivos = new Set(res.data.map((a) => a['id'] as string))
  const enCola = new Set((await db.outbox.toCollection().primaryKeys()) as string[])
  const margen = Date.now() - 15 * 60_000

  const locales = await db.assets.where('room_id').equals(roomId).toArray()
  const sobran = locales
    .filter((a) => !vivos.has(a.id) && !enCola.has(a.id))
    // Lo recién creado no se juzga: puede estar subiendo en este instante.
    .filter((a) => a.created_at !== null && new Date(a.created_at).getTime() <= margen)
    .map((a) => a.id)

  if (sobran.length > 0) await db.assets.bulkDelete(sobran)
}
