/**
 * Abrir la ficha de una revisión desde donde se esté.
 *
 * A la ficha se llega desde cuatro sitios —el listado de revisiones, la línea de
 * tiempo de la pestaña Historial, el histórico plegado de dentro de la revisión y
 * la ficha del aula— y en los cuatro pasa lo mismo: se abre, se lee y se vuelve
 * a lo que se estaba haciendo. Con el estado en cada pantalla, eso son cuatro
 * copias del mismo `useState`, el mismo `lazy` y el mismo montaje.
 *
 * El componente se carga solo cuando alguien abre una: arrastra la consulta de
 * comprobaciones, la de incidencias y el visor de fotos, y la mayoría de las
 * veces nadie lo abre.
 */

import { Suspense, lazy, useCallback, useState } from 'react'

const FichaRevision = lazy(() =>
  import('./FichaRevision').then((m) => ({ default: m.FichaRevision })),
)

export function useFichaRevision(): {
  /** Abre la ficha de esa revisión. */
  abrir: (inspectionId: string) => void
  /** Lo que hay que pintar. Es `null` mientras no haya ninguna abierta. */
  ficha: React.ReactNode
} {
  const [abierta, setAbierta] = useState<string | null>(null)

  const abrir = useCallback((inspectionId: string) => setAbierta(inspectionId), [])

  return {
    abrir,
    ficha: abierta ? (
      /* El fondo del suspense es opaco y a pantalla completa: la ficha es una
         capa sobre lo que hay debajo, y un fallback transparente dejaría ver la
         lista moviéndose detrás mientras carga. */
      <Suspense
        fallback={
          <div className="fixed inset-0 z-40 bg-ground p-6 text-muted">Cargando la revisión…</div>
        }
      >
        <FichaRevision inspectionId={abierta} onCerrar={() => setAbierta(null)} />
      </Suspense>
    ) : null,
  }
}
