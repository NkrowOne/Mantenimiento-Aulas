/**
 * Las unidades del almacén, contra el servidor: leerlas y hacer cosas con ellas.
 *
 * La pantalla de Almacén escribe directa contra la base, sin cola, como el resto
 * de lo que se hace desde ella: es la que se usa con el almacén delante, no en
 * un sótano. Lo que se hace sin cobertura —instalar una unidad desde el aula—
 * va por la cola, en `useRoomInventory`.
 *
 * Un servidor sin la migración del 27 de octubre no tiene `stock_unit_list` ni
 * el estado de cada unidad: se leen las unidades de siempre, sin estado, y lo
 * que todavía no existe allí se dice al intentarlo.
 */

import { useQuery, type QueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { descargaEntera } from '@/sync/paginada'
import { pullMaster } from '@/sync/pull'
import { displayRoomCode, norm } from '@/domain/normalize'
import type { ResultadoDeAlta } from '@/domain/estados'
import type { Condicion, UnidadDeAlmacen } from '@/domain/unidades'
import type { RemovalDestino } from '@/domain/types'

export const CLAVE_UNIDADES = ['stock-units'] as const

/** Todas las unidades, en cualquier situación. Son decenas, no miles. */
export function useUnidades() {
  return useQuery({
    queryKey: CLAVE_UNIDADES,
    queryFn: async (): Promise<UnidadDeAlmacen[]> => {
      const res = await descargaEntera<UnidadDeAlmacen>((d, h) =>
        supabase.from('stock_unit_list').select('*').order('id').range(d, h),
      )
      if (!res.error) return res.data ?? []
      if (!/stock_unit_list|schema cache|does not exist/i.test(res.error.message)) throw new Error(res.error.message)

      // El servidor de antes: las unidades sin estado y sin la sala resuelta.
      const viejo = await descargaEntera<Record<string, unknown>>((d, h) =>
        supabase
          .from('stock_units')
          .select('id, stock_item_id, asset_type_id, articulo, brand, model, serial, notes, status, asset_id, room_id, installed_at, retired_at, source, created_at, updated_at')
          .order('id')
          .range(d, h),
      )
      if (viejo.error) throw new Error(viejo.error.message)
      return (viejo.data ?? []).map((u) => ({
        ...(u as unknown as UnidadDeAlmacen),
        item_name: null,
        item_active: null,
        type_name: null,
        es_ordenador: true,
        condicion: 'sin_indicar' as Condicion,
        room_code: null,
        room_name: null,
        building_code: null,
      }))
    },
    staleTime: 30_000,
  })
}

/** Después de tocar una unidad: la lista, las existencias y el espejo del iPad. */
export function refrescarUnidades(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: CLAVE_UNIDADES })
  void qc.invalidateQueries({ queryKey: ['stock-levels'] })
  void qc.invalidateQueries({ queryKey: ['asset-registry'] })
  // El espejo, para que «Añadir equipo» en el aula ofrezca lo que hay de verdad.
  void pullMaster()
}

export interface AltaDeUnidad {
  stockItemId: string
  serial: string
  condicion: Exclude<Condicion, 'sin_indicar'>
  marca: string
  modelo: string
  observaciones: string
  /** Suma una al almacén (entra ahora) o nombra una que ya estaba contada. */
  sumar: boolean
}

export async function darDeAltaUnidad(a: AltaDeUnidad): Promise<string> {
  const { data, error } = await supabase.rpc('stock_unit_alta', {
    p: {
      stock_item_id: a.stockItemId,
      serial: a.serial.trim(),
      condicion: a.condicion,
      marca: a.marca.trim(),
      modelo: a.modelo.trim(),
      observaciones: a.observaciones.trim(),
      sumar: a.sumar,
    },
  })
  if (error) throw error
  return String(data ?? '')
}

/**
 * Muchas de golpe: la lista que se pega del albarán, de una columna del Excel o
 * del lector de códigos de barras. Todas con el mismo estado, marca y modelo.
 *
 * La base contesta por cada número —apuntada, ya estaba, o el motivo por el que
 * no— y un número malo no impide apuntar los demás.
 */
export async function darDeAltaVarias(a: Omit<AltaDeUnidad, 'serial'> & { seriales: string[] }): Promise<ResultadoDeAlta[]> {
  const { data, error } = await supabase.rpc('stock_unit_alta_varias', {
    p: {
      stock_item_id: a.stockItemId,
      seriales: a.seriales.map((s) => s.trim()).filter(Boolean),
      condicion: a.condicion,
      marca: a.marca.trim(),
      modelo: a.modelo.trim(),
      observaciones: a.observaciones.trim(),
      sumar: a.sumar,
    },
  })
  if (error) throw error
  return Array.isArray(data) ? (data as ResultadoDeAlta[]) : []
}

/**
 * Cambia lo que se diga de una unidad. El estado y las observaciones los puede
 * cambiar cualquiera del personal —es quien la tiene delante—; la marca, el
 * modelo, el número de serie y el artículo, un supervisor. Lo decide la base.
 */
export async function editarUnidad(
  id: string,
  cambios: Partial<{
    condicion: Condicion
    observaciones: string
    marca: string
    modelo: string
    serial: string
    stock_item_id: string
  }>,
): Promise<void> {
  const { error } = await supabase.rpc('stock_unit_editar', { p_unit: id, p: cambios })
  if (error) throw error
}

export async function instalarUnidad(i: {
  unidad: string
  sala: string
  sustituye: string | null
  destino: RemovalDestino
  nota: string
}): Promise<void> {
  const { error } = await supabase.rpc('stock_unit_instalar_en', {
    p_unit: i.unidad,
    p_room: i.sala,
    p_sustituye: i.sustituye,
    p_destino: i.destino,
    p_nota: i.nota.trim() || null,
  })
  if (error) throw error
}

export async function darDeBajaUnidad(id: string, motivo: string): Promise<void> {
  const { error } = await supabase.rpc('stock_unit_baja', { p_unit: id, p_note: motivo.trim() })
  if (error) throw error
}

// -----------------------------------------------------------------------------
// Las salas, para instalar
// -----------------------------------------------------------------------------

export interface SalaParaInstalar {
  id: string
  /** «1.7 · Edificio H · 1ª planta» */
  titulo: string
  codigo: string
  edificio: string
  texto: string
}

/** Las salas activas del espejo, con lo que hace falta para encontrarlas tecleando. */
export function useSalasParaInstalar(): SalaParaInstalar[] {
  return useLiveQuery(
    async () => {
      const [rooms, zones, buildings] = await Promise.all([
        db.rooms.toArray(),
        db.zones.toArray(),
        db.buildings.toArray(),
      ])
      const zona = new Map(zones.map((z) => [z.id, z]))
      const edificio = new Map(buildings.map((b) => [b.id, b]))
      return rooms
        .filter((r) => r.active !== false)
        .map((r) => {
          const z = zona.get(r.zone_id)
          const b = z ? edificio.get(z.building_id) : undefined
          const codigo = displayRoomCode(r.code)
          const nombre = r.name && r.name !== r.code ? r.name : ''
          return {
            id: r.id,
            codigo,
            edificio: b?.code ?? '',
            titulo: [`${codigo}${b ? ` ${b.code}` : ''}`, nombre, z?.name].filter(Boolean).join(' · '),
            texto: norm([codigo, r.code, nombre, b?.code, b?.name, z?.name, r.short_ref].filter(Boolean).join(' ')),
          }
        })
        .sort((a, b) => a.edificio.localeCompare(b.edificio, 'es') || a.codigo.localeCompare(b.codigo, 'es', { numeric: true }))
    },
    [],
    [] as SalaParaInstalar[],
  )
}

/** «h 1.7», «1.7 h», «criminolog»: cada palabra tiene que estar en algún sitio. */
export function buscarSalas(salas: SalaParaInstalar[], consulta: string, max = 8): SalaParaInstalar[] {
  const palabras = norm(consulta).split(' ').filter(Boolean)
  if (palabras.length === 0) return []
  return salas.filter((s) => palabras.every((p) => s.texto.includes(p))).slice(0, max)
}
