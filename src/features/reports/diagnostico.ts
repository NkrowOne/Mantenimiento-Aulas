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

export interface PeticionDeInforme {
  id: number
  kind: string
  cuando: string
  codigo: number | null
  caduco: boolean
  error: string
  /** Su respuesta sigue viva en pg_net. Falsa: nadie contestó, o ya caducó. */
  respondida: boolean
}

export interface EstadoInformes {
  pg_net: { instalado: boolean; en_cola?: number; ultima_respuesta?: string | null }
  respuestas: Array<{ codigo: number | null; caduco: boolean; error: string; cuando: string }>
  /** Cada envío al worker, cruzado con su respuesta si sigue viva. */
  peticiones?: PeticionDeInforme[]
  cron: Array<{ nombre: string; horario: string; activo: boolean }>
  corridas: Array<{ nombre: string; estado: string; detalle: string; cuando: string }>
  informes: Array<{ kind: string; generated_at: string }>
  /** A quién llama la tubería, según app_config. */
  worker_url?: string | null
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

  /*
   * La cola con contenido y pg_net mudo tiene un falso positivo conocido: las
   * respuestas caducan (TTL) y una petición recién encolada tarda unos
   * segundos en despacharse, así que el primer vistazo tras un fin de semana
   * tranquilo puede parecer la avería. Si hay informes emitidos hace poco, la
   * tubería demostró funcionar: se avisa sin ordenar reiniciar nada.
   */
  if (enCola > 0 && muda) {
    const informeReciente =
      e.informes[0] && ahora - new Date(e.informes[0].generated_at).getTime() < 2 * 3600_000
    avisos.push(
      informeReciente
        ? {
            nivel: 'warn',
            texto:
              `Hay ${enCola} petición(es) en la cola de pg_net sin respuesta reciente, pero se han emitido informes hace poco: lo más probable es que esté en tránsito. Vuelve a mirar en un minuto; si sigue igual, es la firma de pg_net sin precargar.`,
          }
        : {
            nivel: 'crit',
            texto:
              `Hay ${enCola} petición(es) en la cola de pg_net y nadie las está despachando. ` +
              'Es la firma de pg_net sin precargar: añade pg_net a shared_preload_libraries del servicio db (docker-compose.yml) y reinicia la base. ' +
              'Con esto roto, todo parece funcionar y ningún informe se genera nunca. ' +
              'Vuelve a mirar en un minuto para confirmarlo: una petición recién encolada pasa por aquí unos segundos.',
          },
    )
  }

  /*
   * Y la petición despachada que nadie contestó: la cola está vacía —pg_net
   * trabajó— pero del envío no queda ni código ni error. O el worker murió a
   * mitad de generar, o la respuesta ya caducó sin que nadie la mirase.
   */
  const pedida = e.peticiones?.[0]
  if (
    pedida &&
    !pedida.respondida &&
    enCola === 0 &&
    ahora - new Date(pedida.cuando).getTime() > SILENCIO_MAX_MS
  ) {
    avisos.push({
      nivel: 'warn',
      texto:
        'La última petición se despachó y no consta su respuesta. Si el informe no está en el archivo, mira el registro del contenedor aulas-reports: pudo morir a mitad de generar.',
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
      /*
       * Con la URL delante, el error se explica solo: un «Couldn't resolve
       * host name» junto a «http://reports-worker:8080/generate» en una
       * plataforma donde el worker se llama de otra manera ES el diagnóstico.
       * Y si lo que no resuelve es el nombre, la salida no es reiniciar nada:
       * es corregir la URL de app_config (deploy.sh o init-plataforma.sh la
       * siembran).
       */
      const destino = e.worker_url ? ` en ${e.worker_url}` : ''
      const esDns = /resolve|resolución|getaddrinfo/i.test(reciente.error)
      avisos.push({
        nivel: 'crit',
        texto: esDns
          ? `No se alcanza el worker${destino}: «${reciente.error}». Ese nombre de host no existe en la red de la base: corrige reports_worker_url en app_config con la URL interna real del worker (deploy.sh o init-plataforma.sh la siembran).`
          : `No se alcanza el worker${destino}: «${reciente.error}». ¿Está arrancado el contenedor aulas-reports y en la misma red?`,
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
