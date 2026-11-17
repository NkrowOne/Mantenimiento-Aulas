/**
 * El campo en el que se va a escribir, a la vista.
 *
 * Se tocaba una caja de texto y podía quedar debajo del teclado: se escribía a
 * ciegas, o había que cerrar el teclado, subir la pantalla a mano y volver a
 * tocar. Pasaba sobre todo con lo que está al final de una pantalla —la nota de
 * una revisión, la explicación de un cierre— y dentro de las hojas que suben
 * desde abajo, que es justo donde más se escribe.
 *
 * Los navegadores intentan arreglarlo solos y cada uno a su manera. iOS desplaza
 * LO QUE SE VE por encima de una página que no cambia de tamaño; Chrome de
 * Android unas veces encoge la página y otras no, según la versión. Y ninguno
 * de los dos sabe que aquí lo que desplaza no es el documento sino el `<main>`
 * del marco (`components/Marco.tsx`) o el cuerpo de una hoja: el campo del
 * final no puede subir más porque su carril ya está abajo del todo, aunque el
 * teclado lo esté tapando.
 *
 * Esto no pelea con el navegador: no mueve la página ni cambia el alto de nada.
 * Hace dos cosas, las dos dentro del carril que ya desplaza:
 *
 *  1. **Le da sitio.** Mide cuánto de la pantalla tapa el teclado y lo deja en
 *     `--teclado`. El carril lleva al final un hueco de ese alto
 *     (`.hueco-del-teclado`, en `index.css`), así que su último campo puede
 *     subir hasta quedar por encima del teclado. Sin teclado mide cero.
 *  2. **Lo coloca.** Al enfocar un campo, y otra vez cuando el teclado termina
 *     de subir, mira dónde ha quedado respecto a la franja que de verdad se ve
 *     —entre la cabecera y el teclado— y desplaza el carril lo justo para que
 *     quede dentro, con su etiqueta y con un poco de aire.
 *
 * Solo al enfocar: una vez colocado no se vuelve a tocar, porque mover la
 * pantalla debajo del dedo mientras se escribe es peor que lo que se arregla.
 *
 * Lo que decide va en funciones puras (`teclado`, `franjaVisible`,
 * `cuantoDesplazar`) porque las pruebas corren sin DOM; el resto es cablear
 * eventos, como en `viewport.ts`.
 */

import { ID_CONTENIDO, abreTeclado } from './viewport'

/**
 * Por debajo de esto no es un teclado: es la barra del navegador que se
 * esconde, o medio píxel de redondeo. Un teclado mide más de doscientos.
 */
export const MINIMO_DE_TECLADO_PX = 80

/** El aire que se deja entre el campo y los bordes de lo que se ve. */
export const MARGEN = { arriba: 12, abajo: 20 }

/**
 * Cuántos píxeles del final de la pantalla están tapados.
 *
 * `altoDePagina` es el de maquetación (`innerHeight`) y lo demás, lo que se ve
 * (`visualViewport`). En iOS la página no encoge y lo visto sí, y además se
 * desplaza por encima: por eso se cuenta desde donde ACABA lo visto, no solo lo
 * que mide. Si el navegador ya ha subido lo visto hasta el final de la página,
 * no queda nada tapado y esto da cero, que es la verdad.
 */
export function teclado(m: { altoDePagina: number; vistoDesde: number; vistoAlto: number }): number {
  const tapado = Math.round(m.altoDePagina - (m.vistoDesde + m.vistoAlto))
  return tapado >= MINIMO_DE_TECLADO_PX ? tapado : 0
}

/** Un tramo vertical, en las coordenadas de la página. */
export interface Tramo {
  arriba: number
  abajo: number
}

/**
 * La franja en la que un campo se ve de verdad: lo que el carril enseña y que
 * además cae dentro de lo visto. Por arriba la corta la cabecera —el carril
 * empieza debajo— y por abajo el teclado.
 */
export function franjaVisible(carril: Tramo, visto: Tramo): Tramo {
  return { arriba: Math.max(carril.arriba, visto.arriba), abajo: Math.min(carril.abajo, visto.abajo) }
}

/**
 * Cuánto hay que desplazar el carril para que el campo quede en la franja.
 * Positivo es hacia abajo (el contenido sube); cero, que ya está bien.
 *
 *  - Si ya cabe entero, con su aire: no se toca. Es lo normal en un campo de
 *    arriba, y moverlo «para dejarlo más bonito» sería mover la pantalla sin
 *    motivo.
 *  - Si lo tapa el teclado: sube lo justo para que su borde inferior quede por
 *    encima, con aire.
 *  - Si se ha quedado por encima de la cabecera: baja lo justo.
 *  - Si es más alto que la franja —una nota larga en un teléfono pequeño—: se
 *    alinea por ARRIBA, que es por donde se empieza a escribir.
 */
export function cuantoDesplazar(campo: Tramo, franja: Tramo, margen = MARGEN): number {
  const techo = franja.arriba + margen.arriba
  const suelo = franja.abajo - margen.abajo
  if (suelo <= techo) return 0
  const alto = campo.abajo - campo.arriba
  if (alto > suelo - techo) return Math.round(campo.arriba - techo)
  if (campo.abajo > suelo) return Math.round(campo.abajo - suelo)
  if (campo.arriba < techo) return Math.round(campo.arriba - techo)
  return 0
}

/**
 * El campo con su etiqueta, si la lleva encima.
 *
 * Casi todos los campos de la aplicación van dentro de su `<label>`, con el
 * texto arriba. Colocar solo la caja deja la pregunta fuera de la pantalla y la
 * respuesta dentro. La etiqueta se cuenta si cabe: una que mide media pantalla
 * —un campo con tres párrafos de ayuda— no puede mandar más que el campo.
 */
export function tramoConEtiqueta(campo: Tramo, etiqueta: Tramo | null, maximo = 120): Tramo {
  if (!etiqueta) return campo
  const arriba = Math.min(campo.arriba, etiqueta.arriba)
  return campo.arriba - arriba <= maximo ? { arriba, abajo: campo.abajo } : campo
}

/* ─────────────────────────────── El cableado ─────────────────────────────── */

/** El carril que desplaza a este elemento: una hoja, un panel, o el `<main>`. */
function carrilDe(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const estilo = getComputedStyle(p).overflowY
    if ((estilo === 'auto' || estilo === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p
  }
  return document.getElementById(ID_CONTENIDO)
}

/**
 * Los momentos en que se vuelve a mirar tras enfocar. El teclado tarda en subir
 * —unos 250 ms en iOS, algo más en algunos Android— y hasta que no termina no
 * se sabe cuánto tapa. Se mira al momento, por si ya estaba arriba (saltar de
 * un campo a otro), y varias veces después. Cada vez solo se mueve si hace
 * falta, así que mirar de más no cuesta nada.
 */
const INSTANTES_MS = [0, 120, 300, 500, 800]

/**
 * Se instala una vez, al arrancar, desde `main.tsx`. Devuelve cómo quitarlo.
 */
export function vigilarLosCampos(): () => void {
  const vv = window.visualViewport
  if (!vv) return () => {}

  const raiz = document.documentElement
  let tapado = -1
  let esperas: Array<ReturnType<typeof setTimeout>> = []
  /** Hasta cuándo se atiende a los cambios de tamaño: solo justo tras enfocar. */
  let atentoHasta = 0

  const medir = (): void => {
    const ahora = teclado({ altoDePagina: window.innerHeight, vistoDesde: vv.offsetTop, vistoAlto: vv.height })
    if (ahora === tapado) return
    tapado = ahora
    raiz.style.setProperty('--teclado', `${ahora}px`)
  }

  const colocar = (): void => {
    medir()
    const campo = document.activeElement
    if (!(campo instanceof HTMLElement) || !abreTeclado(campo)) return
    const carril = carrilDe(campo)
    if (!carril) return

    const rc = campo.getBoundingClientRect()
    const etiqueta = campo.closest('label')?.getBoundingClientRect() ?? null
    const rcarril = carril.getBoundingClientRect()
    const delta = cuantoDesplazar(
      tramoConEtiqueta(
        { arriba: rc.top, abajo: rc.bottom },
        etiqueta ? { arriba: etiqueta.top, abajo: etiqueta.bottom } : null,
      ),
      franjaVisible(
        { arriba: rcarril.top, abajo: rcarril.bottom },
        { arriba: vv.offsetTop, abajo: vv.offsetTop + vv.height },
      ),
    )
    if (delta !== 0) carril.scrollTop += delta
  }

  const cancelar = (): void => {
    for (const e of esperas) clearTimeout(e)
    esperas = []
  }

  const alEnfocar = (e: FocusEvent): void => {
    if (!(e.target instanceof HTMLElement) || !abreTeclado(e.target)) return
    cancelar()
    atentoHasta = Date.now() + 1200
    esperas = INSTANTES_MS.map((ms) => setTimeout(colocar, ms))
  }

  const alSoltar = (): void => {
    cancelar()
    // El hueco se retira cuando el teclado ha bajado, no antes: quitarlo con el
    // teclado a medio bajar deja el carril sin sitio y da un salto.
    esperas = [setTimeout(medir, 350)]
  }

  // El teclado terminando de subir o de bajar, o iOS recolocando lo visto.
  const alCambiar = (): void => {
    medir()
    if (Date.now() < atentoHasta) colocar()
  }

  medir()
  document.addEventListener('focusin', alEnfocar)
  document.addEventListener('focusout', alSoltar)
  vv.addEventListener('resize', alCambiar)
  vv.addEventListener('scroll', alCambiar)

  return () => {
    cancelar()
    document.removeEventListener('focusin', alEnfocar)
    document.removeEventListener('focusout', alSoltar)
    vv.removeEventListener('resize', alCambiar)
    vv.removeEventListener('scroll', alCambiar)
    raiz.style.removeProperty('--teclado')
  }
}
