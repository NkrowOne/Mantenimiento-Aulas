import { afterEach, describe, expect, it, vi } from 'vitest'
import { ofrecerFichero, ofrecerFicheros } from './ficheros'

/**
 * Lo que se comprueba aquí es el orden de los caminos y que ninguno se quede a
 * medias: la hoja de compartir primero, la descarga de red, y la URL del Blob
 * viva hasta que el navegador ha tenido tiempo de leerla.
 */

const blob = new Blob(['hola'], { type: 'text/plain' })

interface Enlace {
  href: string
  download: string
  click: () => void
  remove: () => void
}

function navegador(opciones: { compartir?: () => Promise<void> } = {}): {
  share: ReturnType<typeof vi.fn>
  enlaces: Enlace[]
} {
  const enlaces: Enlace[] = []
  const share = vi.fn(opciones.compartir ?? (() => Promise.resolve()))
  vi.stubGlobal('navigator', {
    canShare: opciones.compartir === undefined && !('compartir' in opciones) ? undefined : () => true,
    share,
  })
  vi.stubGlobal('document', {
    createElement: () => {
      const a: Enlace = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
      enlaces.push(a)
      return a
    },
    body: { appendChild: vi.fn() },
  })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:prueba')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  return { share, enlaces }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ofrecerFichero', () => {
  it('prefiere la hoja de compartir cuando el dispositivo la tiene', async () => {
    const { share, enlaces } = navegador({ compartir: () => Promise.resolve() })

    await expect(ofrecerFichero('copia.json', blob)).resolves.toBe('compartido')

    expect(share).toHaveBeenCalledTimes(1)
    const [reparto] = share.mock.calls[0] as [Record<string, unknown>]
    /*
     * Solo `files`, y esto es la prueba de que sigue siendo solo `files`. Iba
     * con `title` y en el iPhone eso cambia lo que se comparte: en cuanto el
     * reparto lleva texto al lado de los ficheros, Safari ofrece la PÁGINA en
     * vez del fichero, y quien pulsaba «Descargar PDF» mandaba por correo un
     * enlace a la aplicación. El nombre no se pierde: va dentro del `File`.
     */
    expect(Object.keys(reparto)).toEqual(['files'])
    const files = reparto['files'] as File[]
    expect(files.map((f) => f.name)).toEqual(['copia.json'])
    // Compartido es entregado: no se descarga además.
    expect(enlaces).toEqual([])
  })

  it('si se cancela la hoja de compartir, deja igualmente una copia por descarga', async () => {
    const { enlaces } = navegador({
      compartir: () => Promise.reject(Object.assign(new Error('cancelado'), { name: 'AbortError' })),
    })

    await expect(ofrecerFichero('copia.json', blob)).resolves.toBe('descargado')

    expect(enlaces).toHaveLength(1)
    expect(enlaces[0]!.download).toBe('copia.json')
    expect(enlaces[0]!.href).toBe('blob:prueba')
    expect(enlaces[0]!.click).toHaveBeenCalledTimes(1)
  })

  it('sin hoja de compartir descarga, y no revoca la URL hasta que el navegador la ha leído', async () => {
    vi.useFakeTimers()
    const { share, enlaces } = navegador()

    await expect(ofrecerFichero('libro.xlsx', blob)).resolves.toBe('descargado')

    expect(share).not.toHaveBeenCalled()
    expect(enlaces[0]!.click).toHaveBeenCalledTimes(1)
    // Revocar en el acto cancela la descarga en Safari.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:prueba')
  })
})

/**
 * Los dos ficheros de un informe —el PDF y el Excel— de una vez, y sueltos.
 *
 * Lo que se vigila es que vayan los DOS y que ninguno sea un zip: la hoja de
 * compartir los lleva a Correo como dos adjuntos, y metidos en un paquete hay
 * que saber abrirlo.
 */
describe('ofrecerFicheros', () => {
  const pdf = new Blob(['%PDF-'], { type: 'application/pdf' })
  const xlsx = new Blob(['PK'], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const dos = [
    { nombre: 'informe-semanal.pdf', blob: pdf },
    { nombre: 'informe-semanal-almacen.xlsx', blob: xlsx },
  ]

  it('comparte los dos en un solo reparto, cada uno con su nombre y su tipo', async () => {
    const { share, enlaces } = navegador({ compartir: () => Promise.resolve() })

    await expect(ofrecerFicheros(dos)).resolves.toBe('compartido')

    expect(share).toHaveBeenCalledTimes(1)
    const [reparto] = share.mock.calls[0] as [Record<string, unknown>]
    // Solo `files`: con un texto al lado, Safari comparte la página.
    expect(Object.keys(reparto)).toEqual(['files'])
    const files = reparto['files'] as File[]
    expect(files.map((f) => f.name)).toEqual(['informe-semanal.pdf', 'informe-semanal-almacen.xlsx'])
    expect(files.map((f) => f.type)).toEqual([pdf.type, xlsx.type])
    // Ninguno es un paquete: son los dos documentos, tal cual.
    expect(files.some((f) => /zip/.test(f.type) || f.name.endsWith('.zip'))).toBe(false)
    expect(enlaces).toEqual([])
  })

  it('sin hoja de compartir los descarga los dos, uno detrás de otro', async () => {
    vi.useFakeTimers()
    const { share, enlaces } = navegador()

    const entrega = ofrecerFicheros(dos)
    // El primero sale en el acto; el segundo, tras el respiro: dos descargas
    // disparadas en el mismo instante, el navegador se queda con una.
    await vi.advanceTimersByTimeAsync(0)
    expect(enlaces).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(400)
    await expect(entrega).resolves.toBe('descargado')

    expect(share).not.toHaveBeenCalled()
    expect(enlaces.map((a) => a.download)).toEqual(['informe-semanal.pdf', 'informe-semanal-almacen.xlsx'])
    for (const a of enlaces) expect(a.click).toHaveBeenCalledTimes(1)
  })

  it('si se cancela la hoja de compartir, quedan igualmente los dos por descarga', async () => {
    vi.useFakeTimers()
    const { enlaces } = navegador({
      compartir: () => Promise.reject(Object.assign(new Error('cancelado'), { name: 'AbortError' })),
    })

    const entrega = ofrecerFicheros(dos)
    await vi.advanceTimersByTimeAsync(400)
    await expect(entrega).resolves.toBe('descargado')
    expect(enlaces).toHaveLength(2)
  })

  it('con uno solo hace lo mismo que `ofrecerFichero`', async () => {
    const { share } = navegador({ compartir: () => Promise.resolve() })
    await expect(ofrecerFicheros([dos[0]!])).resolves.toBe('compartido')
    const [reparto] = share.mock.calls[0] as [Record<string, unknown>]
    expect((reparto['files'] as File[]).map((f) => f.name)).toEqual(['informe-semanal.pdf'])
  })
})
