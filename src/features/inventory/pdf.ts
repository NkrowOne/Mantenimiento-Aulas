/**
 * «Descargar PDF» de la hoja de inventario, también en la app instalada.
 *
 * El PDF sale del diálogo de imprimir del navegador —ver la cabecera de
 * `HojaDeInventario.tsx`—, y en un iPhone o un iPad con la aplicación abierta
 * desde la pantalla de inicio ese diálogo NO EXISTE: `window.print()` no hace
 * nada, no lanza nada y no avisa. El botón parecía muerto, que es exactamente lo
 * que se veía: «el PDF no se genera ni descarga».
 *
 * Es el mismo muro con el que ya se chocó el informe, y la salida es la misma
 * (`imprimirDocumento`, en `reports/informe/imprimir.ts`): una VENTANA propia
 * con el documento dentro. Fuera de la aplicación instalada esa ventana es una
 * página de Safari de verdad, con su diálogo de imprimir y su «Compartir →
 * Guardar en Archivos».
 *
 * En el navegador normal —Safari con su barra, o un ordenador— se sigue
 * imprimiendo en el sitio, que funciona y ahorra una pestaña.
 */

import { imprimirDocumento } from '@/features/reports/informe/imprimir'

/** Abierta desde la pantalla de inicio, sin la barra del navegador. */
export function esAppInstalada(): boolean {
  const ios = (navigator as Navigator & { standalone?: boolean }).standalone === true
  const pwa = typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches
  return ios || pwa
}

function escapar(texto: string): string {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * La hoja como documento suelto: lo que se ve, sin la interfaz.
 *
 * Se copian las hojas de estilo de la propia aplicación —las mismas reglas de
 * impresión que ya pagina la tabla y fuerza el papel blanco— y se fija el tema
 * claro, porque en pantalla esa ventana se ve antes de imprimirla. La `base` es
 * lo que hace que las rutas de las hojas de estilo y de las fuentes sigan
 * resolviendo desde una ventana que nace en blanco.
 */
export function documentoDeLaHoja(hoja: HTMLElement, titulo: string): string {
  const copia = hoja.cloneNode(true) as HTMLElement
  copia.querySelectorAll('.solo-pantalla').forEach((n) => n.remove())
  const estilos = [...document.querySelectorAll('link[rel="stylesheet"], style')]
    .map((n) => n.outerHTML)
    .join('\n')
  return [
    '<!doctype html>',
    '<html lang="es" data-theme="light">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<base href="${escapar(window.location.origin)}/">`,
    `<title>${escapar(titulo)}</title>`,
    estilos,
    '</head>',
    `<body>${copia.outerHTML}</body>`,
    '</html>',
  ].join('\n')
}

/** Qué ha pasado al pulsar, para poder decirlo en vez de dejar un botón mudo. */
export type ComoSalio = 'dialogo' | 'ventana' | 'bloqueado'

export function descargarPdf(hoja: HTMLElement | null, titulo: string): ComoSalio {
  if (!hoja || !esAppInstalada()) {
    window.print()
    return 'dialogo'
  }
  const via = imprimirDocumento(documentoDeLaHoja(hoja, titulo), null)
  return via === 'bloqueado' ? 'bloqueado' : 'ventana'
}
