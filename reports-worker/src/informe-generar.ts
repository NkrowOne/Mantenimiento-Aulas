/**
 * `POST /informe/generar` — el informe, hecho aquí y sin la aplicación abierta.
 *
 * QUÉ RESUELVE. El informe se arma en el navegador, y un navegador en segundo
 * plano no trabaja: en cuanto se bloquea el iPhone o se cambia de aplicación,
 * el sistema la congela y el informe se queda a medias. Con la IA redactando
 * era hasta un minuto mirando la pantalla sin tocar nada.
 *
 * Ahora la pantalla lo pide y aquí se contesta enseguida «aceptado». El
 * informe se genera después, en este proceso, y queda en el archivo. La
 * pantalla —esa u otra, ahora o dentro de una hora— lee por dónde va en la
 * tabla `report_jobs`.
 *
 * CON QUÉ SE GENERA. Con el código de la aplicación: `src/servidor/informe.ts`
 * llama a la misma función que el botón de la pantalla. Este servidor tuvo su
 * propia copia de los datos, el análisis y la plantilla (`/generate` la sigue
 * usando), y a los dos meses eran dos informes distintos. Aquí no hay copia
 * que mantener a la par.
 *
 * CON QUÉ PERMISOS. Con los de quien lo pide. Las lecturas van con SU sesión
 * —no con la clave de servicio—, así que el informe ve lo que esa persona
 * vería y nada más, y la fila del archivo la escribe ella. La clave de
 * servicio se usa para lo que no es del informe: comprobar la sesión y llevar
 * la cuenta del trabajo en `report_jobs`, que la pantalla no puede escribir.
 *
 * SI SE REINICIA A MITAD. El trabajo vive en memoria y se pierde. Lo que queda
 * es su fila, con el pulso parado: el barrido de abajo la da por fallida y la
 * pantalla ofrece volver a pedirlo, que es un toque porque la fila guarda lo
 * que se pidió. No se reintenta solo: haría falta guardar la sesión de la
 * persona, y eso no se guarda.
 */

import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { apiQueResponde, noSeHaPodidoPreguntar } from './api.js'
import { leerCuerpoPequeno } from './alta.js'
import { quienPide } from './informe-pdf.js'
import { htmlToPdf } from './pdf.js'
import {
  DIAS_MAXIMOS,
  FOTO_LADO_LARGO,
  TOPE_ENFOQUE,
  construirPeticion,
  diasDelRango,
  generarEnElServidor,
  type Eleccion,
} from '../../src/servidor/informe'

const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? ''

/** Emitir un informe es de administrador: lo dice la base y lo dice la pantalla. */
const SOLO_ADMIN: ReadonlySet<string> = new Set(['admin'])

/** La petición es un JSON pequeño: las casillas, dos fechas y media página de instrucciones. */
const TOPE_CUERPO = 16 * 1024

/**
 * Lo que puede tardar un informe entero antes de darlo por perdido.
 *
 * Cada lectura y la IA tienen ya su propio plazo; este es el de todo junto, por
 * si se encadenan. Sin él, un trabajo que no termina nunca dejaría la cola
 * parada detrás.
 */
const TOPE_TRABAJO_MS = Number(process.env['INFORME_TOPE_MS'] ?? 10 * 60_000)

/** Cada cuánto se renueva el pulso de los trabajos vivos. */
const LATIDO_MS = 15_000

/**
 * Cuánto silencio hace falta para dar un trabajo por muerto: seis pulsos.
 * Holgado a propósito —un pulso que llega tarde no puede tumbar un informe que
 * iba bien—, y aun así al minuto y medio de un reinicio ya se sabe.
 */
const SILENCIO_MS = 90_000

/** Cuánto se guarda la fila de un trabajo terminado antes de barrerla. */
const CADUCA_MS = 30 * 24 * 60 * 60_000

/** Cuántos puede tener una persona esperando a la vez, y cuántos todos juntos. */
const TOPE_POR_PERSONA = 3
const TOPE_EN_COLA = 12

const KINDS = ['diario', 'semanal', 'personalizado'] as const
const FECHA = /^\d{4}-\d{2}-\d{2}$/

function responder(res: ServerResponse, codigo: number, cuerpo: unknown): void {
  res
    .writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(JSON.stringify(cuerpo))
}

const ahora = (): string => new Date().toISOString()

// ── Lo que se pide ───────────────────────────────────────────────────────────

/** Un día que existe: `2026-02-30` pasa la expresión regular y no es una fecha. */
function esDia(v: unknown): v is string {
  if (typeof v !== 'string' || !FECHA.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/**
 * Lee la petición sin fiarse de nada.
 *
 * Lo que sale de aquí es la misma `Eleccion` que arma la pantalla, y pasa
 * después por el mismo `leerOpciones` que en el navegador —que es quien quita
 * las secciones que no existen o que no se pueden pedir para dirección—. Aquí
 * solo se comprueba la forma, y que el periodo sea un periodo.
 */
export function leerPeticion(
  cuerpo: unknown,
): { ok: true; eleccion: Eleccion; clave: string } | { ok: false; error: string } {
  const p = (typeof cuerpo === 'object' && cuerpo !== null ? cuerpo : {}) as Record<string, unknown>

  const kind = KINDS.find((k) => k === p['kind'])
  if (!kind) return { ok: false, error: 'Tipo de informe no válido.' }

  if (!esDia(p['start']) || !esDia(p['end'])) {
    return { ok: false, error: 'Las fechas del periodo deben ir como AAAA-MM-DD.' }
  }
  const rango = { start: p['start'], end: p['end'] }
  if (rango.end < rango.start) return { ok: false, error: 'La fecha final es anterior a la inicial.' }
  if (diasDelRango(rango) > DIAS_MAXIMOS) return { ok: false, error: 'El periodo no puede superar un año.' }

  const q = (typeof p['params'] === 'object' && p['params'] !== null ? p['params'] : {}) as Record<
    string,
    unknown
  >
  const texto = (v: unknown, tope: number): string => (typeof v === 'string' ? v.slice(0, tope) : '')

  const secciones = Array.isArray(q['secciones'])
    ? q['secciones'].filter((s): s is string => typeof s === 'string' && s.length <= 40).slice(0, 40)
    : []
  if (secciones.length === 0) return { ok: false, error: 'Marca al menos una sección.' }

  return {
    ok: true,
    eleccion: {
      kind,
      rango,
      secciones,
      comparar: q['comparar'] !== false,
      ia: q['ia'] !== false,
      audiencia: q['audiencia'] === 'equipo' ? 'equipo' : 'direccion',
      enfoque: texto(q['enfoque'], TOPE_ENFOQUE),
      nota: texto(q['nota'], 300),
    },
    // La clave de Gemini del dispositivo, si la manda. No se guarda ni se
    // escribe en ningún registro: vive lo que dura el trabajo.
    clave: texto(p['clave'], 200).trim(),
  }
}

// ── La cuenta del trabajo ────────────────────────────────────────────────────

/** El cliente con la clave de servicio, contra la dirección de la API que responde. */
async function servicio(): Promise<
  { ok: true; admin: SupabaseClient; url: string } | { ok: false; motivo: string }
> {
  if (!SERVICE_KEY) return { ok: false, motivo: 'falta SUPABASE_SERVICE_ROLE_KEY' }
  const r = await apiQueResponde((url) =>
    createClient(url, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } }),
  )
  return r.ok ? { ok: true, admin: r.admin, url: r.url } : { ok: false, motivo: r.motivo }
}

/**
 * El cliente del informe: la API de siempre, con la sesión de quien lo pide.
 *
 * La clave de servicio va de `apikey` porque es la que este proceso tiene —la
 * pasarela solo la usa para dejar pasar—; quién es y qué puede leer lo decide
 * el `Authorization`, que es el token de la persona. Con eso PostgREST y el
 * almacén aplican sus políticas igual que si la consulta saliera de su iPad.
 */
function clienteDe(url: string, token: string): SupabaseClient {
  return createClient(url, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

/**
 * Apunta por dónde va, sin esperar a que se apunte.
 *
 * El informe avisa de cada lectura —una docena de veces en dos segundos— y no
 * puede pararse a esperar a que cada aviso llegue a la base. Se guarda solo el
 * último y se escribe en cuanto termina la escritura anterior: la pantalla
 * pregunta cada dos segundos, no necesita los pasos intermedios.
 */
function apuntador(admin: SupabaseClient, id: string): {
  decir: (cambios: Record<string, unknown>) => void
  asentar: () => Promise<void>
} {
  let pendiente: Record<string, unknown> | null = null
  let escribiendo: Promise<void> | null = null

  const vaciar = async (): Promise<void> => {
    while (pendiente) {
      const cambios = pendiente
      pendiente = null
      try {
        await admin.from('report_jobs').update(cambios).eq('id', id)
      } catch {
        // Un aviso que no llega no es motivo para parar el informe.
      }
    }
    escribiendo = null
  }

  return {
    decir(cambios) {
      pendiente = { ...(pendiente ?? {}), ...cambios, latido_at: ahora() }
      escribiendo ??= vaciar()
    },
    async asentar() {
      while (escribiendo) await escribiendo
    },
  }
}

/** El final se escribe esperando, y con un par de intentos: es lo único que no se puede perder. */
async function cerrar(admin: SupabaseClient, id: string, cambios: Record<string, unknown>): Promise<void> {
  const fila = { ...cambios, paso: null, detalle: null, terminado_at: ahora(), latido_at: ahora() }
  for (let intento = 0; intento < 3; intento++) {
    try {
      const { error } = await admin.from('report_jobs').update(fila).eq('id', id)
      if (!error) return
      console.error(`[informe] ${id}: no se ha podido apuntar el final (${error.message})`)
    } catch (e) {
      console.error(`[informe] ${id}: no se ha podido apuntar el final (${e instanceof Error ? e.message : String(e)})`)
    }
    await new Promise((r) => setTimeout(r, 1500 * (intento + 1)))
  }
}

// ── Las fotos ────────────────────────────────────────────────────────────────

/**
 * La foto al tamaño del documento, con Pillow.
 *
 * En el navegador las encoge un lienzo. Aquí no hay lienzo, pero hay Python
 * —WeasyPrint lo trae— y con él Pillow, que es justo de lo que depende
 * WeasyPrint para las imágenes: no se instala nada nuevo.
 *
 * `exif_transpose` antes de encoger: las fotos del iPad vienen giradas por
 * metadatos, y al reescribir el JPEG los metadatos se pierden. Sin esto, la
 * mitad saldría tumbada.
 */
const ENCOGER = `
import sys, io
from PIL import Image, ImageOps
lado = int(sys.argv[1])
im = Image.open(io.BytesIO(sys.stdin.buffer.read()))
im = ImageOps.exif_transpose(im)
im.thumbnail((lado, lado), getattr(Image, 'Resampling', Image).LANCZOS)
if im.mode != 'RGB':
    im = im.convert('RGB')
out = io.BytesIO()
im.save(out, 'JPEG', quality=72, optimize=True)
sys.stdout.buffer.write(out.getvalue())
`

/** Nunca lanza: una foto que no se puede encoger va como vino. */
export async function reducirFoto(foto: Blob): Promise<Blob> {
  let original: Buffer
  try {
    original = Buffer.from(await foto.arrayBuffer())
  } catch {
    return foto
  }

  return new Promise((resolver) => {
    let resuelto = false
    const terminar = (b: Blob): void => {
      if (resuelto) return
      resuelto = true
      clearTimeout(reloj)
      resolver(b)
    }

    const proc = spawn('python3', ['-c', ENCOGER, String(FOTO_LADO_LARGO)], {
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const reloj = setTimeout(() => {
      proc.kill('SIGKILL')
      terminar(foto)
    }, 15_000)

    const trozos: Buffer[] = []
    proc.stdout.on('data', (c: Buffer) => trozos.push(c))
    proc.on('error', () => terminar(foto))
    proc.stdin.on('error', () => undefined)
    proc.on('close', (codigo) => {
      const salida = Buffer.concat(trozos)
      // Más grande que la original no sirve de nada: se queda la que había.
      if (codigo !== 0 || salida.length === 0 || salida.length >= original.length) {
        terminar(foto)
        return
      }
      terminar(new Blob([new Uint8Array(salida)], { type: 'image/jpeg' }))
    })
    proc.stdin.end(original)
  })
}

// ── El trabajo ───────────────────────────────────────────────────────────────

interface Trabajo {
  id: string
  quien: { id: string; token: string }
  eleccion: Eleccion
  clave: string
}

/** Los trabajos de ESTE proceso que no han terminado. Los demás, si su pulso se para, están muertos. */
const vivos = new Map<string, string>()
let cola: Promise<void> = Promise.resolve()
let reloj: NodeJS.Timeout | null = null

const deEstaPersona = (id: string): number => [...vivos.values()].filter((x) => x === id).length

function conTope<T>(tarea: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolver, rechazar) => {
    const t = setTimeout(
      () => rechazar(new Error(`El informe ha tardado más de ${Math.round(ms / 60_000)} minutos y se ha dado por perdido.`)),
      ms,
    )
    tarea.then(
      (v) => {
        clearTimeout(t)
        resolver(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        rechazar(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

/** El PDF, guardado al lado del documento: al volver, está hecho y no hay que esperarlo. */
async function guardarPdf(admin: SupabaseClient, id: string, html: string, path: string): Promise<void> {
  try {
    const pdf = await htmlToPdf(html)
    const { error } = await admin.storage
      .from('reports')
      .upload(path.replace(/\.html$/, '.pdf'), pdf, { contentType: 'application/pdf', upsert: false })
    if (error && !/exists/i.test(error.message)) {
      console.warn(`[informe] ${id}: el PDF está hecho pero no se ha guardado (${error.message})`)
    }
  } catch (e) {
    // El informe está en el archivo igual: el PDF se puede pedir desde la
    // pantalla, que es lo que se hacía siempre.
    console.warn(`[informe] ${id}: sin PDF guardado (${e instanceof Error ? e.message : String(e)})`)
  }
}

async function correr(admin: SupabaseClient, url: string, t: Trabajo): Promise<void> {
  const cuenta = apuntador(admin, t.id)
  cuenta.decir({ estado: 'en_curso', paso: 'datos', detalle: null })

  try {
    const informe = await conTope(
      generarEnElServidor(
        clienteDe(url, t.quien.token),
        t.quien,
        t.eleccion,
        (paso, detalle) => cuenta.decir({ paso, detalle: detalle ?? null }),
        { reducirFoto, claveDelDispositivo: t.clave },
      ),
      TOPE_TRABAJO_MS,
    )

    // Hecho pero sin archivar no es un informe: nadie tiene la pantalla
    // delante para guardarlo a mano, que es la salida que hay en el navegador.
    if (!informe.archivado || informe.motivoArchivo) {
      throw new Error(informe.motivoArchivo ?? 'no se ha podido guardar el documento en el archivo')
    }

    cuenta.decir({ paso: 'archivo', detalle: 'convirtiendo a PDF' })
    await guardarPdf(admin, t.id, informe.html, informe.archivado)

    await cuenta.asentar()
    await cerrar(admin, t.id, { estado: 'hecho', storage_path: informe.archivado, error: null })
    console.log(`[informe] ${t.id}: hecho (${informe.analisis})`)
  } catch (e) {
    const motivo = (e instanceof Error ? e.message : String(e)).slice(0, 600)
    await cuenta.asentar()
    await cerrar(admin, t.id, { estado: 'fallido', error: motivo })
    console.error(`[informe] ${t.id}: no ha salido (${motivo})`)
  }
}

/**
 * El pulso de los vivos, y el barrido de los que se quedaron a medias.
 *
 * Los dos con el reloj de ESTE proceso: quien escribe el pulso y quien lo mira
 * es el mismo, así que un desfase con el reloj de la base no cuenta.
 */
async function latir(admin: SupabaseClient): Promise<void> {
  try {
    if (vivos.size > 0) {
      await admin.from('report_jobs').update({ latido_at: ahora() }).in('id', [...vivos.keys()])
    }
    await barrer(admin)
  } catch {
    // El siguiente pulso lo vuelve a intentar.
  }
}

export async function barrer(admin: SupabaseClient): Promise<void> {
  const callados = new Date(Date.now() - SILENCIO_MS).toISOString()
  let huerfanos = admin
    .from('report_jobs')
    .update({
      estado: 'fallido',
      error:
        'El servidor de informes se reinició mientras lo generaba, y el informe se quedó a medias. Vuelve a pedirlo.',
      paso: null,
      detalle: null,
      terminado_at: ahora(),
    })
    .in('estado', ['en_cola', 'en_curso'])
    .lt('latido_at', callados)
  // Los de este proceso no: si su pulso va tarde es que la base va lenta, no
  // que el trabajo haya muerto.
  if (vivos.size > 0) huerfanos = huerfanos.not('id', 'in', `(${[...vivos.keys()].join(',')})`)
  await huerfanos

  await admin
    .from('report_jobs')
    .delete()
    .in('estado', ['hecho', 'fallido'])
    .lt('terminado_at', new Date(Date.now() - CADUCA_MS).toISOString())
}

function encolar(admin: SupabaseClient, url: string, t: Trabajo): void {
  vivos.set(t.id, t.quien.id)
  if (!reloj) {
    reloj = setInterval(() => void latir(admin), LATIDO_MS)
    reloj.unref()
  }
  cola = cola
    .then(() => correr(admin, url, t))
    .catch((e: unknown) => console.error('[informe] fallo fuera del trabajo:', e))
    .finally(() => {
      vivos.delete(t.id)
    })
}

/**
 * Al arrancar: lo que hubiera a medias de antes del reinicio se da por perdido
 * en cuanto su pulso lleve callado lo suficiente. Se llama una vez desde
 * `server.ts` y luego lo sigue haciendo el pulso.
 */
export function vigilarLosTrabajos(): void {
  if (!SERVICE_KEY) return
  const mirar = async (): Promise<void> => {
    const s = await servicio()
    if (!s.ok) return
    await barrer(s.admin).catch(() => undefined)
  }
  setTimeout(() => void mirar(), 5_000).unref()
  setInterval(() => void mirar(), 60_000).unref()
}

// ── La ruta ──────────────────────────────────────────────────────────────────

export async function informeGenerar(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // El cuerpo primero: es pequeño, y contestar con él a medio subir cierra el
  // socket de golpe y el navegador se queda sin el motivo.
  const bruto = await leerCuerpoPequeno(req, res, TOPE_CUERPO)
  if (bruto === null) return

  const quien = await quienPide(
    req.headers.authorization,
    SOLO_ADMIN,
    'Solo un administrador puede generar informes.',
  )
  if (!quien.ok) {
    responder(res, quien.codigo, { ok: false, error: quien.error })
    return
  }

  let cuerpo: unknown
  try {
    cuerpo = JSON.parse(bruto.toString('utf8') || '{}')
  } catch {
    responder(res, 400, { ok: false, error: 'JSON no válido' })
    return
  }
  const pedido = leerPeticion(cuerpo)
  if (!pedido.ok) {
    responder(res, 400, { ok: false, error: pedido.error })
    return
  }

  if (vivos.size >= TOPE_EN_COLA || deEstaPersona(quien.id) >= TOPE_POR_PERSONA) {
    responder(res, 429, {
      ok: false,
      error: 'Ya hay varios informes generándose. Espera a que termine alguno y vuelve a pedirlo.',
    })
    return
  }

  const s = await servicio()
  if (!s.ok) {
    responder(res, 503, { ok: false, error: noSeHaPodidoPreguntar(s.motivo) })
    return
  }

  const peticion = construirPeticion(pedido.eleccion)
  const { data, error } = await s.admin
    .from('report_jobs')
    .insert({
      kind: peticion.kind,
      period_start: peticion.p_start,
      period_end: peticion.p_end,
      params: peticion.p_params,
      estado: 'en_cola',
      pedido_por: quien.id,
      latido_at: ahora(),
    })
    .select('id')
    .single()

  if (error || !data) {
    /*
     * Casi siempre, que la migración de `report_jobs` no está aplicada. Es un
     * 503 y no un 500 a propósito: la aplicación lo lee como «el servidor no
     * puede ahora» y genera el informe en el navegador, que es lo que hacía
     * antes de que existiera esto. Nadie se queda sin informe por una tabla.
     */
    console.error(`[informe] no se ha podido apuntar la petición: ${error?.message ?? 'sin fila'}`)
    responder(res, 503, {
      ok: false,
      error:
        'El servidor no puede llevar la cuenta de los informes en segundo plano (¿falta aplicar la migración de «report_jobs»?).',
    })
    return
  }

  const id = String((data as { id: unknown }).id)
  encolar(s.admin, s.url, { id, quien: { id: quien.id, token: quien.token }, eleccion: pedido.eleccion, clave: pedido.clave })

  // 202: aceptado, no hecho. Lo que venga después se lee en `report_jobs`.
  responder(res, 202, { ok: true, id })
}
