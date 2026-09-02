/**
 * Las secciones del informe, con nombre de persona.
 *
 * Espejo de `informe/opciones.ts`. Las claves tienen que coincidir —viajan tal
 * cual en `params.secciones` y son las que lee la plantilla—; los textos son de
 * aquí, porque el contrato del informe no tiene que saber cómo se llaman las
 * cosas en una pantalla.
 *
 * Si aquí aparece una sección que la plantilla todavía no pinta, se ignora y el
 * informe sale sin ella, en vez de reventar.
 */

import { type Audiencia, VETADAS_PARA_DIRECCION, seccionesPorDefecto } from './informe/opciones'

export interface SeccionInfo {
  clave: string
  etiqueta: string
  detalle: string
  /** Fuera del conjunto por defecto: hay que marcarla a mano. */
  optativa?: boolean
}

export const SECCIONES: SeccionInfo[] = [
  {
    clave: 'resumen',
    etiqueta: 'Resumen y cifras',
    detalle: 'La entradilla, los cuatro indicadores y su variación',
  },
  {
    clave: 'actividad',
    etiqueta: 'Actividad día a día',
    detalle: 'Revisiones, altas y cierres de cada jornada',
  },
  {
    clave: 'analisis',
    etiqueta: 'Lo que dicen los datos',
    detalle: 'Los hallazgos del periodo, redactados',
  },
  {
    clave: 'revisiones',
    etiqueta: 'Revisiones del periodo',
    detalle: 'Cada revisión hecha: sala, hora, quién y cómo salió',
  },
  {
    clave: 'eventos',
    etiqueta: 'Diario del periodo',
    detalle: 'Día a día: altas, cierres, material, inventarios y equipos',
  },
  {
    clave: 'edificios',
    etiqueta: 'Dónde está el trabajo',
    detalle: 'Reparto por edificio y cobertura de la ronda',
  },
  {
    clave: 'tendencia',
    etiqueta: 'Tendencia de doce meses',
    detalle: 'Para poner la semana en contexto',
  },
  {
    clave: 'salas',
    etiqueta: 'Salas señaladas',
    detalle: 'Las que acumulan incidencias y las que repiten el mismo repuesto',
  },
  {
    clave: 'lamparas',
    etiqueta: 'Lámparas al límite',
    detalle: 'Por debajo del 20 % de vida restante',
  },
  {
    clave: 'estancadas',
    etiqueta: 'Sin cerrar',
    detalle: 'Lo que lleva más de una semana abierto',
  },
  {
    clave: 'materiales',
    etiqueta: 'Material consumido',
    detalle: 'Qué se ha gastado del almacén en el periodo',
  },
  {
    clave: 'tiempos',
    etiqueta: 'Cuánto se tarda en cerrar',
    detalle: 'La mediana, la media y las cerradas en menos de 48 h. Desmárcala para que el informe no dé ese número',
  },
  {
    clave: 'cierres',
    etiqueta: 'Cada cierre, con sus días',
    detalle: 'Uno por línea: cuándo se abrió, cuándo se cerró, cuánto llevó y qué se hizo. Es lo que sirve para justificar un tiempo',
  },
  {
    clave: 'equipo',
    etiqueta: 'Reparto del trabajo',
    detalle: 'Con nombres: revisiones y altas de cada persona',
    optativa: true,
  },
  {
    clave: 'fotos',
    etiqueta: 'Fotos del periodo',
    detalle: 'Las de las revisiones y las de las incidencias, dentro del propio documento y diciendo de cuándo es cada una: cómo se encontró y cómo quedó',
  },
  {
    clave: 'recomendaciones',
    etiqueta: 'Qué conviene hacer',
    detalle: 'Las acciones que salen de los hallazgos',
  },
]

export const POR_DEFECTO = SECCIONES.filter((s) => !s.optativa).map((s) => s.clave)

/**
 * Las casillas que se ofrecen para una audiencia, y las marcadas de entrada.
 *
 * Las dos salen del contrato del informe, no de aquí: si «Sin cerrar» no se
 * puede pedir para dirección, la casilla no está, en vez de estar y no hacer
 * nada. Y al cambiar de audiencia se vuelve a lo marcado por defecto de la
 * nueva, porque lo que se había marcado era para la otra.
 */
export function seccionesDe(audiencia: Audiencia): SeccionInfo[] {
  return SECCIONES.filter(
    (s) => audiencia !== 'direccion' || !(VETADAS_PARA_DIRECCION as string[]).includes(s.clave),
  )
}

export function porDefectoDe(audiencia: Audiencia): string[] {
  return [...seccionesPorDefecto(audiencia)]
}

export const AUDIENCIAS = [
  {
    clave: 'direccion',
    etiqueta: 'Dirección',
    detalle:
      'Para el cliente: lo que ha mejorado, lo que está en curso y las decisiones que convienen. Sin días abiertos ni salas señaladas',
  },
  {
    clave: 'equipo',
    etiqueta: 'Equipo técnico',
    detalle: 'El parte del servicio: lo grave primero, qué salas tocar, con qué material y en qué orden',
  },
] as const

export const NIVELES_RAZONAMIENTO = [
  { clave: 'minimal', etiqueta: 'Mínimo', detalle: 'Casi sin pensar. Rápido y barato' },
  { clave: 'low', etiqueta: 'Bajo', detalle: 'Lo justo para ordenar los hechos' },
  { clave: 'medium', etiqueta: 'Medio', detalle: 'Equilibrio entre coste y criterio' },
  {
    clave: 'high',
    etiqueta: 'Alto',
    detalle: 'Recomendado: agrupa señales y descarta lo que no aporta',
  },
] as const
