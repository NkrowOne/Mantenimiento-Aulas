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

function anunciar(): void {
  listeners.forEach((l) => l(hayVersionNueva))
}

export function registrarServiceWorker(): void {
  if (actualizar) return

  actualizar = registerSW({
    onNeedRefresh() {
      hayVersionNueva = true
      anunciar()
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

/** «Ahora no»: se esconde el aviso, el service worker sigue esperando. */
export function posponerActualizacion(): void {
  hayVersionNueva = false
  anunciar()
}
