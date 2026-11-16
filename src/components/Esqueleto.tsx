/**
 * Lo que se ve mientras llega una pantalla.
 *
 * Las pantallas que no son la ronda se cargan aparte (ver `App.tsx`), y mientras
 * llegaban se pintaba un «Cargando…» en gris. Con buena cobertura no daba
 * tiempo a leerlo —era un parpadeo— y con mala era una palabra sola en una
 * pantalla vacía, sin nada que dijera cuánto faltaba ni qué iba a salir.
 *
 * Esto pinta la silueta de una pantalla cualquiera de la aplicación: un título,
 * un buscador y unas filas. No es la de ninguna en concreto y no hace falta que
 * lo sea: lo que consigue es que la pantalla no esté en blanco, que nada salte
 * cuando llega el contenido de verdad —las piezas caen más o menos donde
 * estaban los huecos— y que el ojo ya esté mirando al sitio correcto.
 *
 * `role="status"` con su texto para lectores de pantalla: quien no ve los huecos
 * sigue oyendo «Cargando», que es lo que decía antes.
 */
export function Esqueleto({ filas = 5 }: { filas?: number }): React.ReactElement {
  return (
    <div role="status" aria-label="Cargando" className="mx-auto w-full max-w-4xl p-4">
      <div className="hueco h-7 w-40" />
      <div className="hueco mt-4 h-12 w-full rounded-ctl" />
      <div className="mt-5 space-y-3">
        {Array.from({ length: filas }, (_, i) => (
          <div key={i} className="card flex items-center gap-3 p-4 shadow-none">
            <div className="hueco h-10 w-10 shrink-0 rounded-ctl" />
            <div className="min-w-0 flex-1">
              {/* Anchos distintos: cinco barras idénticas se leen como un
                  dibujo; desiguales, como texto que aún no ha llegado. */}
              <div className="hueco h-4" style={{ width: `${[62, 78, 51, 70, 58][i % 5]}%` }} />
              <div className="hueco mt-2 h-3" style={{ width: `${[38, 30, 44, 26, 36][i % 5]}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
