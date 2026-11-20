/**
 * El informe, pedido al servidor para no tener que quedarse mirando.
 *
 * QUÉ RESUELVE. Generar el informe en el navegador exige que el navegador siga
 * despierto, y en un iPhone no lo está en cuanto se bloquea la pantalla o se
 * cambia de aplicación: el sistema congela la página, corta lo que tuviera a
 * medias y el informe no llega a existir. Con la IA redactando es hasta un
 * minuto de pantalla encendida sin tocar nada.
 *
 * Aquí la pantalla solo PIDE. El servidor de informes —el mismo que convierte
 * el documento a PDF— contesta enseguida «aceptado», lo genera con este mismo
 * código y lo deja en el archivo, con su PDF al lado. Se puede cerrar la
 * aplicación. Por dónde va se lee en `report_jobs`, desde este dispositivo o
 * desde otro, ahora o dentro de una hora.
 *
 * Y SI EL SERVIDOR NO PUEDE, NO PASA NADA. Un despliegue sin el servidor de
 * informes, uno sin actualizar o sin la migración de `report_jobs` contesta que
 * no —o no contesta—, y entonces el informe se genera aquí, como siempre.
 * Quien llama lo distingue por `sinServicio`. Nadie se queda sin informe por
 * que falte una pieza que antes no existía.
 */

import { supabase } from '@/lib/supabase'
import { type Eleccion, construirPeticion } from '../peticion'
import { type Kind, type Rango, nombrePeriodo } from '../periodos'
import { TOPE_CONSULTA_MS, TOPE_PDF_MS, conPlazo, esSilencio, señalConTope } from './espera'
import type { InformeGenerado } from './generar'

export type EstadoDelTrabajo = 'en_cola' | 'en_curso' | 'hecho' | 'fallido'

/** Una fila de `report_jobs`: un informe pedido al servidor, y por dónde va. */
export interface Trabajo {
  id: string
  kind: Kind
  period_start: string
  period_end: string
  params: Record<string, unknown> | null
  estado: EstadoDelTrabajo
  paso: string | null
  detalle: string | null
  error: string | null
  storage_path: string | null
  pedido_at: string
  latido_at: string
  terminado_at: string | null
}

export type Aceptado =
  | { ok: true; id: string }
  /**
   * No lo ha cogido. `sinServicio` es «el servidor no puede o no está», y de
   * ahí se sale generándolo en el navegador; sin él, es algo que hay que
   * enseñar tal cual porque repetirlo aquí no lo arregla.
   */
  | { ok: false; motivo: string; sinServicio: boolean }

/** Aceptar es apuntar una fila y contestar: si tarda más que esto, no está. */
const TOPE_ACEPTAR_MS = 15_000

/**
 * Pide el informe. No lo espera: lo que vuelve es «aceptado» y un id.
 *
 * `keepalive` es la mitad del arreglo: con él la petición sale aunque la
 * página se cierre o pase a segundo plano en el mismo instante del toque, que
 * es exactamente lo que hace quien pulsa «Generar» y guarda el teléfono.
 */
export async function pedirAlServidor(
  eleccion: Eleccion,
  token: string | null,
  /** La clave de Gemini de este dispositivo, si tiene una: el servidor no puede leerla de aquí. */
  claveDelDispositivo = '',
): Promise<Aceptado> {
  // Sin sesión no hay a nombre de quién pedirlo, ni aquí ni allí.
  if (!token) return { ok: false, motivo: 'no hay sesión con la que pedirlo', sinServicio: true }

  const p = construirPeticion(eleccion)
  let respuesta: Response
  try {
    respuesta = await fetch('/informe/generar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: p.kind,
        start: p.p_start,
        end: p.p_end,
        params: p.p_params,
        ...(claveDelDispositivo ? { clave: claveDelDispositivo } : {}),
      }),
      keepalive: true,
      signal: señalConTope(TOPE_ACEPTAR_MS),
    })
  } catch (err) {
    return {
      ok: false,
      motivo: esSilencio(err)
        ? `el servidor no ha contestado en ${Math.round(TOPE_ACEPTAR_MS / 1000)} segundos`
        : 'no se ha podido hablar con el servidor',
      sinServicio: true,
    }
  }

  const cuerpo = comoJson(await respuesta.text().catch(() => ''))

  if (respuesta.ok && cuerpo?.ok === true && typeof cuerpo.id === 'string') {
    return { ok: true, id: cuerpo.id }
  }

  /*
   * Lo que se enseña tal cual: una petición mal hecha (400) y «ya hay varios
   * en marcha» (429). Las dos las dice el servidor de informes con sus
   * palabras, y generarlo aquí no las arregla —la segunda, además, la
   * empeoraría—.
   *
   * Todo lo demás es «no puede»: la ruta no existe (404, o un 200 con la
   * página de la aplicación dentro, que es lo que devuelve un proxy sin la
   * regla), el servidor está caído (502), le falta algo (503), o dice que no a
   * una sesión que la base sí acepta. En todos esos casos el informe sale
   * igual: se hace aquí.
   */
  const suyo = typeof cuerpo?.error === 'string' ? cuerpo.error : null
  if (suyo && (respuesta.status === 400 || respuesta.status === 429)) {
    return { ok: false, motivo: suyo, sinServicio: false }
  }
  return {
    ok: false,
    motivo: suyo ?? `el servidor ha respondido ${respuesta.status} y no es el de informes quien contesta`,
    sinServicio: true,
  }
}

/** El cuerpo, si es un JSON nuestro. Si no lo es, quien ha contestado no es el servidor de informes. */
function comoJson(texto: string): { ok?: unknown; id?: unknown; error?: unknown } | null {
  try {
    const v: unknown = JSON.parse(texto)
    return typeof v === 'object' && v !== null ? (v as { ok?: unknown; id?: unknown; error?: unknown }) : null
  } catch {
    return null
  }
}

const COLUMNAS =
  'id,kind,period_start,period_end,params,estado,paso,detalle,error,storage_path,pedido_at,latido_at,terminado_at'

/**
 * Los informes pedidos al servidor, los últimos primero.
 *
 * Si la tabla no existe —la migración sin aplicar— no hay ninguno, y no es un
 * error que enseñar: la pantalla funciona igual, generando aquí.
 */
export async function leerTrabajos(): Promise<Trabajo[]> {
  const { data, error } = await supabase
    .from('report_jobs')
    .select(COLUMNAS)
    .order('pedido_at', { ascending: false })
    .limit(12)
    .abortSignal(señalConTope(TOPE_CONSULTA_MS))
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205' || /report_jobs/.test(error.message)) return []
    throw error
  }
  return (data ?? []) as Trabajo[]
}

/**
 * Cuánto silencio hace falta, visto desde aquí, para dudar de un trabajo.
 *
 * El servidor renueva el pulso cada quince segundos y él mismo da por perdido
 * lo que lleve minuto y medio callado. Esto es para cuando el servidor no
 * vuelve a arrancar y nadie barre: holgado, porque se compara con el reloj de
 * ESTE dispositivo, y un iPad con la hora cinco minutos mal no puede declarar
 * muerto un informe que iba bien.
 */
export const SILENCIO_MS = 6 * 60_000

const activo = (t: Trabajo): boolean => t.estado === 'en_cola' || t.estado === 'en_curso'

/** Activo según su fila, pero sin pulso: lo más probable es que el servidor se parara. */
export function estaAMedias(t: Trabajo, ahora = Date.now()): boolean {
  return activo(t) && ahora - Date.parse(t.latido_at) > SILENCIO_MS
}

/** Se está haciendo, de verdad: es lo que justifica seguir preguntando. */
export function sigueVivo(t: Trabajo, ahora = Date.now()): boolean {
  return activo(t) && !estaAMedias(t, ahora)
}

/** Cuánto se enseña en la lista un informe ya hecho antes de dejarlo solo en el archivo. */
const SE_ENSENA_MS = 24 * 60 * 60_000

/**
 * Los que tienen algo que decir: los que están en ello, los que no salieron, y
 * los hechos en el último día. Los demás ya son una fila del archivo.
 */
export function paraEnsenar(trabajos: Trabajo[], ahora = Date.now()): Trabajo[] {
  return trabajos.filter(
    (t) =>
      t.estado !== 'hecho' ||
      ahora - Date.parse(t.terminado_at ?? t.pedido_at) < SE_ENSENA_MS,
  )
}

/** Lo que se pidió, para volver a pedirlo con un toque. */
export function eleccionDe(t: Trabajo): Eleccion {
  const p = t.params ?? {}
  const texto = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    kind: t.kind,
    rango: { start: t.period_start, end: t.period_end },
    secciones: Array.isArray(p['secciones'])
      ? p['secciones'].filter((s): s is string => typeof s === 'string')
      : [],
    comparar: p['comparar'] !== false,
    ia: p['ia'] !== false,
    audiencia: p['audiencia'] === 'equipo' ? 'equipo' : 'direccion',
    enfoque: texto(p['enfoque']),
    nota: texto(p['nota']),
  }
}

/** Quita la fila de la lista. El informe, si salió, sigue en el archivo. */
export async function quitarTrabajo(id: string): Promise<void> {
  const { error } = await supabase
    .from('report_jobs')
    .delete()
    .eq('id', id)
    .abortSignal(señalConTope(TOPE_CONSULTA_MS))
  if (error) throw new Error(error.message)
}

/**
 * El informe que dejó hecho el servidor, traído a la pantalla.
 *
 * Devuelve lo mismo que `generarInforme`, para que la tarjeta de «Listo» no
 * tenga que saber de dónde ha salido: el documento del archivo, y de su fila
 * cómo se redactó. Sin Excel, que no se archiva: se rehace al momento.
 */
export async function recogerInforme(t: Trabajo): Promise<InformeGenerado> {
  if (!t.storage_path) throw new Error('El servidor no ha dicho dónde dejó el informe.')
  const rango: Rango = { start: t.period_start, end: t.period_end }

  const { data, error } = await conPlazo(
    'El archivo de informes',
    TOPE_PDF_MS,
    supabase.storage.from('reports').download(t.storage_path),
  )
  if (error || !data) {
    throw new Error(`No se ha podido leer el informe del archivo${error ? `: ${error.message}` : ''}.`)
  }
  const html = await data.text()

  // Cómo salió, de la fila del archivo. Si no se puede leer, el informe se
  // enseña igual: lo que falta es una frase sobre quién redactó el análisis.
  let huella: { ia?: unknown; aviso_ia?: unknown; analisis?: unknown } = {}
  try {
    const { data: fila } = await supabase
      .from('reports')
      .select('params')
      .eq('storage_path', t.storage_path)
      .limit(1)
      .abortSignal(señalConTope(TOPE_CONSULTA_MS))
      .maybeSingle()
    huella = ((fila as { params?: typeof huella } | null)?.params ?? {}) as typeof huella
  } catch {
    // Se queda sin la frase.
  }

  return {
    html,
    kind: t.kind,
    rango,
    periodoTexto: nombrePeriodo(rango),
    analisis: typeof huella.analisis === 'string' ? huella.analisis : '',
    conIA: huella.ia === true,
    avisoIA: typeof huella.aviso_ia === 'string' ? huella.aviso_ia : null,
    archivado: t.storage_path,
    motivoArchivo: null,
    excel: null,
    motivoExcel: null,
  }
}

// ── El PDF, guardado al lado del documento ───────────────────────────────────

/** Dónde vive el PDF de un informe archivado: la misma ruta, con otra extensión. */
export function rutaDelPdf(rutaDelDocumento: string): string {
  return rutaDelDocumento.replace(/\.html$/i, '.pdf')
}

/**
 * El PDF que ya esté hecho, o `null`.
 *
 * El servidor lo deja al lado del documento cuando genera el informe, y la
 * pantalla lo deja también la primera vez que alguien lo convierte. Así el
 * segundo que pide el PDF de marzo no espera a WeasyPrint: lo baja. Y los
 * informes antiguos, que el worker archivaba ya en PDF, salen por aquí
 * directamente en vez de pasar por un conversor que no entiende de PDF.
 *
 * Que no esté no es un error: se convierte, como siempre. Nunca lanza.
 */
export async function pdfGuardado(rutaDelDocumento: string): Promise<Blob | null> {
  try {
    const { data, error } = await conPlazo(
      'El archivo de informes',
      TOPE_CONSULTA_MS,
      supabase.storage.from('reports').download(rutaDelPdf(rutaDelDocumento)),
    )
    if (error || !data || data.size === 0) return null
    // Que sea un PDF y no una página de error con extensión de PDF.
    const cabecera = new TextDecoder().decode(await data.slice(0, 5).arrayBuffer())
    return cabecera === '%PDF-' ? new Blob([data], { type: 'application/pdf' }) : null
  } catch {
    return null
  }
}

/**
 * Deja el PDF recién convertido al lado del documento, para el siguiente.
 *
 * Sin esperar y sin avisar: es una cortesía con quien venga después, no parte
 * de lo que se ha pedido. Si ya estaba, o si la política no deja, no pasa nada.
 */
export function guardarPdfAlLado(rutaDelDocumento: string, pdf: Blob): void {
  if (!/\.html$/i.test(rutaDelDocumento)) return
  void Promise.resolve(
    supabase.storage
      .from('reports')
      .upload(rutaDelPdf(rutaDelDocumento), pdf, { contentType: 'application/pdf', upsert: false }),
  ).catch(() => undefined)
}
