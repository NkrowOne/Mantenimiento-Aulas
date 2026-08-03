/**
 * Lo que se puede hacer con una incidencia, esté donde esté.
 *
 * Vive aparte porque ahora se usa en dos sitios y tiene que ser el mismo gesto
 * en los dos: la pestaña de Incidencias —la cola de trabajo, que se despacha
 * sentado— y la ficha de la sala, que es donde se está justo después de arreglar
 * el aparato. Ese segundo sitio es el que faltaba: hasta ahora, para cerrar el
 * parte del proyector que acabas de arreglar había que salir del aula, cambiar
 * de pestaña y encontrarlo entre cuarenta.
 *
 * DOS DECISIONES:
 *
 *  - **Cerrar pide decir cómo.** `resolution` era una columna que nadie
 *    rellenaba: el botón mandaba el estado y nada más. Así, el histórico de la
 *    sala decía «Resuelta: Proyector: no da imagen» — la avería otra vez, no lo
 *    que se hizo con ella, que es lo único que le sirve a quien se encuentre el
 *    mismo aparato dentro de tres meses. Los motivos van como teclas porque esto
 *    se pulsa de pie: un cuadro de texto en blanco y una mano libre son un campo
 *    que se queda vacío.
 *  - **El material, antes de cerrar.** Después nadie vuelve a la incidencia, y
 *    ese era el dato que no llegaba nunca al almacén. Así que el recordatorio va
 *    dentro del panel de cierre, con el botón al lado, y no en una frase suelta
 *    de otra pantalla.
 */

import { useState } from 'react'
import { MaterialUsado } from './MaterialUsado'
import { MOTIVOS_DE_CIERRE, avanzarIncidencia, puedeCerrar } from './acciones'
import type { IncidentState, Role } from '@/domain/types'

export type PanelDeIncidencia = 'material' | 'cerrar'

interface Props {
  incident: { id: string; state: IncidentState; room_id: string | null }
  role: Role
  userId: string | null
  /**
   * Qué panel tiene abierto esta fila, o nulo.
   *
   * Lo lleva la lista y no cada fila a propósito: se está apuntando lo de UNA
   * avería, no llevando la contabilidad de seis a la vez. Con el estado dentro,
   * media lista acabaría desplegada y la cola de trabajo dejaría de recorrerse.
   */
  panel: PanelDeIncidencia | null
  onPanel: (panel: PanelDeIncidencia | null) => void
  /** Se avisa al terminar para que la pantalla refresque lo que tenga que refrescar. */
  onHecho?: () => void
}

export function AccionesDeIncidencia({
  incident,
  role,
  userId,
  panel,
  onPanel,
  onHecho,
}: Props): React.ReactElement {
  const [motivo, setMotivo] = useState<string | null>(null)
  const [detalle, setDetalle] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [hecho, setHecho] = useState<string | null>(null)
  const [fallo, setFallo] = useState<string | null>(null)

  const puede = puedeCerrar(role)

  async function avanzar(
    estado: 'en_curso' | 'resuelta',
    resolucion?: string,
  ): Promise<void> {
    setGuardando(true)
    setFallo(null)
    try {
      await avanzarIncidencia({ id: incident.id, estado, resolucion, userId })
      setHecho(
        estado === 'resuelta'
          ? 'Resuelta. Sube en cuanto haya cobertura.'
          : 'En curso. Sube en cuanto haya cobertura.',
      )
      onPanel(null)
      onHecho?.()
    } catch (e) {
      setFallo(e instanceof Error ? e.message : 'No se ha podido guardar el cambio.')
    } finally {
      setGuardando(false)
    }
  }

  const resolucion = [motivo, detalle.trim()].filter(Boolean).join(' — ')

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap gap-2">
        {puede && incident.state === 'abierta' && (
          <button
            type="button"
            onClick={() => void avanzar('en_curso')}
            disabled={guardando}
            className="key key-quiet min-h-11 px-3 text-xs"
          >
            Empezar
          </button>
        )}

        <button
          type="button"
          aria-expanded={panel === 'material'}
          onClick={() => onPanel(panel === 'material' ? null : 'material')}
          className="key key-quiet min-h-11 px-3 text-xs"
        >
          Material
        </button>

        {puede && (
          <button
            type="button"
            aria-expanded={panel === 'cerrar'}
            onClick={() => onPanel(panel === 'cerrar' ? null : 'cerrar')}
            className="key key-accent min-h-11 px-3 text-xs"
          >
            Resolver
          </button>
        )}
      </div>

      {/* La confirmación se queda hasta que se toque otra cosa: en un iPad que
          está subiendo por la cola, «se ha guardado» es la única respuesta que
          hay, y un aviso que se desvanece solo no la da. */}
      {hecho && (
        <p aria-live="polite" className="mt-2 text-xs text-ok">
          {hecho}
        </p>
      )}
      {fallo && (
        <p role="alert" className="mt-2 text-xs text-crit">
          {fallo}
        </p>
      )}

      {panel === 'material' && <MaterialUsado incidentId={incident.id} roomId={incident.room_id} />}

      {panel === 'cerrar' && (
        <form
          className="mt-3 rounded-ctl border border-line bg-raised p-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!resolucion) return
            void avanzar('resuelta', resolucion)
          }}
        >
          <fieldset className="min-w-0 border-0 p-0">
            <legend className="eyebrow mb-2">¿Cómo se ha resuelto?</legend>

            <div className="flex flex-wrap gap-2">
              {MOTIVOS_DE_CIERRE.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={motivo === m}
                  onClick={() => setMotivo(motivo === m ? null : m)}
                  className={`key min-h-11 px-3 text-xs ${
                    motivo === m ? 'key-accent' : 'key-quiet text-muted'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="mt-3 block text-xs text-muted">
            Detalle (opcional)
            <textarea
              value={detalle}
              onChange={(e) => setDetalle(e.target.value)}
              rows={2}
              placeholder="Qué se ha hecho, o el número de serie de la pieza"
              className="mt-1 w-full rounded-ctl border border-line bg-surface p-2 text-sm text-ink"
            />
          </label>

          {/* Aquí y no en otra pantalla: después de cerrar nadie vuelve, y este
              es el dato que no llegaba nunca al almacén. */}
          <p className="mt-2 text-xs leading-relaxed text-muted">
            ¿Has gastado material?{' '}
            <button
              type="button"
              onClick={() => onPanel('material')}
              className="text-accent underline-offset-4 hover:underline"
            >
              Apúntalo antes de cerrar
            </button>
            .
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            {/* «Cerrar la incidencia» y no «Resolver»: la tecla que abre este
                panel se llama así y está tres centímetros más arriba, a la
                vista. Dos botones con la misma palabra en la misma pantalla, uno
                de los cuales guarda y el otro no, es la forma más barata de que
                alguien pulse el que no era. */}
            <button
              type="submit"
              disabled={guardando || !resolucion}
              className="key key-accent min-h-11 px-3 text-sm"
            >
              {guardando ? 'Guardando…' : 'Cerrar la incidencia'}
            </button>
            <button
              type="button"
              onClick={() => onPanel(null)}
              className="key key-quiet min-h-11 px-3 text-sm"
            >
              Cancelar
            </button>
          </div>

          {!resolucion && (
            <p className="mt-2 text-xs text-muted">
              Elige un motivo, o escribe el detalle. Sin eso, el histórico dice que se
              cerró y no dice qué se hizo.
            </p>
          )}
        </form>
      )}
    </div>
  )
}
