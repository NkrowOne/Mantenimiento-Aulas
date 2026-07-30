import { useRef, useState } from 'react'
import { flush } from '@/sync/outbox'
import { cuantoTrae, importarPendientes, leerCopia } from '@/sync/rescate'

/**
 * El otro extremo de la salida de emergencia.
 *
 * Cuando un dispositivo no consigue subir su cola, el técnico manda el fichero
 * que genera «Guardar copia de lo pendiente». Aquí se vuelve a meter en la cola
 * —la de este equipo, que sí tiene línea y permisos— y se sube.
 *
 * Vive en administración a propósito, y no junto al botón que genera la copia.
 * Lo que se importa se sube con la sesión de quien lo importa: que un técnico
 * cargue la cola de otro produciría filas firmadas por quien no las hizo, y en
 * el mejor caso las rechazaría RLS. Un administrador, en cambio, es justo quien
 * está autorizado a arreglar el estropicio de otro.
 */
export function RecuperarCopia(): React.ReactElement {
  const input = useRef<HTMLInputElement>(null)
  const [parte, setParte] = useState<string | null>(null)
  const [mal, setMal] = useState(false)
  const [trabajando, setTrabajando] = useState(false)

  const cargar = (fichero: File): void => {
    setTrabajando(true)
    setParte(null)
    void (async () => {
      try {
        const lectura = leerCopia(await fichero.text())
        if (!lectura.ok) {
          setMal(true)
          setParte(lectura.error)
          return
        }

        const trae = cuantoTrae(lectura.copia)
        const metido = await importarPendientes(lectura.copia)
        // Forzado: esto es una orden explícita, no un turno de la cola. Y el
        // backoff que trajera la copia es del viaje anterior.
        const subido = await flush({ forzar: true })

        setMal(subido.pendientes > 0 || subido.rechazados > 0)
        setParte(
          `Copia de ${lectura.copia.creado.slice(0, 10) || 'fecha desconocida'}: ` +
            `${metido.entradas} cambios y ${metido.fotos} fotos a la cola. ` +
            `Subidos ${subido.subidos}.` +
            (subido.pendientes > 0 ? ` Quedan ${subido.pendientes} esperando.` : '') +
            (subido.rechazados > 0
              ? ` ${subido.rechazados} rechazados por el servidor: míralos en la lámpara de arriba.`
              : '') +
            (trae.entradas + trae.fotos === 0 ? ' La copia venía vacía.' : ''),
        )
      } catch (err) {
        setMal(true)
        setParte(err instanceof Error ? err.message : String(err))
      } finally {
        setTrabajando(false)
        // Sin esto, volver a elegir el MISMO fichero no dispara `change` y
        // parece que el botón se ha roto — justo cuando alguien reintenta.
        if (input.current) input.current.value = ''
      }
    })()
  }

  return (
    <section>
      <h2 className="text-xl font-semibold">Recuperar trabajo de un dispositivo</h2>
      <p className="mt-1 text-sm text-muted">
        Para cuando un iPad no consigue subir su cola. El técnico pulsa «Guardar copia de lo
        pendiente» en la lámpara de sincronización y manda el fichero; aquí se vuelve a encolar y
        se sube con esta sesión. Importar dos veces la misma copia no duplica nada.
      </p>

      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) cargar(f)
        }}
      />

      <button
        type="button"
        disabled={trabajando}
        onClick={() => input.current?.click()}
        className="key key-accent mt-4 min-h-11 px-4 text-sm"
      >
        {trabajando ? 'Recuperando…' : 'Elegir fichero de copia'}
      </button>

      {parte && (
        <p aria-live="polite" className={`mt-3 text-sm ${mal ? 'text-crit' : 'text-muted'}`}>
          {parte}
        </p>
      )}
    </section>
  )
}
