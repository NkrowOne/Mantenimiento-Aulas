/**
 * Que la barra de pestañas se quede abajo: el fondo congelado y el teclado.
 *
 * La barra es `fixed bottom-0`. En el WebKit del iPhone eso NO la pega a lo
 * que se ve —el viewport visual— sino al de MAQUETACIÓN, y normalmente son el
 * mismo. Dejan de serlo cuando sube el teclado: lo visual encoge, iOS desplaza
 * la página para enseñar el campo, y el de maquetación se queda donde estaba.
 * Al bajar el teclado los dos tienen que volver a coincidir, y a veces no lo
 * hacen: `visualViewport.offsetTop` se queda por encima de cero y todo lo
 * `fixed` se pinta ese trozo más arriba. Es la barra flotando con contenido
 * por debajo, y la cabecera `sticky top-0` asomando por arriba o fuera de la
 * vista. Aguanta hasta que alguien desplaza la página lo bastante —y en una
 * pantalla corta, que no desplaza, no se va nunca—.
 *
 * La hoja de «Añadir una sala» lo provocaba de libro: campos de texto dentro
 * de una capa `fixed`, el fondo con `overflow: hidden` —que en iOS no impide
 * que el propio iOS desplace la página para enseñar el campo—, y al guardar,
 * tres movimientos mientras el teclado todavía está bajando: el foco salta al
 * «Entendido», la hoja se desmonta, y el foco vuelve a la fila que la abrió.
 * Los dos `focus()` desplazan la página para enseñar su elemento, calculado
 * contra un viewport visual a medio encoger.
 *
 * Dos piezas, y las dos hacen falta:
 *
 *  - `congelarFondo()` para las capas: guarda dónde estaba la página, y al
 *    cerrar la deja EXACTAMENTE ahí y devuelve el foco sin desplazar. Un
 *    `scrollTo` explícito es además lo que obliga a WebKit a recalcular dónde
 *    va lo fijo.
 *  - `vigilarElTeclado()` para todo lo demás: cuando el teclado acaba de bajar
 *    —en una hoja o en el buscador, da igual—, mira si lo visual y lo de
 *    maquetación han vuelto a coincidir y, si no, los vuelve a juntar.
 *
 * Lo que decide va en funciones puras (`abreTeclado`, `decidir`) porque las
 * pruebas corren en `node`, sin DOM; el resto es cablear eventos.
 */

/**
 * Medio píxel arriba o abajo es redondeo de iOS, no un desencaje.
 *
 * Con la barra de 57 px, un píxel de desfase no se ve; el que se ve son
 * decenas.
 */
export const HOLGURA_PX = 1

/**
 * Lo que tarda el teclado de iOS en bajar, con margen.
 *
 * La animación son unos 250 ms. Mirar antes es medir un viewport a medio
 * crecer y «arreglar» algo que se arregla solo un instante después.
 */
export const MS_TECLADO = 400

/** Veces seguidas que se intenta juntar los viewports antes de rendirse. */
export const MAX_INTENTOS = 3

/**
 * Tipos de `<input>` que NO sacan teclado.
 *
 * Los demás —texto, número, email, fecha, búsqueda…— sí, y es lo que importa
 * aquí: si el teclado sigue arriba, el desfase es lo normal y no se toca.
 */
const SIN_TECLADO = new Set([
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'range',
  'color',
  'file',
  'image',
  'hidden',
])

/** Lo mínimo de un elemento para saber si saca el teclado. */
export interface ElementoEnfocado {
  tagName: string
  type?: string
  isContentEditable?: boolean
}

/**
 * ¿Tener el foco aquí deja el teclado arriba?
 *
 * `select` cuenta: en el iPhone saca su propia rueda por abajo y encoge lo
 * visual igual que un teclado.
 */
export function abreTeclado(el: ElementoEnfocado | null | undefined): boolean {
  if (!el) return false
  if (el.isContentEditable) return true
  const etiqueta = el.tagName.toUpperCase()
  if (etiqueta === 'TEXTAREA' || etiqueta === 'SELECT') return true
  if (etiqueta !== 'INPUT') return false
  return !SIN_TECLADO.has((el.type || 'text').toLowerCase())
}

/** Lo que se mide para decidir. */
export interface Medidas {
  /** `visualViewport.offsetTop`: cuánto queda lo que se ve por debajo de donde se pinta lo fijo. */
  desfase: number
  /** `visualViewport.scale`. */
  escala: number
  /** Si el foco está en algo que deja el teclado arriba. */
  teclado: boolean
}

/**
 * ¿Hay que volver a juntar los viewports?
 *
 * Solo si están separados SIN motivo:
 *
 *  - Con el teclado arriba la separación es lo normal: así enseña iOS el campo
 *    por encima del teclado. Tocarla ahí movería la página debajo del dedo
 *    mientras se escribe.
 *  - Con la página ampliada también: es la única forma de moverse por ella, y
 *    si alguien ha conseguido ampliar a pesar de los tres bloqueos, lo ha
 *    querido.
 */
export function decidir(m: Medidas): 'nada' | 'juntar' {
  if (m.teclado) return 'nada'
  if (Math.abs(m.escala - 1) > 0.01) return 'nada'
  return Math.abs(m.desfase) > HOLGURA_PX ? 'juntar' : 'nada'
}

/** Lo que hace falta del navegador. Se inyecta para poder probarlo sin DOM. */
export interface Entorno {
  window: Pick<Window, 'scrollX' | 'scrollY' | 'scrollTo' | 'addEventListener' | 'removeEventListener'> & {
    visualViewport: Pick<
      VisualViewport,
      'offsetTop' | 'pageTop' | 'scale' | 'addEventListener' | 'removeEventListener'
    > | null
  }
  document: Pick<Document, 'addEventListener' | 'removeEventListener'> & {
    activeElement: ElementoEnfocado | null
    documentElement: { style: { overflow: string } }
  }
  /** `requestAnimationFrame`, o lo que haga sus veces en una prueba. */
  alSiguienteMarco: (fn: () => void) => void
  /** `setTimeout`. */
  despues: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  cancelar: (id: ReturnType<typeof setTimeout>) => void
}

function entornoReal(): Entorno {
  return {
    window,
    document,
    alSiguienteMarco: (fn) => requestAnimationFrame(() => fn()),
    despues: (fn, ms) => setTimeout(fn, ms),
    cancelar: (id) => clearTimeout(id),
  }
}

/* ────────────────────────────── El fondo ────────────────────────────── */

/**
 * Cuántas capas hay congelando el fondo, y cómo estaba antes de la primera.
 *
 * Contado y no «lo que había antes de mí»: con dos capas abiertas y cerradas
 * fuera de orden, cada una restaurando lo que vio al abrir deja el documento
 * con `overflow: hidden` para siempre —una página que ya no desplaza—.
 */
let congeladas = 0
let antes: { overflow: string; x: number; y: number } | null = null

/**
 * Congela el documento de detrás de una capa, y devuelve cómo descongelarlo.
 *
 * `origen` es a quién se le devuelve el foco al cerrar: la fila o el botón que
 * abrió la capa. Se devuelve **sin desplazar** —con `preventScroll`—: estaba
 * a la vista cuando se tocó, y el scroll ya se deja donde estaba a mano.
 */
export function congelarFondo(
  origen: { focus: (o?: FocusOptions) => void } | null,
  entorno: Entorno = entornoReal(),
): () => void {
  const { window: w, document: d } = entorno
  if (congeladas === 0) {
    antes = { overflow: d.documentElement.style.overflow, x: w.scrollX, y: w.scrollY }
    d.documentElement.style.overflow = 'hidden'
  }
  congeladas++

  let hecho = false
  return () => {
    if (hecho) return
    hecho = true
    congeladas = Math.max(0, congeladas - 1)
    if (congeladas === 0 && antes) {
      const { overflow, x, y } = antes
      antes = null
      d.documentElement.style.overflow = overflow
      // Donde estaba, al píxel. iOS desplaza la página para enseñar un campo
      // aunque tenga `overflow: hidden`, y sin esto la lista reaparecía movida
      // —y lo fijo, calculado para la posición de antes—. El `scrollTo` es,
      // de paso, lo que obliga a WebKit a recolocar la barra.
      w.scrollTo(x, y)
    }
    origen?.focus({ preventScroll: true })
  }
}

/** Solo para las pruebas: vuelve al estado de arranque. */
export function _reiniciarFondo(): void {
  congeladas = 0
  antes = null
}

/* ────────────────────────────── El teclado ────────────────────────────── */

/**
 * Vigila el teclado, y cuando baja, vuelve a juntar los viewports si hace falta.
 *
 * Se instala una vez, al arrancar, desde `main.tsx`. Devuelve cómo quitarlo.
 *
 * Qué dispara la comprobación:
 *
 *  - `focusout` cuyo foco no acaba en otro campo: el teclado va a bajar. Se
 *    espera a que termine de bajar (`MS_TECLADO`).
 *  - `resize` del viewport visual: es lo que avisa de que el teclado ha
 *    terminado de bajar —o de un giro—.
 *
 * Y el remedio es llevar la página a donde ya está lo visual: el viewport de
 * maquetación se va con ella y lo fijo vuelve a pintarse donde se ve. Como
 * mucho `MAX_INTENTOS` seguidos, por si alguna versión de iOS no se deja: una
 * página que se mueve sola en bucle sería peor que la barra fuera de sitio.
 */
export function vigilarElTeclado(entorno: Entorno = entornoReal()): () => void {
  const { window: w, document: d } = entorno
  const vv = w.visualViewport
  if (!vv) return () => {}

  let intentos = 0
  let espera: ReturnType<typeof setTimeout> | null = null
  let marcoPedido = false

  const medir = (): Medidas => ({
    desfase: vv.offsetTop,
    escala: vv.scale,
    teclado: abreTeclado(d.activeElement),
  })

  /**
   * Lleva la página a donde ya está lo visual: el de maquetación se va con ella.
   *
   * `pageTop` es dónde está lo que se ve dentro del documento. Si la página ya
   * dice estar ahí —en WebKit `scrollY` puede seguir a lo visual y no a lo de
   * maquetación—, un `scrollTo` a la misma posición no mueve nada y WebKit no
   * recalcula nada: hay que moverse de verdad, un píxel y de vuelta. Un píxel
   * durante un fotograma no se ve.
   */
  const juntar = (): void => {
    const x = w.scrollX
    const destino = Math.max(0, Math.round(vv.pageTop))
    if (Math.round(w.scrollY) !== destino) {
      w.scrollTo(x, destino)
      return
    }
    w.scrollTo(x, destino + 1)
    // Al final del todo no hay píxel de más: se va uno hacia arriba.
    if (Math.round(w.scrollY) === destino && destino > 0) w.scrollTo(x, destino - 1)
    entorno.alSiguienteMarco(() => w.scrollTo(x, destino))
  }

  const comprobar = (): void => {
    if (marcoPedido) return
    marcoPedido = true
    entorno.alSiguienteMarco(() => {
      marcoPedido = false
      if (decidir(medir()) === 'nada') {
        intentos = 0
        return
      }
      if (intentos >= MAX_INTENTOS) return
      intentos++
      juntar()
      comprobar()
    })
  }

  const alSoltarElFoco = (): void => {
    if (espera !== null) entorno.cancelar(espera)
    espera = entorno.despues(() => {
      espera = null
      // Si el foco ha saltado a otro campo, el teclado sigue arriba.
      if (abreTeclado(d.activeElement)) return
      intentos = 0
      comprobar()
    }, MS_TECLADO)
  }

  const alCambiarDeTamano = (): void => comprobar()

  d.addEventListener('focusout', alSoltarElFoco)
  vv.addEventListener('resize', alCambiarDeTamano)

  return () => {
    d.removeEventListener('focusout', alSoltarElFoco)
    vv.removeEventListener('resize', alCambiarDeTamano)
    if (espera !== null) entorno.cancelar(espera)
  }
}
