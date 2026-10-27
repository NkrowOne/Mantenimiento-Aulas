/**
 * El estado de lo que se cuenta, contra el servidor: leerlo y cambiarlo.
 *
 * Como el resto de la pantalla de Almacén, va directo contra la base, sin cola.
 *
 * Un servidor sin la migración del 27 de octubre (la segunda) no tiene la vista
 * `stock_levels_por_estado`: la lectura devuelve `null` y la pantalla se queda
 * como antes, contando sin estados. No es un fallo que haya que enseñar —el
 * almacén sigue funcionando—, así que no se lanza.
 */

import { useQuery } from '@tanstack/react-query'
import { v7 as uuidv7 } from 'uuid'
import { supabase } from '@/lib/supabase'
import { descargaEntera } from '@/sync/paginada'
import type { NivelPorEstado } from '@/domain/estados'
import type { Condicion } from '@/domain/unidades'

/**
 * Bajo la misma clave que `stock_levels`: todo lo que ya refresca las
 * existencias después de un movimiento (`['stock-levels']`) refresca también
 * esto, sin acordarse de nada más.
 */
export const CLAVE_ESTADOS = ['stock-levels', 'por-estado'] as const

/**
 * Lo que pide un menos o un más: cuántas, qué movimiento y, si el artículo se
 * cuenta por estados, de cuál. Sin estado, lo decide la base como siempre.
 */
export interface MovimientoPedido {
  qty: number
  kind: 'compra' | 'consumo' | 'devolucion'
  condicion?: Condicion
}

/** `null`: el servidor todavía no sabe de estados. */
export function useEstados() {
  return useQuery({
    queryKey: CLAVE_ESTADOS,
    queryFn: async (): Promise<Map<string, NivelPorEstado> | null> => {
      const res = await descargaEntera<NivelPorEstado>((d, h) =>
        supabase.from('stock_levels_por_estado').select('*').order('stock_item_id').range(d, h),
      )
      if (res.error) {
        if (/stock_levels_por_estado|schema cache|does not exist|PGRST20[45]|42P01/i.test(`${res.error.message} ${res.error.code ?? ''}`)) {
          return null
        }
        throw new Error(res.error.message)
      }
      return new Map((res.data ?? []).map((n) => [n.stock_item_id, n]))
    },
  })
}

/**
 * Pasa `cantidad` de un estado a otro sin cambiar el total: «3 de usadas a
 * averiadas».
 *
 * El id nace aquí, con la pulsación, y no dentro del reintento: si la respuesta
 * se pierde y se repite, la base reconoce el id y no lo hace dos veces.
 */
export function nuevoCambioDeEstado(i: {
  stockItemId: string
  cantidad: number
  de: Condicion
  a: Condicion
  nota?: string
}): CambioDeEstado {
  return { id: uuidv7(), ...i }
}

export interface CambioDeEstado {
  id: string
  stockItemId: string
  cantidad: number
  de: Condicion
  a: Condicion
  nota?: string
}

export async function cambiarEstado(c: CambioDeEstado): Promise<void> {
  const { error } = await supabase.rpc('stock_cambiar_estado', {
    p_id: c.id,
    p_item: c.stockItemId,
    p_cantidad: c.cantidad,
    p_de: c.de,
    p_a: c.a,
    p_nota: c.nota?.trim() || null,
  })
  if (error) throw error
}

/**
 * Varios cambios seguidos —repartir las ocho sin estado en cinco nuevas y tres
 * usadas son dos—. Uno detrás de otro y no a la vez: cada uno comprueba que
 * quedan bastantes en el estado de partida, y a la vez se pisarían la cuenta.
 * Si uno falla, los anteriores ya están hechos y se dice cuántos.
 */
export async function cambiarEstados(cambios: CambioDeEstado[]): Promise<void> {
  let hechos = 0
  for (const c of cambios) {
    try {
      await cambiarEstado(c)
      hechos += 1
    } catch (e) {
      if (hechos === 0) throw e
      const m = (e as { message?: string } | null)?.message ?? ''
      throw new Error(`Se ha guardado una parte (${hechos} de ${cambios.length}) y el resto no: ${m}`)
    }
  }
}
