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
      enEspera = true
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
