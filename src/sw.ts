/**
 * Registro del service worker, fuera de la interfaz.
 *
 * Estaba dentro de `UpdatePrompt`, que se monta **detrás del candado** y además
 * solo cuando no se está revisando un aula. O sea que el registro —y con él la
 * detección de que hay versión nueva— no ocurría en los dos únicos sitios donde
 * de verdad hace falta:
 *
 *   - Un dispositivo atascado en la pantalla del PIN. Si lo que rompe la entrada
 *     es precisamente un fallo de la versión instalada, el arreglo no puede
 *     llegar nunca: el único control capaz de activar el service worker nuevo
 *     está al otro lado del candado que no abre.
 *   - Durante una revisión, donde el aviso está suprimido a propósito.
 *
 * Con `registerType: 'prompt'` el service worker nuevo se queda esperando hasta
 * que alguien lo activa, así que quedarse sin quien lo active no es un retraso:
 * es no actualizar nunca.
 *
 * Aquí solo vive el registro y el estado. Quién lo enseña y cuándo es cosa de
 * `UpdatePrompt`, que ya puede montarse y desmontarse sin llevarse el registro
 * por delante.
 */

import { registerSW } from 'virtual:pwa-register'

type Listener = (hayVersionNueva: boolean) => void

const listeners = new Set<Listener>()
let hayVersionNueva = false
let actualizar: ((recargar?: boolean) => Promise<void>) | null = null

/*
 * La versión encontrada AL ABRIR se instala sola; la encontrada a mitad de
 * trabajo se ofrece. Es el punto medio entre `prompt` y `autoUpdate`:
 *
 * En iOS la app instalada puede pasar días congelada, así que el momento
 * real de actualización es el arranque — y en los primeros segundos no hay
 * nada que interrumpir: el borrador vive en Dexie, y la app restaura la
 * ubicación al recargar. Esperar un toque en «Actualizar» ahí solo alargaba
 * la vida de la versión vieja (y en la práctica los arreglos tardaban días
 * en llegar a los iPads, con la barra sin pulsar).
 *
 * Pasado el arranque, mandan las manos del técnico: una recarga espontánea a
 * mitad de una revisión pierde el foco, el teclado y la paciencia. Ahí la
 * barra ofrece y la persona decide.
 */
const VENTANA_DE_ARRANQUE_MS = 45_000
const arrancadaEn = Date.now()

/** El registro del navegador, para poder preguntar a demanda. */
let registro: ServiceWorkerRegistration | null = null

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

function anunciar(): void {
  listeners.forEach((l) => l(hayVersionNueva))
}

export function registrarServiceWorker(): void {
  if (actualizar) return

  actualizar = registerSW({
    onNeedRefresh() {
      enEspera = true
      if (Date.now() - arrancadaEn < VENTANA_DE_ARRANQUE_MS) {
        // Si la activación fallara, la barra de siempre sigue ahí detrás.
        aplicarActualizacion().catch(() => {
          hayVersionNueva = true
          anunciar()
        })
        return
      }
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
     * Se pregunta al volver al frente —el momento en que alguien la va a
     * usar— y cada hora por si se queda en primer plano toda la mañana. Sin
     * red, `update()` falla y da igual: se vuelve a preguntar la siguiente.
     */
    onRegisteredSW(_url, reg) {
      if (!reg) return
      registro = reg
      const buscar = (): void => {
        void reg.update().catch(() => {})
      }
      setInterval(buscar, 60 * 60_000)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') buscar()
      })
    },
    onRegisterError(error) {
      // Sin service worker no hay modo offline, así que conviene que se vea en
      // la consola en lugar de fallar en silencio. La causa casi siempre es un
      // certificado que el dispositivo no acepta.
      console.error('No se pudo registrar el service worker:', error)
    },
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

/** ¿Hay una versión esperando a que alguien la active? */
export function hayActualizacionEnEspera(): boolean {
  return enEspera
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
 * Eso convirtió un arreglo urgente en algo que no llegaba: la avería seguía a la
 * vista en el aula horas después de estar corregida y desplegada, y desde el
 * dispositivo no había manera de saberlo. Ahora se distingue lo que hay —
 * `enEspera`— de lo que se está enseñando ahora mismo, y al volver a primer
 * plano se vuelve a ofrecer.
 */
let enEspera = false

export function posponerActualizacion(): void {
  hayVersionNueva = false
  anunciar()
}

/** Vuelve a ofrecer lo que quedó pospuesto. La llama `main.tsx` al volver al frente. */
export function reofrecerActualizacion(): void {
  if (!enEspera || hayVersionNueva) return
  hayVersionNueva = true
  anunciar()
}
