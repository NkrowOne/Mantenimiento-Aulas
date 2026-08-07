/**
 * Recuentos que concuerdan con su palabra.
 *
 * Nació dentro de la hoja de inventario, donde el mismo ternario estaba escrito
 * cuatro veces y una quinta línea se había quedado sin él: imprimía «1
 * averiados» en un papel que se firma y se archiva. Vive aquí desde que hizo
 * falta en la segunda pantalla, porque copiarlo era volver a repartir la misma
 * decisión por sitios que no se miran juntos — que es exactamente cómo apareció
 * el fallo la primera vez.
 *
 * No intenta ser una biblioteca de pluralización: el castellano de esta
 * aplicación se resuelve con las dos formas escritas a mano, y adivinarlas
 * produciría «revisiones» de «revisión» bien y «lápiz» mal.
 */

/** «1 equipo», «4 equipos», «0 salas». */
export function cuantos(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`
}
