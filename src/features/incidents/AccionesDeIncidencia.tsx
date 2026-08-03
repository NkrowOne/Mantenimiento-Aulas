/**
 * Lo que se puede hacer con una incidencia, esté donde esté.
 *
 * Vive aparte porque se usa en dos sitios y tiene que ser el mismo gesto en los
 * dos: la pestaña de Incidencias —la cola de trabajo, que se despacha sentado— y
 * la ficha de la sala, que es donde se está justo después de arreglar el
 * aparato. Ese segundo sitio es el que faltaba: hasta hace nada, para cerrar el
 * parte del proyector que acabas de arreglar había que salir del aula, cambiar
 * de pestaña y encontrarlo entre cuarenta.
 *
 * CUATRO DECISIONES:
 *
 *  - **Cierra quien lo arregla, y para cerrar dice qué ha hecho.** `resolution`
 *    era una columna que la aplicación nunca rellenaba: el histórico de la sala
 *    decía «Resuelta: Proyector: no da imagen» —la avería otra vez, no lo que se
 *    hizo con ella—. Ahora el campo es obligatorio y es lo que sustituye a la
 *    firma del supervisor.
 *  - **Coger una incidencia la pone a tu nombre.** «En curso» sin dueño es dos
 *    técnicos subiendo al mismo aula el mismo día.
 *  - **La pieza sale del almacén aquí mismo.** El motivo pregunta cuál, se elige
 *    del catálogo, se descuenta apuntada a esta incidencia y su nombre se
 *    escribe en la resolución. Antes eran dos gestos detrás de dos botones y el
 *    segundo se hacía la mitad de las veces.
 *  - **Y la foto de la reparación.** La fontanería estaba entera desde el
 *    principio —`capturePhoto` acepta `'incident'`, la cola lo transporta, el
 *    bucket guarda en `incident/<id>/`— y ninguna pantalla la llamaba nunca. La
 *    foto del después es la única prueba de que el cable nuevo está puesto.
 */

import { useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { PHOTO_ACCEPT, capturePhoto } from '@/lib/photos'
import { FotosDeRevision } from '@/features/inspection/FotosDeRevision'
import { MaterialUsado } from './MaterialUsado'
import {
  MOTIVOS_CON_MATERIAL,
  MOTIVOS_DE_CIERRE,
  avanzarIncidencia,
  conLaPieza,
  resolucionSuficiente,
  type AccionDeIncidencia,
} from './acciones'
import type { Incident, IncidentKind, IncidentState } from '@/domain/types'

export type PanelDeIncidencia = 'material' | 'cerrar'

interface Props {
  incident: {
    id: string
    state: IncidentState
    kind: IncidentKind
    room_id: string | null
    assigned_to?: string | null
  }
  userId: string | null
  /** Cómo se llama quien lleva una incidencia. Del espejo, así que va sin red. */
  nombreDe?: (userId: string) => string | null
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
  nombreDe,
  panel,
  onPanel,
  onHecho,
}: Props): React.ReactElement {
  const [motivo, setMotivo] = useState<string | null>(null)
  const [detalle, setDetalle] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [hecho, setHecho] = useState<string | null>(null)
  const [fallo, setFallo] = useState<string | null>(null)
  const [subiendoFoto, setSubiendoFoto] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  /*
   * Las fotos de esta incidencia, del espejo.
   *
   * `capturePhoto` deja el adjunto en local además de encolar la foto, así que
   * el recuento sobrevive a la subida y a recargar — y se lee sin cobertura,
   * que es donde se hace.
   */
  const fotos =
    useLiveQuery(
      () =>
        db.attachments.where('[entity_type+entity_id]').equals(['incident', incident.id]).count(),
      [incident.id],
    ) ?? 0

  const mio = incident.assigned_to != null && incident.assigned_to === userId
  const deOtro = incident.assigned_to != null && incident.assigned_to !== userId
  const quienLaLleva = incident.assigned_to ? (nombreDe?.(incident.assigned_to) ?? null) : null

  async function avanzar(accion: AccionDeIncidencia, texto?: string): Promise<void> {
    setGuardando(true)
    setFallo(null)
    try {
      await avanzarIncidencia({ id: incident.id, accion, texto, userId })
      setHecho(
        accion === 'cerrar'
          ? 'Resuelta. Sube en cuanto haya cobertura.'
          : accion === 'coger'
            ? 'La llevas tú. Sube en cuanto haya cobertura.'
            : 'Suelta. Vuelve a la cola de todos.',
      )
      onPanel(null)
      onHecho?.()
    } catch (e) {
      setFallo(e instanceof Error ? e.message : 'No se ha podido guardar el cambio.')
    } finally {
      setGuardando(false)
    }
  }

  async function alElegirFoto(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0]
    if (!file) return
    setFallo(null)
    // Comprimir varios megapíxeles tarda. Sin esta señal el botón se queda mudo
    // y se vuelve a pulsar pensando que no ha cogido la foto.
    setSubiendoFoto(true)
    const result = await capturePhoto(file, 'incident', incident.id)
    setSubiendoFoto(false)
    if (!result.ok) setFallo(result.error ?? 'No se pudo guardar la foto.')
    if (fileInput.current) fileInput.current.value = ''
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
  const motivos = MOTIVOS_DE_CIERRE[incident.kind] ?? MOTIVOS_DE_CIERRE.incidencia

  return (
    <div className="min-w-0">
      {/*
        Quién la lleva NO se pinta aquí.

        Lo dicen las dos pantallas que montan esto, en la línea de datos de la
        fila, junto a la sala y a los días que lleva abierta — que es donde se
        lee al recorrer la lista. Repetirlo encima de los botones lo decía dos
        veces seguidas con dos redacciones distintas. Aquí solo aparece donde
        cambia una decisión: dentro del panel de cierre.
      */}
      <div className="flex flex-wrap gap-2">
        {incident.state !== 'resuelta' && !deOtro && !mio && (
          <button
            type="button"
            onClick={() => void avanzar('coger')}
            disabled={guardando}
            className="key key-quiet min-h-11 px-3 text-xs"
          >
            La cojo yo
          </button>
        )}

        {/* Soltarla es deshacer lo tuyo, así que solo aparece si es tuya. */}
        {mio && incident.state !== 'resuelta' && (
          <button
            type="button"
            onClick={() => void avanzar('soltar')}
            disabled={guardando}
            className="key key-quiet min-h-11 px-3 text-xs"
          >
            Soltar
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
            void avanzar('cerrar', resolucion)
          }}
        >
          {/* Cerrar el parte de otro se puede —puede estar de baja— pero no en
              silencio: quien lo lleva se entera por el histórico y no por que su
              lista haya menguado. */}
          {deOtro && (
            <p className="mb-3 text-xs leading-relaxed text-warn">
              Esta la lleva {quienLaLleva ?? 'otra persona'}. Puedes cerrarla igual, pero quedará
              a tu nombre.
            </p>
          )}

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
            {motivos.map((m) => (
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
            El motivo que pregunta CUÁL, y la pregunta se contesta aquí.

            Era la costura que faltaba. El apunte de material vivía detrás de otro
            botón, en otro panel, y nada ataba las dos cosas: se cerraba «Pieza
            sustituida» sin decir qué pieza, el almacén no se enteraba de que
            faltaba una, y el histórico decía que se cambió algo sin decir el qué.

            Elegir la pieza hace dos cosas a la vez: descuenta la unidad del
            almacén apuntándola a ESTA incidencia y a esta sala —así el gasto tiene
            destino, que es lo que permite responder cuánto material se llevó un
            edificio— y escribe su nombre en la resolución, que es lo que leerá
            quien se encuentre el mismo aparato dentro de tres meses.
          */}
          {motivo !== null && MOTIVOS_CON_MATERIAL.has(motivo) ? (
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

          {/*
            La foto del después.

            Opcional a propósito: exigirla convertiría cada cierre en una
            negociación con la cámara, y lo que hay que conseguir es que el parte
            se cierre. Pero está aquí, en el momento en que el técnico tiene el
            aparato arreglado delante — el único momento en que esa foto existe.
          */}
          <input
            ref={fileInput}
            type="file"
            accept={PHOTO_ACCEPT}
            onChange={(e) => void alElegirFoto(e)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={subiendoFoto}
            className="key mt-3 flex min-h-11 w-full items-center justify-center gap-2 border-2 border-dashed border-line bg-transparent text-xs text-muted shadow-none"
          >
            <span aria-hidden className="text-base leading-none">
              +
            </span>
            {subiendoFoto
              ? 'Procesando la foto…'
              : fotos > 0
                ? `${fotos} foto${fotos === 1 ? '' : 's'} de la reparación · añadir otra`
                : 'Foto de la reparación (opcional)'}
          </button>

          {/* Y se enseñan. Pedir una foto y no volver a enseñarla nunca es la
              forma más rápida de que se deje de hacer — está escrito en la
              cabecera de este mismo componente, a propósito de las de revisión.
              La tira incluye las que aún esperan en el dispositivo. */}
          {fotos > 0 && (
            <div className="mt-2">
              <FotosDeRevision ids={[incident.id]} entidad="incident" />
            </div>
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

          {/* La razón, no la regla: «campo obligatorio» no convence a nadie de
              escribir una frase útil. Y con las palabras de lo que se cierra —una
              solicitud no tiene un aparato que se vuelva a encontrar. */}
          {!puedeCerrar && (
            <p className="mt-2 text-xs leading-relaxed text-muted">
              {incident.kind === 'incidencia'
                ? 'Escribe qué has hecho para poder cerrarla. Es lo que leerá quien se encuentre este mismo aparato dentro de tres meses — y es lo que sustituye a que la cierre un supervisor.'
                : 'Escribe qué se ha hecho para poder cerrarla. Es lo único que quedará de este trabajo en el histórico del aula.'}
            </p>
          )}
        </form>
      )}
    </div>
  )
}

/**
 * Volver a abrir un parte cerrado.
 *
 * Va aparte de las acciones de arriba porque es lo contrario: aquéllas empujan
 * el trabajo hacia adelante y esta lo devuelve. Se pide el motivo por lo mismo
 * que se pide para cerrar —un cambio de estado sin explicación no le sirve a
 * quien lo herede— y porque lo que se cerró no se borra: baja a la descripción,
 * junto a lo que alguien dijo que había hecho.
 */
export function ReabrirIncidencia({
  incident,
  userId,
  onHecho,
}: {
  incident: Incident
  userId: string | null
  onHecho?: () => void
}): React.ReactElement {
  const [abierto, setAbierto] = useState(false)
  const [motivo, setMotivo] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [fallo, setFallo] = useState<string | null>(null)

  if (!abierto) {
    return (
      <button
        type="button"
        onClick={() => setAbierto(true)}
        className="key key-quiet min-h-11 px-3 text-xs"
      >
        Reabrir
      </button>
    )
  }

  return (
    <form
      className="w-full rounded-ctl border border-line bg-raised p-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!resolucionSuficiente(motivo)) return
        setGuardando(true)
        setFallo(null)
        void avanzarIncidencia({
          id: incident.id,
          accion: 'reabrir',
          texto: motivo,
          userId,
          fila: incident,
        })
          .then(() => {
            setAbierto(false)
            setMotivo('')
            onHecho?.()
          })
          .catch((err: unknown) =>
            setFallo(err instanceof Error ? err.message : 'No se ha podido reabrir.'),
          )
          .finally(() => setGuardando(false))
      }}
    >
      <label className="block">
        <span className="eyebrow">¿Por qué se vuelve a ella?</span>
        <textarea
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          rows={2}
          enterKeyHint="done"
          placeholder="El aula vuelve a avisar: se apaga a los diez minutos"
          className="mt-2 w-full rounded-ctl border border-line bg-surface p-2 text-sm text-ink"
        />
      </label>

      <p className="mt-2 text-xs leading-relaxed text-muted">
        Lo que se dijo al cerrarla no se pierde: se guarda en la descripción, que es donde
        lo va a leer quien la coja.
      </p>

      {fallo && (
        <p role="alert" className="mt-2 text-xs text-crit">
          {fallo}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={guardando || !resolucionSuficiente(motivo)}
          className="key key-accent min-h-11 px-3 text-sm"
        >
          {guardando ? 'Guardando…' : 'Reabrir'}
        </button>
        <button
          type="button"
          onClick={() => setAbierto(false)}
          className="key key-quiet min-h-11 px-3 text-sm"
        >
          Cancelar
        </button>
      </div>
    </form>
  )
}
