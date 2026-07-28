import { useRegisterSW } from 'virtual:pwa-register/react'

/**
 * Aviso de versión nueva.
 *
 * `vite-plugin-pwa` está configurado en `registerType: 'prompt'`, que **exige**
 * una interfaz que lo atienda: sin ella el service worker descarga la versión
 * nueva y no la activa nunca, y los técnicos se quedan con la vieja
 * indefinidamente. En un iPad que no cierra la pestaña, eso puede durar meses.
 *
 * Se mantiene en `prompt` y no se pasa a `autoUpdate` a propósito: recargar la
 * página bajo los pies de alguien que está rellenando una revisión en un aula
 * es peor que esperar a que termine. El borrador sobreviviría —está en Dexie y
 * respaldado en el servidor— pero perdería el sitio donde iba.
 */
export function UpdatePrompt(): React.ReactElement | null {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      // Sin service worker no hay modo offline, así que conviene que se vea en
      // la consola en lugar de fallar en silencio. La causa casi siempre es un
      // certificado que el dispositivo no acepta.
      console.error('No se pudo registrar el service worker:', error)
    },
  })

  if (!needRefresh) return null

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-accent/30 bg-accent-tint backdrop-blur"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
        <p className="flex-1 text-sm">Hay una versión nueva.</p>

        <button
          type="button"
          onClick={() => setNeedRefresh(false)}
          className="rounded-ctl px-3 py-2 text-sm font-medium text-muted"
        >
          Ahora no
        </button>
        <button
          type="button"
          onClick={() => void updateServiceWorker(true)}
          className="rounded-ctl bg-accent px-3 py-2 text-sm font-semibold text-accent-ink"
        >
          Actualizar
        </button>
      </div>
    </div>
  )
}
