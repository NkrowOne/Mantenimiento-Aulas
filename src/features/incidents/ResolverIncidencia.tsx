/**
 * Cerrar una avería diciendo qué se hizo, y opcionalmente enseñándolo.
 *
 * Antes de esto, resolver era un botón que ponía la incidencia en verde y no
 * preguntaba nada. Dos consecuencias, las dos visibles en el histórico de
 * cualquier sala:
 *
 *  - **La sala no se entera de nada.** La línea de tiempo dice «Resuelta:
 *    Proyector: no da imagen» y ni una palabra sobre qué se hizo. Cuando ese
 *    mismo proyector vuelva a fallar en abril, saber que en marzo se le cambió
 *    la lámpara es la diferencia entre una avería nueva y una reincidencia. El
 *    Excel del que se viene sí lo apuntaba —276 de las 281 cerradas del
 *    histórico traen su frase—, así que no pedirla era perder por el camino
 *    algo que ya se hacía. Y el informe la pinta: cada cierre sale en el
 *    registro del periodo con su resolución debajo.
 *  - **Se cerraba lejos del aula.** El botón vivía en una lista de 283 filas,
 *    o sea en un escritorio; quien lo arregló estaba en el aula y muchas veces
 *    sin cobertura. Este formulario se abre también desde la ficha de la sala,
 *    con el aparato delante, y lo escrito viaja por la cola como todo lo demás.
 *
 * **Lo único obligatorio es la explicación.** Ni la foto ni el material lo son,
 * y ese reparto es deliberado: la frase la puede escribir cualquiera en diez
 * segundos y sirve para siempre; la foto depende de que haya algo que enseñar
 * —una regleta nueva se ve, un ajuste de la matriz de vídeo no— y muchas averías
 * se arreglan sin gastar nada. Exigir cualquiera de las dos convertiría el
 * cierre en un trámite que se esquiva dejando la incidencia abierta, que es
 * exactamente lo que esto viene a evitar.
 *
 * La foto se guarda al elegirla, no al enviar el formulario: es de la
 * incidencia, no de este formulario, y así el error —el HEIC de iOS, sobre
 * todo— se ve en el momento en que se puede arreglar. Si el cierre se cancela,
 * la foto se queda con su incidencia, que es donde tiene sentido.
 */

import { useId, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { v7 as uuidv7 } from 'uuid'
import { db, enqueue } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { flush } from '@/sync/outbox'
import { TiraDeFotos } from '@/components/Fotos'
import { MaterialUsado } from './MaterialUsado'
import { PHOTO_ACCEPT, capturePhoto } from '@/lib/photos'
import { cierreDeIncidencia, incidenciaCerrada, problemaDeExplicacion } from '@/domain/resolucion'
import { INCIDENT_KIND_LABELS, type IncidentKind } from '@/domain/types'

export interface IncidenciaQueSeCierra {
  id: string
  title: string | null
  kind: IncidentKind
}

export function ResolverIncidencia({
  incidencia,
  equipo,
  roomId,
  onCerrada,
  onCancelar,
}: {
  incidencia: IncidenciaQueSeCierra
  /**
   * De qué aparato habla, si se sabe: «Proyector», «Pantalla 2».
   *
   * Es lo que contesta a «¿cuál de las tres he arreglado?» en una sala con
   * varias abiertas. Va en la cabecera del formulario y no solo en la fila que
   * se pulsó: entre pulsar y escribir hay un teclado abriéndose y media
   * pantalla desplazándose, y la respuesta tiene que seguir a la vista.
   */
  equipo: string | null
  /**
   * Dónde se ha gastado el material, si se sabe.
   *
   * Va aquí y no dentro del apunte porque el almacén sabe cuánto queda y no
   * dónde fue, y esa es justo la pregunta que se hace después: cuánto material
   * se lleva un edificio. Nulo en las 118 incidencias del histórico que se
   * importaron sin sala identificada.
   */
  roomId: string | null
  onCerrada: () => void
  onCancelar: () => void
}): React.ReactElement {
  const ayudaId = useId()
  const [texto, setTexto] = useState('')
  /** Se enseña al intentar enviar, no mientras se escribe: regañar por teclear
      despacio es la forma más rápida de que nadie termine una frase. */
  const [tocado, setTocado] = useState(false)
  const [fotoError, setFotoError] = useState<string | null>(null)
  const [guardandoFoto, setGuardandoFoto] = useState(false)
  /* Si el apunte de material está abierto. Cerrado de partida: la mayoría de las
     averías se arreglan sin gastar nada, y quien sí ha gastado se acuerda. */
  const [material, setMaterial] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const problema = problemaDeExplicacion(texto)

  async function elegirFoto(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0]
    if (!file) return
    setFotoError(null)

    // Comprimir varios megapíxeles tarda. Sin esta señal el botón se queda mudo
    // y se vuelve a pulsar pensando que no cogió la foto.
    setGuardandoFoto(true)
    const resultado = await capturePhoto(file, 'incident', incidencia.id)
    setGuardandoFoto(false)

    if (!resultado.ok) setFotoError(resultado.error ?? 'No se pudo guardar la foto.')
    if (fileInput.current) fileInput.current.value = ''
  }

  /*
   * El cierre, **por la cola**.
   *
   * Se escribe en el espejo y se encola; sube en cuanto haya red, cuenta en la
   * lámpara de la cabecera mientras espera y el reenvío no duplica nada — el id
   * nace con la pulsación y la tabla de cierres ignora lo repetido.
   *
   * Y no es un UPDATE contra `incidents`: el servidor no se lo permite a un
   * técnico y un UPDATE reintentado obliga a preguntarse si el primero llegó.
   * Es una fila nueva en `incident_resolutions`, y allí un disparador cierra la
   * incidencia con esta misma explicación.
   */
  const cerrar = useMutation({
    mutationFn: async () => {
      /*
       * La sesión, del almacén local y no de la red: `getSession()` no sale a
       * preguntar, y esto tiene que funcionar en un sótano. Sin ella no se
       * puede firmar, y el servidor rechaza un cierre sin firma — mejor decirlo
       * aquí que dejarlo rebotando en la cola.
       */
      const { data } = await supabase.auth.getSession()
      const autor = data.session?.user.id ?? null
      if (autor === null) {
        throw new Error('Esta sesión todavía no está lista. Vuelve a entrar con tu PIN.')
      }

      const cierre = cierreDeIncidencia({
        incidenciaId: incidencia.id,
        explicacion: texto,
        autor,
        ahora: new Date().toISOString(),
        nuevoId: () => uuidv7(),
      })

      /*
       * El espejo, si esta incidencia está en él.
       *
       * Solo se espejan las que no están resueltas, así que la que se acaba de
       * cerrar tiene que quedar cerrada aquí también: es lo que la saca de la
       * lista de la sala en el acto, sin esperar a la red. Y puede no estar —la
       * pestaña de Incidencias lee del servidor y alcanza cosas que este
       * dispositivo nunca descargó—, en cuyo caso no hay nada que corregir.
       */
      const local = await db.incidents.get(incidencia.id)
      if (local) await db.incidents.put(incidenciaCerrada(local, cierre))

      await enqueue('incident_resolution', cierre.id, cierre)
      void flush()
    },
    onSuccess: onCerrada,
  })

  const etiqueta = INCIDENT_KIND_LABELS[incidencia.kind].toLowerCase()

  return (
    <form
      className="mt-3 rounded-ctl border border-line bg-raised p-3"
      onSubmit={(e) => {
        e.preventDefault()
        setTocado(true)
        if (problema === null) cerrar.mutate()
      }}
    >
      <p className="eyebrow">Resolver {etiqueta}</p>
      <p className="mt-1 text-sm font-medium">
        {equipo && <span className="text-accent">{equipo} · </span>}
        {incidencia.title ?? '(sin describir)'}
      </p>

      <label className="mt-3 block text-sm">
        <span className="text-muted">Qué se ha hecho</span>
        {/*
          Sin `required`: la validación es la de `domain` y el mensaje es el
          nuestro. El del navegador llega en el idioma del dispositivo y solo
          sabe decir «rellena este campo», que es la mitad de la regla —lo que
          falla casi siempre no es el hueco vacío, es el «arreglado».
        */}
        <textarea
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          rows={3}
          aria-invalid={tocado && problema !== null}
          aria-describedby={ayudaId}
          placeholder="Se ha cambiado el cable HDMI de la mesa; el proyector ya da imagen."
          className="mt-1 w-full rounded-ctl border border-line bg-surface p-3 text-sm"
        />
      </label>

      {/* La regla, dicha antes de incumplirla. Y el aviso solo después de
          intentar enviar: el mensaje mientras se escribe es un regaño por
          teclear. */}
      {tocado && problema !== null ? (
        <p id={ayudaId} role="alert" className="mt-1 text-sm text-crit">
          {problema}
        </p>
      ) : (
        <p id={ayudaId} className="mt-1 text-xs leading-relaxed text-muted">
          Obligatorio: lo leerá quien atienda la próxima avería de esta sala, y decide si es la
          misma o es otra.
        </p>
      )}

      <input
        ref={fileInput}
        type="file"
        accept={PHOTO_ACCEPT}
        onChange={(e) => void elegirFoto(e)}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        disabled={guardandoFoto}
        className="key mt-3 flex h-touch w-full items-center justify-center gap-2 border-2 border-dashed border-line bg-transparent text-muted shadow-none"
      >
        <span aria-hidden className="text-lg leading-none">
          +
        </span>
        {guardandoFoto ? 'Procesando la foto…' : 'Añadir foto (opcional)'}
      </button>

      {fotoError && <p className="mt-2 text-sm text-crit">{fotoError}</p>}

      {/* Y se enseña lo que se ha hecho, con su sello de «sin subir» mientras
          espere cobertura. Una foto que se pide y no se devuelve deja de
          hacerse a las tres semanas. */}
      <TiraDeFotos entityType="incident" ids={[incidencia.id]} />

      {/*
        El material, aquí dentro y no en otro botón.

        Es el apunte que nunca llegaba. Vivía detrás de un botón «Material»
        aparte, en la pestaña de Incidencias, y con el aviso escrito en el propio
        código: «se apunta antes de cerrar, porque después nadie vuelve a la
        incidencia». Pues nadie lo apuntaba antes tampoco — el momento en que
        alguien se acuerda del cable que ha puesto es exactamente este, contando
        qué ha hecho, y no un toque anterior en otra pantalla.

        Cada apunte sale del almacén en cuanto se pulsa «Apuntar»: es un
        movimiento de consumo con su incidencia y su sala, y resta del inventario
        igual que cualquier otra salida. Por eso no espera al cierre — el
        material se gastó aunque la avería se quede sin cerrar hoy.

        **Y va PLEGADO**, que es lo único que hace verdad la palabra «opcional».
        Muchas averías se arreglan sin gastar nada —un cable suelto, una entrada
        mal elegida, un reinicio— y en esas el buscador de artículos es un paso
        más entre la frase y el botón de cerrar. Un formulario en el que hay que
        pasar por encima de un campo para llegar al final enseña que ese campo
        hay que rellenarlo. Cerrar no espera a nada de aquí: el botón de abajo
        solo mira la explicación.
      */}
      {material ? (
        <div className="mt-3">
          <p className="eyebrow">Material usado</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Lo que apuntes sale del almacén y queda cargado a esta sala. Puedes cerrar la avería
            sin apuntar nada.
          </p>
          <MaterialUsado incidentId={incidencia.id} roomId={roomId} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setMaterial(true)}
          className="key key-quiet mt-3 min-h-11 w-full px-3 text-sm"
        >
          ¿Has usado material? Apúntalo
        </button>
      )}

      {cerrar.isError && (
        <p role="alert" className="mt-2 text-sm text-crit">
          {cerrar.error instanceof Error ? cerrar.error.message : 'No se ha podido resolver.'}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={cerrar.isPending}
          className="key key-accent min-h-11 flex-1 px-3 text-sm"
        >
          {cerrar.isPending ? 'Guardando…' : 'Marcar como resuelta'}
        </button>
        <button
          type="button"
          onClick={onCancelar}
          className="key key-quiet min-h-11 px-3 text-sm"
        >
          Cancelar
        </button>
      </div>
    </form>
  )
}
