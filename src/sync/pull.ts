/**
 * Descarga del maestro al dispositivo.
 *
 * El conjunto entero son ~276 salas, 23 edificios y un centenar de artículos:
 * cabe sobradamente en IndexedDB. Por eso no hace falta un motor de
 * sincronización — se baja todo y la interfaz lee siempre de local, sin esperar
 * nunca a la red.
 */

import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import type { Asset, AssetType, Building, Incident, Room, StockItem, Zone } from '@/domain/types'

export async function pullMaster(): Promise<void> {
  if (!navigator.onLine) return

  const [buildings, zones, rooms, stock, incidents, types, assets] = await Promise.all([
    supabase.from('buildings').select('*').order('sort_order'),
    supabase.from('zones').select('*'),
    supabase.from('room_overview').select('*'),
    supabase.from('stock_items').select('*').eq('active', true),
    supabase.from('incidents').select('*').neq('state', 'resuelta'),
    // El catálogo entero, fusionados incluidos: sin las lápidas, un elemento
    // cuyo tipo se fusionó ayer se quedaría sin nombre en el dispositivo.
    supabase.from('asset_types').select('*'),
    supabase.from('assets').select('*').neq('status', 'retirado'),
  ])

  if (buildings.data) await db.buildings.bulkPut(buildings.data as Building[])
  if (zones.data) await db.zones.bulkPut(zones.data as Zone[])
  if (stock.data) await db.stockItems.bulkPut(stock.data as StockItem[])
  if (incidents.data) await db.incidents.bulkPut(incidents.data as Incident[])
  if (types.data) await db.assetTypes.bulkPut(types.data as AssetType[])
  if (assets.data) await db.assets.bulkPut(assets.data as Asset[])

  if (rooms.data) {
    // `room_overview` ya trae la fecha de la última revisión resuelta por el
    // servidor, así que la lista de trabajo se puede ordenar sin consultar nada.
    const mapped: Room[] = rooms.data.map((r) => ({
      id: r.room_id as string,
      zone_id: r.zone_id as string,
      code: r.room_code as string,
      name: r.room_name as string,
      kind: r.kind as Room['kind'],
      capabilities: r.capabilities as Room['capabilities'],
      projector_hours: (r.projector_hours as number | null) ?? null,
      lamp_pct: (r.lamp_pct as number | null) ?? null,
      last_inspection_at: (r.last_inspection_at as string | null) ?? null,
      active: true,
    }))
    await db.rooms.bulkPut(mapped)
  }

  await db.meta.put({ key: 'last-pull', value: Date.now() })
}
