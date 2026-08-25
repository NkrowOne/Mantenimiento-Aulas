/**
 * El informe, de principio a fin, dentro de la aplicación.
 *
 * La cadena entera: datos → cifras → redacción (Gemini, si hay clave) →
 * documento → archivo. Sin worker, sin pg_net, sin cron, sin token y sin una
 * sola variable de entorno. Lo único que hay que configurar para que el
 * análisis lo escriba una IA es la clave de Gemini, y se pega desde la propia
 * pantalla.
 *
 * EL ORDEN NO ES CASUAL. Primero la redacción calculada, siempre. Si Gemini
 * contesta, se sustituye; si no contesta, si no hay clave o si quien pide el
 * informe ha desmarcado la casilla, ya hay un texto completo esperando. Nunca
 * hay un momento en el que el informe pueda quedarse sin análisis.
 *
 * Y EL ARCHIVO NO PUEDE TUMBAR EL INFORME. Guardar el documento en Storage es
 * lo último y va aparte: si falla —la política todavía no está, no hay
 * conexión— el informe ya está hecho y en pantalla, listo para imprimir. Lo que
 * no se hace es callarlo: quien lo pidió tiene que saber que ese no ha quedado
 * en el archivo.
 */

import { supabase } from '@/lib/supabase'
import { ZONA } from '@/domain/fechas'
import { TOPE_CONSULTA_MS, conPlazo, señalConTope } from './espera'
import { type Eleccion, construirPeticion } from '../peticion'
import { type Rango, nombrePeriodo } from '../periodos'
import { cargarDatos } from './datos'
import { lecturaCalculada, senales } from './analisis'
import { configurarIA, redactar } from './ia'
import { claveDeGemini } from './clave'
import { leerOpciones, tiene } from './opciones'
import { renderReport } from './plantilla'

export interface InformeGenerado {
  /** El documento entero, autocontenido. Es lo que se imprime y lo que se archiva. */
  html: string
  /*
   * Qué informe es este, y no cuál está elegido AHORA en la pantalla.
   *
   * Van aquí porque el configurador sigue vivo mientras se lee el resultado:
   * cambiar el periodo para pedir el siguiente reetiquetaba el que ya estaba
   * hecho, y el fichero descargado salía con el nombre del que no era. Un
   * documento bien hecho con la etiqueta equivocada es peor que un error.
   */
  kind: string
  rango: Rango
  periodoTexto: string
  /** Qué redactó el análisis. Va al archivo para que el histórico lo diga. */
  analisis: string
  conIA: boolean
  /** Por qué NO lo redactó la IA, cuando se pidió que lo hiciera. */
  avisoIA: string | null
  /** Dónde ha quedado guardado, o `null` si no se ha podido archivar. */
  archivado: string | null
  motivoArchivo: string | null
}

/** Los pasos, para que la pantalla pueda decir en cuál va. */
export type Paso = 'datos' | 'analisis' | 'documento' | 'archivo'

/**
 * Cómo se cuenta un paso mientras pasa.
 *
 * El `fallo` no es un error que interrumpa nada —si algo interrumpe, se lanza—
 * sino un paso que no ha salido como se pidió y del que el informe se ha
 * recuperado solo. La IA que no contesta es el caso: el documento sigue
 * adelante con el análisis calculado, y quien mira la pantalla tiene que verlo
 * en ese momento, no descubrirlo al abrir el PDF.
 */
export type Avisar = (paso: Paso, detalle?: string, fallo?: boolean) => void

const TITULO: Record<string, string> = {
  diario: 'Parte diario',
  semanal: 'Informe semanal',
  personalizado: 'Informe a medida',
}

/**
 * La huella del documento, para que el mismo informe caiga siempre en la misma
 * ruta y uno distinto en otra.
 *
 * `crypto.subtle` no existe fuera de un contexto seguro. La aplicación se sirve
 * por HTTPS y en desarrollo `localhost` también cuenta, así que el respaldo es
 * para un caso que no debería darse — pero un informe no se queda sin archivar
 * por no poder calcular doce caracteres.
 */
async function huellaDe(texto: string): Promise<string> {
  const bytes = new TextEncoder().encode(texto)
  if (globalThis.crypto?.subtle) {
    const resumen = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(resumen)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 12)
  }
  // FNV-1a de 32 bits, dos pasadas con semillas distintas: no es criptografía y
  // no pretende serlo. Solo tiene que distinguir dos documentos distintos.
  const fnv = (semilla: number): string => {
    let h = semilla
    for (const b of bytes) {
      h ^= b
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }
  return `${fnv(0x811c9dc5)}${fnv(0x9dc5811c)}`.slice(0, 12)
}

/**
 * Quién lo pide. El documento lo imprime en la portada.
 *
 * NADA de esto puede impedir que salga el informe, y por eso va entero dentro de
 * un `try` con plazo. Es un adorno de la portada: un nombre. `getSession()`
 * puede tener que renovar el token contra el servidor, y si ese servidor no
 * contesta, sin plazo se lleva por delante el informe completo —esperando, sin
 * error y sin final— por no saber cómo firmar la primera página.
 *
 * Sin nombre, la portada no dice «a petición de» y ya está. Sin id, el archivo
 * guarda la fila sin `generated_by`, que es exactamente lo que ya pasaba con el
 * informe automático del viernes.
 */
const TOPE_PORTADA_MS = 8_000

async function solicitante(): Promise<{ id: string | null; nombre: string | undefined }> {
  try {
    const { data } = await conPlazo('la sesión', TOPE_PORTADA_MS, supabase.auth.getSession())
    const id = data.session?.user.id ?? null
    if (!id) return { id: null, nombre: undefined }

    const { data: perfil } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', id)
      .abortSignal(señalConTope(TOPE_PORTADA_MS))
      .maybeSingle()
    const nombre = (perfil as { full_name?: string | null } | null)?.full_name
    return { id, nombre: nombre ?? undefined }
  } catch {
    return { id: null, nombre: undefined }
  }
}

export async function generarInforme(
  eleccion: Eleccion,
  avisar: Avisar = () => undefined,
): Promise<InformeGenerado> {
  // Por `construirPeticion` y no leyendo la elección a pelo: es la pieza que
  // decide qué viaja y qué no —un enfoque en blanco no es una instrucción, una
  // nota en blanco no es una caja vacía en la portada— y está probada aparte.
  const opciones = leerOpciones(construirPeticion(eleccion).p_params)

  avisar('datos')
  const [datos, quienPide] = await Promise.all([
    cargarDatos(
      eleccion.kind,
      eleccion.rango,
      (leyendo) => avisar('datos', leyendo),
      tiene(opciones, 'fotos'),
    ),
    solicitante(),
  ])

  avisar('analisis')
  const se = senales(datos)
  let lectura = lecturaCalculada(datos)
  let conIA = false
  let avisoIA: string | null = null

  if (opciones.ia) {
    const encontrada = await claveDeGemini()
    const cfg = encontrada
      ? configurarIA({
          clave: encontrada.clave,
          ...(await ajustesGuardados()),
          audiencia: opciones.audiencia,
          ...(opciones.enfoque ? { enfoque: opciones.enfoque } : {}),
        })
      : null

    if (!cfg) {
      avisoIA = 'no hay ninguna clave de Gemini configurada'
      avisar('analisis', 'sin clave de Gemini: sale el análisis calculado', true)
    } else {
      avisar('analisis', `redactando con ${cfg.modelo}`)
      const { lectura: redactada, motivo } = await redactar(datos, se, cfg)
      if (redactada) {
        lectura = redactada
        conIA = true
        avisar('analisis', 'redacción terminada')
      } else {
        avisoIA = motivo
        // En cuanto se sabe, y no al final. Un fallo de la IA añade hasta seis
        // segundos de reintentos, y quien mira la pantalla merece enterarse
        // mientras pasa y no cuando ya no puede hacer nada.
        avisar('analisis', `la IA no ha podido (${motivo}): sigue el análisis calculado`, true)
      }
    }
  }

  avisar('documento')
  // El pie del informe daba la hora UTC sin decirlo: un documento emitido a las
  // 09:00 de Madrid ponía «07:00», y quien lo archivara lo fecharía mal.
  const emitido = new Intl.DateTimeFormat('es-ES', {
    timeZone: ZONA,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date())

  const html = renderReport(datos, lectura, opciones, {
    emitido,
    ...(quienPide.nombre ? { solicitante: quienPide.nombre } : {}),
  })

  avisar('archivo')
  const archivo = await archivar(html, eleccion, opciones, quienPide.id, {
    origen: lectura.origen,
    conIA,
    avisoIA,
  })

  return {
    html,
    kind: eleccion.kind,
    rango: eleccion.rango,
    periodoTexto: nombrePeriodo(eleccion.rango),
    analisis: lectura.origen,
    conIA,
    avisoIA,
    archivado: archivo.path,
    motivoArchivo: archivo.motivo,
  }
}

/**
 * El modelo y el razonamiento guardados, si los hay.
 *
 * `ia_estado()` los devuelve junto con «hay clave o no», y es la misma llamada
 * que ya hace la tarjeta de arriba de la pantalla. Si falla, se usan los valores
 * por defecto: un informe no se queda sin redactar porque no se sepa qué modelo
 * prefiere el despliegue.
 */
async function ajustesGuardados(): Promise<{ modelo?: string; thinking?: string }> {
  try {
    const { data, error } = await supabase.rpc('ia_estado').abortSignal(señalConTope(TOPE_CONSULTA_MS))
    if (error) return {}
    const estado = data as { modelo?: string; thinking?: string } | null
    return {
      ...(estado?.modelo ? { modelo: estado.modelo } : {}),
      ...(estado?.thinking ? { thinking: estado.thinking } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * El documento, guardado donde se pueda volver a buscar.
 *
 * Un informe emitido **no se regenera nunca**: se versiona. Si los datos cambian
 * después, el documento del viernes tiene que seguir diciendo lo que decía el
 * viernes, o deja de servir como registro. De ahí que la ruta lleve la huella
 * del contenido y que la subida no sobrescriba: el mismo documento cae en el
 * mismo sitio —y volver a subirlo es un no-op— y uno distinto abre una ruta
 * nueva.
 */
async function archivar(
  html: string,
  eleccion: Eleccion,
  opciones: ReturnType<typeof leerOpciones>,
  quienPide: string | null,
  redaccion: { origen: string; conIA: boolean; avisoIA: string | null },
): Promise<{ path: string | null; motivo: string | null }> {
  const hash = await huellaDe(html)
  const path = `${eleccion.kind}/${eleccion.rango.start}_${eleccion.rango.end}_${hash}.html`

  let subida
  try {
    subida = await conPlazo(
      'la subida del documento',
      TOPE_CONSULTA_MS,
      supabase.storage
        .from('reports')
        .upload(path, new Blob([html], { type: 'text/html; charset=utf-8' }), {
          contentType: 'text/html; charset=utf-8',
          upsert: false,
        }),
    )
  } catch (err) {
    return { path: null, motivo: err instanceof Error ? err.message : String(err) }
  }

  // «Ya existe» no es un fallo: es el mismo documento, ya archivado. Cualquier
  // otra cosa sí lo es, y hay que decirla.
  if (subida.error && !/exists/i.test(subida.error.message)) {
    return { path: null, motivo: `no se ha podido guardar el documento: ${subida.error.message}` }
  }

  /*
   * En `params` se guarda cómo se hizo, no lo que se pidió: las secciones que
   * de verdad salieron y quién redactó el análisis. Así el archivo puede decir
   * «este de marzo salió sin IA» sin abrir el documento, y la pantalla puede
   * marcarlo.
   *
   * Y con `ia` sola no basta, porque `false` tapa dos cosas que no se parecen
   * en nada: un informe que se pidió sin IA a propósito y uno que la pidió y no
   * la tuvo. El primero salió como se quería; el segundo salió a medias y nadie
   * se enteró. De ahí `ia_pedida` y `aviso_ia`: el archivo guarda si se intentó
   * y por qué no salió, que es lo que convierte «no fue con IA» en «la clave no
   * tiene permiso, cámbiala y vuelve a emitirlo».
   */
  const huella = {
    secciones: opciones.secciones,
    comparar: opciones.comparar,
    audiencia: opciones.audiencia,
    ia: redaccion.conIA,
    ia_pedida: opciones.ia,
    analisis: redaccion.origen,
    ...(redaccion.avisoIA ? { aviso_ia: redaccion.avisoIA } : {}),
    ...(opciones.enfoque ? { enfoque: opciones.enfoque } : {}),
    ...(opciones.nota ? { nota: opciones.nota } : {}),
  }

  const { error } = await supabase.from('reports').insert({
    kind: eleccion.kind,
    period_start: eleccion.rango.start,
    period_end: eleccion.rango.end,
    storage_path: path,
    content_hash: hash,
    params: huella,
    generated_by: quienPide,
  }).abortSignal(señalConTope(TOPE_CONSULTA_MS))

  // Choque con el índice único: este informe ya estaba en el archivo, con el
  // mismo contenido. No hay nada que arreglar.
  if (error && error.code !== '23505') {
    return { path, motivo: `el documento está guardado pero no ha entrado en el archivo: ${error.message}` }
  }

  return { path, motivo: null }
}

/** El nombre con el que se descarga: reconocible en una carpeta de descargas. */
export function nombreDeArchivo(kind: string, rango: { start: string; end: string }): string {
  const titulo = (TITULO[kind] ?? 'Informe').toLowerCase().replace(/\s+/g, '-')
  return `${titulo}-${rango.start}_${rango.end}.html`
}
