/**
 * Preparar el libro: darle a cada fila su matrícula.
 *
 * Es el paso que hay que dar una sola vez y antes que ningún otro, porque un
 * `.xlsx` **no tiene identidad de fila**. Insertar una fila arriba desplaza las
 * 400 de abajo, y para el sincronizador la fila 87 de hoy no es la de ayer. Con
 * ese punto de partida, «bidireccional» significa comparar dos hojas por
 * posición y escribir encima: la primera vez que alguien ordena por edificio se
 * cruzan doscientos números de serie sin que salte ningún error.
 *
 * La solución es una columna `Ref` con la matrícula `SALA-000087`, que la base
 * ya asigna y que no cambia ni al renombrar, ni al mover de planta, ni al
 * fusionar. A partir de ahí da igual cómo se ordene o se filtre la hoja.
 *
 * Dos decisiones que conviene leer antes de discutirlas:
 *
 * **La columna va al final, no la primera.** El documento de diseño decía «la
 * primera», y estaba equivocado: insertar una columna a la izquierda desplaza
 * todas las demás y hay que reescribir cada referencia de la hoja — las
 * fórmulas, el rango del autofiltro, los cuatro formatos condicionales, la
 * validación. Es exactamente el tipo de operación que rompe el libro en
 * silencio. Al final no desplaza nada, y para lo que sirve la columna —que la
 * lea la sincronización— da lo mismo dónde esté.
 *
 * **Una `Ref` que ya está y no coincide no se pisa.** Puede ser que alguien la
 * corrigiera a mano sabiendo algo que el cruce no sabe, o que el cruce se
 * equivoque. En los dos casos, sobreescribirla pierde la única señal de que hay
 * un desacuerdo. Se deja como está y se cuenta aparte.
 */

import { resolverSala } from './cruce'
import type { Indice } from './cruce'
import { columnaANumero, numeroAColumna } from './xlsx'
import type { Cambio, FilaLeida } from './xlsx'

export interface OpcionesDePreparacion {
  /** Fila de la cabecera, 1 por defecto. */
  cabecera?: number
  /** Columnas de edificio, planta y aula en la hoja de estado. */
  colEdificio?: string
  colZona?: string
  colAula?: string
  /** Título de la columna de matrículas. */
  titulo?: string
}

export interface Escritura {
  celda: string
  valor: string
  fila: number
  aula: string
  sala: string
}

export interface FilaSinResolver {
  fila: number
  aula: string
  edificio: string
  motivo: string
}

export interface Preparacion {
  /** Dónde va la matrícula: `Y`. */
  columna: string
  /** Lo que hay que escribir, cabecera incluida. */
  cambios: Cambio[]
  /** Detalle de cada matrícula que se escribiría. */
  escrituras: Escritura[]
  /** Filas que ya la tenían bien puesta. */
  yaCorrectas: number
  /** Filas con una `Ref` distinta de la que sale del cruce. No se tocan. */
  discrepan: Array<Escritura & { actual: string }>
  ambiguas: FilaSinResolver[]
  sinCruce: FilaSinResolver[]
  total: number
}

const vacio = (v: unknown): boolean => v === undefined || v === null || String(v).trim() === ''

/**
 * Decide en qué columna va la matrícula.
 *
 * Si la hoja ya tiene una columna con ese título se reutiliza —preparar dos
 * veces el mismo libro no debe dejar dos columnas `Ref`—; si no, la primera
 * libre a la derecha de todo lo que hay escrito.
 */
export function columnaParaLaRef(filas: FilaLeida[], cabecera: number, titulo: string): string {
  const fila = filas.find((f) => f.fila === cabecera)
  for (const [col, valor] of Object.entries(fila?.celdas ?? {})) {
    if (String(valor).trim().toLowerCase() === titulo.toLowerCase()) return col
  }
  let max = 0
  for (const f of filas) {
    for (const col of Object.keys(f.celdas)) max = Math.max(max, columnaANumero(col))
  }
  return numeroAColumna(max + 1)
}

/**
 * Cruza la hoja de estado y devuelve lo que habría que escribir. **No escribe**:
 * quien mira la pantalla tiene que poder ver qué va a pasar antes de que pase.
 */
export function prepararHojaDeEstado(
  filas: FilaLeida[],
  ix: Indice,
  opciones: OpcionesDePreparacion = {},
): Preparacion {
  const cabecera = opciones.cabecera ?? 1
  const colEdificio = opciones.colEdificio ?? 'A'
  const colZona = opciones.colZona ?? 'B'
  const colAula = opciones.colAula ?? 'C'
  const titulo = opciones.titulo ?? 'Ref'

  const columna = columnaParaLaRef(filas, cabecera, titulo)
  const p: Preparacion = {
    columna,
    cambios: [],
    escrituras: [],
    yaCorrectas: 0,
    discrepan: [],
    ambiguas: [],
    sinCruce: [],
    total: 0,
  }

  const filaCabecera = filas.find((f) => f.fila === cabecera)
  if (vacio(filaCabecera?.celdas[columna])) {
    p.cambios.push({ celda: `${columna}${cabecera}`, valor: titulo })
  }

  // El edificio y la planta van en celdas combinadas: solo aparecen en la
  // primera fila del grupo y valen para todas las de debajo hasta la siguiente.
  // Leer cada fila por su cuenta deja sin edificio a las nueve décimas partes.
  let edificio = ''
  let zona = ''

  for (const f of filas) {
    if (f.fila <= cabecera) continue
    if (!vacio(f.celdas[colEdificio])) edificio = String(f.celdas[colEdificio]).trim()
    if (!vacio(f.celdas[colZona])) zona = String(f.celdas[colZona]).trim()
    const aula = vacio(f.celdas[colAula]) ? '' : String(f.celdas[colAula]).trim()
    if (!aula || !edificio) continue

    p.total++
    const celda = `${columna}${f.fila}`
    const actual = vacio(f.celdas[columna]) ? '' : String(f.celdas[columna]).trim()
    const r = resolverSala(ix, { tipo: 'estado', edificio, zona, aula })

    if (r.estado === 'ambigua') {
      p.ambiguas.push({ fila: f.fila, aula, edificio, motivo: r.motivo })
      continue
    }
    if (r.estado === 'sin_cruce') {
      p.sinCruce.push({ fila: f.fila, aula, edificio, motivo: r.motivo })
      continue
    }

    const ref = r.sala.shortRef
    const escritura: Escritura = { celda, valor: ref, fila: f.fila, aula, sala: r.sala.name }

    if (actual === ref) {
      p.yaCorrectas++
      continue
    }
    if (actual !== '') {
      // Ya tenía otra. No se pisa: es la única señal de que algo no cuadra.
      p.discrepan.push({ ...escritura, actual })
      continue
    }

    p.escrituras.push(escritura)
    p.cambios.push({ celda, valor: ref })
  }

  return p
}
