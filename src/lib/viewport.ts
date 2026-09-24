/**
 * Lo que queda fuera del marco: las capas y el teclado.
 *
 * El arreglo de fondo de la barra de pestañas flotando es `components/Marco.tsx`:
 * la barra ya no es `fixed`, así que el fallo de iOS 26 que deja varado todo lo
 * `fixed` al bajar el teclado (WebKit 297779) ya no la alcanza. Esto cubre lo
 * que sigue siendo `fixed` —las hojas, el visor de fotos, el aviso de versión—
 * y lo que el fallo todavía puede tocar aunque nada sea `fixed`: que al bajar
 * el teclado la página se quede desplazada.
 *
 * En WebKit lo `fixed` se coloca contra el viewport de MAQUETACIÓN y no contra
 * lo que se ve. El teclado los separa: lo visual encoge e iOS desplaza la
 * página para enseñar el campo. Al bajar tienen que volver a juntarse, y en
 * iOS 26 a veces no: `visualViewport.offsetTop` se queda por encima de cero y
 * `visualViewport.height` por debajo de `innerHeight`.
 *
 * La hoja de «Añadir una sala» lo provocaba de libro: campos de texto dentro
 * de una capa `fixed`, el fondo con `overflow: hidden` —que en iOS no impide
 * que el propio iOS desplace la página para enseñar el campo—, y al guardar,
 * tres movimientos mientras el teclado todavía está bajando: el foco salta al
 * «Entendido», la hoja se desmonta, y el foco vuelve a la fila que la abrió.
 * Los dos `focus()` desplazaban la página, midiendo contra un viewport visual a
 * medio crecer.
 *
 * Dos piezas:
 *
 *  - `congelarFondo()` para las capas: congela lo que desplaza por detrás, y al
 *    cerrar lo deja EXACTAMENTE donde estaba y devuelve el foco sin desplazar.
 *  - `vigilarElTeclado()` para todo lo demás: cuando el teclado acaba de bajar,
 *    mira si la página ha vuelto a su sitio y, si no, la devuelve.
 *
 * Lo que decide va en funciones puras (`abreTeclado`, `decidir`) porque las
 * pruebas corren en `node`, sin DOM; el resto es cablear eventos.
 */

/** El `id` del `<main>` del marco: lo único que desplaza mientras está montado. */
export const ID_CONTENIDO = 'contenido'

/** La clase que pone el marco en `<html>` mientras está montado. */
export const CLASE_MARCO = 'marco'

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

/** Veces seguidas que se intenta devolver la página antes de rendirse. */
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
  /** Cuánto está lo que se ve fuera de donde debería, en píxeles. */
  desfase: number
  /** `visualViewport.scale`. */
  escala: number
  /** Si el foco está en algo que deja el teclado arriba. */
  teclado: boolean
}

/**
 * ¿Hay que devolver la página a su sitio?
 *
 * Solo si está fuera de sitio SIN motivo:
 *
 *  - Con el teclado arriba el desplazamiento es lo normal: así enseña iOS el
 *    campo por encima del teclado. Tocarlo ahí movería la página debajo del
 *    dedo mientras se escribe.
 *  - Con la página ampliada también: es la única forma de moverse por ella, y
 *    si alguien ha conseguido ampliar a pesar de los tres bloqueos, lo ha
 *    querido.
 */
export function decidir(m: Medidas): 'nada' | 'devolver' {
  if (m.teclado) return 'nada'
  if (Math.abs(m.escala - 1) > 0.01) return 'nada'
  return Math.abs(m.desfase) > HOLGURA_PX ? 'devolver' : 'nada'
}

/** Algo con estilo en línea, para congelarlo y descongelarlo. */
interface ConEstilo {
  style: { overflow: string }
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
    documentElement: ConEstilo & { classList: { contains: (clase: string) => boolean } }
    getElementById: (id: string) => ConEstilo | null
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
let antes: {
  documento: string
  contenido: { el: ConEstilo; overflow: string } | null
  x: number
  y: number
} | null = null

/**
 * Congela lo que desplaza detrás de una capa, y devuelve cómo descongelarlo.
 *
 * Lo que desplaza es el contenido del marco o, fuera de él, el documento: se
 * congelan los dos, que cuesta lo mismo y no hay que saber cuál toca.
 *
 * `origen` es a quién se le devuelve el foco al cerrar: la fila o el botón que
 * abrió la capa. Se devuelve **sin desplazar** —con `preventScroll`—: estaba
 * a la vista cuando se tocó, y la página ya se deja donde estaba a mano.
 */
export function congelarFondo(
  origen: { focus: (o?: FocusOptions) => void } | null,
  entorno: Entorno = entornoReal(),
): () => void {
  const { window: w, document: d } = entorno
  if (congeladas === 0) {
    const el = d.getElementById(ID_CONTENIDO)
    antes = {
      documento: d.documentElement.style.overflow,
      contenido: el ? { el, overflow: el.style.overflow } : null,
      x: w.scrollX,
      y: w.scrollY,
    }
    d.documentElement.style.overflow = 'hidden'
    if (el) el.style.overflow = 'hidden'
  }
  congeladas++

  let hecho = false
  return () => {
    if (hecho) return
    hecho = true
    congeladas = Math.max(0, congeladas - 1)
    if (congeladas === 0 && antes) {
      const { documento, contenido, x, y } = antes
      antes = null
      d.documentElement.style.overflow = documento
      if (contenido) contenido.el.style.overflow = contenido.overflow
      // Donde estaba, al píxel. iOS desplaza la página para enseñar un campo
      // aunque tenga `overflow: hidden`, y sin esto se quedaba movida. Con el
      // marco montado es (0, 0), que es justo donde tiene que estar.
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
 * Vigila el teclado, y cuando baja, devuelve la página a su sitio si hace falta.
 *
 * Se instala una vez, al arrancar, desde `main.tsx`. Devuelve cómo quitarlo.
 *
 * Qué dispara la comprobación:
 *
 *  - `focusout` cuyo foco no acaba en otro campo: el teclado va a bajar. Se
 *    espera a que termine (`MS_TECLADO`).
 *  - `resize` del viewport visual: es lo que avisa de que el teclado ha
 *    terminado de bajar —o de un giro—.
 *
 * Cuál es «su sitio» depende de quién desplaza:
 *
 *  - **Con el marco** el documento no desplaza nunca, así que su sitio es
 *    arriba del todo: cualquier cosa distinta de (0, 0) con el teclado abajo es
 *    el fallo. Es el caso de la aplicación.
 *  - **Sin él** —el candado, la carga— el sitio es donde está lo visual: se
 *    lleva la página ahí y el viewport de maquetación se va con ella. Si la
 *    página ya dice estar ahí, un `scrollTo` a lo mismo no recalcula nada: un
 *    píxel de ida y vuelta, que durante un fotograma no se ve.
 *
 * Como mucho `MAX_INTENTOS` seguidos, por si alguna versión de iOS no se deja:
 * una página que se mueve sola en bucle sería peor que un desfase.
 */
export function vigilarElTeclado(entorno: Entorno = entornoReal()): () => void {
  const { window: w, document: d } = entorno
  const vv = w.visualViewport
  if (!vv) return () => {}

  let intentos = 0
  let espera: ReturnType<typeof setTimeout> | null = null
  let marcoPedido = false

  const enMarco = (): boolean => d.documentElement.classList.contains(CLASE_MARCO)

  const medir = (): Medidas => ({
    desfase: enMarco()
      ? Math.max(Math.abs(vv.offsetTop), Math.abs(vv.pageTop), Math.abs(w.scrollY))
      : vv.offsetTop,
    escala: vv.scale,
    teclado: abreTeclado(d.activeElement),
  })

  const devolver = (): void => {
    if (enMarco()) {
      w.scrollTo(0, 0)
      return
    }
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
      devolver()
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
