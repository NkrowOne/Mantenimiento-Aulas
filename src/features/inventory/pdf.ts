/**
 * El PDF de la hoja de inventario: un fichero, como el del informe.
 *
 * Salía del diálogo de imprimir del navegador, y en el iPhone con la aplicación
 * abierta desde la pantalla de inicio ese diálogo no existe: `window.print()`
 * no hace nada. La primera salida que se probó —abrir la hoja en una ventana
 * propia y mandar imprimir allí— dejaba a quien la usaba encerrado en una
 * ventana sin diálogo y sin forma de volver a la aplicación.
 *
 * Así que la hoja hace lo mismo que ya hace el informe y que ya funciona en
 * esos iPhone: el servidor compone el PDF con WeasyPrint (`/informe/pdf`), vuelve
 * como fichero, y un segundo toque lo entrega con la hoja de compartir —Archivos,
 * Correo, SharePoint— o como descarga en el ordenador. Dos toques y no uno por
 * lo mismo que en el informe: en iOS la hoja de compartir solo se abre mientras
 * dura la pulsación que la pidió, y la vuelta al servidor la caduca.
 *
 * El documento que viaja es la propia hoja que se ve en pantalla, clonada, con
 * una hoja de estilo propia y autocontenida: WeasyPrint no ve las hojas de
 * estilo de la aplicación ni entiende todo lo que usa Tailwind, y lo que no
 * entiende lo ignora en silencio. Estas reglas son pocas y todas suyas.
 */

import { prepararPdf, type ResultadoPdf } from '@/features/reports/informe/imprimir'
import { supabase } from '@/lib/supabase'

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
 * Las reglas de la hoja impresa, para WeasyPrint.
 *
 * Son las mismas decisiones que `@media print` en `index.css`: papel blanco,
 * la cabecera de la tabla repetida en cada página, ninguna fila partida y el
 * encabezado de la sala pegado a su primera fila. Más las clases de Tailwind
 * que la hoja usa de verdad, traducidas a CSS que WeasyPrint entiende: sin
 * variables, sin `grid`, sin nada que pueda ignorar sin avisar.
 */
export const ESTILO_DE_LA_HOJA = `
@page { size: A4 landscape; margin: 12mm 10mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "DejaVu Sans", Helvetica, Arial, sans-serif; font-size: 9pt; color: #000; background: #fff; }
h2 { font-size: 13pt; font-weight: 600; margin: 0 0 4pt; }
dl { margin: 4pt 0 0; }
dl > div { display: inline-block; width: 24%; vertical-align: top; margin: 0 0 4pt; }
dt { color: #555; font-size: 8pt; }
dd { margin: 0; }
p { margin: 3pt 0 0; }
section { margin-top: 10pt; }
table { width: 100%; border-collapse: collapse; }
thead { display: table-header-group; }
th { text-align: left; font-weight: 600; border-bottom: 0.6pt solid #888; padding: 3pt 4pt 3pt 0; }
td { padding: 3pt 4pt 3pt 0; vertical-align: top; border-bottom: 0.4pt solid #ccc; }
tr { page-break-inside: avoid; break-inside: avoid; }
caption { text-align: left; font-weight: 600; padding: 2pt 0 4pt; page-break-after: avoid; }
hr { border: 0; border-top: 0.6pt solid #888; margin: 8pt 0; }
.sr-only { display: none; }
.solo-pantalla { display: none; }
.block { display: block; }
.font-mono { font-family: "DejaVu Sans Mono", Menlo, monospace; }
.font-medium, .font-semibold { font-weight: 600; }
.font-normal { font-weight: 400; }
.text-muted { color: #555; }
.text-xs { font-size: 7.5pt; }
.text-sm { font-size: 8.5pt; }
.text-lg { font-size: 13pt; }
.text-crit { color: #000; font-weight: 600; }
.text-warn { color: #000; }
.ml-2 { margin-left: 6pt; }
.mt-1, .mt-0\\.5 { margin-top: 2pt; }
.mt-2, .mt-3 { margin-top: 4pt; }
.mt-4, .mt-6 { margin-top: 8pt; }
.rounded-tag.border { border: 0.5pt solid #888; padding: 0 2pt; display: inline-block; }
`

/**
 * La hoja como documento suelto: la tabla y su cabecera, sin la interfaz.
 *
 * Recibe el contenedor de la pantalla y saca de él `.hoja-inventario`, que es
 * exactamente lo que el papel lleva. Lo demás —los botones, la casilla de las
 * bajas, los avisos de carga— vive en `.solo-pantalla` y no viaja.
 */
export function documentoDeLaHoja(contenedor: HTMLElement, titulo: string): string {
  const hoja = contenedor.querySelector('.hoja-inventario') ?? contenedor
  const copia = hoja.cloneNode(true) as HTMLElement
  copia.querySelectorAll('.solo-pantalla').forEach((n) => n.remove())
  return [
    '<!doctype html>',
    '<html lang="es">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapar(titulo)}</title>`,
    `<style>${ESTILO_DE_LA_HOJA}</style>`,
    '</head>',
    `<body>${copia.outerHTML}</body>`,
    '</html>',
  ].join('\n')
}

/** El nombre del fichero: legible en Archivos y sin caracteres que lo rompan. */
export function nombreDelPdf(titulo: string, emitidaEl: string): string {
  const limpio = titulo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9.\- ]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
  return `Inventario-${limpio || 'sala'}-${emitidaEl.slice(0, 10)}.pdf`
}

/** Pide el PDF al servidor. No lo entrega: eso es el segundo toque. */
export async function prepararPdfDeLaHoja(
  contenedor: HTMLElement,
  titulo: string,
  nombre: string,
): Promise<ResultadoPdf> {
  const { data } = await supabase.auth.getSession()
  return prepararPdf(documentoDeLaHoja(contenedor, titulo), nombre, data.session?.access_token ?? null)
}
