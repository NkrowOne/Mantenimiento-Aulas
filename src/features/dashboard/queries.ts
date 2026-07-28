/**
 * Consultas del panel. Van directas a las vistas del servidor: son datos de
 * supervisión, no de trabajo en el aula, así que no necesitan modo offline.
 */

import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

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
}

export function useSummary() {
  return useQuery({
    queryKey: ['summary'],
    queryFn: async (): Promise<Summary> => {
      const monthStart = new Date()
      monthStart.setDate(1)
      monthStart.setHours(0, 0, 0, 0)

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
        supabase.from('rooms').select('*', head),
        supabase
          .from('inspections')
          .select('*', head)
          .eq('status', 'completa')
          .gte('occurred_at', monthStart.toISOString()),
        supabase.from('incidents').select('*', head).neq('state', 'resuelta'),
        supabase.from('alerts_lamp_low').select('*', head),
        supabase.from('alerts_stale_incidents').select('*', head),
        supabase.from('alerts_overdue_rooms').select('*', head),
        supabase.from('buildings').select('*', head).eq('needs_review', true),
        supabase.from('import_quarantine').select('*', head).eq('resolved', false),
      ]).then((rs) => rs.map((r) => r.count ?? 0))

      const { data: stock } = await supabase
        .from('stock_levels')
        .select('stock_item_id')
        .eq('below_threshold', true)

      const { data: problems } = await supabase
        .from('room_overview')
        .select('room_id')
        .gt('open_incidents', 0)

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
