import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * La confirmación de una decisión crítica.
 *
 * Sustituye al `confirm()` del navegador, y no por estética. Tres cosas que el
 * del navegador no puede hacer y aquí importan:
 *
 *  - **Decir qué pasa después.** «¿Estás seguro?» no es información. «Se retira
 *    de la sala y deja de contar en las revisiones; el histórico se conserva» sí,
 *    y es la diferencia entre confirmar a ciegas y decidir.
 *  - **Escalar.** Fusionar dos modelos mueve equipos de verdad y no se deshace;
 *    para eso está `escribir`, que pide teclear una palabra. Un botón más no
 *    frena a un pulgar rápido; teclear, sí.
 *  - **Verse como la aplicación.** El diálogo del sistema en iOS aparece con el
 *    dominio delante y rompe la sensación de estar dentro de una app.
 *
 * Vale igual en el iPad y en el ordenador: el foco entra en el botón seguro,
 * Escape cancela y Enter confirma cuando no hay nada que teclear.
 */

export type TonoConfirmar = 'crit' | 'warn' | 'accent'

export interface PeticionConfirmar {
  titulo: string
  /** Qué va a pasar. En una frase, en presente y sin rodeos. */
  detalle?: string
  /** Las consecuencias, una por línea. Lo que no cabe en la frase de arriba. */
  consecuencias?: string[]
  confirmar?: string
  cancelar?: string
  tono?: TonoConfirmar
  /**
   * Palabra que hay que teclear para poder confirmar.
   *
   * Solo para lo que no se deshace. Ponerlo en todo lo convertiría en un trámite
   * que se cumple sin leer, que es justo lo que se quiere evitar.
   */
  escribir?: string
}

const CLASE_TONO: Record<TonoConfirmar, string> = {
  crit: 'key-crit',
  warn: 'key key-quiet border-warn/50 bg-warn-tint text-warn',
  accent: 'key-accent',
}

export function Confirmar({
  peticion,
  onCancelar,
  onConfirmar,
}: {
  peticion: PeticionConfirmar
  onCancelar: () => void
  onConfirmar: () => void
}): React.ReactElement {
  const [escrito, setEscrito] = useState('')
  const cancelarRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const listo =
    !peticion.escribir ||
    escrito.trim().toLocaleUpperCase('es') === peticion.escribir.toLocaleUpperCase('es')

  // El foco entra en «Cancelar», que es la salida segura. Entrar en el botón
  // destructivo convertiría un Enter de inercia en la acción.
  useEffect(() => {
    cancelarRef.current?.focus()
  }, [])

  useEffect(() => {
    const alTeclear = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancelar()
        return
      }
      // Encerrar el tabulador dentro del diálogo. Sin esto se sale al fondo, que
      // sigue ahí, y se puede pulsar lo que el diálogo estaba tapando.
      if (e.key !== 'Tab' || !panelRef.current) return
      const focos = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input, [href], [tabindex]:not([tabindex="-1"])',
      )
      const primero = focos[0]
      const ultimo = focos[focos.length - 1]
      if (!primero || !ultimo) return

      if (e.shiftKey && document.activeElement === primero) {
        e.preventDefault()
        ultimo.focus()
      } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault()
        primero.focus()
      }
    }
    document.addEventListener('keydown', alTeclear)
    return () => document.removeEventListener('keydown', alTeclear)
  }, [onCancelar])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancelar()
      }}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmar-titulo"
        className="card w-full max-w-md p-5"
        style={{ animation: 'pop 160ms var(--ease-out)' }}
      >
        <h2 id="confirmar-titulo" className="text-base font-semibold">
          {peticion.titulo}
        </h2>
        {peticion.detalle && <p className="mt-2 text-sm text-muted">{peticion.detalle}</p>}

        {peticion.consecuencias && peticion.consecuencias.length > 0 && (
          <ul className="mt-3 space-y-1 border-l-2 border-line pl-3 text-sm text-muted">
            {peticion.consecuencias.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}

        {peticion.escribir && (
          <label className="mt-4 block text-xs text-muted">
            Escribe <span className="font-mono font-semibold text-ink">{peticion.escribir}</span>{' '}
            para confirmar
            <input
              type="text"
              value={escrito}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setEscrito(e.target.value)}
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 font-mono text-sm text-ink"
            />
          </label>
        )}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancelarRef}
            type="button"
            onClick={onCancelar}
            className="key key-quiet min-h-touch px-4 text-sm sm:min-w-28"
          >
            {peticion.cancelar ?? 'Cancelar'}
          </button>
          <button
            type="button"
            disabled={!listo}
            onClick={onConfirmar}
            className={`key min-h-touch px-4 text-sm sm:min-w-28 ${CLASE_TONO[peticion.tono ?? 'crit']}`}
          >
            {peticion.confirmar ?? 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * El diálogo, para usarlo como se usaba `confirm()`: en medio del manejador y
 * sin montar estado en cada pantalla.
 *
 *   const { pedir, dialogo } = useConfirmar()
 *   ...
 *   onClick={() => void pedir({ titulo: '…' }).then((si) => si && borrar())}
 *   ...
 *   {dialogo}
 *
 * Devuelve una promesa porque es lo que permite que quien lo llama siga leyendo
 * como el código de antes. La diferencia con `confirm()` es que no bloquea el
 * hilo, así que la aplicación sigue sincronizando por detrás.
 */
export function useConfirmar(): {
  pedir: (peticion: PeticionConfirmar) => Promise<boolean>
  dialogo: React.ReactElement | null
} {
  const [abierto, setAbierto] = useState<{
    peticion: PeticionConfirmar
    resolver: (v: boolean) => void
  } | null>(null)

  const pedir = useCallback(
    (peticion: PeticionConfirmar) =>
      new Promise<boolean>((resolver) => setAbierto({ peticion, resolver })),
    [],
  )

  const cerrar = useCallback(
    (valor: boolean) => {
      setAbierto((actual) => {
        actual?.resolver(valor)
        return null
      })
    },
    [],
  )

  return {
    pedir,
    dialogo: abierto ? (
      <Confirmar
        peticion={abierto.peticion}
        onCancelar={() => cerrar(false)}
        onConfirmar={() => cerrar(true)}
      />
    ) : null,
  }
}
