import { Icono } from './Icono'

/**
 * El contador: menos, la cifra y más, en UNA pieza.
 *
 * Antes cada pantalla lo montaba con tres teclas sueltas —y a veces una cuarta
 * para quitar—, cada una con su borde: cuatro cajas por fila, y en una lista de
 * cinco filas, veinte. Se leía como un teclado, no como una lista, y las cifras
 * no caían en columna porque cada fila llevaba un número distinto de teclas.
 *
 * Aquí las tres cosas van dentro de un mismo borde y miden siempre lo mismo, así
 * que en una lista los contadores quedan uno debajo de otro y la vista baja por
 * las cifras. Las dos zonas de toque siguen midiendo 44 px.
 *
 * **Quitar es la última «menos».** Con `quitaEnUno`, cuando queda una el menos
 * se pinta como una papelera: es lo que va a pasar al tocarlo, y evita una
 * tecla aparte para quitar la fila. Es como lo hace cualquier carrito.
 */
export function Contador({
  valor,
  onMenos,
  onMas,
  etiquetaMenos,
  etiquetaMas,
  etiquetaQuitar,
  quitaEnUno = false,
  minimo = 0,
  aviso = false,
}: {
  valor: number
  onMenos: () => void
  onMas: () => void
  /** Lo que oye quien no ve la tecla: «Una menos de Teclado USB». */
  etiquetaMenos: string
  etiquetaMas: string
  /** Lo que dice el menos cuando es una papelera. Por defecto, lo mismo que `etiquetaMenos`. */
  etiquetaQuitar?: string
  /** Con una sola, el menos quita la fila y se pinta como tal. */
  quitaEnUno?: boolean
  /** Por debajo de esto el menos no hace nada. */
  minimo?: number
  /** La cifra en ámbar: se pasa de lo que hay. */
  aviso?: boolean
}): React.ReactElement {
  const quita = quitaEnUno && valor <= 1
  const zona =
    'flex w-11 items-center justify-center transition-colors duration-100 active:bg-raised disabled:opacity-35 disabled:active:bg-transparent'
  return (
    <span className="inline-flex h-11 shrink-0 items-stretch rounded-ctl border border-line bg-surface">
      <button
        type="button"
        onClick={onMenos}
        disabled={valor <= minimo}
        aria-label={quita ? (etiquetaQuitar ?? etiquetaMenos) : etiquetaMenos}
        // La papelera, en el mismo gris que el menos: en una lista de cinco
        // artículos de una unidad, cinco papeleras rojas eran lo que más se veía.
        className={`${zona} rounded-l-ctl text-ink-2`}
      >
        <Icono nombre={quita ? 'papelera' : 'menos'} lado={18} />
      </button>
      <span
        className={`min-w-[1.75rem] self-center text-center font-mono text-base tabular ${aviso ? 'text-warn' : ''}`}
        aria-label={`${valor}`}
      >
        {valor}
      </span>
      <button type="button" onClick={onMas} aria-label={etiquetaMas} className={`${zona} rounded-r-ctl text-ink-2`}>
        <Icono nombre="anadir" lado={18} />
      </button>
    </span>
  )
}
