/**
 * Cómo salió la redacción de un informe archivado.
 *
 * Vive aparte de la pantalla porque es la pieza que decide qué se le dice a
 * quien mira el archivo, y eso hay que poder probarlo sin montar React.
 *
 * El problema que resuelve: con `ia` sola, el archivo mentía por omisión.
 * `false` valía igual para el informe que se pidió sin IA a propósito —salió
 * como se quería— que para el que la pidió y no la tuvo —salió a medias y nadie
 * se enteró—. Los dos ponían «análisis calculado» y se leían como lo mismo, así
 * que una clave caducada podía pasar semanas dando informes peores sin que
 * nada lo dijera.
 */

/** Lo que se guarda en `reports.params` sobre la redacción. */
export interface HuellaDeRedaccion {
  /** Si el análisis lo escribió de verdad la IA. */
  ia?: boolean
  /** Si se pidió que lo escribiera. Los informes antiguos no lo traen. */
  ia_pedida?: boolean
  /** Por qué no pudo, cuando se pidió y no salió. */
  aviso_ia?: string
}

export interface Redaccion {
  etiqueta: string
  /** Las clases del distintivo. El color es el estado, no adorno. */
  clase: string
  /**
   * Por qué no la redactó la IA, cuando se pidió que lo hiciera.
   *
   * Va como texto en la lista y no en un `title`: esto se mira desde un iPad, y
   * en una pantalla táctil no hay dónde posar el ratón.
   */
  aviso: string | null
}

/**
 * El distintivo de un informe del archivo, o `null` si de ese no consta nada.
 *
 * `null` es deliberado y no un hueco: un informe emitido por la versión con
 * worker no guardó nada de esto, y pintarle «análisis calculado» sería
 * afirmar algo que no se sabe.
 */
export function redaccionDe(params: HuellaDeRedaccion | null | undefined): Redaccion | null {
  if (!params || params.ia === undefined) return null

  if (params.ia) return { etiqueta: 'Redactado con IA', clase: 'bg-ok-tint text-ok', aviso: null }

  // Sin `ia_pedida` no se le inventa un fallo a un informe antiguo: lo único
  // que consta de él es que el análisis salió calculado.
  if (params.ia_pedida) {
    return {
      etiqueta: 'La IA falló',
      clase: 'bg-warn-tint text-warn',
      aviso: params.aviso_ia?.trim() || 'no se guardó el motivo',
    }
  }

  return { etiqueta: 'Análisis calculado', clase: 'bg-na-tint text-muted', aviso: null }
}
