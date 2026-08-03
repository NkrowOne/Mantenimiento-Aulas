/**
 * Registro del service worker y política de actualización, fuera de la interfaz.
 *
 * El registro estaba dentro de `UpdatePrompt`, que se monta **detrás del
 * candado** y además solo cuando no se está revisando un aula. O sea que el
 * registro —y con él la detección de que hay versión nueva— no ocurría en los
 * dos únicos sitios donde de verdad hace falta:
 *
 *   - Un dispositivo atascado en la pantalla del PIN. Si lo que rompe la entrada
 *     es precisamente un fallo de la versión instalada, el arreglo no puede
 *     llegar nunca: el único control capaz de activar el service worker nuevo
 *     está al otro lado del candado que no abre.
 *   - Durante una revisión, donde el aviso está suprimido a propósito.
 *
 * LA POLÍTICA: la versión nueva se instala SOLA, en los momentos en que
 * recargar no interrumpe a nadie. La barra de «Actualizar» queda como
 * respaldo, no como puerta.
 *
 * Por qué se endureció: con `prompt`, «Ahora no» significaba semanas. Un iPad
 * que no cierra nunca la pestaña no vuelve a «arrancar», así que la única
 * versión que llegaba sola era la del primer día; todo lo demás dependía de un
 * toque que nadie daba. El resultado medido en campo: dispositivos con
 * inventarios distintos para la misma sala, técnicos sin ver un arreglo que
 * llevaba semanas desplegado, y cada uno en una versión diferente.
 *
 * Los momentos seguros son tres, y los tres son «no hay nada entre las manos»:
 *
 *   - **El arranque.** En los primeros segundos no hay nada que interrumpir: el
 *     borrador vive en Dexie y la aplicación restaura la ubicación al recargar.
 *   - **La vuelta tras una ausencia larga.** Guardar el iPad y sacarlo en el
 *     siguiente edificio es el arranque real de una PWA instalada: iOS la
 *     congela y la descongela tal cual, sin recargar nada, durante días.
 *   - **El final de una revisión.** Al volver a la lista, recargar no cuesta
 *     nada — es el mismo momento en que ya reaparecía la barra.
 *
 * Y los momentos en que NO, que son los que hicieron descartar `autoUpdate`
 * de fábrica:
 *
 *   - **Una revisión abierta** (lo marca App con `marcarTrabajoDelicado`):
 *     recargar bajo los pies de alguien que rellena comprobaciones pierde el
 *     foco, el teclado y la paciencia. El borrador sobreviviría, pero perdería
 *     el sitio donde iba.
 *   - **Una foto en tránsito** entre la cámara y Dexie (`retenerRecarga`). Es
 *     la única ventana en la que recargar puede PERDER algo de verdad: la
 *     compresión tarda segundos y hasta que no termina la foto no está escrita.
 *     Todo lo demás ya está a salvo — la cola de salida rescata incluso lo que
 *     se quedó a medio subir (`recuperarEnVuelo`, en outbox.ts) y los envíos
 *     son idempotentes por id, así que una recarga no duplica ni pisa nada.
 */

import { registerSW } from 'virtual:pwa-register'

type Listener = (hayVersionNueva: boolean) => void

const listeners = new Set<Listener>()
let hayVersionNueva = false
let actualizar: ((recargar?: boolean) => Promise<void>) | null = null

/** ¿Hay una versión esperando a que alguien —o algo— la active? */
let enEspera = false

/*
 * La ventana del arranque y la de la vuelta miden lo mismo: lo que tarda el
 * navegador en descargar e instalar el service worker nuevo después de que se
 * le pida buscarlo. Encontrada dentro de una de las dos, la versión se instala
 * sola; encontrada fuera, se ofrece con la barra y se instalará en el próximo
 * momento seguro.
 */
const VENTANA_DE_ARRANQUE_MS = 45_000
const arrancadaEn = Date.now()

/**
 * Cuánto tiene que durar una ausencia para que la vuelta cuente como un
 * arranque.
 *
 * Cinco minutos separa los dos gestos que se ven idénticos en el evento de
 * visibilidad y no pueden tratarse igual: el viaje corto —abrir la cámara,
 * consultar otra aplicación, un mensaje— del que se vuelve con algo entre las
 * manos, y el iPad que se guardó en la funda y reaparece en el siguiente
 * edificio, que es exactamente cuándo se puede recargar sin molestar. El
 * viaje a la cámara es el que importa clavar: recargar justo cuando el
 * navegador va a entregar la foto recién hecha se la tragaría sin error.
 */
const AUSENCIA_LARGA_MS = 5 * 60_000

/**
 * El respiro antes de cualquier recarga automática que no sea la del arranque.
 *
 * Dos carreras distintas lo necesitan, y las dos son de milisegundos con
 * cobertura de sobra aquí:
 *
 *  - En la vuelta larga, el evento `change` de un `<input type="file">`
 *    pendiente se entrega nada más descongelar la página, y con él arranca
 *    `capturePhoto`, que retiene la recarga hasta dejar la foto escrita. El
 *    respiro da tiempo a que esa retención exista.
 *  - Al salir de una revisión, el volcado al desmontar (`useInspection`)
 *    escribe en Dexie el último toque que los temporizadores no llegaron a
 *    guardar. Son dos transacciones de milisegundos, pero recargar en medio
 *    las abortaría — exactamente el toque que ese volcado existe para salvar.
 */
const RESPIRO_ANTES_DE_RECARGAR_MS = 1_500

let ocultadaEn = 0
/** Hasta cuándo dura la ventana abierta por la última vuelta de ausencia larga. */
let regresoHasta = 0

/** Hay una revisión abierta: la versión nueva espera a que termine. */
let trabajoDelicado = false
/** Cuántas fotos están ahora mismo entre la cámara y Dexie. */
let retenciones = 0
/** Se intentó instalar con una foto en tránsito: en cuanto se suelte, se instala. */
let aplicarAlSoltar = false

/** El registro del navegador, para poder preguntar a demanda. */
let registro: ServiceWorkerRegistration | null = null

function momentoSeguro(): boolean {
  const ahora = Date.now()
  return ahora - arrancadaEn < VENTANA_DE_ARRANQUE_MS || ahora < regresoHasta
}

function anunciar(): void {
  listeners.forEach((l) => l(hayVersionNueva))
}

/**
 * Instala la versión en espera, si nada lo impide.
 *
 * Es el único camino de la instalación automática, y por eso concentra las dos
 * salvaguardas: con una revisión abierta no se instala —se anuncia, para que el
 * panel de la lámpara lo diga, y se volverá a intentar al terminarla— y con una
 * foto en tránsito se apunta para el instante en que quede escrita.
 */
function intentarInstalarSola(): void {
  if (!enEspera) return
  if (trabajoDelicado) {
    hayVersionNueva = true
    anunciar()
    return
  }
  if (retenciones > 0) {
    aplicarAlSoltar = true
    return
  }
  aplicarAlSoltar = false
  aplicarActualizacion().catch(() => {
    // Si la activación falla, la barra de siempre sigue ahí detrás.
    hayVersionNueva = true
    anunciar()
  })
}

/**
 * App marca cuándo hay una revisión abierta.
 *
 * Al levantarse la marca —guardar y volver a la lista, descartar, salir— se
 * instala lo que estuviera esperando: es exactamente el momento en que la
 * barra «reaparecía porque recargar no cuesta nada», hecho solo. Tras el
 * respiro, no en el acto: el volcado al desmontar de la revisión todavía está
 * escribiendo su último toque en Dexie.
 */
export function marcarTrabajoDelicado(activo: boolean): void {
  const habia = trabajoDelicado
  trabajoDelicado = activo
  if (habia && !activo) setTimeout(intentarInstalarSola, RESPIRO_ANTES_DE_RECARGAR_MS)
}

/**
 * Retiene cualquier recarga automática mientras una foto viaja de la cámara a
 * Dexie. Devuelve la función que suelta; soltar dos veces no descuenta dos.
 *
 * Lo usa `capturePhoto` y existe por un fallo silencioso muy concreto: la
 * vuelta de la cámara es también una vuelta a primer plano, y si coincide con
 * una versión en espera, la recarga automática mataría la compresión a mitad y
 * la foto desaparecería sin error ni rastro.
 */
export function retenerRecarga(): () => void {
  retenciones++
  let soltada = false
  return () => {
    if (soltada) return
    soltada = true
    retenciones = Math.max(0, retenciones - 1)
    if (retenciones === 0 && aplicarAlSoltar) intentarInstalarSola()
  }
}

/**
 * Busca la versión nueva AHORA y cuenta qué encontró.
 *
 * Existe porque la opacidad tuvo coste real: iPads semanas atrás sin que
 * nadie pudiera distinguir «no hay nada nuevo» de «no está buscando» — las
 * dos se ven igual, que es no viéndose. Con un botón que contesta, el
 * diagnóstico se hace desde el aparato en diez segundos.
 */
export async function buscarActualizacion(): Promise<'encontrada' | 'al-dia' | 'error'> {
  if (!registro) return 'error'
  try {
    await registro.update()
  } catch {
    // Sin red, o el servidor no contesta: distinto de «estás en la última».
    return 'error'
  }
  return enEspera || registro.installing !== null || registro.waiting !== null
    ? 'encontrada'
    : 'al-dia'
}

export function registrarServiceWorker(): void {
  if (actualizar) return

  actualizar = registerSW({
    onNeedRefresh() {
      enEspera = true
      if (momentoSeguro()) {
        intentarInstalarSola()
        return
      }
      // A mitad de trabajo mandan las manos del técnico: la barra ofrece, y el
      // próximo momento seguro —terminar la revisión, la siguiente vuelta tras
      // guardar el iPad— la instala solo.
      hayVersionNueva = true
      anunciar()
    },
    /*
     * Buscar la versión nueva, no solo esperarla.
     *
     * Por defecto el navegador comprueba el service worker al CARGAR la
     * página, y una PWA instalada en un iPad no vuelve a cargar la página en
     * días: iOS la congela y la descongela tal cual. Resultado real: la
     * versión con el arreglo llevaba horas desplegada y ningún dispositivo
     * ofrecía actualizar, porque ninguno había preguntado.
     *
     * Se pregunta al volver al frente —abajo, en el vigía de visibilidad— y
     * cada hora por si se queda en primer plano toda la mañana. Sin red,
     * `update()` falla y da igual: se vuelve a preguntar la siguiente.
     */
    onRegisteredSW(_url, reg) {
      if (!reg) return
      registro = reg
      setInterval(() => {
        void reg.update().catch(() => {})
      }, 60 * 60_000)
    },
    onRegisterError(error) {
      // Sin service worker no hay modo offline, así que conviene que se vea en
      // la consola en lugar de fallar en silencio. La causa casi siempre es un
      // certificado que el dispositivo no acepta.
      console.error('No se pudo registrar el service worker:', error)
    },
  })

  /*
   * El vigía de visibilidad, aquí y no en la interfaz: tiene que funcionar con
   * la aplicación bloqueada, que es justo cuando un dispositivo atascado
   * necesita el arreglo que trae la versión nueva.
   *
   * Cada vuelta a primer plano pregunta por versión nueva. Si además la
   * ausencia fue larga —el iPad salió de la funda—, se abre la ventana de
   * regreso: lo que ya estuviera en espera se instala tras el respiro, y lo
   * que se encuentre en los próximos segundos se instalará al llegar. Si la
   * ausencia fue corta, solo se vuelve a ofrecer lo pospuesto: «ahora no»
   * significa ahora no, no nunca.
   */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      ocultadaEn = Date.now()
      return
    }

    void registro?.update().catch(() => {})

    if (ocultadaEn > 0 && Date.now() - ocultadaEn >= AUSENCIA_LARGA_MS) {
      regresoHasta = Date.now() + VENTANA_DE_ARRANQUE_MS
      setTimeout(intentarInstalarSola, RESPIRO_ANTES_DE_RECARGAR_MS)
      return
    }

    reofrecerActualizacion()
  })
}

export function onVersionNueva(listener: Listener): () => void {
  listeners.add(listener)
  listener(hayVersionNueva)
  return () => listeners.delete(listener)
}

/** Activa el service worker en espera y recarga. */
export async function aplicarActualizacion(): Promise<void> {
  await actualizar?.(true)
}

/*
 * Lo pospuesto sigue esperando, y se vuelve a ofrecer.
 *
 * `posponerActualizacion()` ponía `hayVersionNueva` a false y ahí se acababa
 * todo: nada volvía a ponerlo a true, porque `onNeedRefresh` solo se dispara
 * cuando se INSTALA un service worker nuevo, y ya estaba instalado. Así que
 * «Ahora no» significaba en la práctica «nunca», y un iPad podía quedarse meses
 * con la versión de la que se pospuso una vez.
 *
 * Con la instalación automática, posponer ya solo aplaza hasta el próximo
 * momento seguro. Se distingue lo que hay —`enEspera`— de lo que se está
 * enseñando ahora mismo, y al volver a primer plano se vuelve a ofrecer.
 */
export function posponerActualizacion(): void {
  hayVersionNueva = false
  anunciar()
}

/** Vuelve a ofrecer lo que quedó pospuesto, en las vueltas cortas al frente. */
function reofrecerActualizacion(): void {
  if (!enEspera || hayVersionNueva) return
  hayVersionNueva = true
  anunciar()
}
