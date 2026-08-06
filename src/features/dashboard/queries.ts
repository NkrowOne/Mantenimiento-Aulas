/**
 * Consultas del panel. Van directas a las vistas del servidor: son datos de
 * supervisión, no de trabajo en el aula, así que no necesitan modo offline.
 */

import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { inicioDeMes } from '@/domain/fechas'

export interface Summary {
  roomsTotal: number
  inspectedThisMonth: number
  openIncidents: number
  roomsWithProblems: number
  lampAlerts: number
  staleIncidents: number
  overdueRooms: number
  stockBelow: number
  needsReview: number
  quarantine: number
  /** Salas por las que nadie ha pasado nunca a levantar inventario. */
  roomsUninventoried: number
}

export function useSummary() {
  return useQuery({
    queryKey: ['summary'],
    queryFn: async (): Promise<Summary> => {
      // El mes empieza a medianoche de Madrid, no del huso del aparato que
      // pregunta: este número aparece también en el PDF, calculado en el
      // servidor, y tienen que coincidir.
      const monthStart = inicioDeMes()

      const head = { count: 'exact' as const, head: true }

      const [
        roomsTotal,
        inspectedThisMonth,
        openIncidents,
        lampAlerts,
        staleIncidents,
        overdueRooms,
        needsReview,
        quarantine,
      ] = await Promise.all([
        /*
         * El total de salas sale de `room_overview`, que es la lista de trabajo.
         *
         * Contra `rooms` contaba dos cosas que no son campus: las salas dadas de
         * baja a mano (`active = false`) y, desde que hay papelera de edificios,
         * las de un edificio archivado —que conservan `rooms.active = true` a
         * propósito, para que restaurar devuelva lo que había—. Este número es el
         * denominador de «revisadas este mes» y el de la frase «N% de 276»: con
         * un conjunto distinto al del numerador, el porcentaje del panel no puede
         * llegar a 100 y no coincide con el del informe firmado.
         */
        supabase.from('room_overview').select('room_id', head),
        /*
         * Las revisiones del mes, contadas por VISITA.
         *
         * Sobre `inspections_vigentes` y no sobre `inspections`: una revisión
         * corregida son varias filas de la misma visita al aula, y contarlas todas
         * diría que el equipo ha estado en más aulas de las que ha pisado.
         */
        supabase
          .from('inspections_vigentes')
          .select('*', head)
          .gte('occurred_at', monthStart.toISOString()),
        /*
         * Y «abierta» tiene que significar aquí lo mismo que en la pestaña.
         *
         * Contaba cualquier fila no resuelta, así que sumaba los borradores —que la
         * pestaña esconde a propósito, porque una nota a medio escribir no es
         * trabajo pendiente— y las observaciones importadas. El resultado es la
         * forma más directa de «el sistema dice que hay más de las que me
         * enseña»: el azulejo decía 6, la lista abría con 4 y nadie explicaba la
         * diferencia. El criterio es el de la pestaña, palabra por palabra.
         */
        supabase
          .from('incidents')
          .select('*', head)
          .neq('state', 'resuelta')
          .neq('state', 'borrador')
          .neq('kind', 'observacion'),
        supabase.from('alerts_lamp_low').select('*', head),
        supabase.from('alerts_stale_incidents').select('*', head),
        supabase.from('alerts_overdue_rooms').select('*', head),
        /* Sin los archivados: el azulejo de «sin identificar» es una lista de
           trabajo pendiente, y un edificio provisional que se mandó a la papelera
           ya no lo es. Contándolo, el número se quedaría en 1 para siempre
           señalando a una pantalla donde no aparece nada — y un indicador que no
           se puede bajar a cero es un indicador que se aprende a ignorar. */
        supabase.from('buildings').select('*', head).eq('needs_review', true).eq('active', true),
        supabase.from('import_quarantine').select('*', head).eq('resolved', false),
      ]).then((rs) => {
        // Si una sola consulta falla, el panel entero es mentira: enseñaría
        // «0 incidencias abiertas» en verde sin haber leído ni una fila.
        const fallo = rs.find((r) => r.error)
        if (fallo?.error) throw fallo.error
        return rs.map((r) => r.count ?? 0)
      })

      const { data: stock } = await supabase
        .from('stock_levels')
        .select('stock_item_id')
        .eq('below_threshold', true)

      const { data: problems } = await supabase
        .from('room_overview')
        .select('room_id')
        .gt('open_incidents', 0)

      // Cuántas salas siguen sin que nadie haya confirmado qué hay dentro. Es
      // trabajo por hacer y no una avería, así que se cuenta aparte de las
      // alertas: sale en la sección de pendientes, en gris.
      const { count: roomsUninventoried } = await supabase
        .from('room_overview')
        .select('room_id', head)
        .is('last_inventory_at', null)

      return {
        roomsTotal: roomsTotal!,
        inspectedThisMonth: inspectedThisMonth!,
        openIncidents: openIncidents!,
        roomsWithProblems: problems?.length ?? 0,
        lampAlerts: lampAlerts!,
        staleIncidents: staleIncidents!,
        overdueRooms: overdueRooms!,
        stockBelow: stock?.length ?? 0,
        needsReview: needsReview!,
        quarantine: quarantine!,
        roomsUninventoried: roomsUninventoried ?? 0,
      }
    },
  })
}

export interface LampRow {
  room_id: string
  building_code: string
  room_code: string
  room_name: string
  lamp_pct: number
  projector_hours: number | null
}

export function useLampAlerts() {
  return useQuery({
    queryKey: ['alerts', 'lamp'],
    queryFn: async (): Promise<LampRow[]> => {
      const { data } = await supabase.from('alerts_lamp_low').select('*').limit(25)
      return (data ?? []) as LampRow[]
    },
  })
}

export interface StaleRow {
  id: string
  title: string
  severity: string
  opened_at: string
  state: string
  building_code: string | null
  room_code: string | null
  days_open: number
}

export function useStaleIncidents() {
  return useQuery({
    queryKey: ['alerts', 'stale'],
    queryFn: async (): Promise<StaleRow[]> => {
      const { data } = await supabase.from('alerts_stale_incidents').select('*').limit(50)
      return (data ?? []) as StaleRow[]
    },
  })
}

/** Incidencias por edificio: responde a "¿dónde se nos va el tiempo?". */
export function useIncidentsByBuilding() {
  return useQuery({
    queryKey: ['charts', 'by-building'],
    queryFn: async (): Promise<Array<{ code: string; total: number }>> => {
      const { data } = await supabase.from('incidents_by_building').select('*').limit(12)
      return (data ?? []) as Array<{ code: string; total: number }>
    },
  })
}

/** Incidencias abiertas por mes, para ver tendencia y no solo el total de hoy. */
export function useIncidentsByMonth() {
  return useQuery({
    queryKey: ['charts', 'by-month'],
    queryFn: async (): Promise<Array<{ month: string; total: number }>> => {
      const { data } = await supabase.from('incidents_by_month').select('*')
      return (data ?? []) as Array<{ month: string; total: number }>
    },
  })
}
