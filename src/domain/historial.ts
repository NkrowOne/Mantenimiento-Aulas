/**
 * El histórico: qué le ha pasado a una sala, y cómo se lee.
 *
 * La vista `room_timeline` une cinco tablas en una sola lista de cosas que
 * pasaron. Este fichero es la mitad que vive en el cliente: los tipos, cómo se
 * agrupan las cuatro familias de evento, y cómo se les pone nombre y color.
 *
 * Va en `domain` y no dentro de una pantalla porque lo usan dos —el panel
 * plegado de la revisión y la pestaña de Historial— y la peor versión de esto
 * es que el mismo evento se llame «Material» en un sitio y «Consumo» en el
 * otro: quien lee las dos pantallas deja de saber si está viendo lo mismo.
 */

/** Las cuatro familias. Es también el orden de los filtros. */
export const FAMILIAS = ['revision', 'incidencia', 'material', 'equipo'] as const
export type Familia = (typeof FAMILIAS)[number]

export interface EventoSala {
  ref_id: string
  kind: Familia
  subkind: string
  room_id: string
  at: string
  title: string
  detail: string | null
  qty: number | null
  by_user: string | null
}

/**
 * Cómo se pinta cada familia.
 *
 * Un color por familia y nada más: son cuatro, se distinguen de un vistazo y no
 * hay que aprenderse una leyenda. El estado —resuelta, averiada— va en el texto,
 * que es donde se puede leer sin ambigüedad.
 */
export const FAMILIA_ESTILO: Record<Familia, { etiqueta: string; punto: string; tinte: string }> = {
  revision: { etiqueta: 'Revisión', punto: 'bg-ok', tinte: 'text-ok' },
  incidencia: { etiqueta: 'Incidencia', punto: 'bg-crit', tinte: 'text-crit' },
  material: { etiqueta: 'Material', punto: 'bg-accent', tinte: 'text-accent' },
  equipo: { etiqueta: 'Equipo', punto: 'bg-warn', tinte: 'text-warn' },
}

const SUBTIPO: Record<string, string> = {
  // Incidencias
  abierta: 'abierta',
  resuelta: 'resuelta',
  // Material
  consumo: 'consumido',
  compra: 'entrada',
  ajuste: 'ajuste',
  devolucion: 'devuelto',
  // Equipos
  alta: 'alta',
  baja: 'baja',
  sustitucion: 'sustitución',
  traslado: 'traslado',
  averia: 'avería',
  // Revisiones
  completa: '',
  borrador: 'sin cerrar',
}

/** La palabra que acompaña al título. Vacía cuando no aporta nada. */
export function subtipoLegible(evento: EventoSala): string {
  return SUBTIPO[evento.subkind] ?? evento.subkind
}

/**
 * La cantidad, con su signo, tal y como debe leerse.
 *
 * En el almacén el signo es una convención contable —negativo sale, positivo
 * entra— y aquí eso no se explica: se enseña «−2» y ya. Lo que sí se hace es
 * conservar el signo, porque una devolución de 2 y un consumo de 2 son cosas
 * opuestas y la lista las pone una debajo de la otra.
 */
export function cantidadLegible(qty: number | null): string | null {
  if (qty === null || qty === 0) return null
  return qty > 0 ? `+${qty}` : `−${Math.abs(qty)}`
}

/**
 * La fecha, en la forma en que se lee una lista.
 *
 * Con hora, porque dos movimientos del mismo día son la diferencia entre «se
 * cambió el cable y luego falló» y «falló y luego se cambió el cable», que es
 * justo la pregunta que trae a alguien a esta pantalla.
 */
export function fechaLegible(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** El día al que pertenece un evento, para agrupar la lista por jornadas. */
export function diaDe(iso: string): string {
  return new Date(iso).toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}
