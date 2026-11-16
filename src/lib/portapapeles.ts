/**
 * Copiar un texto al portapapeles, también donde el navegador no deja.
 *
 * `navigator.clipboard` solo existe en una página segura (https o localhost) y
 * hay iPads viejos que lo rechazan aunque lo sea. El camino de reserva es el de
 * siempre: un `textarea` fuera de la vista, seleccionarlo y `copy`. Devuelve si
 * se ha copiado de verdad, para que el botón no diga «Copiado» en falso.
 */
export async function copiar(texto: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(texto)
      return true
    }
  } catch {
    // Se intenta por el otro camino.
  }

  try {
    const area = document.createElement('textarea')
    area.value = texto
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const hecho = document.execCommand('copy')
    area.remove()
    return hecho
  } catch {
    return false
  }
}
