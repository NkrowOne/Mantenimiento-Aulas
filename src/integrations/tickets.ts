/**
 * Puerto de integración con sistemas de tickets externos.
 *
 * Hoy no hay ninguna conexión con ServiceNow. Esto es el enchufe: una interfaz
 * neutra y una tabla (`external_tickets`) donde cualquier origen deja lo suyo.
 * Implementar `ServiceNowSource` mañana no obliga a tocar nada del resto de la
 * aplicación — solo a registrar una implementación más aquí.
 *
 * El puente ya existe en los datos: el histórico importado conserva las
 * referencias `I260203_0051` en `incidents.external_ref`, así que en cuanto
 * haya conexión, `link_tickets_by_ref()` reconstruye los enlaces de golpe.
 */

import { supabase } from '@/lib/supabase'

export interface ExternalTicket {
  externalId: string
  title: string
  status: string
  payload: Record<string, unknown>
}

export interface TicketSource {
  readonly name: string
  fetchOpen(): Promise<ExternalTicket[]>
  fetchSince(date: Date): Promise<ExternalTicket[]>
}

/**
 * Origen manual: lo que ya está en `external_tickets` porque alguien lo
 * introdujo o lo importó. Es la implementación por defecto y la que permite
 * probar todo el flujo sin depender de que IT autorice nada.
 */
export class ManualSource implements TicketSource {
  readonly name = 'manual'

  async fetchOpen(): Promise<ExternalTicket[]> {
    const { data } = await supabase
      .from('external_tickets')
      .select('external_id, title, status, payload')
      .eq('source', this.name)
      .is('linked_incident_id', null)

    return (data ?? []).map((r) => ({
      externalId: r.external_id as string,
      title: (r.title as string) ?? '',
      status: (r.status as string) ?? 'abierta',
      payload: (r.payload as Record<string, unknown>) ?? {},
    }))
  }

  async fetchSince(date: Date): Promise<ExternalTicket[]> {
    const { data } = await supabase
      .from('external_tickets')
      .select('external_id, title, status, payload')
      .eq('source', this.name)
      .gte('fetched_at', date.toISOString())

    return (data ?? []).map((r) => ({
      externalId: r.external_id as string,
      title: (r.title as string) ?? '',
      status: (r.status as string) ?? 'abierta',
      payload: (r.payload as Record<string, unknown>) ?? {},
    }))
  }
}

/**
 * Guarda los tickets de un origen y los enlaza con nuestras incidencias por
 * referencia. Idempotente: reejecutarlo no duplica nada.
 */
export async function syncSource(source: TicketSource): Promise<{ fetched: number; linked: number }> {
  const tickets = await source.fetchOpen()

  if (tickets.length > 0) {
    await supabase.from('external_tickets').upsert(
      tickets.map((t) => ({
        source: source.name,
        external_id: t.externalId,
        title: t.title,
        status: t.status,
        payload: t.payload,
        fetched_at: new Date().toISOString(),
      })),
      { onConflict: 'source,external_id' },
    )
  }

  const { data: linked } = await supabase.rpc('link_tickets_by_ref')
  return { fetched: tickets.length, linked: Number(linked ?? 0) }
}

const registry = new Map<string, TicketSource>([['manual', new ManualSource()]])

export function getSource(name: string): TicketSource | undefined {
  return registry.get(name)
}

export function registerSource(source: TicketSource): void {
  registry.set(source.name, source)
}
