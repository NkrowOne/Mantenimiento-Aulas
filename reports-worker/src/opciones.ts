/**
 * Qué se puede pedir de un informe.
 *
 * Este fichero es el contrato entre las tres piezas que tienen que estar de
 * acuerdo: la pantalla de informes, que ofrece las casillas; `request_report`,
 * que valida lo que llega antes de despertar al worker; y la plantilla, que
 * decide qué imprime. Si se añade una sección, se añade aquí y se pinta en
 * `template.ts` — el resto sigue funcionando sin tocarlo.
 *
 * El worker es tolerante con lo que no conoce: una sección desconocida se
 * ignora en vez de reventar el informe. Un despliegue puede tener el front y el
 * worker a distinta versión durante los minutos que tarda un reinicio, y en esa
 * ventana es mejor un informe sin una sección nueva que ningún informe.
 */

export const SECCIONES = [
  'resumen',
  'actividad',
  'analisis',
  'revisiones',
  'eventos',
  'edificios',
  'tendencia',
  'salas',
  'lamparas',
  'estancadas',
  'materiales',
  'equipo',
  'recomendaciones',
] as const

export type Seccion = (typeof SECCIONES)[number]

/**
 * Lo que sale si nadie elige nada.
 *
 * `equipo` queda fuera por defecto, y es la única exclusión deliberada: son
 * nombres de personas con un recuento de trabajo al lado. Que aparezca tiene que
 * ser una decisión de quien pide el informe, no lo que pasa por no leer las
 * casillas.
 */
export const SECCIONES_POR_DEFECTO: Seccion[] = SECCIONES.filter((s) => s !== 'equipo')

/** Para quién se escribe. Cambia la voz y lo que se cuenta; nunca una cifra. */
export type Audiencia = 'direccion' | 'equipo'

/**
 * Lo que NO lleva un informe para dirección, se marque lo que se marque.
 *
 * «Sin cerrar» es la lista de incidencias con sus días abiertas. Es la sección
 * que el equipo mira el lunes y la que convierte un aula difícil en un
 * reproche cuando la lee el cliente: el documento de dirección no dice cuántos
 * días lleva abierta nada, y por eso esta sección no se puede pedir para él.
 * Se quita al leer las opciones, no al imprimir, para que el archivo tampoco
 * diga que se pidió.
 */
export const VETADAS_PARA_DIRECCION: Seccion[] = ['estancadas']

/**
 * Lo que sale para cada audiencia si nadie elige nada.
 *
 * Para dirección quedan fuera, además de la vetada, las secciones que son
 * registro del servicio y no estado del campus: cada revisión con quién la
 * hizo, el diario de movimientos, cada cierre con sus días y el reparto con
 * nombres. Se pueden marcar a mano —salvo la vetada—, pero no son lo que se
 * lleva a la mesa del cliente sin que nadie lo haya pedido.
 */
const FUERA_PARA_DIRECCION: Seccion[] = ['revisiones', 'eventos', 'equipo', ...VETADAS_PARA_DIRECCION]

export function seccionesPorDefecto(audiencia: Audiencia): Seccion[] {
  return audiencia === 'direccion'
    ? SECCIONES.filter((s) => !FUERA_PARA_DIRECCION.includes(s))
    : SECCIONES_POR_DEFECTO
}

export interface Opciones {
  secciones: Seccion[]
  /** Enseñar la variación contra el tramo anterior. Con datos de un solo día suele estorbar. */
  comparar: boolean
  /** Pedir la redacción a Gemini. En falso, sale la calculada aunque haya clave. */
  ia: boolean
  audiencia: Audiencia
  /** Instrucción libre para la redacción: «céntrate en el edificio H». */
  enfoque?: string
  /** Nota del que lo pide, impresa tal cual bajo el título. No pasa por la IA. */
  nota?: string
}

const es = (v: unknown): v is Seccion => SECCIONES.includes(v as Seccion)

/** Lee lo que venga del `params` del RPC sin confiar en nada. */
export function leerOpciones(bruto: unknown): Opciones {
  const p = (typeof bruto === 'object' && bruto !== null ? bruto : {}) as Record<string, unknown>

  const audiencia: Audiencia = p['audiencia'] === 'equipo' ? 'equipo' : 'direccion'
  const pedidas = (Array.isArray(p['secciones']) ? p['secciones'].filter(es) : []).filter(
    (s) => audiencia !== 'direccion' || !VETADAS_PARA_DIRECCION.includes(s),
  )

  return {
    // Un array vacío —o con solo nombres que no existen— es el informe completo,
    // no un informe en blanco: nadie pide un PDF con la portada y nada más.
    secciones: pedidas.length ? [...new Set(pedidas)] : seccionesPorDefecto(audiencia),
    comparar: p['comparar'] !== false,
    ia: p['ia'] !== false,
    audiencia,
    ...(typeof p['enfoque'] === 'string' && p['enfoque'].trim()
      ? { enfoque: p['enfoque'].trim().slice(0, 400) }
      : {}),
    ...(typeof p['nota'] === 'string' && p['nota'].trim()
      ? { nota: p['nota'].trim().slice(0, 300) }
      : {}),
  }
}

export function tiene(o: Opciones, s: Seccion): boolean {
  return o.secciones.includes(s)
}
