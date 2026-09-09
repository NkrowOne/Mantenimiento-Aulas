/**
 * Entregar a quien lo pidió un fichero que se ha generado en el navegador.
 *
 * Hay un solo camino que funciona en todos los dispositivos, y no es
 * `<a download>`. En iOS —y esta aplicación se usa desde el iPhone y el iPad—
 * un `<a download>` no siempre guarda nada: según la versión abre el fichero en
 * una pestaña y el técnico se queda mirando texto, y dentro de la aplicación
 * instalada en la pantalla de inicio, según la versión, ni eso. La hoja de
 * compartir sí funciona, y además es la que lleva a Archivos, a AirDrop, a
 * Correo y a la aplicación de SharePoint, que es exactamente donde tiene que
 * acabar lo que sale de aquí. Se intenta primero, y el `<a download>` queda de
 * red para el escritorio.
 *
 * Hay que llamarla **desde el gesto**: la hoja de compartir solo se abre
 * mientras dura la pulsación que la pidió. Generar un fichero lleva segundos, y
 * para entonces el permiso ha caducado; por eso generar y entregar son dos
 * botones, no uno, en todas las pantallas que la usan.
 */
export async function ofrecerFichero(nombre: string, blob: Blob): Promise<'compartido' | 'descargado'> {
  const fichero = new File([blob], nombre, { type: blob.type })

  if (navigator.canShare?.({ files: [fichero] })) {
    try {
      /*
       * SOLO `files`, y nada más. Iba con `title` —el nombre del fichero, para
       * que la hoja de compartir dijera de qué se trata— y en el iPhone eso
       * cambia lo que se comparte: Safari, en cuanto el reparto lleva un campo
       * de texto al lado de los ficheros, ofrece la PÁGINA en vez del fichero.
       * Quien pulsaba «Descargar PDF» recibía un enlace a la aplicación, lo
       * mandaba por correo y al otro lado se abría la web, no el informe.
       *
       * El nombre no se pierde: va dentro del `File` y es el que sale en
       * Archivos y en el adjunto del correo.
       */
      await navigator.share({ files: [fichero] })
      return 'compartido'
    } catch (err) {
      // Cancelar la hoja de compartir no es un fallo, pero tampoco ha guardado
      // nada: se cae a la descarga para que siempre quede una copia.
      if ((err as Error)?.name !== 'AbortError') console.warn('compartir', err)
    }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nombre
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Un objeto URL vivo retiene el Blob entero en memoria; con fotos o un libro
  // dentro eso son megas. Pero revocarlo en el acto cancela la descarga en
  // Safari, así que se revoca cuando el navegador ya ha tenido su oportunidad.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return 'descargado'
}
