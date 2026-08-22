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

export interface Opciones {
  secciones: Seccion[]
  /** Enseñar la variación contra el tramo anterior. Con datos de un solo día suele estorbar. */
  comparar: boolean
  /** Pedir la redacción a Gemini. En falso, sale la calculada aunque haya clave. */
  ia: boolean
  audiencia: 'direccion' | 'equipo'
  /** Instrucción libre para la redacción: «céntrate en el edificio H». */
  enfoque?: string
  /** Nota del que lo pide, impresa tal cual bajo el título. No pasa por la IA. */
  nota?: string
}

const es = (v: unknown): v is Seccion => SECCIONES.includes(v as Seccion)

/** Lee lo que venga del `params` del RPC sin confiar en nada. */
export function leerOpciones(bruto: unknown): Opciones {
  const p = (typeof bruto === 'object' && bruto !== null ? bruto : {}) as Record<string, unknown>

  const pedidas = Array.isArray(p['secciones']) ? p['secciones'].filter(es) : []

  return {
    // Un array vacío —o con solo nombres que no existen— es el informe completo,
    // no un informe en blanco: nadie pide un PDF con la portada y nada más.
    secciones: pedidas.length ? [...new Set(pedidas)] : SECCIONES_POR_DEFECTO,
    comparar: p['comparar'] !== false,
    ia: p['ia'] !== false,
    audiencia: p['audiencia'] === 'equipo' ? 'equipo' : 'direccion',
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
