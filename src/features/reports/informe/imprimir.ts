/**
 * Sacar el PDF, sin fabricar un PDF.
 *
 * El informe es HTML maquetado para A4 con `@page`. Todo navegador sabe
 * convertir eso en un PDF —«Guardar como PDF» es un destino de impresión—, y
 * hacerlo así tiene dos ventajas sobre generar el binario a mano: sale con la
 * tipografía y el interlineado que se ven en la vista previa, y no hace falta
 * arrastrar medio megabyte de librería a una aplicación que se abre desde un
 * iPad en un pasillo.
 *
 * Se imprime el `<iframe>` de la vista previa y no una ventana nueva a
 * propósito: entre pulsar «Generar» y tener el documento pasan segundos, y para
 * entonces el navegador ya no considera que haya un gesto del usuario detrás.
 * `window.open` en ese momento se bloquea como si fuera un anuncio. El iframe
 * está ya en la página, y el botón de imprimir es un clic recién hecho.
 */

/**
 * Manda el documento a la impresora (o a «Guardar como PDF»).
 *
 * Devuelve si se ha podido. `false` significa que el marco todavía no estaba
 * listo, y quien llama tiene que decirlo en vez de dejar un botón que a veces no
 * hace nada.
 */
export function imprimirMarco(marco: HTMLIFrameElement | null): boolean {
  const ventana = marco?.contentWindow
  if (!ventana) return false
  try {
    // El foco es necesario en Safari: sin él, `print()` no abre nada y tampoco
    // lanza. Un botón que a veces no hace nada es peor que un botón que falla.
    ventana.focus()
    ventana.print()
    return true
  } catch {
    return false
  }
}

/**
 * Guarda el documento tal cual, para archivarlo o mandarlo por correo.
 *
 * Es el mismo fichero que queda en el archivo del servidor: HTML autocontenido,
 * con los gráficos dentro y sin una sola petición a la red al abrirlo.
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
