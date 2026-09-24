/**
 * Las dos consultas del catálogo de tipos de equipo, en un solo sitio.
 *
 * Las usan dos pantallas —la bandeja de «Por decidir» y el catálogo de
 * «Maestro»— con la MISMA clave de caché, así que tienen que ser la misma
 * consulta: dos funciones distintas bajo una clave compartida pintan lo que
 * haya traído la última que corrió, y renombrar en una dejaría la otra con el
 * nombre viejo.
 */

import { queryOptions } from '@tanstack/react-query'

import type { AssetType } from '@/domain/types'
import { supabase } from '@/lib/supabase'

/** Los tipos ya validados, sin los que una fusión absorbió en otro. */
export const tiposValidados = queryOptions({
  queryKey: ['asset-types', 'confirmed'],
  queryFn: async (): Promise<AssetType[]> => {
    const { data, error } = await supabase
      .from('asset_types')
      .select('*')
      .eq('confirmed', true)
      .is('merged_into', null)
      .order('name')
    if (error) throw error
    return (data ?? []) as AssetType[]
  },
})

/**
 * Cuántos equipos en salas hay de cada tipo.
 *
 * Sin esto se decide a ciegas: no es lo mismo tocar algo que alguien apuntó
 * una vez que algo instalado en treinta aulas.
 */
export const usoDeTipos = queryOptions({
  queryKey: ['asset-types', 'usage'],
  queryFn: async (): Promise<Record<string, number>> => {
    const { data, error } = await supabase.from('assets').select('asset_type_id').neq('status', 'retirado')
    if (error) throw error
    const cuenta: Record<string, number> = {}
    for (const fila of (data ?? []) as Array<{ asset_type_id: string }>) {
      cuenta[fila.asset_type_id] = (cuenta[fila.asset_type_id] ?? 0) + 1
    }
    return cuenta
  },
})
