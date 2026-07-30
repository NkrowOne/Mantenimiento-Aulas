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

/**
 * Lo que puede traer una fila de `room_timeline`.
 *
 * El vocabulario lo fija la vista, y viene de fundir dos que se llamaban igual:
 * la de la ficha de sala —que distingue incidencia, solicitud y observación, y
 * separa las revisiones que salieron bien de las que no— y la del almacén, que
 * añade material, equipos y levantamientos. Distinguir una solicitud de una
 * avería importa: una sala bien atendida acumula solicitudes, y contarlas como
 * fallos la dejaría peor que una a la que nadie hace caso.
 */
export type TipoEvento =
  | 'incidencia'
  | 'solicitud'
  | 'observacion'
  | 'revision_ok'
  | 'revision_ko'
  | 'material'
  | 'equipo'
  | 'inventario'

/**
 * Las familias con las que se filtra, que no son una por tipo.
 *
 * Una revisión que sale bien y otra que sale mal son la misma cosa para quien
 * filtra —«enséñame las revisiones»— y un levantamiento es inventario, igual
 * que un alta de equipo. Ocho botones donde caben cinco no son más precisión:
 * son cinco decisiones que nadie ha pedido tomar.
 */
export const FAMILIAS = ['revision', 'incidencia', 'solicitud', 'material', 'equipo'] as const
export type Familia = (typeof FAMILIAS)[number]

const FAMILIA_DE: Record<TipoEvento, Familia> = {
  revision_ok: 'revision',
  revision_ko: 'revision',
  incidencia: 'incidencia',
  // Las observaciones van con las solicitudes: las dos son «alguien pasó y
  // apuntó algo», frente a «algo está roto».
  solicitud: 'solicitud',
  observacion: 'solicitud',
  material: 'material',
  equipo: 'equipo',
  inventario: 'equipo',
}

export function familiaDe(kind: TipoEvento): Familia {
  return FAMILIA_DE[kind] ?? 'incidencia'
}

/**
 * Los tipos que caen en cada familia.
 *
 * Lo necesita el filtro de la pestaña Historial, que se resuelve en el servidor:
 * pedir `kind = 'revision'` no devolvería nada porque ese valor no existe en la
 * vista — son `revision_ok` y `revision_ko`.
 */
export const TIPOS_DE_FAMILIA: Record<Familia, TipoEvento[]> = FAMILIAS.reduce(
  (acc, f) => {
    acc[f] = (Object.keys(FAMILIA_DE) as TipoEvento[]).filter((k) => FAMILIA_DE[k] === f)
    return acc
  },
  {} as Record<Familia, TipoEvento[]>,
)

export interface EventoSala {
  ref_id: string
  kind: TipoEvento
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
  solicitud: { etiqueta: 'Solicitudes', punto: 'bg-accent', tinte: 'text-accent' },
  material: { etiqueta: 'Material', punto: 'bg-mark', tinte: 'text-ink-2' },
  equipo: { etiqueta: 'Equipo', punto: 'bg-warn', tinte: 'text-warn' },
}

const SUBTIPO: Record<string, string> = {
  // Incidencias, solicitudes y observaciones
  abierta: 'abierta',
  en_curso: 'en curso',
  borrador: 'sin completar',
  resuelta: 'resuelta',
  levantamiento: 'confirmado',
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
  // Revisiones. Una revisión cerrada no necesita adjetivo: es lo normal.
  completa: '',
  /*
   * Lo que se está viendo es la versión corregida de aquella visita.
   *
   * Sí necesita adjetivo, y no es un detalle: la fila lleva la fecha de la visita
   * original y un texto que puede haber cambiado desde entonces. Sin la palabra,
   * quien compare el histórico con lo que recuerda de aquel día pensará que la
   * aplicación ha reescrito el pasado a sus espaldas — cuando lo que ha hecho es
   * justo lo contrario: guardar las dos versiones y enseñar la buena.
   */
  corregida: 'corregida',
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
