/**
 * El botón «atrás» del móvil cierra lo de arriba, no la aplicación.
 *
 * Toda la navegación es estado en memoria: no hay rutas ni router, y el
 * historial del navegador tenía UNA entrada. En Android eso significa que el
 * gesto de volver —el que se hace sin mirar, cien veces al día— cerraba la
 * aplicación instalada, o se salía de ella en Chrome, con una hoja abierta o a
 * mitad de una ficha. En Safari, el gesto desde el borde hacía lo mismo.
 *
 * Aquí se lleva una pila de capas. Cada cosa que se abre encima de otra —una
 * hoja de acciones, la ficha de una revisión, el visor de fotos, la cámara— y
 * cada pantalla hacia dentro de la lista de edificios entra en la pila y deja
 * una entrada en el historial del navegador. Volver atrás saca la de arriba y
 * llama a su `cerrar`, que es exactamente lo que hace el botón de la pantalla.
 * Cerrar por el botón saca su entrada del historial, para que la pila y el
 * historial digan siempre lo mismo.
 *
 * Dos puertas:
 *
 *  - `entrar(cerrar)`, para lo que se monta y se desmonta: la capa entra al
 *    montarse y devuelve el `salir` que se llama al desmontarse.
 *  - `nivelar(n, volver)`, para las pantallas de `App`, que no se montan una
 *    encima de otra sino que SUSTITUYEN a la anterior: `App` dice cuántas
 *    pantallas hay hacia dentro y aquí se ponen o se quitan entradas hasta que
 *    cuadre. Es idempotente, para poder llamarla en cada render.
 *
 * La entrada del historial guarda solo la profundidad, `{ aulas: n }`. Con eso
 * basta para saber cuántas capas hay que cerrar al volver —el navegador puede
 * saltar varias de golpe— y para no fiarse de nada más: tras una recarga el
 * historial sigue ahí, con su estado, pero la pila está vacía.
 *
 * Lo que se sale del historial se va en una sola orden por vuelta de bucle
 * (`go(-n)`): cerrar una ficha cierra también la foto que tenía abierta, y eso
 * son dos `salir` en el mismo instante que tienen que ser UN salto. Los saltos
 * del navegador son asíncronos, así que mientras uno está en camino puede
 * llegar otro `pushState`; no importa: cada entrada lleva la profundidad de la
 * pila en el momento de crearla, y al llegar a cualquiera de ellas se cierra
 * lo que sobre por encima de esa profundidad. Puede quedar alguna entrada
 * «hacia delante» que ya no vale, y por eso, si se llega a una con más
 * profundidad que capas, se vuelve atrás lo que haga falta.
 */

/** Lo que este módulo necesita del navegador, para poderlo probar en Node. */
export interface Entorno {
  historia: {
    readonly state: unknown
    pushState(estado: unknown, titulo: string): void
    go(delta: number): void
  }
  /** Avisa con el estado de la entrada a la que se ha llegado (`popstate`). */
  alVolver(oyente: (estado: unknown) => void): () => void
  /** Al final de la vuelta de bucle actual: agrupa las salidas simultáneas. */
  enMicrotarea(fn: () => void): void
}

interface Capa {
  cerrar: () => void
  /** Puesta por `nivelar`: una pantalla de `App`, no una capa que se monta. */
  nivel: boolean
}

const pila: Capa[] = []
/** Capas quitadas de la pila cuyo salto atrás todavía no se ha pedido. */
let porSalir = 0
let saltoProgramado = false
let entorno: Entorno | null = null

function navegador(): Entorno {
  return {
    historia: window.history,
    alVolver(oyente) {
      const manejador = (e: PopStateEvent): void => oyente(e.state)
      window.addEventListener('popstate', manejador)
      return () => window.removeEventListener('popstate', manejador)
    },
    enMicrotarea: (fn) => queueMicrotask(fn),
  }
}

function el(): Entorno {
  return (entorno ??= navegador())
}

/** La profundidad que dice una entrada del historial; 0 si no es nuestra. */
export function profundidad(estado: unknown): number {
  const n = (estado as { aulas?: unknown } | null | undefined)?.aulas
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0
}

/**
 * Empieza a escuchar el botón atrás. Una vez, al arrancar.
 *
 * Si la entrada actual ya tiene profundidad —se ha recargado con pantallas
 * abiertas— se vuelve hasta la raíz: las capas de antes de recargar ya no
 * existen, y dejar sus entradas debajo obligaría a pulsar atrás varias veces
 * en vacío antes de salir.
 */
export function vigilarElHistorial(e: Entorno = navegador()): () => void {
  entorno = e
  const dejar = e.alVolver(alLlegar)
  const antes = profundidad(e.historia.state)
  if (antes > 0) e.historia.go(-antes)
  return dejar
}

function alLlegar(estado: unknown): void {
  const objetivo = profundidad(estado)
  if (objetivo > pila.length) {
    // Hacia delante, o una entrada de antes de recargar: no hay nada que
    // reabrir, así que se deshace el salto.
    el().historia.go(pila.length - objetivo)
    return
  }
  while (pila.length > objetivo) {
    // Fuera de la pila ANTES de cerrar: al desmontarse, la capa llamará a su
    // `salir`, y ese ya no tiene que pedir ningún salto.
    const arriba = pila.pop()!
    try {
      arriba.cerrar()
    } catch (fallo) {
      console.error(fallo)
    }
  }
}

function apilar(capa: Capa): boolean {
  try {
    // Safari corta el `pushState` a cien por medio minuto. Si no entra en el
    // historial, no entra en la pila: la capa se cierra con su botón, como
    // siempre, y atrás sigue diciendo la verdad sobre lo demás.
    el().historia.pushState({ aulas: pila.length + 1 }, '')
  } catch {
    return false
  }
  pila.push(capa)
  return true
}

function salir(capa: Capa): void {
  const i = pila.lastIndexOf(capa)
  if (i === -1) return
  pila.splice(i, 1)
  porSalir++
  if (saltoProgramado) return
  saltoProgramado = true
  el().enMicrotarea(() => {
    saltoProgramado = false
    const { historia } = el()
    // Nunca más atrás de lo que es nuestro: la entrada actual dice hasta dónde.
    const n = Math.min(porSalir, profundidad(historia.state))
    porSalir = 0
    if (n > 0) historia.go(-n)
  })
}

/**
 * Una capa que acaba de abrirse. Devuelve lo que hay que llamar al cerrarla.
 *
 * `cerrar` es lo que atrás le hace a la capa: lo mismo que su botón. Si es la
 * pila la que la cierra, el `salir` que se devuelve ya no hace nada.
 */
export function entrar(cerrar: () => void): () => void {
  const capa: Capa = { cerrar, nivel: false }
  if (!apilar(capa)) return () => {}
  return () => salir(capa)
}

/**
 * Cuántas pantallas hacia dentro tiene abiertas `App`.
 *
 * Pone o quita entradas de nivel hasta que haya exactamente `n`. Todas cierran
 * con el mismo `volver`, que retrocede UNA pantalla desde la que haya en ese
 * momento: por eso da igual cuál de ellas se quite o se ponga.
 */
export function nivelar(n: number, volver: () => void): void {
  let niveles = 0
  for (const capa of pila) if (capa.nivel) niveles++
  while (niveles < n) {
    if (!apilar({ cerrar: volver, nivel: true })) break
    niveles++
  }
  for (let i = pila.length - 1; i >= 0 && niveles > n; i--) {
    if (pila[i]!.nivel) {
      salir(pila[i]!)
      niveles--
    }
  }
}

/** Solo para las pruebas. */
export function _reiniciarHistorial(): void {
  pila.length = 0
  porSalir = 0
  saltoProgramado = false
  entorno = null
}
