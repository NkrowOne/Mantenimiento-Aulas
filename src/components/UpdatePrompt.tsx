import { useEffect, useState } from 'react'
import { aplicarActualizacion, onVersionNueva, posponerActualizacion } from '@/sw'

/**
 * Aviso de versión nueva.
 *
 * Ya no es la puerta: es el respaldo. La versión nueva se instala sola en los
 * momentos seguros —el arranque, la vuelta tras una ausencia larga, el final
 * de una revisión; la política vive en `@/sw`— así que esta barra solo se ve
 * cuando la versión se encontró a mitad de trabajo y todavía no ha llegado
 * ninguno de esos momentos, o cuando la activación automática falló. Ahí sigue
 * haciendo falta: quien quiera el arreglo YA no tiene por qué esperar a
 * guardar el iPad.
 *
 * «Ahora no» ya no puede significar «nunca», que es lo que significaba en la
 * práctica: solo aplaza hasta el próximo momento seguro.
 *
 * El **registro** ya no vive aquí (está en `@/sw`, y lo arranca `main.tsx`).
 * Estaba dentro de este componente, que se monta detrás del candado: un
 * dispositivo que no consigue entrar no podía recibir nunca el arreglo que le
 * dejaría entrar.
 */
export function UpdatePrompt(): React.ReactElement | null {
  const [needRefresh, setNeedRefresh] = useState(false)
  /*
   * El único final del botón que no se ve solo.
   *
   * Los demás acaban en recarga —la pantalla parpadea y se sabe que ha pasado
   * algo—, pero con una foto en tránsito la orden queda apuntada y la barra se
   * quedaría exactamente igual que si no se hubiera pulsado. Eso ya es el fallo
   * que se está arreglando; repetirlo aquí sería absurdo.
   */
  const [retenida, setRetenida] = useState(false)

  useEffect(() => onVersionNueva(setNeedRefresh), [])

  if (!needRefresh) return null

  return (
    <div
      role="status"
      /* Entra deslizándose desde el borde por el que vive, no aparece de la
         nada. `translateY(100%)` en porcentaje: se mueve su propio alto, sea
         cual sea, sin píxeles cableados que se rompan al cambiar el texto. */
      className="update-bar fixed inset-x-0 bottom-0 z-30 border-t border-accent/30 bg-accent-tint backdrop-blur"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
        <p aria-live="polite" className="flex-1 text-sm">
          {retenida
            ? 'Se instalará en cuanto termine de guardarse la foto.'
            : 'Hay una versión nueva.'}
        </p>

        <button
          type="button"
          onClick={() => posponerActualizacion()}
          className="key key-quiet min-h-11 px-3 text-sm font-medium text-muted"
        >
          Ahora no
        </button>
        <button
          type="button"
          onClick={() => {
            void aplicarActualizacion().then((parte) => setRetenida(parte === 'retenida'))
          }}
          className="key key-accent px-3 py-2 text-sm"
        >
          Actualizar
        </button>
      </div>
    </div>
  )
}
