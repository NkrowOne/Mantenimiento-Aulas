/**
 * Las revisiones anteriores de una sala: leerlas y corregirlas.
 *
 * Es la pantalla que faltaba, y lo que faltaba no era enseñar más datos: era
 * poder **preguntar hacia atrás**. Todo lo que se apuntaba en una revisión
 * —resultado por aparato, gravedad, medidas, la observación de debajo de las
 * fotos, las fotos— se guardaba y no se leía en ningún sitio. La consecuencia no
 * es abstracta: el técnico llega al aula, el proyector no da imagen, y lo único
 * que sabe es lo que ve. Con esto sabe que hace tres semanas alguien apuntó «el
 * mando aparece en el cajón», que la lámpara iba por 1.900 horas y que hay una
 * foto de la roseta.
 *
 * Y la segunda mitad: **corregir en vez de repetir**. Hasta ahora, un error en
 * una revisión cerrada solo se podía arreglar haciendo otra —la revisión es
 * inmutable, y con razón—. Con 276 aulas por ronda eso son veinte revisiones al
 * mes que no son visitas: son la misma visita apuntada varias veces, y cada una
 * mueve la fecha de «última revisión», cuenta en la fiabilidad y sale en el
 * informe del viernes. Aquí una corrección es una versión nueva de la MISMA
 * visita: reemplaza a la anterior en todo lo que se cuenta y no la borra.
 *
 * TRES DECISIONES DE FORMA, y todas salen de lo mismo:
 *
 *  - **Una tarjeta por visita, no por fila.** Una revisión corregida tres veces
 *    es una tarjeta con tres versiones dentro. Pintar cuatro tarjetas sería
 *    trasladar a la pantalla el problema que esto viene a resolver.
 *  - **La observación se lee como una cita**, con su filete a la izquierda y sin
 *    recortar. La escribió una persona que estuvo en el aula; encajada en una
 *    lista de metadatos con su punto de color se lee como un campo más.
 *  - **El detalle se despliega.** Lo normal es mirar la fecha y el resultado; las
 *    nueve filas de aquel día son para cuando algo no cuadra, y se piden.
 *
 * Necesita conexión, y se dice. El histórico completo de 276 salas no cabe en el
 * espejo local, y descargarlo para el caso en que alguien lo abra sería pagar el
 * arranque de todos por el uso de unos pocos. Lo que sí funciona sin cobertura es
 * seguir una corrección ya empezada: desde que el borrador está en el
 * dispositivo, es una revisión como cualquier otra.
 */

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { pullSala } from '@/sync/pull'
import { fechaCorta } from '@/domain/fechas'
import { fechaLegible } from '@/domain/historial'
import {
  GRAVEDAD_LEGIBLE,
  RESULTADO_ESTILO,
  agruparEnVisitas,
  detalleDeComprobacion,
  etiquetaDeComprobacion,
  ordenarComprobaciones,
  resultadoLegible,
  semillaDeCorreccion,
  type ComprobacionDetalle,
  type RevisionResumen,
  type Visita,
} from '@/domain/revisiones'
import { ROOM_CHECKS, assetCheckKey } from '@/domain/types'
import { FotosDeRevision } from './FotosDeRevision'
import type { Correccion } from './useInspection'

/**
 * Cuántas revisiones se traen.
 *
 * Son visitas, no eventos: en un aula muy movida caben dos rondas por curso, así
 * que veinticuatro filas cubren años. Y hay que pedir de sobra porque una visita
 * corregida ocupa varias: con un tope justo, la cadena llegaría partida.
 */
const LIMITE = 24

/** Cuántas visitas se pintan antes de pedirlo. */
const A_LA_VISTA = 5

type Filtro = 'todas' | 'observacion' | 'fotos' | 'fallos'

const FILTROS: Array<{ id: Filtro; label: string; cumple: (v: Visita) => boolean }> = [
  { id: 'todas', label: 'Todas', cumple: () => true },
  {
    id: 'observacion',
    label: 'Con observación',
    cumple: (v) => v.versiones.some((r) => (r.notes ?? '').trim().length > 0),
  },
  { id: 'fotos', label: 'Con fotos', cumple: (v) => v.versiones.some((r) => r.fotos > 0) },
  { id: 'fallos', label: 'Con fallos', cumple: (v) => v.vigente.fallos > 0 },
]

async function comprobacionesDe(inspectionId: string): Promise<ComprobacionDetalle[]> {
  const { data, error } = await supabase
    .from('inspection_check_detail')
    .select('*')
    .eq('inspection_id', inspectionId)
  if (error) throw error
  return ordenarComprobaciones((data ?? []) as ComprobacionDetalle[])
}

export function RevisionesAnteriores({
  roomId,
  onCorregir,
}: {
  roomId: string
  /** Abre el formulario de revisión sembrado con lo que dijo aquella visita. */
  onCorregir: (correccion: Correccion) => void
}): React.ReactElement {
  const qc = useQueryClient()
  const [filtro, setFiltro] = useState<Filtro>('todas')
  const [todas, setTodas] = useState(false)

  /*
   * Antes de sembrar nada, el espejo de esta sala se pone al día.
   *
   * La semilla de una corrección filtra por `clavesVigentes`, que sale del
   * espejo local: si al espejo le falta un equipo —una descarga atrasada, un
   * alta de otro dispositivo—, la respuesta de aquella revisión sobre ese
   * equipo se descartaría como si el aparato ya no existiera. Esta pantalla ya
   * necesita conexión para listar las revisiones, así que reconciliar aquí no
   * añade ningún requisito nuevo; sin red, simplemente no hace nada.
   */
  useEffect(() => {
    void pullSala(roomId)
  }, [roomId])

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['room-inspections', roomId],
    queryFn: async (): Promise<RevisionResumen[]> => {
      const { data: filas, error } = await supabase
        .from('room_inspections')
        .select('*')
        .eq('room_id', roomId)
        .order('occurred_at', { ascending: false })
        .limit(LIMITE)
      if (error) throw error
      return (filas ?? []) as RevisionResumen[]
    },
  })

  const visitas = useMemo(() => agruparEnVisitas(data ?? []), [data])

  /*
   * Las claves que el formulario tiene hoy delante.
   *
   * Es lo que decide qué se puede arrastrar a una corrección: una respuesta sobre
   * un proyector retirado el mes pasado no tendría fila donde verse ni cambiarse.
   * Sale del espejo local, así que se sabe sin red.
   */
  const clavesVigentes = useLiveQuery(
    async () => {
      const assets = await db.assets.where('room_id').equals(roomId).toArray()
      return [
        ...assets.filter((a) => a.status !== 'retirado').map((a) => assetCheckKey(a.id)),
        ...ROOM_CHECKS,
      ]
    },
    [roomId],
    [],
  )

  /*
   * Las correcciones empezadas y no cerradas, para poder continuarlas.
   *
   * Sin esto, una corrección a medias sería invisible: el formulario la encuentra
   * por `corrects`, así que no aparece al pulsar «Revisar esta sala» —y eso es lo
   * correcto—, pero entonces nada la ofrece. Se leen las claves y no las filas
   * para no arrastrar el borrador entero por cada redibujado.
   */
  const enCurso = useLiveQuery(
    async () => {
      const borradores = await db.inspections
        .where('room_id')
        .equals(roomId)
        .filter((i) => i.status === 'borrador' && Boolean(i.corrects))
        .toArray()
      return new Set(borradores.map((i) => i.corrects!))
    },
    [roomId],
    new Set(),
  )

  /* Qué visitas tienen alguna foto todavía en la cola del dispositivo. Se piden
     solo las claves: leer la tabla entera traería los `Blob` con ella. */
  const idsVisibles = useMemo(
    () => visitas.flatMap((v) => v.versiones.map((r) => r.id)),
    [visitas],
  )
  const conFotoLocal = useLiveQuery(
    async () => {
      if (idsVisibles.length === 0) return new Set()
      const claves = (await db.photos
        .where('[entityType+entityId]')
        .anyOf(idsVisibles.map((id) => ['inspection', id]))
        .keys()) as string[]
      // `keys()` sobre un índice compuesto devuelve el par: el segundo es la revisión.
      return new Set(claves.map((k) => (Array.isArray(k) ? (k[1] as string) : k)))
    },
    [idsVisibles.join(',')],
    new Set(),
  )

  /*
   * Preparar la corrección.
   *
   * Se leen las comprobaciones de aquella revisión antes de salir de esta
   * pantalla: es la única parte que necesita red, y hacerla aquí permite decir
   * «no se ha podido» donde está el botón en vez de dejar al técnico en un
   * formulario a medio sembrar. `fetchQuery` reutiliza lo que ya se hubiera
   * descargado al desplegar el detalle.
   */
  const preparar = useMutation({
    mutationFn: async (r: RevisionResumen): Promise<Correccion> => {
      const comprobaciones = await qc.fetchQuery({
        queryKey: ['inspection-checks', r.id],
        queryFn: () => comprobacionesDe(r.id),
      })

      return {
        baseId: r.id,
        occurredAt: r.occurred_at,
        who: r.who,
        fallos: r.fallos,
        fotos: r.fotos,
        notes: r.notes,
        semilla: semillaDeCorreccion(comprobaciones, clavesVigentes),
      }
    },
    onSuccess: onCorregir,
  })

  const filtradas = visitas.filter(FILTROS.find((f) => f.id === filtro)!.cumple)
  const visibles = todas ? filtradas : filtradas.slice(0, A_LA_VISTA)
  const cuenta = (f: Filtro): number =>
    visitas.filter(FILTROS.find((x) => x.id === f)!.cumple).length

  return (
    <section aria-labelledby="sec-rev" className="mt-8">
      <div className="section-head">
        <h2 id="sec-rev" className="eyebrow">
          Revisiones anteriores
        </h2>
        {visitas.length > 0 && (
          <span className="rounded-tag bg-raised px-2 py-0.5 text-xs font-medium text-muted">
            {visitas.length}
          </span>
        )}
      </div>

      <p className="mb-3 max-w-prose text-sm leading-relaxed text-muted">
        Qué se comprobó cada vez, lo que se apuntó y las fotos. Si algo quedó mal
        apuntado, se corrige aquí: la corrección sustituye a esa revisión en vez de
        añadir una visita que no ocurrió.
      </p>

      {isPending && <p className="text-sm text-muted">Cargando las revisiones…</p>}

      {isError && (
        <div className="card p-4">
          <p className="text-sm text-crit">No se han podido leer las revisiones.</p>
          <p className="mt-1 text-sm text-muted">
            Esta parte necesita conexión. Revisar la sala funciona sin ella.
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="key key-quiet mt-3 min-h-11 px-3 text-sm"
          >
            Reintentar
          </button>
        </div>
      )}

      {!isPending && !isError && visitas.length === 0 && (
        <p className="text-sm text-muted">
          Esta sala todavía no tiene ninguna revisión cerrada.
        </p>
      )}

      {/* Los filtros solo cuando hay bastante que filtrar y el filtro tiene algo
          que enseñar: con tres visitas son cuatro botones que no hacen nada. */}
      {visitas.length >= 4 && (
        <div className="scroll-x -mx-1 mb-3 flex gap-2 px-1 pb-1">
          {FILTROS.filter((f) => f.id === 'todas' || cuenta(f.id) > 0).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setFiltro(f.id)
                setTodas(false)
              }}
              aria-pressed={filtro === f.id}
              className={`key min-h-11 shrink-0 px-3 text-xs ${
                filtro === f.id ? 'key-accent' : 'key-quiet text-muted'
              }`}
            >
              {f.label} {cuenta(f.id)}
            </button>
          ))}
        </div>
      )}

      {filtradas.length === 0 && visitas.length > 0 && (
        <p className="text-sm text-muted">Ninguna revisión de esta sala cumple ese filtro.</p>
      )}

      <ul className="space-y-3">
        {visibles.map((v) => (
          <TarjetaDeVisita
            key={v.vigente.id}
            visita={v}
            enCurso={enCurso.has(v.vigente.id)}
            conFotoLocal={v.versiones.some((r) => conFotoLocal.has(r.id))}
            preparando={preparar.isPending && preparar.variables?.id === v.vigente.id}
            fallo={
              preparar.isError && preparar.variables?.id === v.vigente.id
                ? 'No se ha podido recuperar esa revisión. Hace falta conexión para empezar a corregirla.'
                : null
            }
            onCorregir={() => preparar.mutate(v.vigente)}
          />
        ))}
      </ul>

      {filtradas.length > visibles.length && (
        <button
          type="button"
          onClick={() => setTodas(true)}
          className="key key-quiet mt-3 min-h-11 w-full px-3 text-sm"
        >
          Ver {filtradas.length - visibles.length} más
        </button>
      )}

      {(data?.length ?? 0) === LIMITE && (
        <p className="mt-2 text-xs text-muted">
          Las más recientes. El histórico completo está en la pestaña Historial.
        </p>
      )}
    </section>
  )
}

function TarjetaDeVisita({
  visita,
  enCurso,
  conFotoLocal,
  preparando,
  fallo,
  onCorregir,
}: {
  visita: Visita
  /** Ya hay una corrección de esta visita empezada en el dispositivo. */
  enCurso: boolean
  conFotoLocal: boolean
  preparando: boolean
  fallo: string | null
  onCorregir: () => void
}): React.ReactElement {
  const { vigente, versiones } = visita
  const original = versiones[0]!
  const corregida = versiones.length > 1

  /** Qué versión se está mirando por dentro. `null` = el detalle está plegado. */
  const [viendo, setViendo] = useState<string | null>(null)

  const fotos = versiones.reduce((n, r) => n + r.fotos, 0)
  const nota = (vigente.notes ?? '').trim()

  return (
    <li className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{fechaLegible(vigente.occurred_at)}</p>
          <p className="mt-0.5 text-xs text-muted">
            {original.who ? `Revisó ${original.who}` : 'Sin firma'}
            {corregida && vigente.corrected_at && (
              <>
                {' · '}
                <span className="text-accent">
                  corregida el {fechaCorta(vigente.corrected_at)}
                  {vigente.who ? ` por ${vigente.who}` : ''}
                </span>
              </>
            )}
          </p>
        </div>

        {/* El resultado, con palabra y no solo con color. */}
        <span
          className={`shrink-0 rounded-tag px-2 py-0.5 text-xs font-semibold ${
            vigente.fallos > 0 || vigente.overall === 'con_incidencias'
              ? 'bg-crit-tint text-crit'
              : 'bg-ok-tint text-ok'
          }`}
        >
          {resultadoLegible(vigente)}
        </span>
      </div>

      {/* La letra pequeña de la visita: de qué está hecho el resultado. */}
      <p className="mt-2 font-mono text-xs text-muted">
        {[
          vigente.comprobaciones > 0
            ? `${vigente.comprobaciones} comprobacion${vigente.comprobaciones === 1 ? '' : 'es'}`
            : null,
          vigente.no_aplica > 0 ? `${vigente.no_aplica} n/a` : null,
          fotos > 0 ? `${fotos} foto${fotos === 1 ? '' : 's'}` : null,
          vigente.incidencias > 0
            ? `${vigente.incidencias} incidencia${vigente.incidencias === 1 ? '' : 's'} abiertas`
            : null,
          corregida ? `${versiones.length} versiones` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>

      {/* La observación, como lo que es: una frase que escribió alguien que estuvo
          allí. Sin recortar y con el salto de línea que le costó poner. */}
      {nota && (
        <p className="mt-3 whitespace-pre-line border-l-2 border-line pl-3 text-sm leading-relaxed">
          {nota}
        </p>
      )}

      {(fotos > 0 || conFotoLocal) && (
        <div className="mt-3">
          <FotosDeRevision ids={versiones.map((r) => r.id)} />
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setViendo(viendo === null ? vigente.id : null)}
          aria-expanded={viendo !== null}
          className="key key-quiet min-h-11 flex-1 px-3 text-sm"
        >
          {viendo !== null
            ? 'Ocultar el detalle'
            : vigente.comprobaciones > 0
              ? `Ver las ${vigente.comprobaciones} comprobaciones`
              : 'Ver el detalle'}
        </button>

        {/*
          Corregir. Es la acción de la tarjeta y por eso lleva el color de la
          marca, pero va la segunda: nueve de cada diez veces se entra aquí a
          leer, no a arreglar.
        */}
        <button
          type="button"
          onClick={onCorregir}
          disabled={preparando}
          className={`key min-h-11 flex-1 px-3 text-sm ${enCurso ? 'key-accent' : 'key-quiet'}`}
        >
          {preparando
            ? 'Recuperando…'
            : enCurso
              ? 'Continuar la corrección'
              : 'Corregir esta revisión'}
        </button>
      </div>

      {fallo && <p className="mt-2 text-sm text-crit">{fallo}</p>}

      <div className="collapse-y" data-open={viendo !== null} inert={viendo === null}>
        <div>
          {viendo !== null && (
            <div className="border-t border-line pt-3">
              {/* El selector de versiones solo aparece si hay más de una. Es la
                  forma de mirar lo que decía la revisión ANTES de corregirse, que
                  es justamente lo que hace que corregir no sea perder nada. */}
              {corregida && (
                <div className="scroll-x -mx-1 mb-3 flex gap-2 px-1 pb-1">
                  {versiones.map((r, i) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setViendo(r.id)}
                      aria-pressed={viendo === r.id}
                      className={`key min-h-11 shrink-0 px-3 text-xs ${
                        viendo === r.id ? 'key-accent' : 'key-quiet text-muted'
                      }`}
                    >
                      {i === 0 ? 'Original' : `Corrección ${i}`}
                      {r.id === vigente.id ? ' · actual' : ''}
                    </button>
                  ))}
                </div>
              )}

              <Comprobaciones inspectionId={viendo} />

              {/* Quién firmó la versión que se está mirando, cuando no es la
                  vigente: sin esto, «Original» y «Corrección 1» se leen como dos
                  listas sin autor. */}
              {corregida && viendo !== vigente.id && (
                <p className="mt-3 font-mono text-xs text-muted">
                  {(() => {
                    const r = versiones.find((x) => x.id === viendo)
                    if (!r) return null
                    return [
                      r.corrected_at
                        ? `corregida el ${fechaCorta(r.corrected_at)}`
                        : `revisada el ${fechaCorta(r.occurred_at)}`,
                      r.who,
                      resultadoLegible(r),
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  })()}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  )
}

/** Lo que aquella revisión contestó, fila a fila. */
function Comprobaciones({ inspectionId }: { inspectionId: string }): React.ReactElement {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['inspection-checks', inspectionId],
    queryFn: () => comprobacionesDe(inspectionId),
  })

  if (isPending) return <p className="text-sm text-muted">Cargando el detalle…</p>

  if (isError) {
    return (
      <div>
        <p className="text-sm text-crit">No se ha podido leer el detalle.</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="key key-quiet mt-2 min-h-11 px-3 text-sm"
        >
          Reintentar
        </button>
      </div>
    )
  }

  if ((data ?? []).length === 0) {
    return (
      <p className="text-sm text-muted">
        Esta revisión no guardó el resultado fila a fila: viene de la importación del
        Excel, que solo traía la fecha y cómo salió.
      </p>
    )
  }

  return (
    <ul className="divide-y divide-line-soft">
      {(data ?? []).map((c) => {
        const estilo = RESULTADO_ESTILO[c.result]
        const detalle = detalleDeComprobacion(c)

        return (
          <li key={c.id} className="flex items-start gap-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{etiquetaDeComprobacion(c)}</span>
              {detalle && <span className="block font-mono text-xs text-muted">{detalle}</span>}

              {/* La medida, donde la hay: horas de lámpara, Mbps. Es la mitad del
                  valor de leer una revisión vieja —«iba por 1.900 horas»—. */}
              {c.measure !== null && (
                <span className="mt-0.5 block font-mono text-xs text-ink-2">
                  {c.measure} {c.measure_unit ?? ''}
                </span>
              )}

              {c.note && (
                <span className="mt-0.5 block whitespace-pre-line text-xs leading-relaxed text-muted">
                  {c.note}
                </span>
              )}
            </span>

            <span
              className={`shrink-0 rounded-tag px-2 py-0.5 text-xs font-semibold ${estilo.clase}`}
            >
              {estilo.etiqueta}
              {c.result === 'incidencia' && c.severity && (
                <span className="font-normal"> · {GRAVEDAD_LEGIBLE[c.severity]}</span>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
