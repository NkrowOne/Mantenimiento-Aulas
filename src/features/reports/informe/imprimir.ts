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

import { ofrecerFichero } from '@/lib/ficheros'

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

/**
 * El PDF de verdad: un fichero, no un diálogo.
 *
 * «Descargar PDF» abría el documento en una pestaña y lanzaba el diálogo de
 * imprimir. De ahí sale un PDF, sí, pero solo si quien lo pulsa sabe que tiene
 * que ir a «Compartir → Guardar en Archivos» —tres toques y una hoja de sistema
 * que no dice «PDF» por ninguna parte—. Quien pedía un informe para mandarlo
 * acababa mandando el HTML, que en el correo del cliente se abre como código.
 *
 * Así que el PDF lo hace el servidor, con el mismo WeasyPrint que lleva años
 * haciendo los de los informes programados, y vuelve como fichero. El documento
 * es autocontenido —gráficos en SVG y fotos en `data:`— así que lo único que
 * viaja es el informe que ya se iba a archivar de todas formas.
 *
 * Lo que NO se hace: montar una librería de PDF en el navegador. Son cientos de
 * kilobytes en el arranque de una aplicación que se abre desde un iPad en un
 * pasillo, y lo que sacan —el documento pintado como una imagen— es peor que
 * esto en todo: pesa más, no se puede buscar y las tablas se parten donde
 * quieren.
 */
export type ResultadoPdf =
  | { ok: true; via: 'compartido' | 'descargado' }
  /** No se pudo, y por qué. Quien llama decide si cae al diálogo de imprimir. */
  | { ok: false; motivo: string; sinServicio: boolean }

export async function descargarPdf(
  html: string,
  nombre: string,
  token: string | null,
): Promise<ResultadoPdf> {
  if (!token) {
    return { ok: false, motivo: 'no hay sesión con la que pedirlo', sinServicio: false }
  }

  let respuesta: Response
  try {
    respuesta = await fetch('/informe/pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ html, nombre }),
    })
  } catch {
    // Sin red, o el servicio no está: es el caso en el que hay que caer al
    // diálogo de imprimir sin dar la lata, porque desde ahí sale igual.
    return { ok: false, motivo: 'no se ha podido hablar con el servidor', sinServicio: true }
  }

  if (!respuesta.ok) {
    /*
     * Un 404 es un despliegue sin la ruta —el servidor todavía no se ha
     * actualizado— y un 502 es el worker caído. Los dos son «no está», y de los
     * dos se sale por el diálogo de imprimir. Un 401 o un 403 no: ahí hay algo
     * que arreglar y hay que decirlo.
     */
    const sinServicio = respuesta.status === 404 || respuesta.status === 502 || respuesta.status === 503
    let motivo = `el servidor ha respondido ${respuesta.status}`
    try {
      const cuerpo = (await respuesta.json()) as { error?: string }
      if (cuerpo.error) motivo = cuerpo.error
    } catch {
      // Sin cuerpo legible se queda el código, que ya dice algo.
    }
    return { ok: false, motivo, sinServicio }
  }

  const blob = await respuesta.blob()
  if (blob.size === 0) {
    return { ok: false, motivo: 'el PDF ha llegado vacío', sinServicio: true }
  }
  const via = await ofrecerFichero(nombre, new Blob([blob], { type: 'application/pdf' }))
  return { ok: true, via }
}
