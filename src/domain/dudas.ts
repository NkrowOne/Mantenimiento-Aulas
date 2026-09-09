/**
 * Lo que la pasada no decide sola y pregunta antes de aplicar.
 *
 * Hasta aquí una fila que no cruzaba se contaba y se dejaba quieta, que es la
 * regla que hace que la sincronización se pueda ejecutar sin miedo. Pero contar
 * no resuelve: la fila «Sala Vip» de la hoja de estado lleva dos años sin cruzar
 * y va a seguir así, porque nadie sabe desde el libro que la aplicación la tiene
 * como «Sala VIP» en «Rectorado». Y un parte nuevo tecleado en el libro con el
 * aula «3.2» —sin edificio— tiene ocho salas candidatas y ninguna forma de
 * elegir sin preguntar.
 *
 * Una **duda** es eso: una pregunta concreta, con lo que hace falta para
 * contestarla, que sale de la pasada y se enseña antes de aplicar. La respuesta
 * vuelve a entrar en la pasada —que se vuelve a calcular con ella— y lo que era
 * una fila sin cruzar pasa a ser una fila normal.
 *
 * Hay dos clases, y no se mezclan porque se contestan distinto:
 *
 *  - **`sala`**: ¿de qué sala habla esta fila? Se contesta eligiendo una del
 *    maestro, diciendo que no es de ninguna (un parte sin aula) o dejándola
 *    como está. Sale en la hoja de estado —filas con datos y sin código— y en
 *    los partes nuevos cuyo aula no cruza o cruza con varias.
 *  - **`alta`**: ¿esto nuevo entra en la aplicación? Un número de serie que
 *    crearía un equipo que la sala no tenía, un artículo que la bolsa lleva y el
 *    almacén no, un ordenador de repuesto que la hoja de PCs lista y la base
 *    desconoce. Se contesta sí o no.
 *
 * Las respuestas van por el identificador de la duda, que sale de la hoja y la
 * fila —y de la columna o el tipo de equipo cuando una fila puede preguntar
 * más de una cosa—. Es estable dentro de una pasada, que es lo único que hace
 * falta: la pantalla las recoge y la pasada las lee, y se tiran al empezar de
 * nuevo con otro libro.
 */

export interface SalaCandidata {
  id: string
  shortRef: string
  code: string
  edificio: string
  zona: string
}

export type Duda =
  | {
      tipo: 'sala'
      id: string
      hoja: string
      fila: number
      /** De dónde sale la pregunta: una fila de estado o un parte nuevo. */
      que: 'estado' | 'parte'
      /** Lo que la fila dice de sí misma, para poder contestar sin abrir el libro. */
      texto: string
      /** Por qué no se pudo decidir. */
      motivo: string
      /** Las salas entre las que se duda, si el cruce llegó a dudar entre algunas. */
      candidatas: SalaCandidata[]
    }
  | {
      tipo: 'alta'
      id: string
      hoja: string
      fila: number
      que: 'equipo' | 'articulo' | 'unidad'
      texto: string
      detalle: string
    }

export type Respuesta =
  /** Es esa sala. */
  | { tipo: 'sala'; salaId: string }
  /** No es de ninguna sala: un parte que entra sin aula. Solo para partes. */
  | { tipo: 'sin_sala' }
  /** Se deja como está: ni se toca ni se vuelve a preguntar en esta pasada. */
  | { tipo: 'ignorar' }
  /** Sí o no al alta. */
  | { tipo: 'alta'; aceptar: boolean }

/** Las respuestas dadas, por identificador de duda. */
export type Respuestas = Record<string, Respuesta>

export function idDeDuda(hoja: string, fila: number, extra?: string): string {
  return extra ? `${hoja}!${fila}!${extra}` : `${hoja}!${fila}`
}

/** Las dudas que todavía no tienen respuesta. */
export function pendientes(dudas: Duda[], respuestas: Respuestas): Duda[] {
  return dudas.filter((d) => !(d.id in respuestas))
}
