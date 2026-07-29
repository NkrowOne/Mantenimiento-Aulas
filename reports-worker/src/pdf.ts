/**
 * HTML → PDF con WeasyPrint.
 *
 * Sin Chromium: los gráficos ya vienen como SVG desde ECharts SSR, así que la
 * plantilla no necesita ejecutar JavaScript. A cambio de esa restricción, la
 * imagen baja de ~1,5GB a ~300MB y desaparece toda la gestión de procesos de
 * navegador colgados.
 *
 * Si algún día una plantilla necesitara JS de verdad, el reemplazo es
 * Gotenberg 8 — no un contenedor de Playwright a mano.
 */

import { spawn } from 'node:child_process'

export class PdfError extends Error {}

/**
 * Tope de tiempo. Un WeasyPrint colgado no termina nunca, y sin esto la promesa
 * tampoco: la petición HTTP se quedaba abierta para siempre y el worker perdía
 * una de sus dos conexiones a la base. `restart: unless-stopped` no rescata de
 * esto, porque el proceso no se cae — se queda quieto.
 *
 * Un informe real se renderiza en segundos; medio minuto es margen de sobra.
 */
const TIMEOUT_MS = Number(process.env['PDF_TIMEOUT_MS'] ?? 30_000)

export function htmlToPdf(html: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // `-` como entrada y salida: todo por tuberías, sin ficheros temporales
    // que limpiar ni condiciones de carrera entre informes simultáneos.
    const proc = spawn('weasyprint', ['-e', 'utf-8', '-', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const out: Buffer[] = []
    const err: string[] = []
    let resuelto = false

    const terminar = (fn: () => void): void => {
      if (resuelto) return
      resuelto = true
      clearTimeout(reloj)
      fn()
    }

    const reloj = setTimeout(() => {
      proc.kill('SIGKILL')
      terminar(() =>
        reject(new PdfError(`weasyprint no terminó en ${TIMEOUT_MS} ms; proceso terminado`)),
      )
    }, TIMEOUT_MS)

    proc.stdout.on('data', (c: Buffer) => out.push(c))
    proc.stderr.on('data', (c: Buffer) => err.push(c.toString()))

    proc.on('error', (e) => {
      terminar(() => reject(new PdfError(`No se pudo ejecutar weasyprint: ${e.message}`)))
    })

    /*
     * El HTML de un informe con veinte filas y dos SVG no cabe en el búfer de la
     * tubería, así que la escritura es parcial y asíncrona. Si weasyprint muere
     * antes de leerlo todo —plantilla mal formada, falta de memoria—, el `write`
     * emite EPIPE en `stdin`. Ese flujo es su propio emisor de eventos: el
     * `proc.on('error')` de arriba NO lo cubre, y un 'error' sin manejador
     * derriba el proceso entero de Node. El worker se caía por un informe malo.
     */
    proc.stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EPIPE') return // se informa por el código de salida
      terminar(() => reject(new PdfError(`Fallo escribiendo a weasyprint: ${e.message}`)))
    })

    proc.on('close', (code) => {
      terminar(() => {
        if (code !== 0) {
          reject(new PdfError(`weasyprint terminó con código ${code}: ${err.join('')}`))
          return
        }
        const buf = Buffer.concat(out)
        if (buf.length === 0) {
          reject(new PdfError('weasyprint devolvió un PDF vacío'))
          return
        }
        resolve(buf)
      })
    })

    proc.stdin.end(html)
  })
}
