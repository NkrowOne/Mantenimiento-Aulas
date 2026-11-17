import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { pullPersonas, useDirectorio } from '@/sync/personas'
import { displayRoomCode } from '@/domain/normalize'
import { diaEnMadrid, horaCorta } from '@/domain/fechas'
import {
  SIN_NOMBRES,
  TABLAS,
  describir,
  formaDelCambio,
  loQueHizo,
  type Actividad as Cambio,
  type Cambio as CambioDeCampo,
  type FilaDeAuditoria,
  type Nombres,
} from '@/domain/actividad'
import { Icono, type NombreDeIcono } from '@/components/Icono'
import { cuantos } from '@/lib/plural'
import { Cargando, EstadoVacio, FalloDeCarga, Seccion } from './Seccion'
import { useEstadoDeSesion } from '@/lib/estado-de-sesion'

/**
 * Quién cambió qué, y cuándo.
 *
 * La base lo guarda todo desde el primer día (`audit_log`), pero solo se podía
 * leer con SQL desde el servidor, así que «¿quién ha quitado el proyector del
 * 1.7?» se contestaba con una consulta que nadie hacía. Aquí se lee con
 * palabras: la fila con su nombre, la persona, y cada campo con lo que decía y
 * lo que dice. La traducción vive en `domain/actividad.ts`; esto solo la pide
 * y la pinta.
 *
 * Solo lectura, y a propósito: la auditoría no se corrige. Lo que se descubre
 * aquí se arregla en su sección.
 *
 * La ve todo el personal, no solo el panel de administración: la trazabilidad
 * es para quien trabaja en las aulas. Al técnico la base no le da los cambios
 * de usuarios —llevan el correo y el rol—, y por eso esa opción no se le
 * ofrece (`usuarios`).
 *
 * Los nombres de salas, edificios y tipos salen del espejo del dispositivo,
 * que ya está descargado: traducir mil uuid no cuesta ninguna consulta. Lo que
 * el espejo no tiene —una sala borrada— sale abreviado, que es lo honesto.
 */

const TAMANO = 100

/* Etiquetas cortas: van las cuatro en una fila, a partes iguales, en un
   teléfono. «Últimos tres meses» no cabía ni en un desplegable. */
const PERIODOS: Array<{ dias: number; label: string }> = [
  { dias: 7, label: '7 días' },
  { dias: 30, label: '30 días' },
  { dias: 90, label: '90 días' },
  { dias: 0, label: 'Todo' },
]

/**
 * El dibujo de cada cosa y el color de lo que se hizo con ella.
 *
 * Antes eran dos etiquetas grises seguidas —«Cambio» «Incidencia»— iguales en
 * todas las filas, así que no ayudaban a encontrar nada. Ahora el recuadro de
 * la izquierda dice las dos cosas sin leer: el dibujo, DE QUÉ es; el color, QUÉ
 * se hizo —verde un alta, rojo una baja, el de la aplicación un cambio—.
 */
const DIBUJO: Record<string, NombreDeIcono> = {
  buildings: 'edificio',
  zones: 'edificio',
  rooms: 'etiqueta',
  stock_items: 'almacen',
  stock_units: 'almacen',
  assets: 'equipos',
  incidents: 'incidencias',
  profiles: 'persona',
  asset_types: 'lista',
  asset_removals: 'salir',
  asset_defaults: 'lista',
}

const TONO_OP: Record<Cambio['op'], string> = {
  alta: 'bg-ok-tint text-ok',
  cambio: 'bg-accent-tint text-accent',
  baja: 'bg-crit-tint text-crit',
}

/** Cuántos campos enseña un cambio antes de pedir un toque para ver el resto. */
const CAMPOS_A_LA_VISTA = 3

/** «Hoy», «Ayer» o el día dicho entero: es como se busca —«lo del martes»—. */
function nombreDelDia(dia: string, hoy: string): string {
  const [a, m, d] = dia.split('-').map(Number)
  const [ha, hm, hd] = hoy.split('-').map(Number)
  // El día de antes, por el calendario: el 1 de marzo, ayer fue 28 o 29 de febrero.
  const ayer = new Date(Date.UTC(ha!, hm! - 1, hd! - 1)).toISOString().slice(0, 10)
  if (dia === hoy) return 'Hoy'
  if (dia === ayer) return 'Ayer'
  const texto = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(a === Number(hoy.slice(0, 4)) ? {} : { year: 'numeric' }),
  }).format(new Date(Date.UTC(a!, m! - 1, d!)))
  return texto.charAt(0).toUpperCase() + texto.slice(1)
}

/**
 * Un campo que cambió, dicho de la forma que se lee mejor según lo que mide.
 *
 * Sin tachados. El valor de antes iba tachado, y un texto largo tachado no se
 * lee: es justo el dato que hace falta —«¿cómo se llamaba?»— convertido en una
 * mancha. Ahora el de antes va en gris y el de ahora en negro y con peso: se
 * distinguen igual, y los dos se pueden leer.
 */
function CampoCambiado({ cambio }: { cambio: CambioDeCampo }): React.ReactElement {
  const forma = formaDelCambio(cambio)
  return (
    <div className="py-1.5">
      <dt className="text-xs text-muted">{cambio.campo}</dt>
      <dd className="mt-0.5 min-w-0 break-words text-sm">
        {forma === 'nuevo' && <span className="font-medium">{cambio.despues}</span>}
        {forma === 'quitado' && (
          <>
            <span className="text-muted">Se quitó: </span>
            {cambio.antes}
          </>
        )}
        {forma === 'corto' && (
          <>
            <span className="text-muted">{cambio.antes}</span>
            <Icono nombre="derecha" lado={13} className="mx-1.5 inline-block -translate-y-px text-muted" />
            <span className="sr-only">pasa a</span>
            <span className="font-medium">{cambio.despues}</span>
          </>
        )}
        {forma === 'largo' && (
          <span className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
            <span className="text-xs leading-5 text-muted">Antes</span>
            <span className="text-muted">{cambio.antes}</span>
            <span className="text-xs leading-5 text-muted">Ahora</span>
            <span className="font-medium">{cambio.despues}</span>
          </span>
        )}
      </dd>
    </div>
  )
}

/** Una fila de la actividad: quién, qué hizo, a qué, y qué cambió. */
function Fila({ c }: { c: Cambio }): React.ReactElement {
  const [todos, setTodos] = useState(false)
  const visibles = todos ? c.cambios : c.cambios.slice(0, CAMPOS_A_LA_VISTA)
  const ocultos = c.cambios.length - CAMPOS_A_LA_VISTA

  return (
    <li className="flex gap-3 px-3.5 py-3">
      <span
        className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] ${TONO_OP[c.op]}`}
      >
        <Icono nombre={DIBUJO[c.origen] ?? 'actividad'} lado={20} />
      </span>

      <div className="min-w-0 flex-1">
        {/* Quién y cuándo, en el mismo renglón: el nombre a la izquierda, que
            es por lo que se busca, y la hora a la derecha, alineada en todas
            las filas. */}
        <div className="flex items-baseline justify-between gap-3">
          <p className="min-w-0 truncate font-medium">{c.quien ?? 'Sistema'}</p>
          <time dateTime={c.cuando} className="shrink-0 font-mono text-xs text-muted tabular">
            {horaCorta(c.cuando)}
          </time>
        </div>
        <p className="text-sm text-ink-2">{loQueHizo(c)}</p>

        {/* A qué. Hasta dos renglones: el título de una incidencia puede ser un
            párrafo, y entero empujaba fuera de la pantalla lo que cambió. */}
        <p className="mt-1.5 line-clamp-2 break-words text-sm font-medium">{c.que}</p>

        {c.cambios.length > 0 && (
          <dl className="mt-1.5 divide-y divide-line-soft rounded-ctl bg-ground px-3 py-0.5">
            {visibles.map((x) => (
              <CampoCambiado key={x.campo} cambio={x} />
            ))}
          </dl>
        )}
        {ocultos > 0 && (
          <button
            type="button"
            onClick={() => setTodos((v) => !v)}
            aria-expanded={todos}
            className="key-ghost -ml-2 mt-0.5 inline-flex min-h-11 items-center gap-1 px-2 text-sm"
          >
            {todos ? 'Ver menos' : `Ver ${cuantos(ocultos, 'cambio más', 'cambios más')}`}
            <Icono
              nombre="abajo"
              lado={14}
              className={`transition-transform duration-150 ${todos ? 'rotate-180' : ''}`}
            />
          </button>
        )}
      </div>
    </li>
  )
}

export function Actividad({
  usuarios = true,
}: {
  /** Si quien mira puede leer los cambios de usuarios (supervisor o más). */
  usuarios?: boolean
} = {}): React.ReactElement {
  const [dias, setDias] = useEstadoDeSesion('actividad.dias', 7)
  const [tabla, setTabla] = useEstadoDeSesion('actividad.tabla', '')
  const [persona, setPersona] = useEstadoDeSesion('actividad.persona', '')

  /*
   * Los nombres salen del directorio del dispositivo, no de `profiles`: a un
   * técnico `profiles` solo le enseña el suyo, y la lista de «Quién» se le
   * quedaba en una persona. Se refresca al abrir, que es barato —unas decenas
   * de filas— y trae a quien se haya dado de alta desde la última descarga.
   */
  useEffect(() => {
    void pullPersonas()
  }, [])
  const directorio = useDirectorio()
  const perfiles = useMemo(
    () =>
      Object.entries(directorio)
        .map(([id, full_name]) => ({ id, full_name }))
        .sort((a, b) => a.full_name.localeCompare(b.full_name, 'es')),
    [directorio],
  )

  const espejo = useLiveQuery(async () => {
    const [rooms, zones, buildings, tipos, assets, articulos] = await Promise.all([
      db.rooms.toArray(),
      db.zones.toArray(),
      db.buildings.toArray(),
      db.assetTypes.toArray(),
      db.assets.toArray(),
      db.stockItems.toArray(),
    ])
    const edificioDeZona = new Map(zones.map((z) => [z.id, buildings.find((b) => b.id === z.building_id)]))
    return {
      salas: new Map(
        rooms.map((r) => {
          const b = edificioDeZona.get(r.zone_id)
          const codigo = `${b ? `${b.code} ` : ''}${displayRoomCode(r.code)}`
          return [r.id, r.name && r.name !== r.code ? `${codigo} — ${r.name}` : codigo]
        }),
      ),
      plantas: new Map(zones.map((z) => [z.id, z.name])),
      edificios: new Map(buildings.map((b) => [b.id, `${b.code} — ${b.name}`])),
      tipos: new Map(tipos.map((t) => [t.id, t.name])),
      equipos: new Map(assets.map((a) => [a.id, a.label ?? tipos.find((t) => t.id === a.asset_type_id)?.name ?? 'Equipo'])),
      articulos: new Map(articulos.map((s) => [s.id, s.name])),
    }
  }, [])

  const nombres: Nombres = useMemo(
    () => ({
      ...(espejo ?? SIN_NOMBRES),
      personas: new Map(perfiles.map((p) => [p.id, p.full_name])),
    }),
    [espejo, perfiles],
  )

  const desde = dias > 0 ? new Date(Date.now() - dias * 86_400_000).toISOString() : null

  const { data, isPending, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['actividad', desde?.slice(0, 10) ?? 'todo', tabla, persona],
    initialPageParam: null as number | null,
    queryFn: async ({ pageParam }): Promise<FilaDeAuditoria[]> => {
      let q = supabase
        .from('audit_log')
        .select('id, table_name, row_id, op, old_data, new_data, by_user, at')
        // Por id y no por fecha: dos cambios en el mismo instante se ordenan
        // igual en cada página, y el cursor no repite ni salta filas.
        .order('id', { ascending: false })
        .limit(TAMANO)
      if (pageParam !== null) q = q.lt('id', pageParam)
      if (desde) q = q.gte('at', desde)
      if (tabla) q = q.eq('table_name', tabla)
      if (persona) q = q.eq('by_user', persona)
      const { data: filas, error: err } = await q
      if (err) throw err
      return (filas ?? []) as FilaDeAuditoria[]
    },
    getNextPageParam: (ultima) => (ultima.length === TAMANO ? ultima[ultima.length - 1]!.id : undefined),
  })

  const filas = data?.pages.flat() ?? []
  const contadas = filas.map((f) => describir(f, nombres))
  const visibles = contadas.filter((c): c is Cambio => c !== null)
  const omitidas = contadas.length - visibles.length

  // Por día, con el más reciente arriba: es como se busca —«el martes por la
  // tarde desapareció»— y no por tabla.
  const hoy = diaEnMadrid()
  const porDia = new Map<string, Cambio[]>()
  for (const c of visibles) {
    const dia = diaEnMadrid(new Date(c.cuando))
    porDia.set(dia, [...(porDia.get(dia) ?? []), c])
  }

  const filtrado = tabla !== '' || persona !== ''

  /*
   * Los filtros, cada uno diciendo qué filtra.
   *
   * Eran tres desplegables sin nombre —«Última semana», «Todo», «Cualquiera»—:
   * «Todo» ¿de qué?, «Cualquiera» ¿quién? Había que abrirlos para saberlo. Y
   * el tercero medía menos que los otros dos y caía solo en su fila.
   *
   *  - El periodo son cuatro opciones cortas: van a la vista, en un carril, y
   *    se cambia de un toque en vez de abrir un desplegable.
   *  - Los otros dos llevan su nombre encima, miden lo mismo, y su opción de
   *    «sin filtro» dice lo que es: «Todos», «Todas».
   */
  const CAMPO = 'mt-1 h-11 w-full min-w-0 rounded-ctl border border-line bg-surface px-2 text-base text-ink'
  const filtros = (
    <div>
      <div role="group" aria-label="Periodo" className="segmento grid w-full grid-cols-4">
        {PERIODOS.map((p) => (
          <button key={p.dias} type="button" aria-pressed={dias === p.dias} onClick={() => setDias(p.dias)}>
            {p.label}
          </button>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="text-xs text-muted">
          Qué
          <select value={tabla} onChange={(e) => setTabla(e.target.value)} className={CAMPO}>
            <option value="">Todo</option>
            {Object.entries(TABLAS)
              .filter(([id]) => usuarios || id !== 'profiles')
              .map(([id, t]) => (
                <option key={id} value={id}>
                  {t.nombre}
                </option>
              ))}
          </select>
        </label>
        <label className="text-xs text-muted">
          Quién
          <select value={persona} onChange={(e) => setPersona(e.target.value)} className={CAMPO}>
            <option value="">Todas las personas</option>
            {perfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Cuánto hay con lo elegido, y cómo deshacerlo. */}
      {data && (
        <div className="mt-1 flex min-h-11 items-center justify-between gap-3">
          <p aria-live="polite" className="text-sm text-muted">
            {cuantos(visibles.length, 'cambio', 'cambios')}
            {hasNextPage ? ' hasta ahora' : ''}
          </p>
          {filtrado && (
            <button
              type="button"
              onClick={() => {
                setTabla('')
                setPersona('')
              }}
              className="key-ghost -mr-2 inline-flex min-h-11 items-center gap-1 px-2 text-sm"
            >
              <Icono nombre="cerrar" lado={14} />
              Quitar filtros
            </button>
          )}
        </div>
      )}
    </div>
  )

  return (
    <Seccion
      id="sec-actividad"
      titulo="Actividad"
      texto={`Quién ha cambiado qué en salas, edificios, equipos, incidencias${usuarios ? ', catálogo y usuarios' : ' y catálogo'}. Solo lectura.`}
      detalle="Las revisiones, los movimientos del almacén y los eventos de equipo no salen aquí: se consultan en Historial."
    >
      {filtros}

      {isPending && <Cargando texto="Leyendo la actividad…" />}
      {isError && <FalloDeCarga que="la actividad" error={error} onReintentar={() => void refetch()} />}
      {data && visibles.length === 0 && (
        <EstadoVacio
          titulo="Sin actividad"
          texto={omitidas > 0 ? `Solo cambios automáticos (${omitidas}).` : 'Nadie ha cambiado nada en este periodo con estos filtros.'}
        />
      )}

      <div className="mt-2 space-y-5">
        {[...porDia.entries()].map(([dia, lista]) => (
          <section key={dia} aria-label={nombreDelDia(dia, hoy)}>
            {/* El día y cuántos cambios tuvo: «Hoy · 12» dice de un vistazo si
                fue un día tranquilo o no, sin contar filas. */}
            <h3 className="sticky top-0 z-[1] flex items-baseline justify-between gap-3 bg-ground py-1.5">
              <span className="text-sm font-semibold">{nombreDelDia(dia, hoy)}</span>
              <span className="text-xs text-muted tabular">{cuantos(lista.length, 'cambio', 'cambios')}</span>
            </h3>
            <ol className="card divide-y divide-line-soft overflow-hidden">
              {lista.map((c) => (
                <Fila key={c.id} c={c} />
              ))}
            </ol>
          </section>
        ))}
      </div>

      {(hasNextPage || omitidas > 0) && (
        <div className="mt-4">
          {hasNextPage && (
            <button
              aria-busy={isFetchingNextPage}
              type="button"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
              className="key key-quiet min-h-touch w-full px-3 text-sm sm:w-auto"
            >
              {isFetchingNextPage ? 'Cargando…' : 'Ver cambios más antiguos'}
            </button>
          )}
          {omitidas > 0 && (
            <p className="mt-2 text-xs text-muted">
              {omitidas === 1 ? 'Un cambio automático omitido' : `${omitidas} cambios automáticos omitidos`} (fechas de
              última revisión e inventario, orden).
            </p>
          )}
        </div>
      )}
    </Seccion>
  )
}
