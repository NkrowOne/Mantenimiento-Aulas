import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { registrarServiceWorker } from './sw'
import { vigilarElHistorial } from './lib/historial'
import { vigilarLaInstalacion } from './lib/instalar'
import { vigilarElTeclado } from './lib/viewport'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      // Sin cobertura no tiene sentido reintentar tres veces y hacer esperar:
      // las pantallas de supervisión son online y así lo dicen enseguida.
      retry: navigator.onLine ? 1 : 0,
      /*
       * Volver a la aplicación no vuelve a pedir nada. En Android cambiar de
       * aplicación cuenta como perder y recuperar el foco, y con esto a `true`
       * cada vuelta tras un minuto relanzaba todas las consultas de la pantalla
       * abierta por la cobertura del pasillo. Lo que tiene que estar fresco al
       * volver lo pide cada pantalla: el panel lo activa para sí.
       */
      refetchOnWindowFocus: false,
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

/*
 * La barra de pestañas, abajo aunque el teclado de iOS se despiste al bajar:
 * si al cerrarse deja lo que se ve separado de donde se pinta lo fijo, se
 * vuelven a juntar. Lo cuenta entero `lib/viewport.ts`.
 */
vigilarElTeclado()

/*
 * El botón atrás del móvil cierra lo de arriba —una hoja, una ficha, una
 * pantalla— en vez de cerrar la aplicación. Lo cuenta `lib/historial.ts`.
 */
vigilarElHistorial()

/* Y si Chrome ofrece instalar la aplicación, se guarda el ofrecimiento para
   enseñarlo en «Más». Lo cuenta `lib/instalar.ts`. */
vigilarLaInstalacion()

/*
 * Antes de pintar nada, y en particular antes del candado: si lo que impide
 * entrar es un fallo de la versión instalada, el registro tiene que ocurrir de
 * todos modos para que la versión que lo arregla pueda llegar. El registro
 * trae consigo el vigía de visibilidad —buscar versión al volver al frente,
 * instalarla sola tras una ausencia larga—, que por lo mismo vive en `./sw` y
 * no en la interfaz.
 */
registrarServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
