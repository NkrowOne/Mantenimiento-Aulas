import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      // Sin cobertura no tiene sentido reintentar tres veces y hacer esperar:
      // las pantallas de supervisión son online y así lo dicen enseguida.
      retry: navigator.onLine ? 1 : 0,
      refetchOnWindowFocus: true,
    },
  },
})

/**
 * Bloqueo del zoom por pellizco en WebKit.
 *
 * Safari ignora `user-scalable=no` desde iOS 10 —fue una decisión suya de
 * accesibilidad— así que en el iPad la única vía que queda son sus eventos
 * propios `gesture*`, que no existen en ningún otro motor. En Android basta con
 * el `meta viewport` y con `touch-action` en el CSS.
 *
 * Se hace porque esto se usa de pie, sujetando el iPad con una mano y tocando
 * con el pulgar de la otra: el pellizco accidental es constante y deja la
 * pantalla a medio ampliar en mitad de una revisión.
 *
 * Lo que se pierde: ampliar para leer. Se compensa manteniendo el texto en
 * tamaños que no lo necesiten —nada por debajo de 11px— y respetando el ajuste
 * de tamaño de letra del sistema, que sí sigue funcionando.
 */
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
