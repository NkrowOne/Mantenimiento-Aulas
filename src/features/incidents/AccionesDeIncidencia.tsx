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
 *  - **Cierra quien lo arregla, y para cerrar dice qué ha hecho.** Antes cerraba
 *    un supervisor que no había visto la reparación, y `resolution` era una
 *    columna que la aplicación nunca rellenaba: el histórico de la sala decía
 *    «Resuelta: Proyector: no da imagen» —la avería otra vez, no lo que se hizo
 *    con ella—. Ahora el campo es obligatorio y es lo que sustituye a la firma
 *    del supervisor. Los motivos van como teclas porque esto se pulsa de pie:
 *    encabezan la frase y clasifican, pero no la escriben.
 *  - **El material, antes de cerrar.** Después nadie vuelve a la incidencia, y
 *    ese era el dato que no llegaba nunca al almacén. Así que el recordatorio va
 *    dentro del panel de cierre, con el botón al lado, y no en una frase suelta
 *    de otra pantalla.
 */

import { useState } from 'react'
import { MaterialUsado } from './MaterialUsado'
import {
  MOTIVOS_DE_CIERRE,
  PIEZA_SUSTITUIDA,
  avanzarIncidencia,
  conLaPieza,
  resolucionSuficiente,
} from './acciones'
import type { IncidentState } from '@/domain/types'

export type PanelDeIncidencia = 'material' | 'cerrar'

interface Props {
  incident: { id: string; state: IncidentState; room_id: string | null }
  userId: string | null
  /**
   * Qué panel tiene abierto esta fila, o nulo.
   *
   * Lo lleva la lista y no cada fila a propósito: se está despachando UNA
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

  /*
   * La resolución es lo escrito, con el motivo delante si se ha elegido uno.
   *
   * Lo que decide si se puede cerrar es el TEXTO, no el motivo: «Pieza
   * sustituida» a secas no dice qué pieza ni en qué aparato, y dentro de tres
   * meses, cuando el mismo proyector vuelva a fallar, es justo lo que hará falta
   * saber.
   */
  const puedeCerrar = resolucionSuficiente(detalle)
  const resolucion = [motivo, detalle.trim()].filter(Boolean).join(' — ')

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap gap-2">
        {incident.state === 'abierta' && (
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

        <button
          type="button"
          aria-expanded={panel === 'cerrar'}
          onClick={() => onPanel(panel === 'cerrar' ? null : 'cerrar')}
          className="key key-accent min-h-11 px-3 text-xs"
        >
          Resolver
        </button>
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
            if (!puedeCerrar) return
            void avanzar('resuelta', resolucion)
          }}
        >
          <label className="block">
            <span className="eyebrow">¿Qué has hecho?</span>
            <textarea
              value={detalle}
              onChange={(e) => setDetalle(e.target.value)}
              rows={2}
              enterKeyHint="done"
              placeholder="Cambiada la lámpara (S/N 4471) y reiniciada la matriz"
              className="mt-2 w-full rounded-ctl border border-line bg-surface p-2 text-sm text-ink"
            />
          </label>

          {/* Debajo del campo y no encima: son un atajo para empezar la frase,
              no la respuesta. Puestos delante se leerían como el formulario
              entero y el campo de texto pasaría por opcional, que es justo lo
              que este cierre no puede permitirse. */}
          <p className="eyebrow mt-3">Y de qué tipo</p>
          <div className="mt-2 flex flex-wrap gap-2">
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

          {/*
            «Pieza sustituida» pregunta CUÁL, y la pregunta se contesta aquí.

            Era la costura que faltaba. El apunte de material vivía detrás de otro
            botón, en otro panel, y nada ataba las dos cosas: se cerraba «Pieza
            sustituida» sin decir qué pieza, el almacén no se enteraba de que
            faltaba una, y el histórico decía que se cambió algo sin decir el qué.
            Los dos datos son el mismo gesto y ahora se piden juntos.

            Elegir la pieza hace dos cosas a la vez: descuenta la unidad del
            almacén apuntándola a ESTA incidencia y a esta sala —así el gasto tiene
            destino, que es lo que permite responder cuánto material se llevó un
            edificio— y escribe su nombre en la resolución, que es lo que leerá
            quien se encuentre el mismo aparato dentro de tres meses.
          */}
          {motivo === PIEZA_SUSTITUIDA ? (
            <div className="mt-3 rounded-ctl border border-line bg-surface p-3">
              <p className="eyebrow">¿Qué pieza?</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Sale del almacén, queda apuntada en esta incidencia y se escribe arriba.
              </p>
              <MaterialUsado
                incidentId={incident.id}
                roomId={incident.room_id}
                variante="incrustado"
                onApuntado={({ nombre, qty }) => setDetalle((t) => conLaPieza(t, nombre, qty))}
              />
            </div>
          ) : (
            /* Para el resto de motivos sigue habiendo material que apuntar —un
               cable en un «Reparado»— y sigue siendo aquí: después de cerrar
               nadie vuelve a la incidencia, y ese era el dato que no llegaba
               nunca al almacén. */
            <p className="mt-3 text-xs leading-relaxed text-muted">
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
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {/* «Cerrar la incidencia» y no «Resolver»: la tecla que abre este
                panel se llama así y está tres centímetros más arriba, a la
                vista. Dos botones con la misma palabra en la misma pantalla, uno
                de los cuales guarda y el otro no, es la forma más barata de que
                alguien pulse el que no era. */}
            <button
              type="submit"
              disabled={guardando || !puedeCerrar}
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

          {!puedeCerrar && (
            <p className="mt-2 text-xs leading-relaxed text-muted">
              Escribe qué has hecho para poder cerrarla. Es lo que leerá quien se
              encuentre este mismo aparato dentro de tres meses — y es lo que sustituye
              a que la cierre un supervisor.
            </p>
          )}
        </form>
      )}
    </div>
  )
}
