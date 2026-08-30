/**
 * Qué es cada columna de cada hoja, y quién manda en ella.
 *
 * Es la única declaración de la sincronización, y va aparte a propósito: el
 * resto del código —el cruce, la fusión, el volcado, la vuelta— no menciona
 * ninguna columna por su letra. Así, el día que alguien inserte una columna en
 * la hoja o rebautice una cabecera, se toca aquí y nada más.
 *
 * Y por eso cada columna lleva **la cabecera que espera encontrar**. Una `M` que
 * ya no es `S/N Proyector` porque alguien metió una columna delante no se
 * distingue de una `M` normal mirando los valores: los dos lados son texto corto
 * en mayúsculas. Comprobar la cabecera antes de escribir convierte un desastre
 * silencioso —280 números de serie en la columna equivocada— en una pasada que
 * se niega a empezar diciendo qué columna no cuadra.
 *
 * Sobre los dueños, que es lo que decide la dirección de cada celda y está
 * explicado en `fusion.ts`, aquí solo van las tres decisiones propias de **este**
 * libro y que no se deducen de nada:
 *
 * **`Fecha Revisión Anterior` es de la app y no se discute.** No es un dato: es
 * la penúltima fecha de un historial. Si alguien la escribe a mano, lo que dice
 * es falso en cuanto haya una revisión más, y dejarla entrar contaminaría el
 * historial con una revisión que no existió.
 *
 * **`Horas Proyector` y `% Lámparas` son medidas.** Si cambian los dos lados no
 * gana quien escribió el último, gana la lectura más reciente. Es la única
 * columna donde «el último gana» sería activamente peligroso: la alerta de
 * lámpara se calcula con esto.
 *
 * **`Microfono Jabra` es dos columnas metidas en una.** En 32 filas dice `SÍ` o
 * `NO` —si hay micrófono— y en 37 lleva el número de serie del aparato. Las dos
 * cosas son ciertas y las dos hay que conservarlas, así que la columna se lee
 * mirando la forma del valor: lo que parece un número de serie va al micrófono,
 * y lo que parece un sí o un no va a la capacidad. Escribir una encima de la
 * otra perdería 37 números de serie o 32 respuestas, y no hay manera de
 * elegir cuál de las dos pérdidas es la buena.
 */

import type { Dueno } from './fusion'

// -----------------------------------------------------------------------------
// La forma de una columna
// -----------------------------------------------------------------------------

export type Tipo =
  /** Texto tal cual. */
  | 'texto'
  /** Número. Un texto donde debería haber número es cuarentena, no un cero. */
  | 'numero'
  /** Fecha. En el fichero es el número de serie de Excel. */
  | 'fecha'
  /** Fracción de 0 a 1 con formato `0%`: el `0,86` de la hoja es el 86 %. */
  | 'porcentaje'
  /** `SÍ`/`NO` en cualquiera de sus doce grafías. */
  | 'si_no'
  /** Celda calculada por la propia hoja. Nunca se escribe encima. */
  | 'formula'

export interface Columna {
  letra: string
  /** Lo que tiene que decir la cabecera. Se comprueba antes de escribir nada. */
  cabecera: string
  /**
   * De dónde sale el valor en la aplicación.
   *
   *  - `sala.code`, `rooms.projector_hours`… un campo directo
   *  - `equipo:Proyector:serial` el número de serie del proyector de la sala
   *  - `capacidad:altavoces` una clave de `rooms.capabilities`
   *  - `mes:3` el consumo de marzo
   *  - `derivado:...` algo que se calcula y que el Excel no puede devolver
   */
  campo: string
  dueno: Dueno
  tipo: Tipo
  /** Para `dueno: 'medida'`: el campo que dice cuándo se tomó la lectura. */
  fechaDe?: string
  /** La fórmula que le toca, con `{f}` en lugar del número de fila. */
  formula?: string
  /** Por qué es de quien es, cuando no salta a la vista. */
  nota?: string
}

export type Identidad =
  /** Por la matrícula de la columna `Ref`, con el cruce como respaldo. */
  | { tipo: 'sala' }
  /** Por el número de incidencia (`I260102_0007`). */
  | { tipo: 'incidencia'; columna: string }
  /** Por el nombre del artículo, resuelto por alias. */
  | { tipo: 'articulo'; columna: string }

export interface Hoja {
  nombre: string
  /** Fila de la cabecera. */
  cabecera: number
  identidad: Identidad
  columnas: Columna[]
  /**
   * `true` si la hoja está cerrada: se lee para entender el histórico y no se
   * escribe nunca. Las de 2025 lo están porque son un cierre que alguien dio
   * por bueno, y corregirlo a posteriori cambia cuentas ya rendidas.
   */
  congelada?: boolean
  /** Filas por debajo de la cabecera que no son datos (totales, IVA). */
  filasDeTotales?: number
  nota?: string
}

// -----------------------------------------------------------------------------
// Hoja de estado — una fila por sala
// -----------------------------------------------------------------------------

/** Los aparatos que la hoja saca en columnas, con el tipo del catálogo. */
export const EQUIPOS_EN_COLUMNAS = [
  'Proyector',
  'Cámara',
  'TV',
  'Monitor',
  'Ordenador',
  'Micrófono',
  'Screenbeam',
  'Barco',
  'Panacast 50',
] as const

export const ESTADO: Hoja = {
  nombre: 'Estado Aulas y Salas de reunion',
  cabecera: 1,
  identidad: { tipo: 'sala' },
  columnas: [
    { letra: 'A', cabecera: 'EDIFICIO', campo: 'edificio', dueno: 'ambos', tipo: 'texto' },
    { letra: 'B', cabecera: 'PLANTA/MÓDULO', campo: 'zona', dueno: 'ambos', tipo: 'texto' },
    { letra: 'C', cabecera: 'AULAS', campo: 'sala.code', dueno: 'ambos', tipo: 'texto' },
    {
      letra: 'D',
      cabecera: 'Fecha Revisión',
      campo: 'revision.ultima',
      dueno: 'ambos',
      tipo: 'fecha',
      nota: 'Escribirla en el Excel crea una revisión sin autor, con source = sharepoint. Nunca pisa una hecha en la app con fecha posterior.',
    },
    {
      letra: 'E',
      cabecera: 'Fecha Revisión Anterior',
      campo: 'revision.penultima',
      dueno: 'solo_app',
      tipo: 'fecha',
      nota: 'No es un dato: es la penúltima fecha de un historial. Escrita a mano deja de ser verdad en cuanto haya una revisión más.',
    },
    {
      letra: 'F',
      cabecera: 'Horas Proyector',
      campo: 'rooms.projector_hours',
      dueno: 'medida',
      tipo: 'numero',
      fechaDe: 'revision.ultima',
    },
    {
      letra: 'G',
      cabecera: '% Lámparas',
      campo: 'rooms.lamp_pct',
      dueno: 'medida',
      tipo: 'porcentaje',
      fechaDe: 'revision.ultima',
    },
    { letra: 'H', cabecera: 'Altavoces', campo: 'capacidad:altavoces', dueno: 'ambos', tipo: 'si_no' },
    { letra: 'I', cabecera: 'Cámara', campo: 'capacidad:camara', dueno: 'ambos', tipo: 'si_no' },
    {
      letra: 'J',
      cabecera: 'Microfono Jabra',
      campo: 'microfono',
      dueno: 'ambos',
      tipo: 'texto',
      nota: 'Dos columnas en una: 32 filas dicen SÍ/NO y 37 llevan el número de serie del micrófono. Se decide por la forma del valor.',
    },
    {
      letra: 'K',
      cabecera: 'Botonera',
      campo: 'rooms.botonera_estado',
      dueno: 'ambos',
      tipo: 'texto',
      nota: 'No es un sí o un no: «Actualizada *», «Actualizada», «No tiene». Se guarda literal, asterisco incluido.',
    },
    { letra: 'L', cabecera: 'Modelo Proyector', campo: 'equipo:Proyector:model', dueno: 'ambos', tipo: 'texto' },
    { letra: 'M', cabecera: 'S/N Proyector', campo: 'equipo:Proyector:serial', dueno: 'ambos', tipo: 'texto' },
    { letra: 'N', cabecera: 'Modelo Camara', campo: 'equipo:Cámara:model', dueno: 'ambos', tipo: 'texto' },
    { letra: 'O', cabecera: 'S/N Cámara', campo: 'equipo:Cámara:serial', dueno: 'ambos', tipo: 'texto' },
    { letra: 'P', cabecera: 'Modelo TV', campo: 'equipo:TV:model', dueno: 'ambos', tipo: 'texto' },
    { letra: 'Q', cabecera: 'S/N TV', campo: 'equipo:TV:serial', dueno: 'ambos', tipo: 'texto' },
    { letra: 'R', cabecera: 'S/N Monitor', campo: 'equipo:Monitor:serial', dueno: 'ambos', tipo: 'texto' },
    { letra: 'S', cabecera: 'S/N Ordenador', campo: 'equipo:Ordenador:serial', dueno: 'ambos', tipo: 'texto' },
    {
      letra: 'T',
      cabecera: 'Modelo',
      campo: 'equipo:Ordenador:model',
      dueno: 'ambos',
      tipo: 'texto',
      nota: 'La cabecera dice solo «Modelo» porque va detrás de «S/N Ordenador»: es el modelo del ordenador.',
    },
    {
      letra: 'U',
      cabecera: 'Sreenbeam',
      campo: 'equipo:Screenbeam:serial',
      dueno: 'ambos',
      tipo: 'texto',
      nota: 'La cabecera trae la errata. Corregirla es cosa de una persona; mientras tanto hay que cruzar con lo que dice.',
    },
    { letra: 'V', cabecera: 'Barco', campo: 'equipo:Barco:serial', dueno: 'ambos', tipo: 'texto' },
    { letra: 'W', cabecera: 'Panacast 50', campo: 'equipo:Panacast 50:serial', dueno: 'ambos', tipo: 'texto' },
    {
      letra: 'X',
      cabecera: 'Observaciones',
      campo: 'revision.notas',
      dueno: 'ambos',
      tipo: 'texto',
      nota: 'Las 22 que hay las escribió alguien en la hoja. Marcarla como columna de la app las borraría en la primera pasada.',
    },
  ],
}

// -----------------------------------------------------------------------------
// Material instalado — una fila por parte
// -----------------------------------------------------------------------------

/**
 * El libro tiene una hoja por año y no se pueden dar por iguales: la de 2025
 * lleva una columna `Observación` que la de 2026 no tiene, y a partir de ahí
 * todas las letras bailan una posición. Es exactamente el fallo que la
 * comprobación de cabeceras existe para pillar.
 */
function materialInstalado(anyo: number, conObservacion: boolean): Hoja {
  const c = (n: number): string => String.fromCharCode(65 + n)
  let i = 0
  const columnas: Columna[] = [
    { letra: c(i++), cabecera: 'Aula', campo: 'sala.code', dueno: 'ambos', tipo: 'texto' },
    { letra: c(i++), cabecera: 'Fecha', campo: 'incidencia.abierta', dueno: 'ambos', tipo: 'fecha' },
    { letra: c(i++), cabecera: 'Fecha resuelta', campo: 'incidencia.resuelta', dueno: 'ambos', tipo: 'fecha' },
    { letra: c(i++), cabecera: 'N.º Incidencia', campo: 'incidencia.numero', dueno: 'ambos', tipo: 'texto' },
    { letra: c(i++), cabecera: 'Problema del Aula', campo: 'incidencia.problema', dueno: 'ambos', tipo: 'texto' },
  ]
  if (conObservacion) {
    columnas.push({
      letra: c(i++),
      cabecera: 'Observación',
      campo: 'incidencia.observacion',
      dueno: 'ambos',
      tipo: 'texto',
    })
  }
  columnas.push(
    { letra: c(i++), cabecera: 'Resolución', campo: 'incidencia.resolucion', dueno: 'ambos', tipo: 'texto' },
    {
      letra: c(i++),
      cabecera: 'Material Usado',
      campo: 'incidencia.material',
      dueno: 'ambos',
      tipo: 'texto',
      nota: 'Texto libre («2 Cable Hdmi 10mts Fibra»). De aquí salen los movimientos de consumo, y por eso los alias de artículo no son un lujo.',
    },
  )

  return {
    nombre: `Material Instalado ${anyo}`,
    cabecera: 1,
    identidad: { tipo: 'incidencia', columna: columnas[3]!.letra },
    columnas,
  }
}

export const MATERIAL_2026 = materialInstalado(2026, false)
export const MATERIAL_2025: Hoja = { ...materialInstalado(2025, true), congelada: true }

// -----------------------------------------------------------------------------
// Bolsa — una fila por artículo, con el consumo mes a mes
// -----------------------------------------------------------------------------

const MESES = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
] as const

/**
 * Las doce columnas de mes.
 *
 * Son de la app y no de las dos: el consumo sale de sumar los movimientos de
 * `stock_movements` de ese mes, y un número tecleado encima no se puede repartir
 * entre las incidencias que lo gastaron. Escribirlos aquí es justamente lo que
 * arregla el descuadre: hoy las doce están vacías mientras la hoja de partes del
 * mismo año lleva 96 consumos apuntados.
 */
function columnasDeMes(desde: number): Columna[] {
  return MESES.map((mes, i) => ({
    letra: String.fromCharCode(65 + desde + i),
    cabecera: mes,
    campo: `mes:${i + 1}`,
    dueno: 'solo_app' as const,
    tipo: 'numero' as const,
  }))
}

export const BOLSA_2026: Hoja = {
  nombre: 'Bolsa 2026',
  cabecera: 1,
  identidad: { tipo: 'articulo', columna: 'A' },
  columnas: [
    { letra: 'A', cabecera: 'Articulo / Material', campo: 'articulo.nombre', dueno: 'ambos', tipo: 'texto' },
    ...columnasDeMes(1),
    {
      letra: 'N',
      cabecera: 'Total Instalado',
      campo: 'articulo.consumido',
      dueno: 'formula',
      tipo: 'formula',
      formula: '=B{f}+C{f}+D{f}+E{f}+F{f}+G{f}+H{f}+I{f}+J{f}+K{f}+L{f}+M{f}',
      nota: 'Es la suma de los doce meses. En tres filas alguien escribió el número encima y desde entonces esa celda miente: se le devuelve la fórmula.',
    },
    {
      letra: 'O',
      cabecera: 'Stock Disponible',
      campo: 'articulo.disponible',
      dueno: 'formula',
      tipo: 'formula',
      formula: '=P{f}-N{f}',
      nota: 'La fila 35 apuntaba a la 34. Un error de arrastre que nadie ve porque el resultado es un número plausible.',
    },
    {
      letra: 'P',
      cabecera: 'Total Comprado',
      campo: 'articulo.comprado',
      dueno: 'ambos',
      tipo: 'numero',
      nota: 'Entra como movimiento de compra. Si el Excel dice más que la base, la diferencia es una compra que nadie apuntó en la aplicación.',
    },
    {
      letra: 'Q',
      cabecera: 'Articulo / Material',
      campo: 'articulo.nombreAlternativo',
      dueno: 'solo_excel',
      tipo: 'texto',
      nota: 'La segunda grafía del mismo artículo. No se toca: es de donde salen los alias, y reescribirla los perdería.',
    },
  ],
}

export const BOLSA_2025: Hoja = {
  nombre: 'Bolsa 2025',
  cabecera: 1,
  congelada: true,
  // Las tres últimas filas son la suma, el 21 % de IVA y el total con IVA.
  filasDeTotales: 3,
  identidad: { tipo: 'articulo', columna: 'A' },
  columnas: [
    { letra: 'A', cabecera: 'Nombre del material', campo: 'articulo.nombre', dueno: 'solo_excel', tipo: 'texto' },
    ...columnasDeMes(1).map((c) => ({ ...c, dueno: 'solo_excel' as const })),
    { letra: 'N', cabecera: 'TOTAL', campo: 'articulo.consumido', dueno: 'formula', tipo: 'formula' },
    { letra: 'O', cabecera: 'Bolsa de material 1 Inversión 2025', campo: 'articulo.bolsa1', dueno: 'solo_excel', tipo: 'numero' },
    { letra: 'P', cabecera: 'Precio unidad', campo: 'articulo.precio1', dueno: 'solo_excel', tipo: 'numero' },
    { letra: 'Q', cabecera: 'Total', campo: 'articulo.total1', dueno: 'formula', tipo: 'formula' },
    { letra: 'R', cabecera: 'Bolsa de material 2 Inversión 2025', campo: 'articulo.bolsa2', dueno: 'solo_excel', tipo: 'numero' },
    { letra: 'S', cabecera: 'Precio unidad', campo: 'articulo.precio2', dueno: 'solo_excel', tipo: 'numero' },
    { letra: 'T', cabecera: 'Total', campo: 'articulo.total2', dueno: 'formula', tipo: 'formula' },
    { letra: 'U', cabecera: 'TOTAL MATERIAL 2025', campo: 'articulo.totalAnyo', dueno: 'formula', tipo: 'formula' },
    { letra: 'V', cabecera: 'Stock 2025 disponible', campo: 'articulo.disponible', dueno: 'solo_excel', tipo: 'numero' },
    { letra: 'W', cabecera: 'Comprado', campo: 'articulo.comprado', dueno: 'solo_excel', tipo: 'numero' },
    { letra: 'X', cabecera: 'Total STOCK', campo: 'articulo.stockFinal', dueno: 'formula', tipo: 'formula' },
    { letra: 'Y', cabecera: 'Nombre del material', campo: 'articulo.nombreAlternativo', dueno: 'solo_excel', tipo: 'texto' },
  ],
  nota: 'Cerrada. Se lee para sacar alias y el saldo de apertura de 2026, y no se escribe: es un cierre que alguien dio por bueno, con su IVA calculado.',
}

// -----------------------------------------------------------------------------

export const HOJAS: Hoja[] = [ESTADO, MATERIAL_2026, BOLSA_2026, MATERIAL_2025, BOLSA_2025]

export function hojaPorNombre(nombre: string): Hoja | undefined {
  return HOJAS.find((h) => h.nombre === nombre)
}

/** La hoja de partes y la de bolsa de un año, si el libro las lleva. */
export function hojasDelAnyo(anyo: number): { material: string; bolsa: string } {
  return { material: `Material Instalado ${anyo}`, bolsa: `Bolsa ${anyo}` }
}

export function columna(hoja: Hoja, letra: string): Columna | undefined {
  return hoja.columnas.find((c) => c.letra === letra.toUpperCase())
}

export function columnaDeCampo(hoja: Hoja, campo: string): Columna | undefined {
  return hoja.columnas.find((c) => c.campo === campo)
}

/** El tipo de equipo y el campo que pide una columna `equipo:Tipo:campo`. */
export function equipoDe(campo: string): { tipo: string; campo: 'serial' | 'model' } | null {
  const m = /^equipo:(.+):(serial|model)$/.exec(campo)
  return m ? { tipo: m[1]!, campo: m[2] as 'serial' | 'model' } : null
}

/** La clave de `capabilities` que pide una columna `capacidad:x`. */
export function capacidadDe(campo: string): string | null {
  return /^capacidad:(.+)$/.exec(campo)?.[1] ?? null
}

/** El mes (1-12) que pide una columna `mes:n`. */
export function mesDe(campo: string): number | null {
  const m = /^mes:(\d+)$/.exec(campo)
  return m ? Number(m[1]) : null
}

// -----------------------------------------------------------------------------
// La comprobación que va antes de escribir nada
// -----------------------------------------------------------------------------

export interface Desajuste {
  hoja: string
  letra: string
  esperada: string
  encontrada: string
}

/**
 * Compara las cabeceras del libro con las que declara el mapa.
 *
 * Se compara con tolerancia a mayúsculas, tildes y espacios de sobra —la
 * cabecera `S/N Monitor ` del libro real lleva un espacio final— y sin tolerancia
 * a nada más. Una columna insertada mueve todas las de su derecha, y eso sí
 * cambia la palabra.
 */
export function comprobarCabeceras(
  hoja: Hoja,
  cabeceras: Record<string, string | number | boolean | null>,
): Desajuste[] {
  const fuera: Desajuste[] = []
  for (const c of hoja.columnas) {
    const encontrada = cabeceras[c.letra]
    const texto = encontrada === null || encontrada === undefined ? '' : String(encontrada)
    if (llana(texto) !== llana(c.cabecera)) {
      fuera.push({ hoja: hoja.nombre, letra: c.letra, esperada: c.cabecera, encontrada: texto })
    }
  }
  return fuera
}

function llana(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}
