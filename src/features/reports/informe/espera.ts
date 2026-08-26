/**
 * Ninguna espera de este módulo puede ser infinita.
 *
 * Es la regla que faltaba, y costó un «nunca me llega a dar el informe». Armar
 * un informe son unas veinticinco peticiones, y ninguna llevaba plazo: bastaba
 * con que UNA no contestase —un pool de PostgREST agotado, una red que se cae a
 * la mitad, un token que se está renovando contra un servidor mudo— para que la
 * pantalla se quedara en «Leyendo los datos del periodo…» hasta que alguien
 * recargara. Sin error, sin pista y sin final.
 *
 * Es el mismo fallo que la versión con worker: algo no contesta y la interfaz no
 * lo cuenta. Se arregló allí quitando la tubería, y volvió a entrar por la
 * puerta de al lado. Así que aquí no hay ninguna promesa que pueda no terminar:
 * lo que no contesta a tiempo se convierte en un mensaje que dice QUÉ no
 * contestó, que es lo único con lo que alguien puede hacer algo.
 */

/** Lo que se le da a una consulta de la API antes de darla por muerta. */
export const TOPE_CONSULTA_MS = 25_000

/**
 * Una señal que se corta sola.
 *
 * `AbortSignal.timeout` es de Safari 16. Los iPads del campus no tienen por qué
 * estarlo, y un `TypeError` aquí dejaría el informe sin generarse por culpa del
 * mecanismo que existe para que se genere. El respaldo hace exactamente lo
 * mismo con un `AbortController` y un reloj.
 */
export function señalConTope(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms)
  }
  const control = new AbortController()
  setTimeout(() => control.abort(new DOMException('Se agotó la espera', 'TimeoutError')), ms)
  return control.signal
}

/**
 * ¿Este fallo es «no ha contestado» y no «ha contestado que no»?
 *
 * Los dos llegan como excepción y piden respuestas distintas de quien lo lee:
 * un permiso denegado se arregla con el rol, y un silencio con la red o el
 * servidor. El nombre del error no es fiable —cada navegador aborta a su
 * manera— así que se mira también el texto.
 */
export function esSilencio(err: unknown): boolean {
  const nombre = (err as { name?: string } | null)?.name ?? ''
  const texto = err instanceof Error ? err.message : String(err ?? '')
  return /abort|timeout/i.test(nombre) || /abort|timed out|se agotó la espera/i.test(texto)
}

/**
 * ¿Este fallo es «la petición no llegó a salir»?
 *
 * Es la tercera categoría, y hasta ahora se colaba en la pantalla tal cual:
 * «TypeError: Load failed». Eso es lo que dice Safari cuando la petición muere
 * antes de tener respuesta —sin red, el servidor corta, la URL no pasa por el
 * portero de la entrada—, y cada navegador lo dice con otras palabras: Chrome
 * «Failed to fetch», Firefox «NetworkError when attempting to fetch resource».
 * Ninguna de las tres significa nada para quien está esperando un informe.
 *
 * Se distingue de un plazo agotado —ahí SÍ hubo petición y no hubo respuesta— y
 * de un permiso denegado, que llega como un error de la base con su mensaje.
 *
 * SE MIRA EL TEXTO Y NO EL TIPO, y no es pereza. Por el camino de la descarga
 * paginada el `TypeError` original no llega nunca: `descargaEntera` lo recoge,
 * se queda con su mensaje y sigue con un error normal, porque lo recibido vale
 * aunque falte el resto. Un clasificador que exigiera `TypeError` se callaría
 * justo en la consulta más larga del informe, que es por donde entró este fallo.
 * Ninguna otra cosa dice «Load failed»: el riesgo de confundirlo es ninguno.
 */
export function esRedCaida(err: unknown): boolean {
  const texto = err instanceof Error ? err.message : String(err ?? '')
  return /load failed|failed to fetch|networkerror|network request failed/i.test(texto)
}

/**
 * Plazo para lo que no acepta una señal.
 *
 * `storage.upload` y `auth.getSession` no admiten `AbortSignal`, así que no hay
 * forma de cancelarlos: lo que se corta es la ESPERA, y la petición sigue su
 * camino sin que nadie la mire. Es aceptable justo aquí —lo peor que puede
 * pasar es que un documento acabe subido y sin apuntar en el archivo, que es un
 * caso que la ruta con el hash ya sabe resolver— y es mucho mejor que la
 * alternativa, que es no terminar nunca.
 */
export function conPlazo<T>(que: string, ms: number, tarea: PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const reloj = setTimeout(
      () => reject(new Error(`${que} no ha contestado en ${Math.round(ms / 1000)} s`)),
      ms,
    )
    Promise.resolve(tarea).then(
      (v) => {
        clearTimeout(reloj)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(reloj)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}
