/**
 * Qué se puede pedir de un informe.
 *
 * Este fichero es el contrato entre las piezas que tienen que estar de acuerdo:
 * `secciones.ts`, que ofrece las casillas con nombre de persona, y
 * `plantilla.ts`, que decide qué imprime. Si se añade una sección, se añade aquí
 * y se pinta allí — el resto sigue funcionando sin tocarlo.
 *
 * Es tolerante con lo que no conoce: una sección desconocida se ignora en vez de
 * reventar el informe. Importa porque `params` se lee también del archivo —de
 * informes emitidos por versiones anteriores, o por el worker— y un nombre que
 * ya no existe no puede impedir que se vuelva a leer lo que se pidió aquel día.
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
  'tiempos',
  'cierres',
  'equipo',
  'fotos',
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
 *
 * `tiempos` y `cierres` son las dos caras de la misma pregunta —cuánto se tarda
 * en cerrar— y por eso son secciones separadas: `tiempos` da la mediana y la
 * media, y se desmarca cuando ese número no ayuda; `cierres` pone cada cierre
 * con sus fechas y sus días, que es lo que hace falta cuando hay que justificar
 * por qué algo tardó lo que tardó. Se pueden llevar las dos, una, o ninguna.
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
const FUERA_PARA_DIRECCION: Seccion[] = ['revisiones', 'eventos', 'cierres', 'equipo', ...VETADAS_PARA_DIRECCION]

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
