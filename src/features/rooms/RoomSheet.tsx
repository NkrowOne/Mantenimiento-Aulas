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
 * **Dos — leer las observaciones.** Se escribían en cada revisión, debajo de las
 * fotos, se guardaban en `inspections.notes` y no se pintaban en ningún sitio:
 * exactamente el mismo destino que la columna de texto libre del Excel de la que
 * se venía huyendo. Ahora se leen aquí, que es donde alguien pregunta «qué se ha
 * dicho de esta aula». Y no en la pestaña de Incidencias: eso es la lista de lo
 * que hay que arreglar, y una nota de seguimiento no es trabajo pendiente.
 *
 * Lo que sí es trabajo pendiente entra por su camino. Un equipo que falla se
 * marca en la revisión, en su propia fila, y eso abre una incidencia. El
 * formulario de aquí es para lo que no cabe en una revisión —una avería que se ve
 * de paso, un trabajo que se pide— y por eso ya no ofrece «observación»: tenerla
 * aquí era una segunda puerta para lo mismo, y las dos puertas se llenaban a
 * medias.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { v7 as uuidv7 } from 'uuid'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { RoomPlate } from '@/components/RoomPlate'
import { DoorPlate } from '@/components/DoorPlate'
import { displayRoomCode } from '@/domain/normalize'
import { identifyAsset } from '@/domain/inventory'
import { fechaCorta } from '@/domain/fechas'
import { INCIDENT_KIND_LABELS, type AssetModel, type IncidentKind, type Room } from '@/domain/types'

interface TimelineRow {
  at: string
  kind: 'incidencia' | 'solicitud' | 'observacion' | 'revision_ok' | 'revision_ko'
    | 'material' | 'equipo' | 'inventario'
  title: string
  /**
   * Lo que se dijo, o de qué aparato se está hablando.
   *
   * La letra pequeña del evento: la nota de la revisión, la descripción de la
   * incidencia, la resolución. Y en las filas de equipo lo rellena
   * `room_timeline` con marca, modelo y número de serie: es lo que separa
   * «Pantalla 2 — alta» de algo que se puede cruzar con una factura.
   */
  detail: string | null
  ref: string | null
  who: string | null
  state: string
  /** Unidades, en las filas de material. Negativo sale del almacén. */
  qty: number | null
}

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

/** Una observación escrita en una revisión, tal y como se lee aquí. */
interface Observacion {
  ref_id: string
  at: string
  who: string | null
  texto: string
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

/** Cómo se marca cada cosa en la línea de tiempo. Nunca solo el color. */
const MARCA: Record<TimelineRow['kind'], { punto: string; texto: string }> = {
  incidencia: { punto: 'bg-crit', texto: 'Incidencia' },
  solicitud: { punto: 'bg-accent', texto: 'Solicitud' },
  observacion: { punto: 'bg-warn', texto: 'Observación' },
  revision_ok: { punto: 'bg-ok', texto: 'Revisión' },
  revision_ko: { punto: 'bg-crit', texto: 'Revisión' },
  /*
   * Las tres que trae la línea de tiempo desde que se fundió con la del
   * almacén. Sin ellas aquí, `MARCA[h.kind]` era `undefined` y la ficha
   * reventaba al abrir cualquier sala donde se hubiera gastado un cable.
   */
  material: { punto: 'bg-mark', texto: 'Material' },
  equipo: { punto: 'bg-warn', texto: 'Equipo' },
  inventario: { punto: 'bg-ok', texto: 'Inventario' },
}

interface Props {
  room: Room
  buildingName: string
  zoneName: string
  userId: string | null
  onBack: () => void
  onRevisar: () => void
  /** Ir a la hoja de placas del edificio, lista para imprimir. */
  onImprimir: () => void
}

export function RoomSheet({
  room,
  buildingName,
  zoneName,
  userId,
  onBack,
  onRevisar,
  onImprimir,
}: Props): React.ReactElement {
  const qc = useQueryClient()
  const [abierto, setAbierto] = useState(false)
  const [kind, setKind] = useState<IncidentKind>('incidencia')
  const [texto, setTexto] = useState('')
  const [codigo, setCodigo] = useState('')
  const [guardado, setGuardado] = useState<string | null>(null)

  // El inventario sale del espejo local: la ficha tiene que abrirse en un
  // sótano sin cobertura igual que la revisión.
  const equipos = useLiveQuery(async () => {
    const assets = await db.assets.where('room_id').equals(room.id).toArray()
    const tipos = new Map((await db.assetTypes.toArray()).map((t) => [t.id, t]))
    const modelos = new Map<string, AssetModel>(
      (await db.assetModels.toArray()).map((m) => [m.id, m]),
    )
    return assets
      .map((a) => ({ ...a, id: a.id, ident: identifyAsset(a, tipos, modelos) }))
      .sort(
        (x, y) =>
          x.ident.tipo.localeCompare(y.ident.tipo, 'es') ||
          x.ident.etiqueta.localeCompare(y.ident.etiqueta, 'es', { numeric: true }),
      )
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

  /*
   * Las observaciones de las revisiones.
   *
   * Se escriben debajo de las fotos, en el aula, y hasta ahora acababan en
   * `inspections.notes` sin que ninguna pantalla las leyera: guardadas y
   * perdidas, que es el destino de la columna de texto libre del Excel.
   *
   * Sale de `room_timeline` y no de `inspections` por dos motivos. La vista ya
   * resuelve el nombre de quien lo escribió con un `join` —desde el cliente
   * serían dos consultas— y ya está filtrada por RLS igual que el resto de la
   * ficha. Y el filtro va en el servidor: pedir las últimas treinta filas del
   * histórico y quedarse con las que traen nota daría tres observaciones en un
   * aula con mucho movimiento, porque las treinta se las come el material.
   *
   * `detail` es la nota de la revisión. Solo revisiones: las observaciones
   * importadas del Excel son incidencias de tipo `observacion` y siguen leyéndose
   * en el histórico de abajo, con su marca.
   */
  const { data: observaciones } = useQuery({
    queryKey: ['room-notes', room.id],
    queryFn: async (): Promise<Observacion[]> => {
      const { data, error } = await supabase
        .from('room_timeline')
        .select('ref_id, at, who, detail')
        .eq('room_id', room.id)
        .in('kind', ['revision_ok', 'revision_ko'])
        .not('detail', 'is', null)
        .order('at', { ascending: false })
        .limit(12)
      if (error) throw error
      return (data ?? []).map((o) => ({
        ref_id: o['ref_id'] as string,
        at: o['at'] as string,
        who: (o['who'] as string | null) ?? null,
        texto: (o['detail'] as string | null) ?? '',
      }))
    },
  })

  const { data: historial, isError: historialFalla } = useQuery({
    queryKey: ['room-timeline', room.id],
    queryFn: async (): Promise<TimelineRow[]> => {
      const { data, error } = await supabase
        .from('room_timeline')
        .select('*')
        .eq('room_id', room.id)
        .order('at', { ascending: false })
        .limit(30)
      if (error) throw error
      return (data ?? []) as TimelineRow[]
    },
  })

  /*
   * Guardar el registro.
   *
   * Nace como `borrador` cuando no hay título, y como `abierta` cuando sí lo
   * hay: la restricción de la base dice exactamente eso, y repetirla aquí evita
   * que el servidor rechace algo que la pantalla dejó escribir.
   *
   * El id se genera en el cliente (UUID v7), que es lo que permite que la fila
   * nazca con su identidad definitiva sin haber hablado con nadie.
   */
  const registrar = useMutation({
    mutationFn: async () => {
      const titulo = texto.trim()
      const { error } = await supabase.from('incidents').insert({
        id: uuidv7(),
        room_id: room.id,
        kind,
        title: titulo || null,
        state: titulo ? 'abierta' : 'borrador',
        external_ref: codigo.trim() || null,
        opened_at: new Date().toISOString(),
        opened_by: userId,
      })
      if (error) throw error
      return titulo.length > 0
    },
    onSuccess: (completo) => {
      setGuardado(
        completo
          ? `${INCIDENT_KIND_LABELS[kind]} registrada.`
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

        <section aria-labelledby="sec-inv" className="mt-8">
          <div className="section-head">
            <h2 id="sec-inv" className="eyebrow">Inventario instalado</h2>
          </div>
          <ul className="divide-y divide-line">
            {(equipos ?? []).map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{a.ident.etiqueta}</span>
                  {/*
                    Marca, modelo y número de serie, que es lo que se viene a
                    mirar a la ficha: «¿qué proyector hay en el 2.4?» no se
                    contesta con «un proyector».
                  */}
                  <span className="block truncate font-mono text-xs text-muted">
                    {a.ident.ficha || 'Sin modelo ni serie'}
                  </span>
                  {/* Desde cuándo está puesto. Sin esto, un inventario es una
                      lista; con esto, es algo con lo que planificar. */}
                  {a.installed_at && (
                    <span className="block text-xs text-muted">
                      Instalado el {fechaCorta(a.installed_at)}
                    </span>
                  )}
                </span>
                {a.ident.modeloSinValidar && (
                  <span className="shrink-0 rounded-tag bg-warn-tint px-2 py-0.5 text-xs text-warn">
                    modelo sin validar
                  </span>
                )}
                {a.status !== 'instalado' && (
                  <span className="shrink-0 rounded-tag bg-warn-tint px-2 py-0.5 text-xs text-warn">
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
          Las observaciones, antes del histórico y solo si hay alguna.

          Van en su propia sección y no confundidas entre las filas de la línea de
          tiempo porque se vienen a leer: son frases escritas por alguien que
          estuvo en el aula, y una frase encajada en una lista de eventos con su
          punto de color y su fecha se lee como metadato en vez de como lo que
          dice. Aquí se leen enteras, sin recortar, con quién y cuándo debajo.

          Cuando no hay ninguna no se dibuja nada: un «sin observaciones» es
          ruido en una ficha que ya tiene seis bloques.
        */}
        {(observaciones ?? []).length > 0 && (
          <section aria-labelledby="sec-obs" className="mt-8">
            <div className="section-head">
              <h2 id="sec-obs" className="eyebrow">Observaciones</h2>
              <span className="rounded-tag bg-raised px-2 py-0.5 text-xs font-medium text-muted">
                {observaciones?.length}
              </span>
            </div>
            <p className="mb-3 max-w-prose text-sm leading-relaxed text-muted">
              Lo que se ha ido apuntando en las revisiones de esta sala. No son averías: lo que hay
              que arreglar está en Incidencias.
            </p>
            <ul className="divide-y divide-line-soft border-y border-line bg-surface px-4">
              {(observaciones ?? []).map((o) => (
                <li key={o.ref_id} className="py-4">
                  {/* `whitespace-pre-line`: quien escribe tres cosas las escribe
                      en tres líneas, y aplastarlas en un párrafo pierde justo la
                      separación que le costó poner con el móvil en una mano. */}
                  <p className="whitespace-pre-line text-sm leading-relaxed">{o.texto}</p>
                  <p className="mt-1.5 font-mono text-xs text-muted">
                    {[fechaCorta(o.at), o.who].filter(Boolean).join(' · ')}
                  </p>
                </li>
              ))}
            </ul>
            {observaciones?.length === 12 && (
              <p className="mt-2 text-xs text-muted">
                Las 12 más recientes. El resto está en el histórico de la sala.
              </p>
            )}
          </section>
        )}

        <section aria-labelledby="sec-hist" className="mt-8">
          <div className="section-head">
            <h2 id="sec-hist" className="eyebrow">Historial</h2>
          </div>
          {historialFalla && (
            <p className="mt-2 text-sm text-muted">
              El historial necesita conexión; lo demás de esta ficha funciona sin ella.
            </p>
          )}
          <ul className="mt-2 space-y-3">
            {(historial ?? []).map((h, i) => (
              <li key={`${h.at}-${i}`} className="flex gap-3">
                <span
                  aria-hidden
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-[1px] ${MARCA[h.kind].punto}`}
                />
                <div className="min-w-0 flex-1 text-sm">
                  <p>
                    <span className="text-muted">{MARCA[h.kind].texto} — </span>
                    {h.title}
                    {h.qty !== null && h.qty !== 0 && (
                      <span className="ml-2 font-mono text-xs font-semibold tabular text-ink-2">
                        {h.qty > 0 ? `+${h.qty}` : `−${Math.abs(h.qty)}`}
                      </span>
                    )}
                    {h.state === 'borrador' && (
                      <span className="ml-2 rounded-tag bg-warn-tint px-1.5 py-0.5 text-xs text-warn">
                        sin completar
                      </span>
                    )}
                  </p>
                  {/* El detalle se pinta. La vista lo traía —la nota de la
                      revisión, la descripción de la incidencia, la resolución, y
                      en las filas de equipo la marca, el modelo y el número de
                      serie— y esta lista lo tiraba: un evento decía «Revisión con
                      incidencias» y no lo que se vio. `line-clamp-3` porque aquí
                      es contexto; la observación entera se lee arriba. */}
                  {h.detail && (
                    <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed text-muted">
                      {h.detail}
                    </p>
                  )}
                  <p className="mt-0.5 font-mono text-xs text-muted">

                    {[fechaCorta(h.at), h.who, h.ref].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </li>
            ))}
            {historial?.length === 0 && (
              <li className="text-sm text-muted">Todavía no hay nada registrado en esta sala.</li>
            )}
          </ul>
        </section>
      </div>
    </div>
  )
}
