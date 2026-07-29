/**
 * Generación de la matriz de un QR.
 *
 * Separado del componente para poder **probarlo**. Y hay que probarlo: el
 * prototipo llevaba una marca decorativa que se parecía mucho a un QR y no lo
 * era, así que aquí lo único que distingue «funciona» de «parece que funciona»
 * es una prueba que compruebe la estructura del código real.
 *
 * La codificación la hace `qrcode-generator`, que es minúsculo y no tiene
 * dependencias. Lo que se prueba aquí es lo NUESTRO: el margen de silencio y el
 * trazado, que es donde se puede meter un error propio.
 */

import qrcode from 'qrcode-generator'

export interface MatrizQR {
  /** Módulos por lado, sin contar el margen. */
  modulos: number
  /** Lado total del `viewBox`, márgenes incluidos. */
  lado: number
  /** El `d` de un único `<path>` con todos los módulos oscuros. */
  path: string
  /** Consulta directa, para las pruebas. */
  esOscuro: (fila: number, col: number) => boolean
}

/**
 * Corrección de errores M (~15 %).
 *
 * Una placa atornillada a la puerta de un aula se raya, se ensucia y le da el
 * sol. L sería más pequeño y más frágil; Q y H gastan módulos en resistencia que
 * aquí no hace falta.
 */
const CORRECCION = 'M'

export function matrizQR(valor: string, quiet = 4): MatrizQR {
  if (!valor) throw new Error('Un QR vacío no codifica nada')

  // Versión 0 = automática: la más pequeña que admita el contenido. Un UUID cabe
  // en la 3 (29×29), justo el hueco que el prototipo ya reservaba.
  const qr = qrcode(0, CORRECCION)
  qr.addData(valor)
  qr.make()

  const n = qr.getModuleCount()

  /*
   * Un solo `<path>` en vez de un `<rect>` por módulo.
   *
   * Con un rectángulo cada uno, una hoja de 24 placas son ~20.000 nodos: el
   * navegador tarda en pintarla y la impresión se arrastra. Un `path` es un
   * nodo y en papel sale idéntico.
   */
  let path = ''
  for (let fila = 0; fila < n; fila++) {
    for (let col = 0; col < n; col++) {
      if (qr.isDark(fila, col)) path += `M${col + quiet} ${fila + quiet}h1v1h-1z`
    }
  }

  return {
    modulos: n,
    lado: n + quiet * 2,
    path,
    esOscuro: (fila, col) => qr.isDark(fila, col),
  }
}
