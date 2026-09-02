import { afterEach, describe, expect, it, vi } from 'vitest'
import { ofrecerFichero } from './ficheros'

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
    const [{ files, title }] = share.mock.calls[0] as [{ files: File[]; title: string }]
    expect(title).toBe('copia.json')
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
