/**
 * Lo que se le manda a `request_report`, armado aparte de la pantalla.
 *
 * Está en su propio fichero por un fallo concreto que ya ocurrió una vez: la
 * pantalla recogía «Desde» y «Hasta», los guardaba en su estado y no los
 * incluía en la llamada. El worker calculaba entonces su periodo por defecto, y
 * quien pedía marzo recibía un PDF con los datos de ayer etiquetado «a medida».
 * Un documento equivocado que parece legítimo es peor que un error, porque se
 * archiva y se cita.
 *
 * Armar la petición es una función pura, así que se puede comprobar sin montar
 * un navegador. Es lo que hace `peticion.test.ts`.
 */

import type { Kind, Rango } from './periodos'

export interface Eleccion {
  kind: Kind
  rango: Rango
  secciones: string[]
  comparar: boolean
  ia: boolean
  audiencia: 'direccion' | 'equipo'
  enfoque: string
  nota: string
}

export interface Peticion {
  kind: Kind
  p_start: string
  p_end: string
  p_params: {
    secciones: string[]
    comparar: boolean
    ia: boolean
    audiencia: 'direccion' | 'equipo'
    enfoque?: string
    nota?: string
  }
}

/** Máximo que acepta la función de la base: más sería cargar el histórico entero. */
export const DIAS_MAXIMOS = 366

export function construirPeticion(e: Eleccion): Peticion {
  return {
    kind: e.kind,
    p_start: e.rango.start,
    p_end: e.rango.end,
    p_params: {
      secciones: e.secciones,
      comparar: e.comparar,
      ia: e.ia,
      audiencia: e.audiencia,
      // Los textos en blanco no viajan: un `enfoque` vacío en el expediente de
      // la IA es una instrucción vacía, y una `nota` vacía imprimiría una caja
      // con nada dentro en la portada.
      ...(e.enfoque.trim() ? { enfoque: e.enfoque.trim() } : {}),
      ...(e.nota.trim() ? { nota: e.nota.trim() } : {}),
    },
  }
}

/**
 * Si se puede pedir, y si no, por qué no.
 *
 * Devuelve el motivo en vez de un booleano para poder enseñarlo: un botón
 * apagado sin explicación deja a quien lo mira buscando qué le falta.
 */
export function motivoParaNoPedir(e: Eleccion, dias: number): string | null {
  if (!e.rango.start || !e.rango.end) return 'Elige las dos fechas del periodo.'
  if (e.rango.end < e.rango.start) return 'La fecha final es anterior a la inicial.'
  if (dias > DIAS_MAXIMOS) return 'El periodo no puede superar un año.'
  if (e.secciones.length === 0) return 'Marca al menos una sección.'
  return null
}
