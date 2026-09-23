/**
 * El PDF se hace aquí y se entrega **en otro sitio**, y esa separación es el
 * arreglo de un fallo que solo se veía en el iPhone.
 *
 * En iOS la hoja de compartir —lo único que lleva un fichero a Archivos o a
 * SharePoint desde el móvil— solo se abre mientras dura la pulsación que la
 * pidió. Hacer el PDF es una vuelta al servidor con WeasyPrint dentro, así que
 * cuando `descargarPdf` entregaba el fichero al volver, el permiso llevaba
 * segundos caducado: `navigator.share` fallaba con `NotAllowedError`, se caía al
 * `<a download>` de red, y en iOS un `<a download>` sobre un `blob:` fuera del
 * gesto **no hace nada**. Ni descarga, ni abre, ni avisa.
 *
 * Por eso lo que se comprueba abajo, y lo que no puede volver atrás, es que
 * preparar el PDF **no lo entrega**: ni hoja de compartir, ni enlace, ni URL de
 * Blob. Quien llama lo hace desde su propia pulsación.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { prepararPdf } from './imprimir'

const HTML = '<html lang="es"><body>informe</body></html>'

/** Un `fetch` que contesta lo que se le diga, y que apunta lo que le pidieron. */
function servidor(respuesta: Response | Error): ReturnType<typeof vi.fn> {
  const f = vi.fn(() =>
    respuesta instanceof Error ? Promise.reject(respuesta) : Promise.resolve(respuesta),
  )
  vi.stubGlobal('fetch', f)
  return f
}

/** Espía sobre todo lo que usaría una entrega, para poder exigir que no se use. */
function vigilarLaEntrega(): { share: ReturnType<typeof vi.fn>; creados: string[] } {
  const share = vi.fn(() => Promise.resolve())
  const creados: string[] = []
  vi.stubGlobal('navigator', { canShare: () => true, share })
  vi.stubGlobal('document', {
    createElement: (t: string) => {
      creados.push(t)
      return { href: '', download: '', click: vi.fn(), remove: vi.fn() }
    },
    body: { appendChild: vi.fn() },
  })
  return { share, creados }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('preparar el PDF', () => {
  it('devuelve el fichero y NO lo entrega', async () => {
    // El corazón del arreglo. Si algún día esto vuelve a entregar desde aquí,
    // el iPhone se queda otra vez sin PDF y sin mensaje que lo explique.
    const { share, creados } = vigilarLaEntrega()
    servidor(new Response(new Blob(['%PDF-1.7']), { status: 200 }))

    const r = await prepararPdf(HTML, 'informe.pdf', 'token')

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.nombre).toBe('informe.pdf')
    expect(await r.blob.text()).toBe('%PDF-1.7')
    expect(share).not.toHaveBeenCalled()
    expect(creados).toEqual([])
  })

  it('el fichero sale como PDF aunque el servidor no lo diga', async () => {
    // Con `application/octet-stream`, iOS ofrece «documento» en vez de «PDF» y
    // Archivos lo guarda sin icono ni vista previa.
    servidor(
      new Response(new Blob(['%PDF-1.7'], { type: 'application/octet-stream' }), { status: 200 }),
    )
    const r = await prepararPdf(HTML, 'informe.pdf', 'token')
    expect(r.ok && r.blob.type).toBe('application/pdf')
  })

  it('va al servidor con el informe y la sesión', async () => {
    const f = servidor(new Response(new Blob(['%PDF-1.7']), { status: 200 }))
    await prepararPdf(HTML, 'informe.pdf', 'token-de-la-sesion')

    const [ruta, opciones] = f.mock.calls[0] as [string, RequestInit]
    expect(ruta).toBe('/informe/pdf')
    expect((opciones.headers as Record<string, string>).Authorization).toBe(
      'Bearer token-de-la-sesion',
    )
    expect(JSON.parse(String(opciones.body))).toEqual({ html: HTML, nombre: 'informe.pdf' })
  })
})

describe('cuando no se puede', () => {
  it('sin sesión no se pide nada', async () => {
    const f = servidor(new Response(null, { status: 200 }))
    const r = await prepararPdf(HTML, 'informe.pdf', null)
    expect(r).toEqual({ ok: false, motivo: 'no hay sesión con la que pedirlo', sinServicio: false })
    expect(f).not.toHaveBeenCalled()
  })

  it('sin red se marca «sin servicio», que es por donde se cae al diálogo de imprimir', async () => {
    servidor(new TypeError('Failed to fetch'))
    const r = await prepararPdf(HTML, 'informe.pdf', 'token')
    expect(r).toMatchObject({ ok: false, sinServicio: true })
  })

  it('un 404 o un 502 también: es un servidor sin la ruta o el worker caído', async () => {
    for (const status of [404, 502, 503]) {
      servidor(new Response('', { status }))
      expect(await prepararPdf(HTML, 'informe.pdf', 'token')).toMatchObject({ sinServicio: true })
    }
  })

  it('un 403 no: ahí hay algo que arreglar y hay que decirlo', async () => {
    servidor(new Response(JSON.stringify({ error: 'no puedes' }), { status: 403 }))
    const r = await prepararPdf(HTML, 'informe.pdf', 'token')
    expect(r).toEqual({ ok: false, motivo: 'no puedes', sinServicio: false })
  })

  it('un 200 que trae el index.html no es un PDF', async () => {
    /*
     * `/informe/pdf` lo atiende el worker y hasta él llega por un proxy. Si esa
     * regla no está publicada —un Caddyfile viejo, el worker parado, un
     * despliegue a medias— la petición cae en el comodín que sirve la
     * aplicación: 200, varios kilobytes, y un `index.html` dentro. Sin mirar la
     * cabecera eso se guardaba con nombre `.pdf` y tipo `application/pdf`: un
     * fichero que parece bueno hasta que lo abre quien lo ha recibido.
     */
    servidor(
      new Response(new Blob(['<!doctype html><html lang="es"><body>app</body></html>']), {
        status: 200,
      }),
    )
    const r = await prepararPdf(HTML, 'informe.pdf', 'token')
    expect(r).toMatchObject({ ok: false, sinServicio: true })
    expect(r.ok === false && r.motivo).toContain('no es un PDF')
  })

  it('y un PDF de verdad pasa aunque venga sin tipo', async () => {
    servidor(new Response(new Blob(['%PDF-1.7\n…']), { status: 200 }))
    expect((await prepararPdf(HTML, 'informe.pdf', 'token')).ok).toBe(true)
  })

  it('un PDF vacío no se entrega como si fuera bueno', async () => {
    // Un fichero de cero bytes en Archivos es peor que un error: parece que ha
    // ido bien hasta que alguien lo abre, normalmente el que lo ha recibido.
    servidor(new Response(new Blob([]), { status: 200 }))
    const r = await prepararPdf(HTML, 'informe.pdf', 'token')
    expect(r).toMatchObject({ ok: false, sinServicio: true })
  })
})
