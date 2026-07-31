/**
 * La lectura del estado de la tubería de informes, en palabras.
 *
 * `estado_de_informes()` devuelve los hechos —la cola de pg_net, las últimas
 * respuestas del worker, los trabajos de cron—; esto los convierte en el
 * diagnóstico que una persona puede accionar. Vive aparte del componente y sin
 * tocar la red porque cada regla codifica un fallo real que costó encontrar, y
 * eso se protege con pruebas, no con memoria.
 *
 * La regla que dio origen a todo el fichero: pg_net instalado pero SIN
 * despachar su cola. La extensión se crea sin quejarse, `net.http_post()`
 * devuelve un id, y las peticiones se quedan encoladas para siempre porque el
 * proceso de fondo solo arranca si la librería está en
 * `shared_preload_libraries`. Con eso roto, «Generar» parece funcionar, el cron
 * parece funcionar, y no se emite un informe jamás — sin un solo error en
 * ningún sitio. La única firma observable es exactamente esta: cola con
 * contenido y ninguna respuesta reciente.
 */

export interface EstadoInformes {
  pg_net: { instalado: boolean; en_cola?: number; ultima_respuesta?: string | null }
  respuestas: Array<{ codigo: number | null; caduco: boolean; error: string; cuando: string }>
  cron: Array<{ nombre: string; horario: string; activo: boolean }>
  corridas: Array<{ nombre: string; estado: string; detalle: string; cuando: string }>
  informes: Array<{ kind: string; generated_at: string }>
  /** app_config conserva el token de ejemplo: nadie sembró el de verdad. */
  token_de_ejemplo?: boolean
}

export interface Aviso {
  nivel: 'crit' | 'warn' | 'ok'
  texto: string
}

/** Cuánto silencio de pg_net se tolera con peticiones esperando en su cola. */
const SILENCIO_MAX_MS = 5 * 60_000

export function diagnostico(e: EstadoInformes, ahora = Date.now()): Aviso[] {
  const avisos: Aviso[] = []

  if (!e.pg_net.instalado) {
    avisos.push({
      nivel: 'crit',
      texto:
        'La extensión pg_net no está instalada en la base: pedir un informe no puede llegar al worker. ' +
        'En el despliegue con Docker la trae la imagen (create extension pg_net); en un Postgres gestionado sin pg_net, los informes se programan con el cron del sistema contra el worker.',
    })
    return avisos
  }

  // Antes que nada, porque no necesita esperar a ninguna llamada: si el token
  // sigue siendo el de ejemplo, TODO informe morirá en un 401. Pasa en un
  // despliegue que no corrió deploy.sh, y el síntoma es idéntico al de pg_net
  // sin precarga — nada llega nunca.
  if (e.token_de_ejemplo) {
    avisos.push({
      nivel: 'crit',
      texto:
        'app_config todavía tiene el token de ejemplo (reports_worker_token): el worker rechazará cada llamada con 401. scripts/deploy.sh lo siembra igual que el WORKER_TOKEN del contenedor; vuelve a desplegar o iguálalos a mano.',
    })
  }

  const enCola = e.pg_net.en_cola ?? 0
  const ultima = e.pg_net.ultima_respuesta ? new Date(e.pg_net.ultima_respuesta).getTime() : null
  const muda = ultima === null || ahora - ultima > SILENCIO_MAX_MS

  if (enCola > 0 && muda) {
    avisos.push({
      nivel: 'crit',
      texto:
        `Hay ${enCola} petición(es) en la cola de pg_net y nadie las está despachando. ` +
        'Es la firma de pg_net sin precargar: añade pg_net a shared_preload_libraries del servicio db (docker-compose.yml) y reinicia la base. ' +
        'Con esto roto, todo parece funcionar y ningún informe se genera nunca.',
    })
  }

  const reciente = e.respuestas[0]
  if (reciente) {
    if (reciente.codigo === 401) {
      avisos.push({
        nivel: 'crit',
        texto:
          'El worker rechaza la llamada (401): el token de app_config (reports_worker_token) no coincide con el WORKER_TOKEN del contenedor de informes. scripts/deploy.sh los siembra iguales.',
      })
    } else if (reciente.codigo !== null && reciente.codigo >= 500) {
      avisos.push({
        nivel: 'warn',
        texto: `El worker contesta pero falla generando (${reciente.codigo}). Mira el registro del contenedor aulas-reports.`,
      })
    } else if (reciente.codigo === null && reciente.error) {
      avisos.push({
        nivel: 'crit',
        texto: `No se alcanza el worker: «${reciente.error}». ¿Está arrancado el contenedor aulas-reports y en la misma red?`,
      })
    } else if (reciente.caduco) {
      avisos.push({
        nivel: 'warn',
        texto:
          'La última llamada agotó su espera. El informe puede haber salido igual —el worker termina aunque nadie espere la respuesta—: mira el archivo antes de tocar nada.',
      })
    }
  }

  const semanal = e.cron.find((j) => j.nombre === 'informe-semanal')
  if (e.cron.length === 0) {
    avisos.push({
      nivel: 'warn',
      texto:
        'No hay ningún trabajo de cron de informes: el semanal del viernes no saldrá solo. Sin pg_cron, prográmalo con el cron del sistema.',
    })
  } else if (semanal && !semanal.activo) {
    avisos.push({ nivel: 'warn', texto: 'El trabajo del informe semanal está desactivado.' })
  }

  if (avisos.length === 0) {
    avisos.push({
      nivel: 'ok',
      texto:
        enCola === 0 && ultima !== null
          ? 'La tubería responde: la cola está vacía y el worker contestó a la última llamada.'
          : 'Sin señales de avería. Si acabas de pedir un informe, dale unos segundos y refresca.',
    })
  }

  return avisos
}
