/**
 * Qué salas casan con lo tecleado en el buscador de incidencias.
 *
 * El buscador promete «por descripción, referencia o sala», y la mitad de la
 * sala era mentira: el servidor filtraba solo por el texto de la incidencia, y
 * la sala se comprobaba después, en el cliente, sobre las filas que el texto
 * hubiera dejado pasar. Teclear «H» no encontraba las incidencias del edificio
 * H salvo que su título llevara una hache — así que el histórico entero de un
 * edificio podía «no existir» para quien lo buscaba.
 *
 * Esto resuelve la otra mitad: convierte lo tecleado en la lista de salas que
 * casan, para que la consulta al servidor pregunte también por `room_id`. Vive
 * aparte y sin tocar la red porque decidir qué casa es lógica pura, y es la
 * parte que rompe en silencio si nadie la prueba.
 */

import { norm } from '@/domain/normalize'

export interface SalaBuscable {
  id: string
  /** El código del edificio: `H`, `CRAI`, `BC`. */
  edificio: string
  /** El código de la sala: `1.7`, `-1.3`. */
  codigo: string
  nombre: string
}

/**
 * Tope de ids que viajan en la consulta. Un edificio entero son ~40 salas;
 * cien cubre cualquier búsqueda razonable sin fabricar una URL kilométrica.
 */
const MAX_SALAS = 100

export function salasQueCasan(salas: SalaBuscable[], query: string): string[] {
  const q = norm(query)
  if (!q) return []

  /*
   * Una consulta de SOLO letras es un edificio, y un edificio casa EXACTO: como
   * subcadena, «C» estaría dentro de «CRAI», «CD» y de media universidad. El
   * nombre descriptivo se le admite solo a partir de tres letras, para que
   * «grados» encuentre el salón sin que una letra suelta pesque en cada nombre.
   */
  const soloLetras = /^[A-ZÑ]+$/.test(q)

  const ids: string[] = []
  for (const s of salas) {
    const edificio = norm(s.edificio)
    const codigo = norm(s.codigo)

    /*
     * Las formas de nombrar una sala, todas vistas en el uso real: el edificio
     * a secas («H», «CRAI»), el código con o sin edificio y en los dos órdenes
     * («1.7», «H 1.7», «1.7 H» como lo escribe el histórico), y el nombre
     * descriptivo («Salón de grados»).
     */
    const casa = soloLetras
      ? edificio === q || (q.length >= 3 && norm(s.nombre).includes(q))
      : `${edificio} ${codigo}`.includes(q) ||
        `${codigo} ${edificio}`.includes(q) ||
        norm(s.nombre).includes(q)

    if (casa) {
      ids.push(s.id)
      if (ids.length >= MAX_SALAS) break
    }
  }
  return ids
}
