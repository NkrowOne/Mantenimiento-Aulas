/**
 * Empezar y cerrar una incidencia, desde donde se esté.
 *
 * Estaba escrito dentro de la pestaña de Incidencias y solo servía allí, que era
 * medio problema; el otro medio es que **iba directo contra el servidor**. Los
 * dos se notan en el mismo momento: el técnico acaba de cambiar el cable en el
 * −2.1, y para cerrar el parte tenía que salir del sótano, ir a otra pestaña,
 * buscar la incidencia entre cuarenta y pulsar un botón que sin cobertura no
 * hacía nada. Se cierra luego. «Luego» es la palabra que llenó de partes viejos
 * la lista de la que se venía huyendo.
 *
 * Y había un tercer medio, que era el de verdad: **el técnico no podía cerrar**.
 * Quien arregla el proyector es él; quien firmaba el cierre, un supervisor que
 * no había visto la reparación. O preguntaba —y entonces el dato viajaba por
 * WhatsApp— o cerraba a ciegas.
 *
 * Ahora cierra él, **diciendo qué ha hecho**. Ese texto es lo que sustituye a la
 * firma del supervisor, y por eso es obligatorio: sin él la fila diría
 * «resuelta» y nada más, que es exactamente lo que hacía inútil el cierre de
 * antes. Lo comprueba el servidor —`avanzar_incidencia`— y lo comprueba la
 * pantalla, para no gastar un viaje en decir que no.
 *
 * Todo pasa por la cola de salida: el cierre se guarda en el dispositivo, la
 * sala deja de contar la avería en el momento, y la orden sube cuando haya red.
 */

import { db, enqueueRpc } from '@/db/dexie'
import { flush } from '@/sync/outbox'
import type { IncidentState } from '@/domain/types'

/**
 * Los motivos de cierre que se ofrecen de un toque.
 *
 * No sustituyen a la descripción, la encabezan: se pulsa el motivo —que además
 * clasifica, y eso es lo que permitirá algún día contar cuántos cierres fueron
 * una sustitución— y se escribe al lado lo que se ha hecho de verdad. El campo
 * en blanco y una mano libre es un campo que se queda vacío; el motivo solo, un
 * cierre que no explica nada.
 */
export const MOTIVOS_DE_CIERRE: string[] = [
  'Reparado',
  'Pieza sustituida',
  'Ajuste o reinicio',
  'Ya funcionaba',
  'No procede',
]

/**
 * El motivo que además pregunta CUÁL.
 *
 * Es el único que arrastra un dato que vive en otra tabla: la pieza sale del
 * almacén. Con el motivo a secas, el cierre decía que se había cambiado algo sin
 * decir el qué, y el almacén no se enteraba de que faltaba una unidad — las dos
 * mitades del mismo gesto, cada una esperando a que alguien se acordara de la
 * otra. Va como constante y no como literal suelto porque la pantalla decide con
 * él qué enseñar, y una errata ahí sería un desplegable que no aparece nunca.
 */
export const PIEZA_SUSTITUIDA = 'Pieza sustituida'

/**
 * Añade a lo escrito la pieza que se acaba de sacar del almacén.
 *
 * El nombre del artículo es la mejor descripción posible de «qué has hecho»
 * —«Lámpara Epson ELPLP96» dice bastante más que «cambiada la lámpara»— así que
 * se escribe en el campo en vez de quedarse solo en el movimiento de almacén.
 * Y se AÑADE, no se sustituye: en una avería se cambian dos cosas más veces de
 * las que parece, y lo que el técnico haya escrito a mano es suyo.
 */
export function conLaPieza(texto: string, nombre: string, qty: number): string {
  const linea = qty > 1 ? `${nombre} ×${qty}` : nombre
  const base = texto.trim()
  return base ? `${base} · ${linea}` : linea
}

/**
 * Lo mínimo que se acepta como «qué has hecho».
 *
 * Tres caracteres no son una descripción y no pretenden serlo: son el suelo que
 * impide cerrar con un punto o con una equis. Lo mismo que comprueba el servidor
 * en `avanzar_incidencia`, y aquí para no gastar un viaje a la red en decir que
 * no — sobre todo cuando ese viaje puede tardar horas en salir del sótano.
 */
export const RESOLUCION_MIN = 3

/** ¿Sirve esto como descripción de lo que se ha hecho? */
export function resolucionSuficiente(texto: string): boolean {
  return texto.trim().length >= RESOLUCION_MIN
}

export interface AvanceDeIncidencia {
  id: string
  estado: Extract<IncidentState, 'en_curso' | 'resuelta'>
  /** Qué se ha hecho. Obligatoria al cerrar: es la mitad del valor del cierre. */
  resolucion?: string
  /** Quién lo hace, para firmar el cierre sin preguntárselo a la red. */
  userId: string | null
  /** Se inyecta para poder probar sin reloj. */
  ahora?: string
}

/**
 * Cambia el estado de una incidencia: en el espejo y en la cola.
 *
 * El espejo primero y a propósito: es lo que hace que la sala deje de contar la
 * avería y que la lista se redibuje sin esperar a nadie. La cola llama después a
 * `avanzar_incidencia`, que es la única puerta por la que el personal puede
 * cerrar —la tabla sigue cerrada a UPDATE para quien no sea supervisor— y la que
 * vuelve a exigir el texto. Si el servidor lo rechaza, lo dice con su motivo en
 * la pantalla de pendientes en vez de dejar al dispositivo creyéndose algo que
 * arriba no ha pasado.
 */
export async function avanzarIncidencia(entrada: AvanceDeIncidencia): Promise<void> {
  const ahora = entrada.ahora ?? new Date().toISOString()
  const texto = entrada.resolucion?.trim() ?? ''

  if (entrada.estado === 'resuelta' && !resolucionSuficiente(texto)) {
    throw new Error('Para cerrar una incidencia hay que escribir qué se ha hecho.')
  }

  /*
   * El espejo solo guarda lo que no está resuelto, así que la fila puede no
   * estar —una incidencia vieja que se abre desde la búsqueda—. No es un error:
   * en ese caso el cambio viaja igual por la cola y llega igual.
   */
  if (await db.incidents.get(entrada.id)) {
    await db.incidents.update(
      entrada.id,
      entrada.estado === 'resuelta'
        ? {
            state: 'resuelta',
            resolved_at: ahora,
            resolved_by: entrada.userId,
            resolution: texto,
          }
        : { state: 'en_curso' },
    )
  }

  // Mismo sufijo para los dos estados: pulsar «Empezar» y luego «Resolver» es
  // una sola orden con el estado final, no dos que compiten por la misma fila.
  await enqueueRpc('incident', 'avanzar_incidencia', entrada.id, 'estado', {
    p_id: entrada.id,
    p_estado: entrada.estado,
    p_resolucion: entrada.estado === 'resuelta' ? texto : null,
  })
  void flush()
}
