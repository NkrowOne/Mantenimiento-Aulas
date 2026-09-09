import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { displayRoomCode } from '@/domain/normalize'
import { fechaCorta } from '@/domain/fechas'
import type { Role } from '@/domain/types'

/**
 * Los ordenadores de repuesto: los PCs del almacén, uno por número de serie.
 *
 * El almacén de arriba cuenta —«quedan 7 Ordenador Tiny M70Q»— y esto nombra:
 * cuál es cada uno, y dónde está. Es la cara en la aplicación de la hoja
 * «PCs STOCK» del Excel: lo que se da de alta aquí sale en la hoja, y lo que
 * se teclea en la hoja entra aquí al sincronizar.
 *
 * Instalar uno en un aula es lo que cierra el círculo: crea el equipo en la
 * sala con su número de serie, retira el ordenador que hubiera, descuenta la
 * unidad del almacén y deja la unidad como «instalada en 2.1 C». Todo eso lo
 * hace `stock_unit_instalar` en la base, de una vez, para que no quede un
 * ordenador en dos sitios.
 */

interface Unidad {
  id: string
  articulo: string
  brand: string | null
  model: string | null
  serial: string
  notes: string | null
  status: 'disponible' | 'instalado' | 'baja'
  room_id: string | null
  installed_at: string | null
  retired_at: string | null
}

interface SalaElegible {
  id: string
  buildingId: string
  etiqueta: string
}

const ESTADO: Record<Unidad['status'], string> = {
  disponible: 'En almacén',
  instalado: 'Instalado',
  baja: 'Baja',
}

export function UnidadesDeAlmacen({ role }: { role: Role }): React.ReactElement {
  const qc = useQueryClient()
  const [alta, setAlta] = useState(false)
  const [verTodas, setVerTodas] = useState(false)
  const [fallo, setFallo] = useState<string | null>(null)
  const esSupervisor = role === 'supervisor' || role === 'admin'

  const { data: unidades, isPending, isError } = useQuery({
    queryKey: ['stock-units'],
    queryFn: async (): Promise<Unidad[]> => {
      const { data, error } = await supabase
        .from('stock_units')
        .select('id, articulo, brand, model, serial, notes, status, room_id, installed_at, retired_at')
        .order('status')
        .order('articulo')
        .order('model')
        .order('serial')
      if (error) throw error
      return (data ?? []) as Unidad[]
    },
  })

  /* Salas y edificios del espejo, para elegir dónde se instala. */
  const maestro = useLiveQuery(async () => {
    const [rooms, zones, buildings] = await Promise.all([
      db.rooms.toArray(),
      db.zones.toArray(),
      db.buildings.orderBy('sort_order').toArray(),
    ])
    const zonaEdificio = new Map(zones.map((z) => [z.id, z.building_id]))
    const salas: SalaElegible[] = rooms
      .map((r) => ({
        id: r.id,
        buildingId: zonaEdificio.get(r.zone_id) ?? '',
        etiqueta: `${displayRoomCode(r.code)}${r.name && r.name !== r.code ? ` — ${r.name}` : ''}`,
      }))
      .sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, 'es', { numeric: true }))
    const nombreDeSala = new Map(
      rooms.map((r) => {
        const b = buildings.find((x) => x.id === zonaEdificio.get(r.zone_id))
        return [r.id, `${displayRoomCode(r.code)}${b ? ` (${b.name})` : ''}`]
      }),
    )
    return { salas, edificios: buildings.map((b) => ({ id: b.id, code: b.code, name: b.name })), nombreDeSala }
  }, [])

  const refrescar = (): void => {
    void qc.invalidateQueries({ queryKey: ['stock-units'] })
    void qc.invalidateQueries({ queryKey: ['stock-levels'] })
  }

  const crear = useMutation({
    mutationFn: async (p: { articulo: string; marca: string; modelo: string; serial: string; observaciones: string }) => {
      const { error } = await supabase.rpc('stock_unit_alta', { p })
      if (error) throw error
    },
    onSuccess: () => {
      setAlta(false)
      setFallo(null)
      refrescar()
    },
    onError: (e: Error) => setFallo(e.message),
  })

  const instalar = useMutation({
    mutationFn: async (input: { unidad: string; sala: string }) => {
      const { error } = await supabase.rpc('stock_unit_instalar', {
        p_unit: input.unidad,
        p_room: input.sala,
        p_note: null,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setFallo(null)
      refrescar()
    },
    onError: (e: Error) => setFallo(e.message),
  })

  const baja = useMutation({
    mutationFn: async (input: { unidad: string; nota: string }) => {
      const { error } = await supabase.rpc('stock_unit_baja', { p_unit: input.unidad, p_note: input.nota || null })
      if (error) throw error
    },
    onSuccess: () => {
      setFallo(null)
      refrescar()
    },
    onError: (e: Error) => setFallo(e.message),
  })

  const lista = (unidades ?? []).filter((u) => verTodas || u.status === 'disponible')
  const disponibles = (unidades ?? []).filter((u) => u.status === 'disponible').length
  const ocupado = crear.isPending || instalar.isPending || baja.isPending

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">PCs de repuesto</h2>
          <p className="text-sm text-muted">
            {isPending
              ? 'Cargando…'
              : `${disponibles} ${disponibles === 1 ? 'ordenador disponible' : 'ordenadores disponibles'} en el almacén, por número de serie.`}
          </p>
        </div>
        {esSupervisor && (
          <button
            type="button"
            onClick={() => setAlta((v) => !v)}
            className="key key-accent min-h-11 shrink-0 px-3 text-sm"
          >
            {alta ? 'Cancelar' : 'Nuevo PC'}
          </button>
        )}
      </div>

      {isError && (
        <p className="mt-3 text-sm text-crit">
          No se pudieron leer los ordenadores de repuesto. Si el servidor no está al día, falta la
          migración de septiembre.
        </p>
      )}
      {fallo && <p className="mt-3 rounded-ctl bg-crit-fill p-3 text-sm text-crit-ink">{fallo}</p>}

      {alta && (
        <form
          className="card mt-4 grid gap-3 p-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            const serial = String(f.get('serial') ?? '').trim()
            if (!serial) return
            crear.mutate({
              articulo: String(f.get('articulo') ?? '').trim() || 'Ordenador Tiny',
              marca: String(f.get('marca') ?? '').trim(),
              modelo: String(f.get('modelo') ?? '').trim(),
              serial,
              observaciones: String(f.get('observaciones') ?? '').trim(),
            })
          }}
        >
          <Campo nombre="articulo" etiqueta="Artículo" valor="Ordenador Tiny" />
          <Campo nombre="marca" etiqueta="Marca" valor="Lenovo ThinkCentre" />
          <Campo nombre="modelo" etiqueta="Modelo" valor="" pista="M710Q" />
          <Campo nombre="serial" etiqueta="Número de serie" valor="" pista="S4GM1899" requerido />
          <div className="sm:col-span-2">
            <Campo nombre="observaciones" etiqueta="Observaciones" valor="" pista="Ordenador con imagen funcional de repuesto" />
          </div>
          <div className="sm:col-span-2">
            <button type="submit" disabled={ocupado} className="key key-accent min-h-11 px-4 text-sm">
              {crear.isPending ? 'Guardando…' : 'Dar de alta'}
            </button>
          </div>
        </form>
      )}

      {!isPending && (unidades ?? []).length > 0 && (
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={verTodas} onChange={(e) => setVerTodas(e.target.checked)} />
          Ver también los instalados y los de baja
        </label>
      )}

      <ul className="mt-3 divide-y divide-hair">
        {lista.map((u) => (
          <FilaDeUnidad
            key={u.id}
            unidad={u}
            sala={u.room_id ? (maestro?.nombreDeSala.get(u.room_id) ?? null) : null}
            salas={maestro?.salas ?? []}
            edificios={maestro?.edificios ?? []}
            ocupado={ocupado}
            puedeInstalar
            puedeDarDeBaja={esSupervisor}
            onInstalar={(sala) => instalar.mutate({ unidad: u.id, sala })}
            onBaja={(nota) => baja.mutate({ unidad: u.id, nota })}
          />
        ))}
        {!isPending && lista.length === 0 && (
          <li className="py-3 text-sm text-muted">
            {verTodas ? 'No hay ordenadores de repuesto.' : 'No hay ordenadores disponibles en el almacén.'}
          </li>
        )}
      </ul>
    </section>
  )
}

function Campo({
  nombre,
  etiqueta,
  valor,
  pista,
  requerido,
}: {
  nombre: string
  etiqueta: string
  valor: string
  pista?: string
  requerido?: boolean
}): React.ReactElement {
  return (
    <label className="block text-sm">
      <span className="text-muted">{etiqueta}</span>
      <input
        name={nombre}
        defaultValue={valor}
        placeholder={pista}
        required={requerido}
        className="mt-1 h-10 w-full rounded-ctl border border-line bg-surface px-2 text-base"
      />
    </label>
  )
}

function FilaDeUnidad({
  unidad,
  sala,
  salas,
  edificios,
  ocupado,
  puedeInstalar,
  puedeDarDeBaja,
  onInstalar,
  onBaja,
}: {
  unidad: Unidad
  sala: string | null
  salas: SalaElegible[]
  edificios: Array<{ id: string; code: string; name: string }>
  ocupado: boolean
  puedeInstalar: boolean
  puedeDarDeBaja: boolean
  onInstalar: (roomId: string) => void
  onBaja: (nota: string) => void
}): React.ReactElement {
  const [abierto, setAbierto] = useState<'instalar' | 'baja' | null>(null)
  const [buildingId, setBuildingId] = useState('')
  const [roomId, setRoomId] = useState('')
  const [nota, setNota] = useState('')
  const delEdificio = salas.filter((s) => s.buildingId === buildingId)

  const situacion =
    unidad.status === 'instalado'
      ? `Instalado en ${sala ?? '?'}${unidad.installed_at ? ` · ${fechaCorta(unidad.installed_at)}` : ''}`
      : unidad.status === 'baja'
        ? `Baja${unidad.retired_at ? ` · ${fechaCorta(unidad.retired_at)}` : ''}`
        : ESTADO.disponible

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-sm font-semibold">{unidad.serial}</span>
        <span className="text-sm">{[unidad.articulo, unidad.brand, unidad.model].filter(Boolean).join(' ')}</span>
        <span
          className={`text-xs ${unidad.status === 'disponible' ? 'text-ok-ink' : unidad.status === 'baja' ? 'text-crit' : 'text-muted'}`}
        >
          {situacion}
        </span>
      </div>
      {unidad.notes && <p className="mt-1 text-xs text-muted">{unidad.notes}</p>}

      {unidad.status === 'disponible' && abierto === null && (
        <div className="mt-2 flex flex-wrap gap-2">
          {puedeInstalar && (
            <button
              type="button"
              className="key key-accent h-10 px-3 text-sm"
              disabled={ocupado}
              onClick={() => setAbierto('instalar')}
            >
              Instalar en un aula
            </button>
          )}
          {puedeDarDeBaja && (
            <button
              type="button"
              className="key key-quiet h-10 px-3 text-sm"
              disabled={ocupado}
              onClick={() => setAbierto('baja')}
            >
              Dar de baja
            </button>
          )}
        </div>
      )}

      {abierto === 'instalar' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            value={buildingId}
            onChange={(e) => {
              setBuildingId(e.target.value)
              setRoomId('')
            }}
            aria-label="Edificio"
            className="h-10 rounded-ctl border border-line bg-surface px-2 text-base"
          >
            <option value="">Edificio…</option>
            {edificios.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.name}
              </option>
            ))}
          </select>
          <select
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            disabled={!buildingId}
            aria-label="Sala"
            className="h-10 rounded-ctl border border-line bg-surface px-2 text-base"
          >
            <option value="">{buildingId ? 'Sala…' : 'Elige edificio'}</option>
            {delEdificio.map((s) => (
              <option key={s.id} value={s.id}>
                {s.etiqueta}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!roomId || ocupado}
            onClick={() => {
              onInstalar(roomId)
              setAbierto(null)
            }}
            className="key key-accent h-10 px-3 text-sm"
          >
            Instalar
          </button>
          <button type="button" className="key key-quiet h-10 px-3 text-sm" onClick={() => setAbierto(null)}>
            Cancelar
          </button>
          <p className="basis-full text-xs text-muted">
            Se crea el equipo en el aula con este número de serie, se retira el ordenador que hubiera y se
            descuenta una unidad del almacén.
          </p>
        </div>
      )}

      {abierto === 'baja' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            placeholder="Por qué (opcional)"
            aria-label="Motivo de la baja"
            className="h-10 min-w-56 rounded-ctl border border-line bg-surface px-2 text-base"
          />
          <button
            type="button"
            disabled={ocupado}
            onClick={() => {
              onBaja(nota)
              setAbierto(null)
            }}
            className="key key-quiet h-10 px-3 text-sm"
          >
            Confirmar la baja
          </button>
          <button type="button" className="key key-quiet h-10 px-3 text-sm" onClick={() => setAbierto(null)}>
            Cancelar
          </button>
        </div>
      )}
    </li>
  )
}
