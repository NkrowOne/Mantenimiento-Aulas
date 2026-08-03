/**
 * Ficha de sala.
 *
 * La pantalla del prototipo que nunca llegó a construirse, y la que sostiene dos
 * piezas que faltaban.
 *
 * **Una — registrar sin que nada haya fallado.** Toda la aplicación asumía que un
 * registro nace de una revisión que sale mal. Pero la petición de instalar una
 * cámara no es una revisión que falla: es alguien que pasa por delante y ve algo.
 * Por eso el botón está aquí y está siempre disponible, no colgando de un bloque
 * en FALLA. Y por eso **basta la sala para guardar**: nada obliga a teclear de
 * pie en un pasillo. Lo aplazado aparece sin completar en Incidencias, que es
 * la contrapartida honesta de permitir aplazar — y no una pestaña propia: un
 * destino permanente en la barra para algo que casi siempre está vacío enseña a
 * no pulsarlo.
 *
 * **Dos — leer las revisiones anteriores, enteras.** Lo que se apuntaba en cada
 * visita —el resultado de cada aparato, las medidas, la observación de debajo de
 * las fotos, las fotos mismas— se guardaba y no se pintaba en ningún sitio:
 * exactamente el mismo destino que la columna de texto libre del Excel de la que
 * se venía huyendo. Ahora se lee aquí, que es donde alguien pregunta «qué se ha
 * dicho de esta aula». Y no en la pestaña de Incidencias: eso es la lista de lo
 * que hay que arreglar, y una nota de seguimiento no es trabajo pendiente.
 *
 * La observación vive dentro de su revisión y no en una sección aparte, y ese
 * cambio es deliberado: se escribió el mismo día que se comprobaron nueve cosas,
 * y leerla al lado de lo que se comprobó dice bastante más que leerla suelta. Una
 * sola puerta, además, en vez de dos listas que hablan de lo mismo.
 *
 * **Tres — corregir una revisión sin fabricar otra.** Una revisión cerrada es
 * inmutable, y con razón. Pero hasta ahora eso significaba que un error solo se
 * podía arreglar revisando otra vez: veinte revisiones nuevas que no son visitas
 * nuevas, cada una moviendo la fecha de «última revisión» y contando en el
 * informe. Desde la lista de revisiones se corrige la que salió mal, y la
 * corrección la reemplaza en todo lo que se cuenta sin borrarla.
 *
 * Lo que sí es trabajo pendiente entra por su camino. Un equipo que falla se
 * marca en la revisión, en su propia fila, y eso abre una incidencia. El
 * formulario de aquí es para lo que no cabe en una revisión —una avería que se ve
 * de paso, un trabajo que se pide— y por eso ya no ofrece «observación»: tenerla
 * aquí era una segunda puerta para lo mismo, y las dos puertas se llenaban a
 * medias.
 */

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { v7 as uuidv7 } from 'uuid'
import { db, enqueue } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { flush } from '@/sync/outbox'
import { RoomPlate } from '@/components/RoomPlate'
import { DoorPlate } from '@/components/DoorPlate'
import { RevisionesAnteriores } from '@/features/inspection/RevisionesAnteriores'
import { LineaTiempo } from '@/features/history/LineaTiempo'
import {
  AccionesDeIncidencia,
  type PanelDeIncidencia,
} from '@/features/incidents/AccionesDeIncidencia'
import type { Correccion } from '@/features/inspection/useInspection'
import { displayRoomCode } from '@/domain/normalize'
import { fechaCorta } from '@/domain/fechas'
import { esAveriaViva } from './averias'
import type { EventoSala } from '@/domain/historial'
import {
  INCIDENT_KIND_LABELS,
  STALE_INCIDENT_DAYS,
  type Incident,
  type IncidentKind,
  type Room,
} from '@/domain/types'

interface Fiabilidad {
  score: number
  incidencias: number
  observaciones: number
  solicitudes: number
  revisiones: number
  hay_datos: boolean
}

interface Reincidencia {
  item: string
  veces: number
  desde: string
  hasta: string
}

/**
 * Lo que se puede registrar a mano desde la ficha.
 *
 * Sin `observacion`, y es el cambio de fondo de esta pantalla. Una observación se
 * escribe en la revisión, debajo de las fotos, con el aula delante; ofrecerla
 * también aquí era una segunda puerta al mismo dato, y con dos puertas ninguna de
 * las dos se llena entera. Este formulario queda para lo que de verdad hay que
 * atender: una avería vista de paso y un trabajo que se pide.
 *
 * El tipo `IncidentKind` sigue teniendo los tres: hay observaciones importadas
 * del Excel y borradores de antes de este cambio, y quitarlo del vocabulario
 * dejaría esas filas sin nombre.
 */
const TIPOS_REGISTRABLES: IncidentKind[] = ['incidencia', 'solicitud']

/**
 * En qué orden se despachan las incidencias de un aula.
 *
 * Las averías antes que las solicitudes —una cámara por instalar no compite con
 * un proyector roto—, dentro de las averías primero lo que impide dar clase, y a
 * igual gravedad lo más viejo. Es el orden en que las miraría alguien que entra a
 * arreglar, y el único que no necesita explicación al lado.
 *
 * La gravedad de una solicitud no entra en el orden a propósito: la columna es
 * obligatoria en la tabla, así que «Molesta» aplicado a «instalar una cámara» es
 * un valor por defecto disfrazado de dato. Por eso tampoco se pinta.
 */
const GRAVEDAD_ORDEN: Record<string, number> = { alta: 3, media: 2, baja: 1 }

/** Lo que se lee de una gravedad, con las palabras que se eligen en el aula. */
const GRAVEDAD_TEXTO: Record<string, string> = {
  alta: 'Impide la clase',
  media: 'Molesta',
  baja: 'Leve',
}

/** Cuántos días lleva abierta. Es lo que decide qué se atiende antes. */
function diasAbierta(desde: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(desde).getTime()) / 86_400_000))
}

interface Props {
  room: Room
  buildingName: string
  zoneName: string
  userId: string | null
  /**
   * A qué se ha venido, cuando no se ha venido a revisar.
   *
   * Se llega aquí desde una incidencia o desde una línea del historial, y en ese
   * caso la ficha entera es el rodeo: lo que se buscaba está en el bloque de
   * incidencias abiertas, a media pantalla de distancia. Con esto, la pantalla
   * abre donde estaba la pregunta.
   */
  enfocar?: 'incidencias' | null
  onBack: () => void
  onRevisar: () => void
  /**
   * Abrir el formulario para corregir una revisión anterior.
   *
   * Es el mismo destino que `onRevisar` —la pantalla de revisión— y va por otro
   * camino a propósito: lleva consigo lo que dijo aquella visita, y de eso
   * depende que corregir no sea rellenarlo todo otra vez.
   */
  onCorregir: (correccion: Correccion) => void
  /** Ir a la hoja de placas del edificio, lista para imprimir. */
  onImprimir: () => void
}

export function RoomSheet({
  room,
  buildingName,
  zoneName,
  userId,
  enfocar,
  onBack,
  onRevisar,
  onCorregir,
  onImprimir,
}: Props): React.ReactElement {
  const qc = useQueryClient()
  const [abierto, setAbierto] = useState(false)
  const [kind, setKind] = useState<IncidentKind>('incidencia')
  const [texto, setTexto] = useState('')
  const [codigo, setCodigo] = useState('')
  const [guardado, setGuardado] = useState<string | null>(null)
  /* Qué incidencia de esta sala tiene un panel abierto. Una sola, igual que en
     la pestaña: se está despachando una avería, no seis. */
  const [enPanel, setEnPanel] = useState<{ id: string; panel: PanelDeIncidencia } | null>(null)

  /*
   * Las incidencias vivas de esta sala, del espejo local.
   *
   * Del espejo y no del servidor, y ahí está el cambio: la ficha se abre en un
   * sótano y esta es justo la lista que hace falta al llegar —qué queda por
   * arreglar aquí—. El espejo guarda todo lo que no está resuelto, así que la
   * respuesta ya estaba en el dispositivo; lo que faltaba era enseñarla. Hasta
   * ahora la única forma de saber qué tenía abierto un aula era el histórico, que
   * necesita conexión y mezcla las de hace tres años.
   */
  const abiertasAqui = useLiveQuery(
    async () => {
      const filas = await db.incidents.where('room_id').equals(room.id).toArray()
      /*
       * Y lo que este dispositivo acaba de cerrar sigue a la vista hasta que sube.
       *
       * Sin esto, resolver hace desaparecer la fila al instante y con ella la
       * única confirmación que hay: quedaría la duda de si se guardó o de si se
       * ha tocado la que no era. Se reconoce por su entrada en la cola.
       */
      const claves = (await db.outbox.toCollection().primaryKeys()) as string[]
      const sinSubir = new Set(
        claves.filter((k) => k.includes('#')).map((k) => k.slice(0, k.indexOf('#'))),
      )
      return filas
        .filter((i) => esAveriaViva(i) || (i.state === 'resuelta' && sinSubir.has(i.id)))
        .map((i) => ({ ...i, sinSubir: sinSubir.has(i.id) }))
        .sort((a, b) => {
          const averia = (i: Incident): number => (i.kind === 'incidencia' ? 0 : 1)
          const grave = (i: Incident): number =>
            i.kind === 'incidencia' ? (GRAVEDAD_ORDEN[i.severity] ?? 0) : 0
          return (
            averia(a) - averia(b) ||
            grave(b) - grave(a) ||
            a.opened_at.localeCompare(b.opened_at)
          )
        })
    },
    [room.id],
    [],
  )

  const sinCerrar = abiertasAqui.filter((i) => i.state !== 'resuelta').length

  /* Quién lleva cada una. Del espejo, que es lo que hace que esto se lea en un
     sótano igual que el resto de la sección. */
  const nombres = useLiveQuery(
    async () => new Map((await db.personal.toArray()).map((n) => [n.id, n.full_name])),
    [],
  )
  const nombreDe = (id: string): string | null => nombres?.get(id) ?? null

  /*
   * Y si se ha venido a por ellas, la pantalla abre ahí.
   *
   * `block: 'start'` con el desplazamiento suave desactivado si el sistema lo
   * pide: llegar de otra pestaña y que la pantalla se deslice sola es
   * desorientador para quien ha configurado justo lo contrario.
   */
  const incidenciasRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (enfocar !== 'incidencias') return
    const suave = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    incidenciasRef.current?.scrollIntoView({
      behavior: suave ? 'smooth' : 'auto',
      block: 'start',
    })
  }, [enfocar, room.id])

  // El inventario sale del espejo local: la ficha tiene que abrirse en un
  // sótano sin cobertura igual que la revisión.
  const equipos = useLiveQuery(async () => {
    const assets = await db.assets.where('room_id').equals(room.id).toArray()
    const tipos = new Map((await db.assetTypes.toArray()).map((t) => [t.id, t]))
    return assets
      .map((a) => ({ ...a, tipo: tipos.get(a.asset_type_id)?.name ?? 'Sin tipo' }))
      .sort((x, y) => x.tipo.localeCompare(y.tipo, 'es'))
  }, [room.id])

  const { data: fiabilidad } = useQuery({
    queryKey: ['room-reliability', room.id],
    queryFn: async (): Promise<Fiabilidad | null> => {
      const { data, error } = await supabase
        .from('room_reliability')
        .select('*')
        .eq('room_id', room.id)
        .maybeSingle()
      if (error) throw error
      return (data as Fiabilidad | null) ?? null
    },
  })

  const { data: reincidencias } = useQuery({
    queryKey: ['room-repeats', room.id],
    queryFn: async (): Promise<Reincidencia[]> => {
      const { data, error } = await supabase
        .from('room_repeat_offenders')
        .select('*')
        .eq('room_id', room.id)
        .order('veces', { ascending: false })
      if (error) throw error
      return (data ?? []) as Reincidencia[]
    },
  })

  const { data: historial, isError: historialFalla } = useQuery({
    queryKey: ['room-timeline', room.id],
    queryFn: async (): Promise<EventoSala[]> => {
      const { data, error } = await supabase
        .from('room_timeline')
        .select('*')
        .eq('room_id', room.id)
        .order('at', { ascending: false })
        .limit(30)
      if (error) throw error
      return (data ?? []) as EventoSala[]
    },
  })

  /*
   * Guardar el registro, **por la cola**.
   *
   * Nace como `borrador` cuando no hay título, y como `abierta` cuando sí lo
   * hay: la restricción de la base dice exactamente eso, y repetirla aquí evita
   * que el servidor rechace algo que la pantalla dejó escribir.
   *
   * El id se genera en el cliente (UUID v7), que es lo que permite que la fila
   * nazca con su identidad definitiva sin haber hablado con nadie.
   *
   * Y eso último era todo lo que estaba aprovechado: esto hacía un `insert`
   * directo contra Supabase, el único camino de escritura de la aplicación que no
   * pasaba por la cola. En un sótano el `fetch` lanza, la mutación falla y lo
   * escrito no queda en NINGUNA parte —ni en el espejo, ni en la cola, ni en el
   * contador de pendientes—: solo un párrafo rojo con «Load failed» y el texto
   * todavía en el cuadro, que se pierde al cambiar de sala. En la pantalla donde
   * la aplicación promete justo lo contrario, y para apuntar precisamente lo que
   * se ve de paso por un pasillo sin cobertura.
   *
   * Ahora se escribe en el espejo y se encola. Sube en cuanto haya red, cuenta en
   * la lámpara de la cabecera mientras espera, y el reenvío ya es idempotente
   * —'incident' está en `IGNORE_DUPLICATES`—. Aquí no hay clave ajena a una
   * revisión que ordenar: `opened_from_inspection_id` va nulo.
   */
  const registrar = useMutation({
    mutationFn: async () => {
      const titulo = texto.trim()
      const fila: Incident = {
        id: uuidv7(),
        room_id: room.id,
        asset_id: null,
        opened_from_inspection_id: null,
        check_key: null,
        external_ref: codigo.trim() || null,
        title: titulo || null,
        description: null,
        severity: 'media',
        state: titulo ? 'abierta' : 'borrador',
        kind,
        opened_at: new Date().toISOString(),
        opened_by: userId,
        resolved_at: null,
        resolved_by: null,
        resolution: null,
        assigned_to: null,
        assigned_at: null,
        source: 'app',
      }

      await db.incidents.put(fila)
      await enqueue('incident', fila.id, fila)
      void flush()

      return titulo.length > 0
    },
    onSuccess: (completo) => {
      setGuardado(
        completo
          ? `${INCIDENT_KIND_LABELS[kind]} registrada. Sube en cuanto haya cobertura.`
          : `Guardado sin describir. Aparecerá en Incidencias para que lo completes.`,
      )
      setTexto('')
      setCodigo('')
      setAbierto(false)
      void qc.invalidateQueries({ queryKey: ['room-timeline', room.id] })
      void qc.invalidateQueries({ queryKey: ['borradores'] })
    },
  })

  return (
    <div className="pb-4">
      <RoomPlate
        building={buildingName}
        zone={zoneName}
        title={room.name || displayRoomCode(room.code)}
        code={displayRoomCode(room.code)}
        onBack={onBack}
      />

      <div className="mx-auto max-w-2xl px-4 pb-10">
        {/*
          La placa, con su código escaneable.
          Va arriba del todo porque es lo que identifica la sala, y porque es lo
          que alguien viene a buscar cuando entra aquí desde el listado: «¿es
          esta?». El QR codifica el identificador interno, no el nombre, así que
          renombrar la sala no invalida las etiquetas ya atornilladas.
        */}
        {room.short_ref && (
          <section aria-labelledby="sec-placa" className="mt-6">
            <div className="section-head">
              <h2 id="sec-placa" className="eyebrow">Placa de puerta</h2>
            </div>
            <DoorPlate
              building={buildingName}
              zone={zoneName}
              title={room.name || displayRoomCode(room.code)}
              ref={room.short_ref}
              id={room.id}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onImprimir}
                className="key key-quiet min-h-11 px-3 text-sm"
              >
                Imprimir las placas del edificio
              </button>
            </div>
          </section>
        )}

        {/*
          El índice, y de qué está hecho.
          Un número solo invita a discutirlo; un número con su recuento al lado
          se puede comprobar. Y con la base recién arrancada dice honestamente
          que no sabe lo suficiente, en vez de sacar un 100 de la nada — que se
          leería como «va perfecta» cuando significa «no sé nada de ella».
        */}
        {fiabilidad && (
          <div className="card mt-4 flex items-center gap-4 p-4">
            <span
              className={`font-mono text-3xl font-bold tabular ${
                !fiabilidad.hay_datos
                  ? 'text-muted'
                  : fiabilidad.score >= 75
                    ? 'text-ok'
                    : fiabilidad.score >= 45
                      ? 'text-warn'
                      : 'text-crit'
              }`}
            >
              {fiabilidad.hay_datos ? fiabilidad.score : '—'}
            </span>
            <div className="min-w-0 text-sm">
              <p className="font-medium">Índice de fiabilidad</p>
              <p className="text-muted">
                {fiabilidad.hay_datos
                  ? `${fiabilidad.incidencias} incidencias · ${fiabilidad.observaciones} observaciones · ${fiabilidad.revisiones} revisiones en el último año`
                  : 'Datos insuficientes todavía: hacen falta unas cuantas revisiones más para que este número signifique algo.'}
              </p>
              {fiabilidad.hay_datos && fiabilidad.solicitudes > 0 && (
                <p className="mt-1 text-xs text-muted">
                  {fiabilidad.solicitudes} solicitudes, que no penalizan: pedir trabajo no es un
                  fallo de la sala.
                </p>
              )}
            </div>
          </div>
        )}

        {(reincidencias ?? []).map((r) => (
          <div key={r.item} className="card mt-3 border-warn/30 bg-warn-tint p-4 text-sm">
            <p className="font-medium text-warn">Reincidencia detectada: {r.item}</p>
            <p className="mt-1">
              {r.veces} sustituciones en esta sala desde {fechaCorta(r.desde)}. Poner la pieza otra
              vez no resuelve la causa: conviene revisar canalización, rosetas o longitud del
              tirado.
            </p>
            <p className="mt-1 text-xs text-muted">
              Basado en {r.veces} incidencias con consumo de ese artículo, la última el{' '}
              {fechaCorta(r.hasta)}.
            </p>
          </div>
        ))}

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onRevisar} className="key key-accent min-h-11 flex-1 px-3 text-sm">
            Revisar esta sala
          </button>
          <button
            type="button"
            onClick={() => setAbierto((v) => !v)}
            className="key key-quiet min-h-11 flex-1 px-3 text-sm"
          >
            {/* Dice qué abre, no «registrar algo». Los dos tipos que quedan
                caben en el propio botón, y con ellos delante nadie usa este
                formulario para apuntar una nota de seguimiento. */}
            {abierto ? 'Cancelar' : 'Incidencia o solicitud'}
          </button>
        </div>

        {guardado && !abierto && (
          <p aria-live="polite" className="mt-3 text-sm text-ok">
            {guardado}
          </p>
        )}

        {abierto && (
          <form
            className="card mt-3 p-4"
            onSubmit={(e) => {
              e.preventDefault()
              registrar.mutate()
            }}
          >
            <h2 className="eyebrow">
              Registrar en {room.name || displayRoomCode(room.code)}
            </h2>

            {/* Los dos tipos, a la vista y sin desplegable: son dos y se elige
                uno de pie. Un `select` aquí serían dos toques y una lista. */}
            <div className="mt-2 flex gap-2">
              {TIPOS_REGISTRABLES.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  onClick={() => setKind(k)}
                  className={`key min-h-11 flex-1 px-2 text-xs ${
                    kind === k ? 'key-accent' : 'key-quiet'
                  }`}
                >
                  {INCIDENT_KIND_LABELS[k]}
                </button>
              ))}
            </div>

            <textarea
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              rows={3}
              placeholder="¿Qué ocurre? Opcional — se puede rellenar luego."
              className="mt-3 w-full rounded-ctl border border-line bg-surface p-3 text-sm"
            />

            {/* Los dos tipos que quedan pueden llevar ticket externo, así que el
                campo ya no se esconde para ninguno. */}
            <label className="mt-3 block text-sm">
              <span className="text-muted">Código de ticket externo</span>
              <input
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                placeholder="I260728_0001"
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 font-mono text-sm"
              />
            </label>

            <p className="mt-3 text-xs leading-relaxed text-muted">
              Basta la sala para guardar. Lo demás se completa después, desde Incidencias.
            </p>
            {/* La frontera, dicha donde se cruza. Sin esto, este cuadro de texto
                acaba llevándose las notas de seguimiento y la lista de trabajo se
                llena de cosas que nadie tiene que arreglar. */}
            <p className="mt-2 text-xs leading-relaxed text-muted">
              Un equipo que no funciona se marca en la revisión, en su fila: eso abre la incidencia
              y la deja asociada al aparato. Y las observaciones van en la revisión, debajo de las
              fotos — se leen más abajo, en esta misma ficha.
            </p>

            {registrar.isError && (
              <p className="mt-2 text-sm text-crit">
                {registrar.error instanceof Error ? registrar.error.message : 'No se ha podido guardar.'}
              </p>
            )}

            <button
              type="submit"
              disabled={registrar.isPending}
              className="key key-accent mt-3 min-h-11 w-full px-3 text-sm"
            >
              {registrar.isPending
                ? 'Guardando…'
                : texto.trim()
                  ? `Guardar ${INCIDENT_KIND_LABELS[kind].toLowerCase()}`
                  : 'Guardar borrador'}
            </button>
          </form>
        )}

        {/*
          Lo que queda por arreglar aquí.

          Es la sección que faltaba y la que contesta a la pregunta con la que se
          entra al aula: «¿esto ya está reportado?». Antes la respuesta vivía en
          la pestaña de Incidencias —otra pantalla, filtrada por texto, con las de
          las 276 salas mezcladas— y en el histórico, que necesita conexión. Aquí
          sale del espejo local, así que funciona en un sótano, y trae el cierre
          al lado: se arregla el proyector y se cierra el parte sin salir del aula,
          que es donde de verdad ocurre.
        */}
        <section
          ref={incidenciasRef}
          aria-labelledby="sec-abiertas"
          className="section-tail mt-8 scroll-mt-16"
        >
          <div className="section-head">
            <h2 id="sec-abiertas" className="eyebrow">Incidencias abiertas</h2>
            {/* La cifra cuenta las que siguen abiertas, no las filas de la lista:
                la que se acaba de cerrar se queda a la vista hasta que sube —para
                que la confirmación no desaparezca con ella— y contarla diría que
                queda trabajo donde ya no queda. */}
            {sinCerrar > 0 && (
              <span className="rounded-tag bg-crit-tint px-2 py-0.5 text-xs font-semibold text-crit">
                {sinCerrar}
              </span>
            )}
          </div>

          {abiertasAqui.length === 0 ? (
            <p className="text-sm text-muted">
              Ninguna. Lo que se marque «Falla» en la próxima revisión aparecerá aquí.
            </p>
          ) : (
            <>
              <ul className="card divide-y divide-line-soft overflow-hidden">
                {abiertasAqui.map((i) => (
                  <li key={i.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="min-w-0 flex-1 basis-48 text-sm font-medium">
                        {i.title ?? 'Sin describir'}
                      </span>
                      {/* La gravedad en palabras, no en color: «alta» a secas no
                          dice qué está en juego, y el color solo no se lee. */}
                      {i.kind === 'incidencia' && (
                        <span
                          className={`shrink-0 text-xs ${
                            i.severity === 'alta'
                              ? 'font-semibold text-crit'
                              : i.severity === 'media'
                                ? 'text-warn'
                                : 'text-muted'
                          }`}
                        >
                          {GRAVEDAD_TEXTO[i.severity] ?? i.severity}
                        </span>
                      )}
                    </div>

                    <p className="mt-0.5 text-xs text-muted">
                      {i.kind !== 'incidencia' && <>{INCIDENT_KIND_LABELS[i.kind]} · </>}
                      {i.external_ref && <span className="font-mono">{i.external_ref} · </span>}
                      {i.state === 'en_curso' && <span className="text-warn">en curso · </span>}
                      {i.assigned_to && (
                        <span className="text-accent">
                          {i.assigned_to === userId
                            ? 'la llevas tú'
                            : `la lleva ${nombreDe(i.assigned_to) ?? 'otra persona'}`}
                          {' · '}
                        </span>
                      )}
                      {i.opened_from_inspection_id && <>de la revisión · </>}
                      {/* «Hace N días» y no la fecha: es la misma frase que usa la
                          pestaña de Incidencias —quien lee las dos pantallas no
                          tiene que traducir— y es lo accionable. La fecha exacta
                          de una avería de hace tres semanas no cambia nada; que
                          lleve tres semanas, sí. */}
                      abierta hace{' '}
                      <span className={diasAbierta(i.opened_at) > STALE_INCIDENT_DAYS ? 'font-semibold text-crit' : ''}>
                        {diasAbierta(i.opened_at)} días
                      </span>
                    </p>

                    {i.description && (
                      <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted">
                        {i.description}
                      </p>
                    )}

                    {i.sinSubir && i.state === 'resuelta' ? (
                      <p className="mt-2 text-xs text-ok">
                        Resuelta. Sube en cuanto haya cobertura.
                      </p>
                    ) : (
                      <div className="mt-2">
                        <AccionesDeIncidencia
                          incident={i}
                          userId={userId}
                          nombreDe={nombreDe}
                          panel={enPanel?.id === i.id ? enPanel.panel : null}
                          onPanel={(panel) => setEnPanel(panel ? { id: i.id, panel } : null)}
                          onHecho={() => {
                            void qc.invalidateQueries({ queryKey: ['room-timeline', room.id] })
                            void qc.invalidateQueries({ queryKey: ['incidents'] })
                          }}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section aria-labelledby="sec-inv" className="mt-8">
          <div className="section-head">
            <h2 id="sec-inv" className="eyebrow">Inventario instalado</h2>
          </div>
          <ul className="divide-y divide-line">
            {(equipos ?? []).map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="flex-1">
                  {a.label || a.tipo}
                  <span className="block font-mono text-xs text-muted">
                    {[a.model, a.serial].filter(Boolean).join(' · ') || 'Sin modelo ni serie'}
                  </span>
                </span>
                {a.status !== 'instalado' && (
                  <span className="rounded-tag bg-warn-tint px-2 py-0.5 text-xs text-warn">
                    {a.status}
                  </span>
                )}
              </li>
            ))}
            {equipos?.length === 0 && (
              <li className="py-2 text-sm text-muted">Sin equipos registrados en esta sala.</li>
            )}
          </ul>
        </section>

        {/*
          Las revisiones anteriores: lo que se comprobó, lo que se apuntó, las
          fotos — y el botón de corregir.

          Van antes del histórico porque son la respuesta a la pregunta con la que
          se entra («¿qué se ha dicho de esta aula?») y el histórico es el resto:
          material, equipos y registros, en orden de reloj. Las dos listas hablan
          de cosas distintas, y por eso conviven sin repetirse.
        */}
        <RevisionesAnteriores roomId={room.id} onCorregir={onCorregir} />

        {/*
          El histórico, con la MISMA línea de tiempo que las otras dos pantallas.

          Esta sección tenía su propio dibujo —cuadraditos de dos píxeles, su
          propio mapa de colores, su propia jerarquía— para pintar exactamente la
          misma consulta que `HistorialSala` y la pestaña de Historial pintan con
          `LineaTiempo`. Dos diseños del mismo dato en la misma aplicación es lo
          que el comentario de cabecera de ese componente dice literalmente que no
          puede pasar: quien lo lee en las dos pantallas tiene que reconocer las
          mismas filas, no traducir entre dos maquetas.

          Sin `onSala`: aquí ya se está en la sala, y un enlace que no lleva a
          ninguna parte es peor que no ofrecerlo.
        */}
        <section aria-labelledby="sec-hist" className="mt-8">
          <div className="section-head">
            <h2 id="sec-hist" className="eyebrow">Historial</h2>
          </div>
          {historialFalla && (
            <p className="mt-2 text-sm text-muted">
              El historial necesita conexión; lo demás de esta ficha funciona sin ella.
            </p>
          )}
          {(historial ?? []).length > 0 && <LineaTiempo eventos={historial ?? []} />}
          {historial?.length === 0 && (
            <p className="mt-2 text-sm text-muted">
              Todavía no hay nada registrado en esta sala.
            </p>
          )}
        </section>
      </div>
    </div>
  )
}
