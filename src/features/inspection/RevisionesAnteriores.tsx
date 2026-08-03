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
 * Y la segunda mitad: **corregir en vez de repetir**. Una corrección es una
 * versión nueva de la MISMA visita: reemplaza a la anterior en todo lo que se
 * cuenta y no la borra.
 *
 * DOS DECISIONES DE FORMA, y las dos salen de lo mismo:
 *
 *  - **La lista lista, la ficha aparte.** Aquí una fila limpia por visita —una
 *    corregida tres veces sigue siendo UNA fila— y todo lo demás en su propia
 *    pantalla (`FichaDeRevision`): las fotos en grande, la observación entera,
 *    cada comprobación con su medida y quién firmó qué. Metido en la tarjeta,
 *    la lista dejaba de recorrerse; y recorrer es para lo que está la lista.
 *  - **El detalle no se paga por adelantado.** La lista trae contadores; las
 *    comprobaciones y las fotos se piden al abrir la ficha de esa visita.
 *
 * Necesita conexión, y se dice. El histórico completo de 276 salas no cabe en el
 * espejo local, y descargarlo para el caso en que alguien lo abra sería pagar el
 * arranque de todos por el uso de unos pocos. Lo que sí funciona sin cobertura es
 * seguir una corrección ya empezada: desde que el borrador está en el
 * dispositivo, es una revisión como cualquier otra.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { pullSala } from '@/sync/pull'
import { fechaCorta } from '@/domain/fechas'
import {
  agruparEnVisitas,
  resultadoLegible,
  semillaDeCorreccion,
  type RevisionResumen,
  type Visita,
} from '@/domain/revisiones'
import { ROOM_CHECKS, assetCheckKey } from '@/domain/types'
import { FichaDeRevision, comprobacionesDe } from './FichaDeRevision'
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
   * Qué visita está abierta en su ficha. Se guarda el identificador y no el
   * objeto: la lista se refresca por debajo —al guardar una corrección la
   * versión vigente cambia de id— y una referencia guardada se quedaría
   * enseñando la visita de antes.
   *
   * El ref acompaña al estado para que `preparar` pueda preguntar «¿sigue
   * abierta?» en el momento de resolverse, no en el de dispararse. Guarda la
   * visita entera y no el id: si un refetch cambia la vigente con la ficha
   * abierta, el id con el que se disparó la corrección sigue en su cadena de
   * versiones y la pregunta tiene que seguir contestando que sí.
   */
  const [abiertaId, setAbiertaId] = useState<string | null>(null)
  const abiertaRef = useRef<Visita | null>(null)

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
   * formulario a medio sembrar. `fetchQuery` reutiliza lo que la ficha ya
   * descargó al abrirse.
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
    /*
     * Solo si la ficha SIGUE abierta: con red lenta, quien pulsa «Corregir»,
     * ve «Recuperando…» y se arrepiente cerrando con Escape no puede acabar
     * segundos después en un formulario de corrección que ya no pidió — y que
     * además crea el borrador. Cerrar la ficha es cancelar.
     */
    onSuccess: (correccion, r) => {
      const abierta = abiertaRef.current
      if (abierta && abierta.versiones.some((x) => x.id === r.id)) onCorregir(correccion)
    },
  })

  const filtradas = visitas.filter(FILTROS.find((f) => f.id === filtro)!.cumple)
  const visibles = todas ? filtradas : filtradas.slice(0, A_LA_VISTA)
  const cuenta = (f: Filtro): number =>
    visitas.filter(FILTROS.find((x) => x.id === f)!.cumple).length

  /*
   * La visita abierta se deriva de los datos frescos, no se guarda — y se
   * busca por CUALQUIER versión de su cadena, no solo por la vigente: si un
   * compañero guarda una corrección mientras se lee, la vigente cambia de id
   * pero la visita sigue siendo la misma, y cerrar la ficha en silencio le
   * robaría el punto de lectura a quien no ha hecho nada. Solo si la visita
   * desaparece del todo (fuera de la ventana de 24) la ficha se cierra sola.
   */
  const abierta = visitas.find((v) => v.versiones.some((r) => r.id === abiertaId)) ?? null
  abiertaRef.current = abierta

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
        Una fila por visita. Toca una para abrir su ficha: las fotos, la observación y
        el detalle de cada comprobación. Si algo quedó mal apuntado, desde la ficha se
        corrige.
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

      {visibles.length > 0 && (
        /* Las filas comparten tarjeta, como los edificios comparten lista: son
           entradas de un índice, no cinco documentos sueltos. */
        <ul className="card divide-y divide-line-soft overflow-hidden">
          {visibles.map((v) => (
            <FilaDeVisita
              key={v.vigente.id}
              visita={v}
              enCurso={enCurso.has(v.vigente.id)}
              conFotoLocal={v.versiones.some((r) => conFotoLocal.has(r.id))}
              onAbrir={() => setAbiertaId(v.vigente.id)}
            />
          ))}
        </ul>
      )}

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

      {abierta && (
        <FichaDeRevision
          /* Por visita: cambiar de visita con la capa abierta —posible por
             teclado— tiene que remontar la pantalla, o `viendo` seguiría
             enseñando las comprobaciones de la anterior bajo la fecha nueva. */
          key={abierta.vigente.id}
          visita={abierta}
          enCurso={enCurso.has(abierta.vigente.id)}
          conFotoLocal={abierta.versiones.some((r) => conFotoLocal.has(r.id))}
          preparando={preparar.isPending && preparar.variables?.id === abierta.vigente.id}
          fallo={
            preparar.isError && preparar.variables?.id === abierta.vigente.id
              ? 'No se ha podido recuperar esa revisión. Hace falta conexión para empezar a corregirla.'
              : null
          }
          onCorregir={() => preparar.mutate(abierta.vigente)}
          onCerrar={() => {
            /* Cerrar también limpia la mutación: sin el reset, reabrir la
               visita nacía enseñando el fallo de hace un rato, y una
               recuperación en vuelo navegaría al formulario ya sin público. */
            preparar.reset()
            setAbiertaId(null)
          }}
        />
      )}
    </section>
  )
}

/**
 * Una visita, como fila de índice: la fecha, quién, qué salió y las señales de
 * que dentro hay algo más — fotos, observación, corrección en curso. Todo lo
 * demás vive en la ficha, que es donde cabe.
 */
function FilaDeVisita({
  visita,
  enCurso,
  conFotoLocal,
  onAbrir,
}: {
  visita: Visita
  /** Ya hay una corrección de esta visita empezada en el dispositivo. */
  enCurso: boolean
  /** Hay fotos de esta visita todavía en la cola del dispositivo. */
  conFotoLocal: boolean
  onAbrir: () => void
}): React.ReactElement {
  const { vigente, versiones } = visita
  const original = versiones[0]!
  const corregida = versiones.length > 1
  const fotos = versiones.reduce((n, r) => n + r.fotos, 0)
  const conNota = (vigente.notes ?? '').trim() !== ''

  const señas = [
    original.who ? `Revisó ${original.who}` : 'Sin firma',
    fotos > 0 ? `${fotos} foto${fotos === 1 ? '' : 's'}` : null,
    // La foto de hoy, que el recuento del servidor aún no conoce: sin la seña,
    // la revisión recién hecha parecía no tener su foto hasta que subiera.
    conFotoLocal && fotos === 0 ? 'foto sin subir' : null,
    conNota ? 'con observación' : null,
    corregida ? 'corregida' : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <li>
      <button
        type="button"
        onClick={onAbrir}
        /* El anillo de foco hacia dentro: la card de la lista recorta con
           `overflow-hidden` y el anillo por fuera desaparecía en las filas de
           los extremos — el mismo remedio que las baldosas de la ficha. */
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-100 focus-visible:outline-offset-[-2px] active:bg-raised"
      >
        <span className="min-w-0 flex-1">
          {/* La fecha sola, de índice: la hora la contesta la ficha. */}
          <span className="block font-medium">{fechaCorta(vigente.occurred_at)}</span>
          <span className="mt-0.5 block truncate text-xs text-muted">
            {/* La corrección en curso va PRIMERA y en su color: es la única
                seña accionable, y al final de la línea era justo la que el
                truncado se comía con una firma larga. */}
            {enCurso && <span className="text-accent">corrección en curso · </span>}
            {señas}
          </span>
        </span>

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

        {/* El galón dice «esto se abre» sin gastar una palabra. Mismo tamaño
            que el del histórico plegable: un solo galón en toda la aplicación. */}
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          className="shrink-0 text-muted"
        >
          <path
            d="M9 6l6 6-6 6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </li>
  )
}
