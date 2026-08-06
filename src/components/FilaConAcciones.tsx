/**
 * Una fila de lista con su vía a las acciones de administrador: la pulsación
 * larga sobre la fila entera y el botón `⋯` hermano.
 *
 * Existe por una razón muy concreta, y conviene dejarla escrita porque no se
 * adivina leyendo el resultado: `usePulsacionLarga` es un hook, y las filas se
 * pintan dentro de un `.map()` sobre 23 edificios o 39 salas. Llamar un hook una
 * vez por elemento de una lista que cambia de longitud es exactamente lo que
 * React prohíbe — y aquí la longitud cambia sola, porque archivar un edificio
 * borra su fila del espejo mientras la lista está en pantalla. La única forma
 * limpia de tener un temporizador por fila es que cada fila sea un componente.
 *
 * Los manejadores se entregan por función hija en vez de esparcirlos aquí
 * dentro: el elemento pulsable no siempre es el mismo. En la lista es un
 * `<button>` que además navega, y en la cabecera de planta es un `<p>` que no
 * navega a ningún sitio. Que lo decida quien lo pinta.
 *
 * Y el `⋯` es **hermano**, nunca hijo del botón de la fila: un `<button>` dentro
 * de otro `<button>` es HTML inválido, y React lo hidrata mal —el interior
 * desaparece o hereda el `onClick` del de fuera—, así que tocar «acciones»
 * acabaría abriendo la sala.
 */

import { usePulsacionLarga, type ManejadoresDePulsacion } from '@/lib/pulsacion-larga'

interface Props {
  /**
   * Solo el administrador ve el `⋯` y siente el gesto. Con `false` esto no
   * pinta ni un nodo de más: la fila del técnico queda exactamente como estaba
   * antes de que existiera este componente, sin envoltorio, sin manejadores y
   * sin la lupa de iOS desactivada.
   */
  esAdmin: boolean
  /** El nombre del botón para VoiceOver: «Acciones de 1.7», no «Más». */
  etiqueta: string
  alAbrir: () => void
  /** Clases del contenedor. La cabecera de planta trae aquí su `sticky`. */
  className?: string
  children: (manejadores: ManejadoresDePulsacion) => React.ReactNode
}

export function FilaConAcciones({
  esAdmin,
  etiqueta,
  alAbrir,
  className,
  children,
}: Props): React.ReactElement {
  const manejadores = usePulsacionLarga(alAbrir, esAdmin)

  if (!esAdmin) return <>{children(manejadores)}</>

  return (
    <div className={`flex items-stretch ${className ?? ''}`}>
      {children(manejadores)}
      {/*
        Ancho de objetivo táctil entero y alto el de la fila: se pulsa de pie,
        con guantes y con el iPad en la otra mano. La línea de la izquierda es lo
        único que lo separa de la fila —sin ella, el dedo no sabe dónde acaba
        «abrir la sala» y empieza «acciones».

        El `min-h-11` no sobra aunque las filas midan de sobra: la cabecera de
        planta mide treinta y pocos píxeles, y estirado a la altura de su barra
        este botón se quedaría por debajo del objetivo táctil mínimo. Sube la
        cabecera a 44 px, y solo para quien tiene acciones que pulsar.
      */}
      <button
        type="button"
        onClick={alAbrir}
        aria-label={etiqueta}
        aria-haspopup="dialog"
        className="flex min-h-11 w-touch shrink-0 items-center justify-center border-l border-line-soft text-muted transition-colors duration-100 active:bg-raised"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="12" cy="19" r="1.75" />
        </svg>
      </button>
    </div>
  )
}
