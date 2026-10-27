/**
 * Ver lo que se va a exportar antes de exportarlo, y sacarlo también en PDF.
 *
 * Las exportaciones a Excel salían a ciegas: se pulsaba, se preparaba el
 * fichero y había que abrirlo en otro sitio para saber si traía lo que se
 * quería. El informe ya no funciona así —se ve entero en la pantalla y luego se
 * descarga— y el inventario tampoco debería. Aquí está lo que hace falta para
 * las dos cosas a partir de las mismas hojas que van al Excel:
 *
 *  - **El texto de cada celda**, como se lee en pantalla y en el papel: una
 *    fecha de Excel (`45831`) es un día, un porcentaje lleva su signo y un
 *    número va con la coma y los puntos de aquí.
 *  - **El documento del PDF**, una tabla por hoja, que compone el servidor con
 *    el mismo WeasyPrint que la hoja de inventario de las aulas.
 *
 * **La vista previa, el Excel y el PDF salen de las mismas hojas.** Si cada uno
 * se armara por su cuenta, lo que se ve no sería lo que se descarga, que es
 * justo la confianza que la vista previa viene a dar.
 *
 * El PDF no lleva por fuerza todas las columnas del Excel: una hoja de
 * veintinueve columnas en un A4 apaisado son letras de tres puntos. Quien
 * exporta dice qué columnas van al papel, por su nombre de cabecera, y el
 * Excel sigue llevándolas todas.
 */

import type { Formato, HojaNueva, Tinte } from './libro'
import type { ValorCelda } from './xlsx'
import { excelAFecha } from './valores'

/** Una hoja que se exporta, y cómo va al PDF. */
export interface HojaParaExportar {
  hoja: HojaNueva
  pdf?: {
    /** Si va en el PDF de partida. Por defecto, sí. */
    incluir?: boolean
    /** Las columnas que van al papel, por su cabecera. Por defecto, todas. */
    columnas?: string[]
  }
}

/** Lo que se ve, se descarga en Excel y se imprime en PDF. */
export interface Exportacion {
  /** El título del documento: «Inventario del almacén». */
  titulo: string
  /** Una línea con las cifras: «182 artículos · 7 bajo mínimo». */
  resumen?: string
  /** Base del nombre de los ficheros: «Almacén» → `Almacén 2026-10-27.xlsx`. */
  nombreBase: string
  hojas: HojaParaExportar[]
}

/** `2025-06-23` → `23/06/2025`: la fecha corta que se lee en un papel en España. */
function diaCorto(iso: string): string {
  const [a, m, d] = iso.split('-')
  return `${d}/${m}/${a}`
}

/** Lo que dice una celda, para leerla. Vacía es cadena vacía, no «null». */
export function textoDeCelda(v: ValorCelda, formato: Formato | undefined): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'Sí' : 'No'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return ''
    if (formato === 'fecha') {
      const iso = excelAFecha(v)
      return iso ? diaCorto(iso) : String(v)
    }
    if (formato === 'porcentaje') return `${Math.round(v * 100)} %`
    if (formato === 'entero') return Math.round(v).toLocaleString('es-ES')
    return Number.isInteger(v)
      ? v.toLocaleString('es-ES')
      : v.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  return v
}

/**
 * Los índices de las columnas que van al PDF, en el orden de la hoja.
 *
 * Una cabecera que no existe se ignora: si mañana una hoja cambia el nombre de
 * una columna, el PDF sale sin ella en vez de no salir.
 */
export function columnasDelPdf(hoja: HojaNueva, columnas?: string[]): number[] {
  const cabecera = (hoja.filas[0] ?? []).map((c) => String(c ?? ''))
  if (!columnas || columnas.length === 0) return cabecera.map((_, i) => i)
  const pedidas = new Set(columnas)
  return cabecera.flatMap((c, i) => (pedidas.has(c) ? [i] : []))
}

/** Las filas de datos de una hoja, sin la cabecera. */
export function filasDeDatos(hoja: HojaNueva): ValorCelda[][] {
  return hoja.filas.slice(1)
}

function escapar(texto: string): string {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** El color de fondo de una fila en el papel, el mismo que el Excel. */
const CSS_DE_TINTES = `
tr.t-ok td { background: #e6f2ea; }
tr.t-aviso td { background: #fbf0dc; }
tr.t-critico td { background: #f8e1e1; }
tr.t-apagado td { color: #777; }
td.num, th.num { text-align: right; padding-right: 10pt; }
.cabecera-doc { margin-bottom: 6pt; }
`

export const CLASE_DE_TINTE: Record<Tinte, string> = {
  ok: 't-ok',
  aviso: 't-aviso',
  critico: 't-critico',
  apagado: 't-apagado',
}

/**
 * El documento que se manda al servidor para hacer el PDF.
 *
 * Una cabecera con el título, la fecha de emisión y el resumen, y después una
 * tabla por hoja con las columnas que van al papel. `estilo` es la hoja de
 * estilo de la hoja de inventario de las aulas, para que los dos papeles se
 * parezcan: misma letra, misma tabla, misma página apaisada.
 */
export function documentoDeTablas(
  e: Pick<Exportacion, 'titulo' | 'resumen'>,
  hojas: Array<{ hoja: HojaNueva; columnas: number[] }>,
  emitidaEl: string,
  estilo: string,
): string {
  const secciones = hojas.map(({ hoja, columnas }) => {
    const cabecera = hoja.filas[0] ?? []
    const numericas = new Set(
      columnas.filter((i) => {
        const f = hoja.formatos?.[i]
        return f === 'entero' || f === 'porcentaje'
      }),
    )
    const th = columnas
      .map((i) => `<th${numericas.has(i) ? ' class="num"' : ''}>${escapar(String(cabecera[i] ?? ''))}</th>`)
      .join('')
    const filas = filasDeDatos(hoja)
      .map((fila, n) => {
        const tinte = hoja.tintes?.[n]
        const clase = tinte ? ` class="${CLASE_DE_TINTE[tinte]}"` : ''
        const td = columnas
          .map((i) => {
            const texto = escapar(textoDeCelda(fila[i] ?? null, hoja.formatos?.[i]))
            return `<td${numericas.has(i) ? ' class="num"' : ''}>${texto}</td>`
          })
          .join('')
        return `<tr${clase}>${td}</tr>`
      })
      .join('\n')
    const cuantas = filasDeDatos(hoja).length
    return [
      '<section>',
      `<table><caption>${escapar(hoja.nombre)} · ${cuantas} ${cuantas === 1 ? 'fila' : 'filas'}</caption>`,
      `<thead><tr>${th}</tr></thead>`,
      `<tbody>${filas || `<tr><td colspan="${columnas.length}">Sin filas.</td></tr>`}</tbody>`,
      '</table>',
      '</section>',
    ].join('\n')
  })

  return [
    '<!doctype html>',
    '<html lang="es">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapar(e.titulo)}</title>`,
    `<style>${estilo}${CSS_DE_TINTES}</style>`,
    '</head>',
    '<body>',
    '<div class="cabecera-doc">',
    `<h2>${escapar(e.titulo)}</h2>`,
    `<p class="text-muted">Emitido el ${escapar(diaCorto(emitidaEl.slice(0, 10)))}${e.resumen ? ` · ${escapar(e.resumen)}` : ''}</p>`,
    '</div>',
    ...secciones,
    '</body>',
    '</html>',
  ].join('\n')
}

/** `Inventario del almacén` + día → `Inventario-del-almacen-2026-10-27.pdf`. */
export function nombreDelPdfDe(base: string, emitidaEl: string): string {
  const limpio = base
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9.\- ]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
  return `${limpio || 'Exportacion'}-${emitidaEl.slice(0, 10)}.pdf`
}
