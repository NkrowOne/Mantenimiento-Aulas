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

export function htmlToPdf(html: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // `-` como entrada y salida: todo por tuberías, sin ficheros temporales
    // que limpiar ni condiciones de carrera entre informes simultáneos.
    const proc = spawn('weasyprint', ['-e', 'utf-8', '-', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const out: Buffer[] = []
    const err: string[] = []

    proc.stdout.on('data', (c: Buffer) => out.push(c))
    proc.stderr.on('data', (c: Buffer) => err.push(c.toString()))

    proc.on('error', (e) => {
      reject(new PdfError(`No se pudo ejecutar weasyprint: ${e.message}`))
    })

    proc.on('close', (code) => {
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

    proc.stdin.write(html)
    proc.stdin.end()
  })
}
