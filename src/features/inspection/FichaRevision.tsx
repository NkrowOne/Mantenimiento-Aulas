/**
 * La ficha de una revisión.
 *
 * Lo que faltaba, y no era un adorno: una revisión guardada no se podía leer.
 * Quedaba una fila en `inspections`, sus comprobaciones en `inspection_checks`,
 * sus fotos en `attachments` y las incidencias que abrió en `incidents`, y la
 * única huella de todo eso en la aplicación era una línea del histórico que
 * decía «Revisión con incidencias». No **qué** había fallado, ni con qué
 * gravedad, ni qué escribió quien estaba delante del aparato, ni si la foto que
 * hizo llegó a subir.
 *
 * Eso convertía la revisión en un trámite: se rellenaba, se cerraba y se
 * perdía. Y hacía imposible la pregunta que de verdad se hace tres meses
 * después: «esto ya lo miramos en marzo, ¿qué se vio?».
 *
 * El orden de la ficha es el de esa pregunta:
 *
 *  1. Quién, cuándo y con qué resultado — la cabecera.
 *  2. **Qué falló**, con el aparato, su serie, la gravedad, la nota, la
 *     incidencia que abrió y cuántas veces había fallado antes.
 *  3. Lo demás comprobado, con sus medidas.
 *  4. Las observaciones, enteras.
 *  5. Las fotos.
 *  6. El histórico de incidencias de la sala, para leer lo de arriba en contexto.
 *
 * Necesita conexión, y se dice. Es la misma frontera que la ficha del aula y la
 * pestaña Historial: el dispositivo purga las revisiones ya subidas —si no,
 * crecería una fila por aula revisada para siempre— así que esto solo puede
 * salir del servidor.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { displayRoomCode } from '@/domain/normalize'
import { fechaCorta } from '@/domain/fechas'
import { fechaLegible } from '@/domain/historial'
import {
  RESULTADO,
  SEVERIDAD_ETIQUETA,
  etiquetaDeCheck,
  ordenDeResultado,
  retrasoDeSubida,
  tituloDeResultado,
  type RevisionCheckRow,
  type RevisionRow,
} from '@/domain/revision'
import { type Incident, type IncidentState } from '@/domain/types'

/*
 * Las incidencias de la sala.
 *
 * Se derivan de `Incident` con `Pick` en vez de reescribirse: es la misma tabla,
 * y una copia a mano de once campos es una copia que se queda vieja el día que
 * `severity` deje de ser lo que era.
 */
type IncidenciaRow = Pick<
  Incident,
  | 'id'
  | 'check_key'
  | 'title'
  | 'description'
  | 'severity'
  | 'state'
  | 'external_ref'
  | 'opened_at'
  | 'resolved_at'
  | 'resolution'
  | 'opened_from_inspection_id'
>

const ESTADO_INCIDENCIA: Record<IncidentState, { etiqueta: string; clase: string }> = {
  borrador: { etiqueta: 'sin completar', clase: 'bg-warn-tint text-warn' },
  abierta: { etiqueta: 'abierta', clase: 'bg-crit-tint text-crit' },
  en_curso: { etiqueta: 'en curso', clase: 'bg-warn-tint text-warn' },
  resuelta: { etiqueta: 'resuelta', clase: 'bg-ok-tint text-ok' },
}

/** Cuántas incidencias de la sala se traen. Es contexto, no la lista de trabajo. */
const LIMITE_INCIDENCIAS = 20

export function FichaRevision({
  inspectionId,
  onCerrar,
}: {
  inspectionId: string
  onCerrar: () => void
}): React.ReactElement {
  const revision = useQuery({
    queryKey: ['revision', inspectionId],
    queryFn: async (): Promise<RevisionRow | null> => {
      const { data, error } = await supabase
        .from('inspection_overview')
        .select('*')
        .eq('id', inspectionId)
        .maybeSingle()
      if (error) throw error
      return (data as RevisionRow | null) ?? null
    },
  })

  const checks = useQuery({
    queryKey: ['revision-checks', inspectionId],
    queryFn: async (): Promise<RevisionCheckRow[]> => {
      const { data, error } = await supabase
        .from('inspection_check_detail')
        .select('*')
        .eq('inspection_id', inspectionId)
      if (error) throw error
      return (data ?? []) as RevisionCheckRow[]
    },
  })

  const roomId = revision.data?.room_id ?? null

  /*
   * El histórico de incidencias de la sala.
   *
   * No se lanza hasta saber de qué sala es la revisión, y eso obliga a
   * encadenar dos consultas. Merece la pena: la alternativa era pedir el
   * histórico por revisión —que no existe como pregunta— o traerlo todo.
   */
  const incidencias = useQuery({
    queryKey: ['revision-incidencias', roomId, inspectionId],
    enabled: roomId !== null,
    queryFn: async (): Promise<IncidenciaRow[]> => {
      const { data, error } = await supabase
        .from('incidents')
        // En una sola cadena literal y no partida en dos: el cliente de Supabase
        // deduce el tipo de la respuesta leyendo esta lista, y una concatenación
        // le deja como resultado un error de cadena genérica.
        .select('id, check_key, title, description, severity, state, external_ref, opened_at, resolved_at, resolution, opened_from_inspection_id')
        .eq('room_id', roomId as string)
        .order('opened_at', { ascending: false })
        .limit(LIMITE_INCIDENCIAS)
      if (error) throw error
      return (data ?? []) as IncidenciaRow[]
    },
  })

  const filas = [...(checks.data ?? [])].sort(
    (a, b) =>
      ordenDeResultado(a.result) - ordenDeResultado(b.result) ||
      etiquetaDeCheck(a.check_key, a.asset_label).localeCompare(
        etiquetaDeCheck(b.check_key, b.asset_label),
        'es',
        { numeric: true },
      ),
  )
  const fallos = filas.filter((c) => c.result === 'incidencia')
  const resto = filas.filter((c) => c.result !== 'incidencia')

  const r = revision.data ?? null
  const marca = r ? tituloDeResultado(r.status, r.overall) : null
  const retraso = r ? retrasoDeSubida(r.occurred_at, r.recorded_at) : null

  return (
    /*
     * Va como capa sobre la pantalla de la que se abre, no como una vista más.
     *
     * A la ficha se llega desde cuatro sitios —el listado, la línea de tiempo de
     * la pestaña, el histórico plegado de la revisión y la ficha del aula— y en
     * los cuatro se vuelve exactamente al mismo sitio con el trabajo intacto:
     * los filtros puestos, la página cargada, el desplazamiento donde estaba.
     * Como vista de la navegación habría que reconstruir eso cuatro veces.
     */
    <div className="fixed inset-0 z-40 overflow-y-auto overscroll-contain bg-ground">
      <header className="sticky top-0 z-10 border-b border-line bg-ground px-4 py-2">
        <button
          type="button"
          onClick={onCerrar}
          className="-ml-2 inline-flex min-h-11 items-center px-2 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-accent"
        >
          ← Volver
        </button>
      </header>

      <div className="mx-auto max-w-2xl px-4 pb-16">
        {revision.isPending && <p className="py-8 text-sm text-muted">Cargando la revisión…</p>}

        {revision.isError && (
          <div className="card mt-6 p-4">
            <p className="text-sm text-crit">No se ha podido leer esta revisión.</p>
            <p className="mt-1 text-sm text-muted">
              La ficha necesita conexión: el dispositivo no guarda las revisiones que ya subió.
            </p>
            <button
              type="button"
              onClick={() => void revision.refetch()}
              className="key key-quiet mt-3 min-h-11 px-3 text-sm"
            >
              Reintentar
            </button>
          </div>
        )}

        {!revision.isPending && !revision.isError && !r && (
          <p className="py-8 text-sm text-muted">Esa revisión ya no está en el servidor.</p>
        )}

        {r && marca && (
          <>
            {/* La cabecera: dónde, cuándo, quién y con qué resultado. */}
            <section className="mt-4">
              <p className="font-mono text-[0.625rem] font-bold uppercase tracking-[0.17em] text-muted">
                {r.building_name} · {r.zone_name}
              </p>
              <h1 className="mt-1 text-[1.6rem] font-bold leading-[1.2] tracking-tight">
                {r.room_name || displayRoomCode(r.room_code)}
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className={`rounded-tag px-2 py-0.5 text-xs font-medium ${marca.clase}`}>
                  {marca.etiqueta}
                </span>
                <span className="rounded-tag bg-raised px-2 py-0.5 font-mono text-xs text-muted">
                  {r.building_code} {displayRoomCode(r.room_code)}
                </span>
              </div>
              <p className="mt-2 text-sm text-muted">
                {fechaLegible(r.occurred_at)}
                {r.who && <> · {r.who}</>}
                {/* El origen solo cuando NO es la aplicación: las 283 filas que
                    vinieron del Excel no las revisó nadie con el iPad en la
                    mano, y leerlas como si sí es engañoso. */}
                {r.source !== 'app' && <> · importada del {r.source}</>}
              </p>
              {retraso && <p className="mt-1 text-xs text-warn">{retraso}</p>}
              {r.status !== 'completa' && (
                <p className="mt-2 max-w-prose text-sm text-warn">
                  Esta revisión no se cerró: lo que hay aquí es lo que se llegó a marcar. No cuenta
                  como revisión hecha y la sala sigue en la lista de pendientes.
                </p>
              )}
            </section>

            {/* El recuento, que es la lectura de un vistazo. */}
            <ul className="mt-4 grid grid-cols-4 gap-2 text-center">
              {[
                { n: r.fallos, etiqueta: 'Fallan', clase: r.fallos > 0 ? 'text-crit' : 'text-muted' },
                { n: r.ok, etiqueta: 'Correctos', clase: 'text-ok' },
                { n: r.na, etiqueta: 'No aplica', clase: 'text-muted' },
                { n: r.fotos, etiqueta: r.fotos === 1 ? 'Foto' : 'Fotos', clase: 'text-muted' },
              ].map((c) => (
                <li key={c.etiqueta} className="card px-2 py-3">
                  <span className={`block font-mono text-xl font-bold tabular ${c.clase}`}>{c.n}</span>
                  <span className="mt-0.5 block text-[0.6875rem] text-muted">{c.etiqueta}</span>
                </li>
              ))}
            </ul>

            {checks.isError && (
              <p className="mt-4 text-sm text-crit">No se han podido leer las comprobaciones.</p>
            )}

            {/*
              Qué falló. Es la razón de existir de esta pantalla, así que va
              arriba y con su propio marco, no como tres filas rojas entre nueve.
            */}
            {fallos.length > 0 && (
              <section aria-labelledby="sec-fallos" className="mt-8">
                <div className="section-head">
                  <h2 id="sec-fallos" className="eyebrow">Qué falló</h2>
                </div>
                <ul className="space-y-3">
                  {fallos.map((c) => (
                    <li key={c.check_id} className="card border-crit/25 bg-crit-tint p-4">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-medium">
                          {etiquetaDeCheck(c.check_key, c.asset_label)}
                        </span>
                        {c.severity && (
                          <span className="rounded-tag bg-crit-tint px-2 py-0.5 text-xs text-crit">
                            {SEVERIDAD_ETIQUETA[c.severity]}
                          </span>
                        )}
                      </div>

                      {/* El aparato, con su serie. Es lo que separa «algo de las
                          pantallas va mal» de «la Pantalla 2, serie X, va mal». */}
                      {(c.serial || c.model || c.type_name) && (
                        <p className="mt-0.5 font-mono text-xs text-muted">
                          {[c.type_name, c.model, c.serial].filter(Boolean).join(' · ')}
                        </p>
                      )}

                      {c.note && (
                        <p className="mt-2 whitespace-pre-line text-sm leading-relaxed">{c.note}</p>
                      )}

                      {/* Y qué se hizo con ello. Una avería marcada en una
                          revisión abre una incidencia; si aquí no se dijera,
                          quien lee la ficha no sabría si alguien se hizo cargo. */}
                      {c.incident_id ? (
                        <p className="mt-2 text-xs text-muted">
                          Abrió una incidencia
                          {c.incident_state && (
                            <>
                              {' · '}
                              <span
                                className={`rounded-tag px-1.5 py-0.5 ${ESTADO_INCIDENCIA[c.incident_state].clase}`}
                              >
                                {ESTADO_INCIDENCIA[c.incident_state].etiqueta}
                              </span>
                            </>
                          )}
                          {c.incident_ref && <> · <span className="font-mono">{c.incident_ref}</span></>}
                          {c.incident_resolved_at && <> · resuelta el {fechaCorta(c.incident_resolved_at)}</>}
                        </p>
                      ) : (
                        /*
                         * Sin incidencia: pasa con lo revisado antes de que la
                         * revisión abriera partes sola, y con lo importado. Decirlo
                         * es la diferencia entre «nadie se hizo cargo» y «no lo sé».
                         */
                        <p className="mt-2 text-xs text-muted">
                          Sin incidencia asociada: se marcó antes de que la revisión las abriera sola.
                        </p>
                      )}

                      {c.incident_resolution && (
                        <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-muted">
                          Resolución: {c.incident_resolution}
                        </p>
                      )}

                      {/* La reincidencia, dicha donde importa. Poner la pieza
                          otra vez no resuelve una avería que va por la cuarta. */}
                      {c.fallos_previos > 0 && (
                        <p className="mt-2 text-xs font-medium text-warn">
                          Ya había fallado {c.fallos_previos}{' '}
                          {c.fallos_previos === 1 ? 'vez' : 'veces'} en esta sala
                          {c.fallo_previo_at && <>, la última el {fechaCorta(c.fallo_previo_at)}</>}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Todo lo comprobado, incluida la medida que se tomó. */}
            <section aria-labelledby="sec-checks" className="mt-8">
              <div className="section-head">
                <h2 id="sec-checks" className="eyebrow">
                  {fallos.length > 0 ? 'Lo demás comprobado' : 'Comprobaciones'}
                </h2>
                <span className="rounded-tag bg-raised px-2 py-0.5 text-xs font-medium text-muted">
                  {r.total}
                </span>
              </div>

              {checks.isPending ? (
                <p className="text-sm text-muted">Cargando las comprobaciones…</p>
              ) : resto.length === 0 && fallos.length === 0 ? (
                /*
                 * Una revisión sin ni una comprobación existe: se abrió el aula,
                 * se cerró sin marcar nada, o el aula no tenía inventario del que
                 * preguntar. Y hay que decirlo, porque un «0 de 0» en verde se
                 * leería como «todo bien».
                 */
                <p className="text-sm text-muted">
                  Esta revisión no dejó ninguna comprobación guardada.
                </p>
              ) : (
                <ul className="divide-y divide-line-soft border-y border-line bg-surface px-4">
                  {resto.map((c) => (
                    <li key={c.check_id} className="flex items-start gap-3 py-3">
                      <span
                        aria-hidden
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${RESULTADO[c.result].punto}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm">
                          {etiquetaDeCheck(c.check_key, c.asset_label)}
                        </span>
                        {(c.serial || c.model) && (
                          <span className="mt-0.5 block font-mono text-xs text-muted">
                            {[c.model, c.serial].filter(Boolean).join(' · ')}
                          </span>
                        )}
                        {c.note && (
                          <span className="mt-1 block whitespace-pre-line text-xs leading-relaxed text-muted">
                            {c.note}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-right">
                        {/* La medida es un dato de la revisión y hasta ahora no se
                            leía en ningún sitio: las horas de lámpara y los Mbps
                            se pedían en el aula y morían en la tabla. */}
                        {c.measure !== null ? (
                          <span className="block font-mono text-sm font-semibold tabular">
                            {c.measure}
                            {c.measure_unit && (
                              <span className="ml-1 text-xs font-normal text-muted">
                                {c.measure_unit}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className={`block text-xs ${RESULTADO[c.result].tinte}`}>
                            {RESULTADO[c.result].etiqueta}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/*
              Las observaciones, enteras y sin recortar.

              Se escriben en el aula, debajo de las fotos, y se leían resumidas a
              tres líneas en la ficha del aula. Aquí es donde se leen completas:
              es el sitio de la revisión que las produjo.
            */}
            {r.notes && (
              <section aria-labelledby="sec-notas" className="mt-8">
                <div className="section-head">
                  <h2 id="sec-notas" className="eyebrow">Observaciones</h2>
                </div>
                <p className="card whitespace-pre-line p-4 text-sm leading-relaxed">{r.notes}</p>
              </section>
            )}

            <Fotos inspectionId={inspectionId} enServidor={r.fotos} />

            {/*
              El histórico de incidencias de la sala.

              Va al final y a propósito: se lee después de saber qué se encontró
              ese día. Es lo que responde a «¿esto es nuevo?» sin salir de la
              ficha — y lo que esta revisión abrió sale marcado, para no
              confundir lo que se encontró con lo que ya estaba.
            */}
            <section aria-labelledby="sec-inc" className="mt-8">
              <div className="section-head">
                <h2 id="sec-inc" className="eyebrow">Histórico de incidencias de la sala</h2>
              </div>

              {incidencias.isPending && <p className="text-sm text-muted">Cargando…</p>}
              {incidencias.isError && (
                <p className="text-sm text-muted">No se ha podido leer el histórico.</p>
              )}
              {incidencias.data?.length === 0 && (
                <p className="text-sm text-muted">Esta sala no tiene ninguna incidencia registrada.</p>
              )}

              <ul className="divide-y divide-line-soft">
                {(incidencias.data ?? []).map((i) => {
                  const deEsta = i.opened_from_inspection_id === inspectionId
                  return (
                    <li key={i.id} className="py-3">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="min-w-0 flex-1 text-sm">
                          {i.title || '(sin describir)'}
                        </span>
                        <span
                          className={`shrink-0 rounded-tag px-1.5 py-0.5 text-xs ${ESTADO_INCIDENCIA[i.state].clase}`}
                        >
                          {ESTADO_INCIDENCIA[i.state].etiqueta}
                        </span>
                      </div>
                      {i.description && (
                        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">
                          {i.description}
                        </p>
                      )}
                      <p className="mt-0.5 font-mono text-xs text-muted">
                        {[
                          fechaCorta(i.opened_at),
                          SEVERIDAD_ETIQUETA[i.severity],
                          i.external_ref,
                          i.resolved_at ? `resuelta el ${fechaCorta(i.resolved_at)}` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      {deEsta && (
                        <p className="mt-1 text-xs font-medium text-accent">
                          La abrió esta revisión
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>

              {(incidencias.data?.length ?? 0) === LIMITE_INCIDENCIAS && (
                <p className="mt-2 text-xs text-muted">
                  Las {LIMITE_INCIDENCIAS} más recientes. El resto está en la pestaña Incidencias.
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Las fotos de la revisión.
 *
 * Se hacían en el aula, se comprimían, se subían y **no se veían en ninguna
 * parte**: el único rastro era el contador del botón «2 fotos · añadir otra»
 * mientras la revisión seguía abierta. Una foto que nadie puede volver a mirar
 * no es una prueba de nada.
 *
 * El bucket es privado, así que se piden URLs firmadas de vida corta. Es
 * deliberado —las fotos enseñan instalaciones y a veces personas— y por eso la
 * consulta no se cachea largo: una URL caducada da una imagen rota, que es peor
 * que pedirla otra vez.
 *
 * Y se cuentan también las que aún no han salido del dispositivo. Si no, alguien
 * que hizo tres fotos en un sótano abriría la ficha, vería una y pensaría que
 * las otras dos se perdieron.
 */
function Fotos({
  inspectionId,
  enServidor,
}: {
  inspectionId: string
  enServidor: number
}): React.ReactElement | null {
  const [grande, setGrande] = useState<string | null>(null)

  const pendientes =
    useLiveQuery(
      async () =>
        db.photos.where('[entityType+entityId]').equals(['inspection', inspectionId]).count(),
      [inspectionId],
      0,
    ) ?? 0

  const fotos = useQuery({
    queryKey: ['revision-fotos', inspectionId],
    enabled: enServidor > 0,
    // Las URLs firmadas caducan: se piden frescas en vez de servir una cacheada
    // que ya no abre nada.
    staleTime: 4 * 60_000,
    queryFn: async (): Promise<Array<{ id: string; url: string; taken_at: string }>> => {
      const { data: adjuntos, error } = await supabase
        .from('attachments')
        .select('id, storage_path, taken_at')
        .eq('entity_type', 'inspection')
        .eq('entity_id', inspectionId)
        .order('taken_at')
      if (error) throw error

      const rutas = (adjuntos ?? []).map((a) => a['storage_path'] as string)
      if (rutas.length === 0) return []

      const { data: firmadas, error: fallo } = await supabase.storage
        .from('fotos')
        .createSignedUrls(rutas, 5 * 60)
      if (fallo) throw fallo

      const porRuta = new Map((firmadas ?? []).map((f) => [f.path ?? '', f.signedUrl]))
      return (adjuntos ?? [])
        .map((a) => ({
          id: a['id'] as string,
          taken_at: a['taken_at'] as string,
          url: porRuta.get(a['storage_path'] as string) ?? '',
        }))
        .filter((f) => f.url !== '')
    },
  })

  if (enServidor === 0 && pendientes === 0) return null

  return (
    <section aria-labelledby="sec-fotos" className="mt-8">
      <div className="section-head">
        <h2 id="sec-fotos" className="eyebrow">Fotos</h2>
        <span className="rounded-tag bg-raised px-2 py-0.5 text-xs font-medium text-muted">
          {enServidor}
        </span>
      </div>

      {fotos.isPending && enServidor > 0 && <p className="text-sm text-muted">Cargando las fotos…</p>}
      {fotos.isError && (
        <p className="text-sm text-muted">
          Las fotos no se han podido abrir. Vuelve a intentarlo con conexión.
        </p>
      )}

      <ul className="grid grid-cols-3 gap-2">
        {(fotos.data ?? []).map((f) => (
          <li key={f.id}>
            <button
              type="button"
              onClick={() => setGrande(f.url)}
              className="block w-full overflow-hidden rounded-ctl border border-line bg-sunken"
            >
              <img
                src={f.url}
                alt={`Foto de la revisión del ${fechaCorta(f.taken_at)}`}
                loading="lazy"
                className="aspect-square w-full object-cover"
              />
            </button>
          </li>
        ))}
      </ul>

      {pendientes > 0 && (
        <p className="mt-2 text-xs text-warn">
          {pendientes} {pendientes === 1 ? 'foto' : 'fotos'} de este dispositivo{' '}
          {pendientes === 1 ? 'sigue' : 'siguen'} sin subir. {pendientes === 1 ? 'Aparecerá' : 'Aparecerán'} aquí
          en cuanto haya cobertura.
        </p>
      )}

      {/* A pantalla completa, porque una miniatura de 100 px no sirve para ver
          si un conector está doblado. */}
      {grande && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setGrande(null)}
        >
          <img src={grande} alt="Foto de la revisión" className="max-h-full max-w-full object-contain" />
          <button
            type="button"
            onClick={() => setGrande(null)}
            className="key key-quiet absolute right-4 top-4 min-h-11 px-3 text-sm"
            style={{ marginTop: 'env(safe-area-inset-top)' }}
          >
            Cerrar
          </button>
        </div>
      )}
    </section>
  )
}
