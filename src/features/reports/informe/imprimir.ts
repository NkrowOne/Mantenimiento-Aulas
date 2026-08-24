/**
 * De informe a PDF, con el diálogo del navegador.
 *
 * El PDF sale de «Imprimir → Guardar como PDF», que es de donde sale también el
 * de la hoja de inventario y el de las placas. No hay librería de PDF en el
 * arranque de esta aplicación y no la va a haber por esto: son cientos de
 * kilobytes en algo que se abre desde un iPad en un pasillo, y el resultado
 * sería peor que lo que el propio navegador imprime del documento.
 *
 * LO QUE SE APRENDIÓ POR LAS MALAS: **no se imprime un iframe.**
 *
 * `iframe.contentWindow.print()` funciona en un ordenador y NO funciona en el
 * Safari del iPad, que es el aparato para el que está hecha esta aplicación.
 * Allí no abre nada y no lanza nada: el botón parece muerto. Quien lo pulsaba
 * acababa en «Descargar», abría el fichero suelto y se encontraba con el código
 * fuente del documento en vez de con el documento.
 *
 * Así que el informe se imprime desde una VENTANA propia, que es un documento
 * de verdad para el navegador: se pagina, se imprime y —en el iPad— se comparte
 * a Archivos. El iframe se queda solo para la vista previa, que es lo único que
 * hace bien.
 */

/** Qué se ha podido hacer, para poder decirlo en vez de dejar un botón mudo. */
export type Resultado = 'ventana' | 'marco' | 'bloqueado'

/**
 * Abre el documento en una ventana y manda imprimir.
 *
 * `window.open` va primero y sin `await` delante: el permiso para abrir una
 * pestaña vale mientras dure el gesto que la pidió, y cualquier espera por medio
 * lo caduca y la convierte en un elemento emergente bloqueado.
 */
export function imprimirDocumento(html: string, marco: HTMLIFrameElement | null): Resultado {
  const ventana = window.open('', '_blank')
  if (ventana) {
    ventana.document.open()
    ventana.document.write(html)
    ventana.document.close()
    /*
     * Después de pintar, no antes. Con `document.write` el documento está
     * completo al cerrar, pero las fuentes y los SVG todavía no: imprimir en ese
     * instante saca la primera página con la tipografía de respaldo.
     */
    const imprimir = (): void => {
      try {
        ventana.focus()
        ventana.print()
      } catch {
        // Sin diálogo, la ventana se queda con el informe dentro y desde ahí se
        // imprime a mano. Es un paso más, no un callejón.
      }
    }
    if (ventana.document.readyState === 'complete') setTimeout(imprimir, 100)
    else ventana.addEventListener('load', () => setTimeout(imprimir, 100))
    return 'ventana'
  }

  // Bloqueada la pestaña: queda el marco de la vista previa, que en un ordenador
  // imprime perfectamente. En el iPad no, y por eso esto es el respaldo y no el
  // camino principal.
  const dentro = marco?.contentWindow
  if (dentro) {
    try {
      dentro.focus()
      dentro.print()
      return 'marco'
    } catch {
      return 'bloqueado'
    }
  }
  return 'bloqueado'
}

/**
 * Abre un documento ya archivado, renderizado y no como código.
 *
 * El almacenamiento puede servir un HTML subido por un usuario como texto
 * plano —es lo prudente por su parte: evita que alguien ejecute algo en el
 * dominio del almacén— y entonces lo que se ve al abrir el enlace firmado es el
 * código fuente del informe. Se descarga y se vuelve a servir desde el propio
 * navegador con su tipo real, que es lo que lo convierte otra vez en un
 * documento.
 *
 * La ventana se abre ANTES de descargar, por lo mismo de siempre: el permiso
 * caduca con el gesto.
 */
export function ventanaEnBlanco(): Window | null {
  return window.open('', '_blank')
}

export function mostrarEn(ventana: Window, contenido: Blob): void {
  const url = URL.createObjectURL(new Blob([contenido], { type: 'text/html; charset=utf-8' }))
  ventana.location.href = url
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * Guarda el documento tal cual, para archivarlo o mandarlo por correo.
 *
 * Es el original del que sale el PDF: HTML autocontenido, con los gráficos
 * dentro y sin una sola petición a la red al abrirlo. No es el camino para
 * conseguir un PDF —para eso está el botón de imprimir— y por eso en la pantalla
 * se llama por su nombre.
 */
export function descargarDocumento(html: string, nombre: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html; charset=utf-8' }))
  const enlace = document.createElement('a')
  enlace.href = url
  enlace.download = nombre
  document.body.appendChild(enlace)
  enlace.click()
  enlace.remove()
  // Sin esperar, Safari cancela la descarga al revocar la URL demasiado pronto.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
