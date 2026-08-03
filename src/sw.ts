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
 * Cuánto se espera al relevo antes de darlo por fallido.
 *
 * El relevo son dos pasos del navegador —el worker en espera acepta
 * `skipWaiting()` y luego toma el control, lo que se ve aquí como
 * `controllerchange`— y en marcha son milisegundos. Ocho segundos cubren un
 * arranque en frío del worker (el navegador lo mata cuando está ocioso, así que
 * el mensaje llega a un hilo que hay que volver a levantar) con holgura de
 * sobra. Pasado el plazo, lo que hay no es lentitud: es que no va a pasar.
 */
const PLAZO_DE_RELEVO_MS = 8_000

/**
 * Qué versión de la política de activación ejecuta esta página.
 *
 * Es lo que se contesta al sondeo del rescate, y tiene que coincidir con
 * `POLITICA_MINIMA` de `public/rescate-sw.js` — que es quien pregunta, y quien
 * decide con la respuesta si este dispositivo sabe actualizarse solo o hay que
 * rescatarlo a la fuerza. Allí está el porqué del número; aquí basta con saber
 * que **los dos suben juntos**: contestar un número que el rescate ya no acepta
 * es pedir el rescate, y contestar uno que no se cumple es lo que dejó iPads
 * meses sin actualizar.
 */
const POLITICA_DE_ACTIVACION = 2

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
 * El respiro antes de cualquier recarga —automática o pedida— que no sea la
 * del arranque.
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

/**
 * El cuarto momento seguro: pantalla encendida y nadie tocándola.
 *
 * Sin él, un dispositivo siempre visible no se actualizaba solo NUNCA: el
 * kiosco, o el iPad clavado en la pantalla del PIN con el autobloqueo
 * desactivado —justo el caso que motiva registrar antes del candado— no
 * arranca, no cambia de visibilidad y no termina revisiones, así que ninguna
 * de las otras tres puertas se abría y la barra volvía a ser la única, que es
 * lo que esta política vino a quitar. Diez minutos sin un toque significa que
 * no hay nadie a quien interrumpir; el tic horario que ya busca versión hace
 * la comprobación.
 */
const OCIO_LARGO_MS = 10 * 60_000
let ultimaInteraccionEn = Date.now()

/** Hay una revisión abierta: la versión nueva espera a que termine. */
let trabajoDelicado = false
/** Cuántas fotos están ahora mismo entre la cámara y Dexie. */
let retenciones = 0
/** Se intentó instalar con una foto en tránsito: en cuanto se suelte, se instala. */
let aplicarAlSoltar = false
/** Alguien PULSÓ actualizar con una foto en tránsito: al soltarse, se obedece
    sin volver a pasar por las salvaguardas automáticas — fue una orden. */
let ordenManualAlSoltar = false

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
function intentarInstalarSola(desatendida = false): void {
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
  activar(desatendida ? 'desatendida' : 'automatica').catch(() => {
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
 * Retiene cualquier recarga —automática o pedida con el botón— mientras una
 * foto viaja de la cámara a Dexie. Devuelve la función que suelta; soltar dos
 * veces no descuenta dos.
 *
 * Lo usa `capturePhoto` y existe por un fallo silencioso muy concreto: la
 * vuelta de la cámara es también una vuelta a primer plano, y si coincide con
 * una versión en espera, la recarga mataría la compresión a mitad y la foto
 * desaparecería sin error ni rastro.
 *
 * Con tope de tiempo: si la compresión se cuelga —pasa en WebKit con lienzos
 * grandes— el `finally` de `capturePhoto` no llega nunca, y sin el tope esa
 * retención huérfana dejaba la instalación automática bloqueada para siempre.
 * Ninguna foto legítima tarda un minuto en comprimirse.
 */
export function retenerRecarga(): () => void {
  retenciones++
  let soltada = false
  const soltar = (): void => {
    if (soltada) return
    soltada = true
    clearTimeout(tope)
    retenciones = Math.max(0, retenciones - 1)
    if (retenciones > 0) return
    if (ordenManualAlSoltar) {
      // La orden explícita se obedece tal cual: quien pulsó ya decidió, y
      // volver a pasarla por las salvaguardas la degradaría a un anuncio.
      ordenManualAlSoltar = false
      aplicarAlSoltar = false
      void activar('manual')
      return
    }
    if (aplicarAlSoltar) intentarInstalarSola()
  }
  const tope = setTimeout(soltar, 60_000)
  return soltar
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

  /*
   * Un `installing` sin controlador es el PRIMER service worker instalándose
   * —un arranque recién desplegado—, no una versión nueva: la página que lo
   * registró ya ES la última. Contarlo como «encontrada» hacía decir al panel
   * «instalándose» en un dispositivo perfectamente al día.
   */
  const primeraInstalacion =
    registro.installing !== null && navigator.serviceWorker.controller === null

  /*
   * Lo que hay AHORA en el navegador, no lo que se anunció alguna vez.
   *
   * `enEspera` estaba en esta cuenta y no podía estar: es la memoria de un
   * anuncio, y un anuncio puede quedarse viejo —el worker que lo motivó lo
   * deja `redundant` el siguiente despliegue, o se activó por otra vía—. Con
   * él dentro, el botón contestaba «encontrada» sobre un worker que ya no
   * existe y reofrecía una caja cuyo «Actualizar ahora» no podía hacer nada.
   */
  const encontrada =
    registro.waiting !== null || (registro.installing !== null && !primeraInstalacion)

  if (encontrada) {
    enEspera = true
    // Quien busca a mano quiere la versión YA: se reofrece la caja con
    // «Actualizar ahora» en vez de dejarla esperando al próximo momento seguro.
    reofrecerActualizacion()
  } else if (enEspera) {
    // Se anunciaba una versión que ya no está: se retira el anuncio. Dejarlo
    // puesto es peor que no haberlo dado, porque convierte el botón en un
    // adorno —se pulsa, no pasa nada, y no hay forma de saber por qué—.
    olvidarLaEspera()
  }

  return encontrada ? 'encontrada' : 'al-dia'
}

/** El anuncio se retira: no hay ninguna versión esperando de verdad. */
function olvidarLaEspera(): void {
  enEspera = false
  aplicarAlSoltar = false
  hayVersionNueva = false
  anunciar()
}

export function registrarServiceWorker(): void {
  if (actualizar) return

  /*
   * La contraseña del rescate. El service worker recién instalado pregunta a
   * las ventanas abiertas qué política de activación ejecutan
   * (`public/rescate-sw.js`): las que contestan un número suficiente son
   * páginas como esta, que activarán ellas mismas cuando toque; las que callan
   * —o contestan lo de antes— no saben activar y se las rescata con una recarga
   * forzada. Contestar es lo que protege a esta página de esa recarga, así que
   * el oyente se registra ANTES que el service worker: no puede haber ventana
   * en la que la pregunta llegue y el oyente todavía no esté.
   */
  navigator.serviceWorker?.addEventListener('message', (evento: MessageEvent) => {
    const datos = evento.data as { tipo?: string } | null
    if (datos?.tipo === 'sondeo-de-politica') {
      evento.ports[0]?.postMessage({ politica: POLITICA_DE_ACTIVACION })
    }
  })

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
        // El momento seguro del kiosco: pantalla encendida, nadie tocando. Sin
        // esto, un dispositivo siempre visible —clavado en el PIN, o de
        // consulta— no atravesaba nunca ninguna de las otras puertas y se
        // quedaba con la versión vieja esperando un toque que no llega.
        if (Date.now() - ultimaInteraccionEn >= OCIO_LARGO_MS) intentarInstalarSola(true)
      }, 60 * 60_000)
    },
    onRegisterError(error) {
      // Sin service worker no hay modo offline, así que conviene que se vea en
      // la consola en lugar de fallar en silencio. La causa casi siempre es un
      // certificado que el dispositivo no acepta.
      console.error('No se pudo registrar el service worker:', error)
    },
  })

  // Para el momento seguro del ocio hace falta saber cuándo se tocó por última
  // vez. `pointerdown` y `keydown` cubren dedo y teclado; pasivos, porque aquí
  // solo se apunta la hora.
  for (const gesto of ['pointerdown', 'keydown'] as const) {
    document.addEventListener(
      gesto,
      () => {
        ultimaInteraccionEn = Date.now()
      },
      { passive: true },
    )
  }

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

/**
 * Cómo acabó el intento de instalar la versión nueva.
 *
 * Se devuelve en vez de tragárselo porque el modo de fallo que trajo todo esto
 * era exactamente ese: un botón que no contaba nada.
 */
export type ParteDeActivacion =
  /** El relevo ocurrió: el worker nuevo manda y la página se está recargando. */
  | 'activada'
  /** Hay una foto entre la cámara y Dexie: se hará en cuanto quede escrita. */
  | 'retenida'
  /** Se anunciaba una versión que ya no existe en el navegador. */
  | 'sin-worker'
  /** El worker en espera no tomó el control dentro del plazo. */
  | 'sin-relevo'
  /** No hubo relevo y se recargó igualmente, porque alguien lo pidió. */
  | 'recargada'

/** Una sola recarga, venga de donde venga la orden. */
let recargando = false
function recargar(): void {
  if (recargando) return
  recargando = true
  window.location.reload()
}

/** Corta la espera de una promesa que puede no volver nunca. */
function conTope<T>(promesa: Promise<T>, ms: number, siTarda: T): Promise<T> {
  return Promise.race([
    promesa,
    new Promise<T>((listo) => setTimeout(() => listo(siTarda), ms)),
  ])
}

/** Espera a que el worker recién descargado termine de instalarse. */
function esperarInstalacion(sw: ServiceWorker): Promise<void> {
  return new Promise((listo) => {
    const fin = (): void => {
      clearTimeout(tope)
      sw.removeEventListener('statechange', alCambiar)
      listo()
    }
    const alCambiar = (): void => {
      if (sw.state !== 'installing') fin()
    }
    const tope = setTimeout(fin, PLAZO_DE_RELEVO_MS)
    sw.addEventListener('statechange', alCambiar)
  })
}

/** Espera al relevo de verdad: que el worker nuevo pase a controlar la página. */
function esperarRelevo(): Promise<boolean> {
  return new Promise((resolver) => {
    const fin = (ocurrio: boolean): void => {
      clearTimeout(tope)
      navigator.serviceWorker.removeEventListener('controllerchange', alRelevo)
      resolver(ocurrio)
    }
    const alRelevo = (): void => fin(true)
    const tope = setTimeout(() => fin(false), PLAZO_DE_RELEVO_MS)
    navigator.serviceWorker.addEventListener('controllerchange', alRelevo)
  })
}

/**
 * Pide el relevo al worker en espera y espera a que ocurra.
 *
 * ESTE es el arreglo. Antes se llamaba a `updateSW(true)` de vite-plugin-pwa y
 * se daba por hecho lo demás, y lo demás no estaba garantizado:
 *
 *  - `updateSW` ignora su propio argumento `reloadPage`. Lo único que hace es
 *    `messageSkipWaiting()`, y la recarga la dispara aparte un oyente de
 *    `controlling` que workbox instala al anunciar la versión.
 *  - `messageSkipWaiting()` es, literalmente, `if (registration.waiting)
 *    postMessage(...)`. **Sin worker en espera no hace nada y no lo dice.**
 *
 * Así que bastaba con que el worker anunciado dejara de estar en espera —lo
 * deja `redundant` cualquier despliegue posterior, que es lo normal cuando pasan
 * horas entre el aviso y el toque; o se activó ya por otra ventana— para que
 * «Actualizar» fuera un botón muerto: sin mensaje, sin recarga, sin error y con
 * la barra intacta ofreciendo lo mismo otra vez. Que es exactamente lo que se
 * vio en campo.
 *
 * Ahora se conduce desde el registro: se recupera el worker que haya AHORA, se
 * le manda el relevo y se espera a `controllerchange`, que es el único hecho que
 * significa «ya mandas tú».
 */
async function relevar(): Promise<'activada' | 'sin-worker' | 'sin-relevo'> {
  if (!('serviceWorker' in navigator)) return 'sin-worker'

  registro ??= (await navigator.serviceWorker.getRegistration().catch(() => null)) ?? null
  const reg = registro
  if (!reg) return 'sin-worker'

  // El anuncio pudo quedarse viejo. Preguntar otra vez recupera el worker que
  // haya ahora, y no cuesta nada cuando ya hay uno en la puerta.
  if (!reg.waiting && !reg.installing) {
    await conTope(reg.update().catch(() => {}), PLAZO_DE_RELEVO_MS, undefined)
  }

  // Uno a medio instalar todavía no acepta el relevo: se le deja terminar.
  if (!reg.waiting && reg.installing) await esperarInstalacion(reg.installing)

  const enCola = reg.waiting
  if (!enCola) return 'sin-worker'

  const relevo = esperarRelevo()
  enCola.postMessage({ type: 'SKIP_WAITING' })
  return (await relevo) ? 'activada' : 'sin-relevo'
}

/**
 * El último recurso desde la página ya se ha gastado en esta carga.
 *
 * Uno por carga y no más: es la diferencia entre rescatar un dispositivo
 * atascado y montarle un carrusel de recargas.
 */
let ultimoRecursoGastado = false

/**
 * El camino común de la instalación. Lo que cambia entre las tres órdenes es
 * qué se hace cuando el relevo NO ocurre, y es una diferencia de fondo:
 *
 *  - `manual` es una orden. Recargar por las bravas trae el código nuevo igual
 *    —un `reload` vuelve a pedir el service worker y el navegador reintenta el
 *    ciclo entero— y, sobre todo, hace que pulsar el botón SIEMPRE haga algo.
 *    Recargar de más es un segundo perdido; un botón que no responde cuesta
 *    semanas de versión vieja.
 *  - `automatica` no fuerza nada, y no es simetría mal entendida: nadie ha
 *    pedido esto, y una recarga forzada aquí se repetiría en cada arranque
 *    mientras el relevo siguiera sin ocurrir — un bucle de recargas en la cara
 *    de alguien que solo quería abrir la aplicación. Se deja la barra puesta,
 *    que es lo que ya hacía.
 *  - `desatendida` es el respaldo para lo que el rescate del worker no alcanza.
 *    `public/rescate-sw.js` rescata al dispositivo cuya política es DEMASIADO
 *    VIEJA para activar; no puede hacer nada con el que contesta el número
 *    bueno y aun así falla —una activación que se atasca por lo que sea, y el
 *    rescate ya se ha retirado creyéndole—. Ese es el hueco que tapa esto: la
 *    puerta del ocio (diez minutos sin un toque, pantalla encendida) ya
 *    garantiza que no hay a quién interrumpir, así que recargar ahí no cuesta
 *    nada. Una vez por carga, para que un fallo persistente sea una recarga y
 *    no un bucle: si tampoco así, la barra sigue puesta para una persona.
 */
async function activar(
  orden: 'manual' | 'automatica' | 'desatendida',
): Promise<ParteDeActivacion> {
  const parte = await relevar()

  if (parte === 'activada') {
    // `controllerchange` significa que el worker nuevo manda, no que esta página
    // ejecute su código: eso solo lo cambia recargar.
    recargar()
    return 'activada'
  }

  if (orden === 'manual' || (orden === 'desatendida' && !ultimoRecursoGastado)) {
    if (orden === 'desatendida') ultimoRecursoGastado = true
    recargar()
    return 'recargada'
  }

  if (parte === 'sin-worker') {
    olvidarLaEspera()
    return parte
  }

  hayVersionNueva = true
  anunciar()
  return parte
}

/**
 * Activa el service worker en espera y recarga.
 *
 * También el camino del botón pasa por aquí, y por eso las dos cortesías:
 *
 *  - Con una foto en tránsito NO recarga ya: se apunta la orden y se obedece en
 *    el instante en que la foto quede escrita. El botón «Actualizar ahora» vive
 *    en la cabecera, visible en plena revisión, y pulsarlo con la compresión a
 *    medias se tragaba la foto — saltándose la retención que existe para esto.
 *  - Con una revisión abierta espera el respiro antes de recargar: el
 *    autoguardado local va con 400 ms de retardo, y la recarga inmediata perdía
 *    el último toque. La orden se cumple igual, un segundo más tarde.
 */
export async function aplicarActualizacion(): Promise<ParteDeActivacion> {
  if (retenciones > 0) {
    ordenManualAlSoltar = true
    return 'retenida'
  }
  if (trabajoDelicado) {
    await new Promise((listo) => setTimeout(listo, RESPIRO_ANTES_DE_RECARGAR_MS))
    // Durante el respiro pudo empezar una foto: se vuelve a mirar.
    if (retenciones > 0) {
      ordenManualAlSoltar = true
      return 'retenida'
    }
  }
  return activar('manual')
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
