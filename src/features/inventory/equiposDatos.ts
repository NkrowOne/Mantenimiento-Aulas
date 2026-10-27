/**
 * De dónde lee la pantalla de Equipos, y cómo se refresca después de tocar algo.
 *
 * **Lee del servidor, no del espejo**, y es a propósito. El espejo del iPad
 * guarda los equipos de las aulas para poder revisar sin cobertura, pero no
 * guarda los retirados, ni el histórico de entradas y salidas, ni la ficha de
 * compra: es la lista de trabajo de quien está en el pasillo, no el registro
 * del parque. Esta pantalla contesta preguntas de despacho —qué se ha comprado,
 * qué está obsoleto, dónde acabó el número de serie tal— y la respuesta tiene
 * que ser la de la base, entera.
 *
 * Lo único que sale del espejo es el maestro de salas y el catálogo de tipos,
 * que son los desplegables: ya están en el dispositivo y pedirlos otra vez solo
 * haría la pantalla más lenta.
 */

import { useQuery, type QueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { descargaEntera } from '@/sync/paginada'
import { pullSala } from '@/sync/pull'
import { displayRoomCode } from '@/domain/normalize'
import type { EquipoDelRegistro, MovimientoDeEquipo } from '@/domain/fichaDeEquipo'

/**
 * Lo que dice un fallo, en palabras de quien lo lee.
 *
 * El caso que hay que distinguir es el servidor sin la migración del 27 de
 * octubre: la vista no existe y PostgREST contesta con su nombre técnico, que
 * no le dice nada a nadie.
 */
export function mensajeDeFallo(error: unknown): string {
  const m = error instanceof Error ? error.message : (error as { message?: string } | null)?.message ?? ''
  if (/asset_registry|asset_movements|asset_registrar_entrada|asset_dar_de_baja|asset_trasladar|asset_type_vida_util/.test(m) && /exist|schema cache|not find/i.test(m)) {
    return 'El servidor todavía no tiene la ficha de equipos: falta aplicar la migración del 27 de octubre.'
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
    return 'Sin conexión con el servidor. Esta pantalla necesita red: vuelve a intentarlo con cobertura.'
  }
  return m || 'No se ha podido completar.'
}

export const CLAVE_REGISTRO = ['asset-registry'] as const
export const CLAVE_MOVIMIENTOS = ['asset-movements'] as const

/** El registro entero: todos los equipos, también los retirados. Unos pocos miles de filas. */
export function useRegistro() {
  return useQuery({
    queryKey: CLAVE_REGISTRO,
    queryFn: async (): Promise<EquipoDelRegistro[]> => {
      const res = await descargaEntera<EquipoDelRegistro>((d, h) =>
        supabase.from('asset_registry').select('*').order('id').range(d, h),
      )
      if (res.error) throw new Error(res.error.message)
      return res.data ?? []
    },
    staleTime: 60_000,
  })
}

/** El histórico de un equipo, del más reciente al más antiguo. */
export function useHistorialDeEquipo(assetId: string) {
  return useQuery({
    queryKey: [...CLAVE_MOVIMIENTOS, 'equipo', assetId],
    queryFn: async (): Promise<MovimientoDeEquipo[]> => {
      const { data, error } = await supabase
        .from('asset_movements')
        .select('*')
        .eq('asset_id', assetId)
        .order('occurred_at', { ascending: false })
        .limit(100)
      if (error) throw new Error(error.message)
      return (data ?? []) as MovimientoDeEquipo[]
    },
  })
}

export interface FiltroDeMovimientos {
  clase: string
  desde: string
  hasta: string
  edificio: string
}

/**
 * Los movimientos de un periodo, enteros, para la lista y para el Excel.
 *
 * `hasta` es el día incluido: se pide hasta el día siguiente, porque un
 * `occurred_at` de las 17:00 del día 31 no es `<= '2026-10-31'`.
 */
export async function cargarMovimientos(f: FiltroDeMovimientos): Promise<MovimientoDeEquipo[]> {
  const res = await descargaEntera<MovimientoDeEquipo>((d, h) => {
    let q = supabase.from('asset_movements').select('*')
    if (f.clase) q = q.eq('kind', f.clase)
    if (f.desde) q = q.gte('occurred_at', f.desde)
    if (f.hasta) q = q.lt('occurred_at', diaSiguiente(f.hasta))
    if (f.edificio) q = q.eq('building_code', f.edificio)
    return q.order('occurred_at', { ascending: false }).order('id').range(d, h)
  })
  if (res.error) throw new Error(res.error.message)
  return res.data ?? []
}

function diaSiguiente(dia: string): string {
  const t = new Date(`${dia}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + 1)
  return t.toISOString().slice(0, 10)
}

export interface SalaElegible {
  id: string
  buildingId: string
  etiqueta: string
}

export interface EdificioElegible {
  id: string
  code: string
  name: string
}

/** Salas y edificios activos del espejo, para los desplegables de traslado y alta. */
export function useMaestroDeSalas(): { salas: SalaElegible[]; edificios: EdificioElegible[] } | undefined {
  return useLiveQuery(async () => {
    const [rooms, zones, buildings] = await Promise.all([
      db.rooms.toArray(),
      db.zones.toArray(),
      db.buildings.orderBy('sort_order').toArray(),
    ])
    const zonaEdificio = new Map(zones.map((z) => [z.id, z.building_id]))
    const salas = rooms
      .filter((r) => r.active !== false)
      .map((r) => ({
        id: r.id,
        buildingId: zonaEdificio.get(r.zone_id) ?? '',
        etiqueta: `${displayRoomCode(r.code)}${r.name && r.name !== r.code ? ` — ${r.name}` : ''}`,
      }))
      .sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, 'es', { numeric: true }))
    return {
      salas,
      edificios: buildings.map((b) => ({ id: b.id, code: b.code, name: b.name })),
    }
  }, [])
}

export interface TipoElegible {
  id: string
  name: string
  category: string
}

/** El catálogo de tipos sin las lápidas de las fusiones. */
export function useTiposDeEquipo(): TipoElegible[] | undefined {
  return useLiveQuery(async () => {
    const tipos = await db.assetTypes.toArray()
    return tipos
      .filter((t) => !t.merged_into)
      .map((t) => ({ id: t.id, name: t.name, category: t.category }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
  }, [])
}

/**
 * Después de cambiar un equipo en el servidor: la lista, el histórico y el
 * espejo de las salas tocadas.
 *
 * El espejo importa: si este iPad tiene abierta la ficha de esa sala, tiene que
 * dejar de enseñar el proyector que se acaba de dar de baja, y la próxima
 * corrección desde el aula no puede salir con el modelo viejo.
 */
export function refrescarTrasCambio(qc: QueryClient, salas: Array<string | null | undefined>): void {
  void qc.invalidateQueries({ queryKey: CLAVE_REGISTRO })
  void qc.invalidateQueries({ queryKey: CLAVE_MOVIMIENTOS })
  void qc.invalidateQueries({ queryKey: ['stock-levels'] })
  void qc.invalidateQueries({ queryKey: ['stock-units'] })
  for (const s of new Set(salas)) if (s) void pullSala(s)
}
