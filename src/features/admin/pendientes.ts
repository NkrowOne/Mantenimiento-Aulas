/**
 * Cuánto trabajo espera en cada sección de «Datos», contado de una vez.
 *
 * Es lo que hace que la pestaña se pueda abrir sin recorrerla: un número al
 * lado de cada sección dice si hay algo que decidir antes de entrar, y el
 * resumen de arriba lo junta en cuatro baldosas. Sin esto, saber si había
 * retiradas por autorizar exigía abrir «Por decidir» y bajar hasta ellas.
 *
 * Siete recuentos y una fecha, en paralelo y cada uno con su propio fallo: un
 * recuento que no se pueda leer —una vista que exige supervisor, un servidor
 * viejo sin la función— vale cero y no tumba a los otros seis. Es un
 * indicador, no un dato: lo que manda es lo que enseñe la sección al abrirla.
 *
 * Los recuentos son de cabecera (`head: true`): PostgREST cuenta y no manda
 * filas, así que esto cuesta lo mismo con diez retiradas que con mil.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

export interface PendientesDeDatos {
  retiradas: number
  equiposSinValidar: number
  tiposSinValidar: number
  duplicados: number
  edificiosSinIdentificar: number
  incidenciasSinSala: number
  cuarentena: number
  /** Cuándo salió el último libro sincronizado, en ISO. Nulo si nunca. */
  ultimaSincronizacion: string | null
}

export const CLAVE_PENDIENTES = ['datos', 'pendientes'] as const

const NADA: PendientesDeDatos = {
  retiradas: 0,
  equiposSinValidar: 0,
  tiposSinValidar: 0,
  duplicados: 0,
  edificiosSinIdentificar: 0,
  incidenciasSinSala: 0,
  cuarentena: 0,
  ultimaSincronizacion: null,
}

async function cuenta(consulta: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  try {
    const { count, error } = await consulta
    if (error) return 0
    return count ?? 0
  } catch {
    return 0
  }
}

async function filasDe(rpc: string): Promise<number> {
  try {
    const { data, error } = await supabase.rpc(rpc)
    if (error || !Array.isArray(data)) return 0
    return data.length
  } catch {
    return 0
  }
}

async function ultimaSalida(): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc('sync_ultima_salida')
    if (error) return null
    const fila = Array.isArray(data) ? (data[0] as { cuando?: string } | undefined) : undefined
    return fila?.cuando ?? null
  } catch {
    return null
  }
}

export async function contarPendientes(): Promise<PendientesDeDatos> {
  const [retiradas, equipos, tipos, duplicados, edificios, sinSala, cuarentena, salida] = await Promise.all([
    cuenta(supabase.from('asset_removal_queue').select('id', { count: 'exact', head: true })),
    cuenta(
      supabase
        .from('assets')
        .select('id', { count: 'exact', head: true })
        .eq('confirmed', false)
        .neq('status', 'retirado'),
    ),
    cuenta(
      supabase
        .from('asset_types')
        .select('id', { count: 'exact', head: true })
        .eq('confirmed', false)
        .is('merged_into', null),
    ),
    filasDe('auditoria_duplicados'),
    cuenta(
      supabase
        .from('buildings')
        .select('id', { count: 'exact', head: true })
        .eq('needs_review', true)
        .eq('active', true),
    ),
    filasDe('incidencias_sin_sala'),
    cuenta(supabase.from('import_quarantine').select('id', { count: 'exact', head: true }).eq('resolved', false)),
    ultimaSalida(),
  ])

  return {
    retiradas,
    equiposSinValidar: equipos,
    tiposSinValidar: tipos,
    duplicados,
    edificiosSinIdentificar: edificios,
    incidenciasSinSala: sinSala,
    cuarentena,
    ultimaSincronizacion: salida,
  }
}

export function usePendientesDeDatos(): PendientesDeDatos {
  const { data } = useQuery({
    queryKey: CLAVE_PENDIENTES,
    queryFn: contarPendientes,
    // Un minuto: es un indicador de la cabecera, y cada decisión que se toma en
    // una sección lo vuelve a pedir por su cuenta.
    staleTime: 60_000,
  })
  return data ?? NADA
}

/**
 * Para que cada sección avise cuando ha cambiado algo que se cuenta arriba.
 * Se llama en el `onSuccess` de las mutaciones que vacían una bandeja.
 */
export function useRefrescarPendientes(): () => void {
  const qc = useQueryClient()
  return () => void qc.invalidateQueries({ queryKey: CLAVE_PENDIENTES })
}

/** Cuánto hay que decidir en cada sección, sumado como lo enseña la barra. */
export function porSeccion(p: PendientesDeDatos): {
  pendientes: number
  maestro: number
  importacion: number
} {
  return {
    pendientes: p.retiradas + p.equiposSinValidar + p.tiposSinValidar + p.duplicados,
    maestro: p.edificiosSinIdentificar,
    importacion: p.incidenciasSinSala + p.cuarentena,
  }
}
