/**
 * Las secciones del informe, con nombre de persona.
 *
 * Espejo de `reports-worker/src/opciones.ts`. Las claves tienen que coincidir
 * —viajan tal cual en `params.secciones`—; los textos son de aquí, porque el
 * worker no tiene que saber cómo se llaman las cosas en una pantalla.
 *
 * Si aquí aparece una sección que el worker todavía no conoce, el worker la
 * ignora y el informe sale sin ella. Es lo correcto durante los minutos que un
 * despliegue tarda en actualizar las dos piezas.
 */

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
    etiqueta: 'Material y tiempos',
    detalle: 'Consumo del periodo y cuánto se tarda en cerrar',
  },
  {
    clave: 'equipo',
    etiqueta: 'Reparto del trabajo',
    detalle: 'Con nombres: revisiones y altas de cada persona',
    optativa: true,
  },
  {
    clave: 'recomendaciones',
    etiqueta: 'Qué conviene hacer',
    detalle: 'Las acciones que salen de los hallazgos',
  },
]

export const POR_DEFECTO = SECCIONES.filter((s) => !s.optativa).map((s) => s.clave)

export const AUDIENCIAS = [
  {
    clave: 'direccion',
    etiqueta: 'Dirección',
    detalle: 'Estado general, tendencia y decisiones: compras, refuerzos, prioridades',
  },
  {
    clave: 'equipo',
    etiqueta: 'Equipo técnico',
    detalle: 'Qué salas tocar, con qué material y en qué orden',
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
