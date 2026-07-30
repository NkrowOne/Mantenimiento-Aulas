import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { pendingSummary } from '@/db/dexie'
import { flush, getUltimoErrorSync, onSyncState, retryRejected, type SyncState } from '@/sync/outbox'
import { pullMaster, ultimoPull } from '@/sync/pull'
import { exportarPendientes, ofrecerFichero } from '@/sync/rescate'
import { aplicarActualizacion, onVersionNueva } from '@/sw'
import { Diagnostico } from '@/features/admin/Diagnostico'

/**
 * La lámpara de estado.
 *
 * Responde a la única pregunta que importa cuando no hay cobertura —*¿se ha
 * guardado mi trabajo?*— y, casi siempre, la responde **callándose**.
 *
 * Antes era una píldora verde permanente con un punto brillante y un texto
 * tranquilizador. Un panel de instrumentos no lleva un piloto que diga «AUDIO
 * CORRECTO»: lleva uno rojo que se enciende cuando algo va mal. Algo que está en
 * pantalla el 100% del tiempo no debe decir nada cuando no tiene nada que decir,
 * porque entonces deja de leerse y se lleva por delante la atención que hará
 * falta el día que sí importe.
 *
 * Así que: cuadrado gris apagado cuando todo está subido; se enciende con su
 * color y gana la cuenta en cuanto hay algo pendiente, sin conexión o
 * rechazado. Sigue siendo pulsable en los dos casos, así que no se pierde el
 * acceso al detalle ni al «Sincronizar» manual.
 *
 * La confirmación explícita de que el trabajo está a salvo la da la barra de la
 * revisión («Guardado» / «Guardando…»), que es donde el técnico la necesita.
 */
export function SyncChip(): React.ReactElement {
  const [state, setState] = useState<SyncState>('inactivo')
  const [open, setOpen] = useState(false)
  const [bajando, setBajando] = useState(false)
  const [resultado, setResultado] = useState<string | null>(null)
  const [copiando, setCopiando] = useState(false)
  const raiz = useRef<HTMLDivElement>(null)
  const summary = useLiveQuery(() => pendingSummary(), [], null)
  // El parte de la última bajada. `ultimoPull()` existía y no lo leía nadie.
  const ultimo = useLiveQuery(() => ultimoPull(), [], null)

  useEffect(() => onSyncState(setState), [])

  // Si hay versión nueva esperando, este panel es donde hace falta saberlo.
  const [hayActualizacion, setHayActualizacion] = useState(false)
  useEffect(() => onVersionNueva(setHayActualizacion), [])

  /*
   * Cerrar tocando fuera, y con Escape.
   *
   * Antes la única salida era volver a pulsar la lámpara —un cuadrado de 8 px
   * que el propio panel tapa en cuanto se abre—, así que en un móvil el panel
   * se quedaba clavado en pantalla y no había forma de quitarlo sin recargar.
   * Un popover que no se cierra tocando fuera no es un popover, es un modal
   * sin botón de cerrar.
   */
  useEffect(() => {
    if (!open) return

    const fuera = (e: PointerEvent): void => {
      if (!raiz.current?.contains(e.target as Node)) setOpen(false)
    }
    const escape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', fuera)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', fuera)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const pending = summary?.total ?? 0
  const rejected = summary?.rejected ?? 0

  // Un pendiente que lleva horas ahí ya no es "en camino", es un problema.
  const stuckHours = summary?.oldestAt ? (Date.now() - summary.oldestAt) / 3_600_000 : 0
  const stuck = pending > 0 && stuckHours > 6

  /*
   * Qué enseña la lámpara. Es una cadena de prioridades, no un conmutador: lo
   * más grave que esté pasando gana.
   *
   * Escrito como cadena de `if` y no de ternarios porque ya son seis casos, y
   * el sexto —`error`— faltaba: caía al último brazo y se pintaba gris y mudo,
   * exactamente igual que «todo bien». El motor tiene un estado para decir que
   * ha reventado y la lámpara lo dibujaba como si no hubiera pasado nada.
   */
  const { label, lamp } = ((): { label: string | null; lamp: string } => {
    if (rejected > 0) return { label: `${rejected} sin enviar`, lamp: 'bg-crit' }
    if (stuck) return { label: `${pending} atascados`, lamp: 'bg-crit' }
    if (state === 'error') return { label: 'Error al sincronizar', lamp: 'bg-crit' }
    if (state === 'sin-conexion') {
      return { label: pending > 0 ? `${pending} sin conexión` : 'Sin conexión', lamp: 'bg-warn' }
    }
    if (state === 'sincronizando') return { label: 'Guardando…', lamp: 'bg-accent' }
    if (pending > 0) return { label: `${pending} pendientes`, lamp: 'bg-warn' }
    return { label: null, lamp: 'bg-muted' }
  })()

  return (
    <div ref={raiz} className="relative">
      {/*
        Sin pendientes —el caso normal— `label` es null y el botón se quedaba
        reducido a la lámpara: 16×20 px de área pulsable, muy por debajo del
        mínimo 24×24 de WCAG y a un mundo de los 44×44 de Apple. Y en `bg-muted/50`
        sobre el fondo daba 1.98:1 de contraste, o sea que se leía como
        decoración, no como un control. Un piloto apagado sigue teniendo que ser
        un botón: es la única puerta al detalle y al «Sincronizar».
      */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 min-w-11 items-center justify-center gap-2 px-2 py-1.5 text-xs font-medium text-ink-2"
        aria-expanded={open}
        aria-controls="panel-sync"
        aria-label={label ?? 'Estado de sincronización'}
      >
        {/* Cuadrado, no círculo: un piloto de panel, no un punto de notificación. */}
        <span aria-hidden className={`h-2 w-2 rounded-[1px] ring-1 ring-line ${lamp}`} />
        {label}
      </button>

      {/*
        El panel crece desde la lámpara, no desde su propio centro. Un popover
        anclado que aparece del centro se lee como una capa suelta; anclado al
        origen se lee como el detalle de lo que acabas de tocar.
      */}
      {open && (
        // El ancho fijo de 288 px se salía por la izquierda en cualquier móvil
        // por debajo de ~419 px: el panel cuelga de `right-0` del chip, que no
        // está pegado al borde —a su derecha hay «Cerrar sesión» y el `px-4` de
        // la cabecera—. Lo que se sale por la izquierda no se puede recuperar
        // desplazando, así que se recortaba texto sin más.
        <div
          id="panel-sync"
          className="card absolute right-0 z-20 mt-2 w-[min(18rem,calc(100vw-2rem))] origin-top-right p-4 text-sm"
          style={{ animation: 'pop 150ms var(--ease-out)' }}
        >
          {/*
            Decía «Todo guardado en el servidor» a partir de seis `count()` de
            Dexie, sin preguntarle al servidor absolutamente nada. En el caso que
            trajo aquí a este usuario —la aplicación sin datos y sin dejarle
            hacer nada— el único panel que abrió le afirmaba que todo iba bien, y
            le mandaba a mirar la SUBIDA cuando lo roto era la BAJADA. Ahora dice
            solo lo que sabe, y la bajada se cuenta aparte.
          */}
          <p className="text-muted">
            {pending === 0 && rejected === 0
              ? 'Nada pendiente de subir.'
              : `${pending} sin subir${summary?.photos ? ` · ${summary.photos} fotos` : ''}`}
          </p>

          {/* El motivo del que lleva más esperando. Un contador que no baja y
              no dice nada obliga a adivinar, y desde un iPad no hay dónde
              mirar: ni consola, ni red, ni registro. */}
          {pending > 0 && rejected === 0 && summary?.motivoPendiente && (
            <p className="mt-1 break-words font-mono text-xs text-muted">
              {summary.motivoPendiente}
            </p>
          )}

          {ultimo && (
            <p className={`mt-1 ${ultimo.ok ? 'text-muted' : 'text-crit'}`}>
              {ultimo.ok
                ? `Última descarga: ${ultimo.filas} filas.`
                : `La última descarga falló: ${ultimo.error}`}
            </p>
          )}

          {state === 'error' && getUltimoErrorSync() && (
            <p className="mt-2 break-words font-mono text-xs text-crit">{getUltimoErrorSync()}</p>
          )}

          {/*
            La versión nueva, ofrecida DONDE se está viendo el fallo.
            El aviso de abajo se puede posponer, y se pospone: es una barra que
            estorba. Pero cuando lo que hay delante es un error de
            sincronización, actualizar suele ser literalmente el arreglo — el
            fallo se corrigió, se desplegó, y este dispositivo sigue con el
            código de antes porque nadie pulsó el botón. Pasó, y tuvo a gente de
            campo mirando una avería ya resuelta.
          */}
          {hayActualizacion && (
            <div className="mt-3 rounded-ctl border border-accent/30 bg-accent-tint p-3">
              <p className="text-sm">
                Hay una versión nueva sin instalar.
                {state === 'error' && ' Puede que sea justo lo que arregla esto.'}
              </p>
              <button
                type="button"
                onClick={() => void aplicarActualizacion()}
                className="key key-accent mt-2 min-h-11 w-full px-3 text-sm"
              >
                Actualizar ahora
              </button>
            </div>
          )}

          {stuck && (
            <p className="mt-2 text-crit">
              {Math.floor(stuckHours)} h sin subir. Busca cobertura.
            </p>
          )}

          {rejected > 0 && (
            <>
              <p className="mt-2 text-crit">
                {rejected} rechazados. Avisa a administración.
              </p>
              {/* El motivo se guardaba por entrada desde el principio y no lo
                  leía nadie: «avisa a administración» sin decir de qué obliga a
                  administración a adivinarlo. */}
              {summary?.ultimoMotivo && (
                <p className="mt-1 break-words font-mono text-xs text-muted">
                  {summary.ultimoMotivo}
                </p>
              )}
            </>
          )}

          {/* `aria-live` para que el resultado de «Sincronizar» se anuncie: el
              texto aparece sin que nada más cambie de sitio. */}
          <p aria-live="polite" className={resultado ? 'mt-2 text-muted' : 'sr-only'}>
            {resultado}
          </p>

          <div className="mt-3 flex gap-2">
            {/*
              «Sincronizar» sincroniza en los dos sentidos.
              Antes solo llamaba a `flush()`, que vacía la cola de SALIDA: con la
              cola vacía —el caso normal— no hacía absolutamente nada, ni siquiera
              decirlo. Quien lo pulsa quiere lo contrario, traerse lo que hay en el
              servidor, así que ahora sube y luego baja, y cuenta cómo ha ido.

              `forzar` porque pulsar el botón es la orden explícita de intentarlo
              ahora: sin él, lo que estuviera esperando su turno de backoff ni se
              tocaba y el panel contestaba «Al día» con la cola intacta detrás.
            */}
            <button
              type="button"
              disabled={bajando}
              onClick={() => {
                setBajando(true)
                setResultado(null)
                void (async () => {
                  try {
                    const subido = await flush({ forzar: true })
                    const bajado = await pullMaster()

                    /*
                       La subida se cuenta en voz alta. Antes solo se hablaba de
                       la bajada, así que la pantalla decía «Al día: 1466 filas»
                       mientras la cabecera seguía marcando pendientes: dos
                       afirmaciones que se contradicen, y el técnico se queda sin
                       saber cuál de las dos vale.
                     */
                    const subida =
                      subido.subidos > 0 ? `Subidos ${subido.subidos}.` : null
                    const queda =
                      subido.pendientes > 0
                        ? `Quedan ${subido.pendientes} por subir.`
                        : subido.subidos > 0
                          ? 'No queda nada por subir.'
                          : null
                    const descarga = bajado.ok
                      ? `Al día: ${bajado.filas} filas del servidor.`
                      : `No se ha podido descargar: ${bajado.error}`

                    setResultado([subida, queda, descarga].filter(Boolean).join(' '))
                  } catch (err) {
                    setResultado(err instanceof Error ? err.message : String(err))
                  } finally {
                    setBajando(false)
                  }
                })()
              }}
              className="key key-accent flex-1 px-3 py-2 text-xs"
            >
              {bajando ? 'Sincronizando…' : 'Sincronizar'}
            </button>
            {rejected > 0 && (
              <button
                type="button"
                onClick={() => void retryRejected()}
                className="key key-quiet flex-1 px-3 py-2 text-xs"
              >
                Reintentar
              </button>
            )}
          </div>

          {/*
            La salida de emergencia.

            Mientras la cola no sube, la regla de oro del proyecto —nada
            pendiente vive solo en el móvil— está rota, y veinte revisiones
            hechas a mano existen en un único IndexedDB de un único iPad. Este
            botón no arregla la subida: saca el trabajo del dispositivo ahora,
            sin servidor, sin permisos y sin red, a un fichero que se manda por
            AirDrop o correo y que administración puede volver a meter en la
            cola desde otro sitio.

            Solo aparece cuando hay algo que salvar: un botón de rescate
            permanente enseña a ignorarlo.
          */}
          {pending + rejected > 0 && (
            <button
              type="button"
              disabled={copiando}
              onClick={() => {
                setCopiando(true)
                void (async () => {
                  try {
                    const copia = await exportarPendientes()
                    const via = await ofrecerFichero(copia.nombre, copia.blob)
                    setResultado(
                      `Copia de ${copia.entradas} cambios y ${copia.fotos} fotos ` +
                        `${via === 'compartido' ? 'compartida' : 'guardada'}. ` +
                        'Mándasela a administración: con ella el trabajo ya no depende de este dispositivo.' +
                        // Dar por salvado lo que no lo está es peor que no tener
                        // copia, así que lo que se ha quedado fuera se dice.
                        (copia.fotosIlegibles > 0
                          ? ` Ojo: ${copia.fotosIlegibles} fotos no han entrado porque el dispositivo ya no puede leerlas. Hay que repetirlas.`
                          : ''),
                    )
                  } catch (err) {
                    setResultado(
                      `No se ha podido hacer la copia: ${err instanceof Error ? err.message : String(err)}`,
                    )
                  } finally {
                    setCopiando(false)
                  }
                })()
              }}
              className="key key-quiet mt-2 w-full px-3 py-2 text-xs"
            >
              {copiando ? 'Preparando copia…' : 'Guardar copia de lo pendiente'}
            </button>
          )}

          {/* Aquí es donde se viene cuando «algo no va», así que aquí tiene que
              estar. Antes solo se llegaba al diagnóstico desde la lista de
              edificios vacía, o sea desde una de las pantallas que el propio
              fallo deja en blanco. */}
          <Diagnostico />

          {/*
            Qué versión ejecuta ESTE dispositivo.
            `salud.json` dice qué hay en el servidor, que no es lo mismo: con
            `registerType: 'prompt'` un iPad puede llevar días con la anterior.
            Sin este dato, diagnosticar desde una captura de pantalla es
            adivinar si el código que falla es siquiera el que está corriendo.
          */}
          <p className="mt-3 border-t border-line pt-2 text-right font-mono text-[10px] text-muted">
            versión {__BUILD__}
          </p>
        </div>
      )}
    </div>
  )
}
