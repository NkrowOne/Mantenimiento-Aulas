import { useMemo, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { displayRoomCode } from '@/domain/normalize'
import { fechaCorta, horaCorta } from '@/domain/fechas'
import {
  OPERACION_LABELS,
  SIN_NOMBRES,
  TABLAS,
  describir,
  type Actividad as Cambio,
  type FilaDeAuditoria,
  type Nombres,
} from '@/domain/actividad'
import { Cargando, EstadoVacio, FalloDeCarga, Seccion } from './Seccion'

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
 * Los nombres de salas, edificios y tipos salen del espejo del dispositivo,
 * que ya está descargado: traducir mil uuid no cuesta ninguna consulta. Lo que
 * el espejo no tiene —una sala borrada— sale abreviado, que es lo honesto.
 */

const TAMANO = 100

const PERIODOS: Array<{ dias: number; label: string }> = [
  { dias: 7, label: 'Última semana' },
  { dias: 30, label: 'Último mes' },
  { dias: 90, label: 'Últimos tres meses' },
  { dias: 0, label: 'Todo' },
]

const TONO_OP: Record<Cambio['op'], string> = {
  alta: 'bg-ok-tint text-ok',
  cambio: 'bg-raised text-muted',
  baja: 'bg-crit-tint text-crit',
}

export function Actividad(): React.ReactElement {
  const [dias, setDias] = useState(7)
  const [tabla, setTabla] = useState('')
  const [persona, setPersona] = useState('')

  const { data: perfiles } = useQuery({
    queryKey: ['perfiles', 'nombres'],
    queryFn: async () => {
      const { data } = await supabase.from('profiles').select('id, full_name').order('full_name')
      return (data ?? []) as Array<{ id: string; full_name: string }>
    },
    staleTime: 5 * 60_000,
  })

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
      personas: new Map((perfiles ?? []).map((p) => [p.id, p.full_name])),
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
  const porDia = new Map<string, Cambio[]>()
  for (const c of visibles) {
    const dia = fechaCorta(c.cuando)
    porDia.set(dia, [...(porDia.get(dia) ?? []), c])
  }

  const filtros = (
    <>
      <select
        value={dias}
        onChange={(e) => setDias(Number(e.target.value))}
        aria-label="Periodo"
        className="h-11 rounded-ctl border border-line bg-surface px-2 text-base"
      >
        {PERIODOS.map((p) => (
          <option key={p.dias} value={p.dias}>
            {p.label}
          </option>
        ))}
      </select>
      <select
        value={tabla}
        onChange={(e) => setTabla(e.target.value)}
        aria-label="Qué"
        className="h-11 rounded-ctl border border-line bg-surface px-2 text-base"
      >
        <option value="">Todo</option>
        {Object.entries(TABLAS).map(([id, t]) => (
          <option key={id} value={id}>
            {t.nombre}
          </option>
        ))}
      </select>
      <select
        value={persona}
        onChange={(e) => setPersona(e.target.value)}
        aria-label="Quién"
        className="h-11 max-w-48 rounded-ctl border border-line bg-surface px-2 text-base"
      >
        <option value="">Cualquiera</option>
        {(perfiles ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.full_name}
          </option>
        ))}
      </select>
    </>
  )

  return (
    <Seccion
      id="sec-actividad"
      titulo="Actividad"
      texto="Quién cambió qué y cuándo, en salas, edificios, equipos, incidencias, catálogo y usuarios. Solo se lee: lo que haya que corregir se corrige en su sección. Las revisiones, los movimientos del almacén y los eventos de equipo no están aquí porque tienen su propio histórico."
      acciones={filtros}
    >
      {isPending && <Cargando texto="Leyendo la actividad…" />}
      {isError && <FalloDeCarga que="la actividad" error={error} onReintentar={() => void refetch()} />}
      {data && visibles.length === 0 && (
        <EstadoVacio
          titulo="Sin actividad"
          texto={omitidas > 0 ? `Solo cambios automáticos (${omitidas}).` : 'Nadie ha cambiado nada en este periodo con estos filtros.'}
        />
      )}

      <div className="space-y-5">
        {[...porDia.entries()].map(([dia, lista]) => (
          <section key={dia} aria-label={dia}>
            <h3 className="eyebrow sticky top-0 bg-ground py-1">{dia}</h3>
            <ol className="mt-1 divide-y divide-line-soft rounded-card border border-line bg-surface">
              {lista.map((c) => (
                <li key={c.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                    <span className="font-mono text-xs text-muted tabular">{horaCorta(c.cuando)}</span>
                    <span className="font-medium">{c.quien ?? 'Sistema'}</span>
                    <span className={`rounded-tag px-1.5 py-0.5 text-[0.6875rem] font-medium ${TONO_OP[c.op]}`}>
                      {OPERACION_LABELS[c.op]}
                    </span>
                    <span className="rounded-tag bg-raised px-1.5 py-0.5 text-[0.6875rem] text-muted">{c.tabla}</span>
                    <span className="min-w-0 break-words">{c.que}</span>
                  </div>
                  {c.cambios.length > 0 && (
                    <dl className="mt-1.5 space-y-0.5 pl-0 text-sm sm:pl-14">
                      {c.cambios.map((x) => (
                        <div key={x.campo} className="flex flex-wrap gap-x-1.5">
                          <dt className="text-muted">{x.campo}:</dt>
                          <dd className="min-w-0 break-words">
                            <span className={x.antes === null ? 'text-muted' : 'line-through decoration-line'}>
                              {x.antes ?? '—'}
                            </span>
                            <span aria-hidden className="mx-1 text-muted">
                              →
                            </span>
                            <span className="sr-only">pasa a</span>
                            <span className="font-medium">{x.despues ?? '—'}</span>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>

      {(hasNextPage || omitidas > 0) && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {hasNextPage && (
            <button
              type="button"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
              className="key key-quiet min-h-11 px-3 text-sm"
            >
              {isFetchingNextPage ? 'Cargando…' : 'Ver más antiguos'}
            </button>
          )}
          {omitidas > 0 && (
            <p className="text-xs text-muted">
              {omitidas === 1 ? 'Un cambio automático omitido' : `${omitidas} cambios automáticos omitidos`} (fechas de
              última revisión e inventario, orden).
            </p>
          )}
        </div>
      )}
    </Seccion>
  )
}
