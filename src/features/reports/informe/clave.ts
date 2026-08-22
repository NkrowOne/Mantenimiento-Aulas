/**
 * De dónde sale la clave de Gemini.
 *
 * Dos sitios, y el orden importa poco porque no compiten: la del despliegue
 * —que un administrador pega una vez desde la pantalla de Informes y queda en
 * `app_config`— y la de este dispositivo, que es la salida para quien no quiera
 * ninguna clave guardada en la base o para el rato en que la migración que crea
 * `ia_clave()` todavía no se ha aplicado.
 *
 * Manda la del despliegue: es la que hace que activar la IA sea una cosa que se
 * hace una vez y no una por dispositivo. La local existe para que nadie se quede
 * bloqueado esperando a que se aplique una migración.
 *
 * Las dos las pone un administrador, que es quien emite informes. `ia_clave()`
 * lo exige, y aquí se recoge su negativa como «no hay clave»: si algún día la
 * pestaña se abriera a otro rol, el informe le saldría con el análisis calculado
 * en vez de reventar.
 *
 * Aquí no hay variables de entorno, ni las va a haber. Ese era exactamente el
 * problema: `GEMINI_API_KEY` declarada vacía «por si acaso» en el compose pisaba
 * la clave que sí estaba guardada, y el registro decía «sin clave» mientras la
 * clave estaba puesta.
 */

import { supabase } from '@/lib/supabase'

const EN_ESTE_DISPOSITIVO = 'informes.clave-gemini'

export type Origen = 'despliegue' | 'dispositivo'

export interface ClaveEncontrada {
  clave: string
  origen: Origen
}

/** La que haya en este navegador, si alguien la puso aquí. */
export function claveDelDispositivo(): string {
  try {
    return localStorage.getItem(EN_ESTE_DISPOSITIVO)?.trim() ?? ''
  } catch {
    // Modo privado, almacenamiento bloqueado: no hay clave local y ya está.
    return ''
  }
}

export function guardarClaveDelDispositivo(clave: string): void {
  try {
    const limpia = clave.trim()
    if (limpia) localStorage.setItem(EN_ESTE_DISPOSITIVO, limpia)
    else localStorage.removeItem(EN_ESTE_DISPOSITIVO)
  } catch {
    // Sin almacenamiento no se puede recordar, pero el informe de ahora mismo
    // sí puede salir: quien llama ya tiene la clave en la mano.
  }
}

/**
 * La clave que se va a usar, y de dónde ha salido.
 *
 * Un fallo al preguntar a la base no es un error que valga la pena propagar: si
 * `ia_clave()` no existe todavía —o el rol no llega— lo que corresponde es
 * mirar en el dispositivo, y si tampoco hay, el informe sale con el análisis
 * calculado, que es un informe completo.
 */
export async function claveDeGemini(): Promise<ClaveEncontrada | null> {
  try {
    const { data, error } = await supabase.rpc('ia_clave')
    const guardada = typeof data === 'string' ? data.trim() : ''
    if (!error && guardada) return { clave: guardada, origen: 'despliegue' }
  } catch {
    // La función puede no estar: se sigue por el otro camino.
  }

  const local = claveDelDispositivo()
  return local ? { clave: local, origen: 'dispositivo' } : null
}
