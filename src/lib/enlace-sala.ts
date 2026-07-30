/**
 * El enlace que codifica la placa de puerta.
 *
 * Aquí está la diferencia entre un QR que funciona y uno que solo lo parece.
 *
 * Lo natural es codificar el identificador de la sala y ya está: es el dato, es
 * estable y sobrevive a los renombrados. Pero un QR que contiene
 * `0198f2c1-3a4b-…` escaneado con la cámara del móvil —que es lo que va a hacer
 * el técnico, no abrir un lector especializado— enseña esa cadena como texto
 * plano y no ofrece nada que pulsar. Técnicamente correcto y completamente
 * inútil delante de la puerta.
 *
 * Así que se codifica una URL de la propia aplicación con la sala en la
 * consulta. La cámara la reconoce como enlace, ofrece abrirla, y la PWA —que ya
 * está instalada en ese dispositivo— la recoge y salta directamente al aula.
 *
 * El identificador sigue siendo lo que manda: va en la URL, no el nombre ni el
 * código. Renombrar la sala no invalida ninguna placa impresa.
 *
 * Lo que sí ata esto es el dominio: si la aplicación se muda, las placas ya
 * atornilladas apuntan al sitio antiguo. Es un intercambio consciente —sin él no
 * hay nada que escanear— y tiene arreglo barato: una redirección en el dominio
 * viejo. Se deja dicho aquí para que quien mueva el despliegue lo sepa antes y
 * no después de recorrer 276 puertas.
 */

/** El parámetro que lleva la sala. Corto porque va dentro de un QR. */
export const PARAM_SALA = 'sala'

/**
 * La URL que se imprime.
 *
 * `origin` y no una constante compilada: la aplicación ya deduce su API del
 * origen en el que se sirve, y una variable más que alguien pueda olvidar es
 * una variable más que deja placas apuntando a ninguna parte.
 */
export function enlaceDeSala(roomId: string, origen?: string): string {
  const base = origen ?? (typeof window !== 'undefined' ? window.location.origin : '')
  return `${base}/?${PARAM_SALA}=${roomId}`
}

/**
 * La sala que venía en la URL, si venía alguna.
 *
 * Acepta las dos formas a propósito: la URL completa que produce `enlaceDeSala`
 * y un identificador pelado. La segunda es para las placas antiguas —o para un
 * lector de QR que devuelva solo texto— y cuesta una línea admitirla.
 */
export function salaDeLaUrl(search: string): string | null {
  const valor = new URLSearchParams(search).get(PARAM_SALA)
  if (!valor) return null

  // Un UUID y nada más. Sin esto, cualquier cosa que llegue por la URL se usaría
  // tal cual como clave de una consulta.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valor)
    ? valor.toLowerCase()
    : null
}

/**
 * La sala que trae un código escaneado con la cámara.
 *
 * `salaDeLaUrl` lee la barra de direcciones, donde el navegador ya ha separado
 * la consulta. Un lector de QR no: devuelve **el texto crudo** del código, que
 * puede ser la URL entera —lo normal— pero también un identificador pelado si
 * las placas se generaron con otra herramienta, o cualquier otra cosa, porque
 * al apuntar con la cámara se lee lo que haya delante: la etiqueta del wifi de
 * la sala, el código de un extintor.
 *
 * Devolver null ante lo que no reconoce es la mitad importante. Abrir un aula al
 * azar es peor que no abrir ninguna: el técnico revisaría la sala equivocada sin
 * enterarse de nada.
 */
export function salaDeTextoQR(texto: string): string | null {
  const t = String(texto ?? '').trim()
  if (!t) return null

  // Se busca el parámetro, no un UUID suelto: así un enlace a otra cosa que
  // lleve un identificador dentro no se confunde con una sala.
  const enUrl = t.match(new RegExp(`[?&#]${PARAM_SALA}=([0-9a-f-]{36})`, 'i'))
  if (enUrl?.[1]) return salaDeLaUrl(`?${PARAM_SALA}=${enUrl[1]}`)

  // El identificador pelado, y solo si es lo único que hay.
  return salaDeLaUrl(`?${PARAM_SALA}=${t}`)
}
