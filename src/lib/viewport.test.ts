import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_INTENTOS,
  MS_TECLADO,
  _reiniciarFondo,
  abreTeclado,
  congelarFondo,
  decidir,
  vigilarElTeclado,
  type ElementoEnfocado,
  type Entorno,
} from './viewport'

/**
 * Un navegador de mentira con lo justo: el viewport visual con su desfase, el
 * foco, y una cola de fotogramas que se vacía a mano.
 */
function navegador(opciones: { desfase?: number; pageTop?: number; scrollY?: number; conVisual?: boolean } = {}) {
  const vv = Object.assign(new EventTarget(), {
    offsetTop: opciones.desfase ?? 0,
    pageTop: opciones.pageTop ?? 0,
    scale: 1,
  })
  const llamadas: Array<[number, number]> = []
  const win = Object.assign(new EventTarget(), {
    scrollX: 0,
    scrollY: opciones.scrollY ?? 0,
    visualViewport: opciones.conVisual === false ? null : vv,
    scrollTo: vi.fn((x: number, y: number) => {
      llamadas.push([x, y])
    }),
  })
  const doc = Object.assign(new EventTarget(), {
    activeElement: { tagName: 'BODY' } as ElementoEnfocado | null,
    documentElement: { style: { overflow: '' } },
  })
  const marcos: Array<() => void> = []
  const entorno = {
    window: win,
    document: doc,
    alSiguienteMarco: (fn: () => void) => void marcos.push(fn),
    despues: (fn: () => void, ms: number) => setTimeout(fn, ms),
    cancelar: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  } as unknown as Entorno

  /** Vacía los fotogramas pendientes, incluidos los que se pidan mientras. */
  const pintar = (): void => {
    for (let vueltas = 0; marcos.length > 0 && vueltas < 50; vueltas++) marcos.shift()!()
  }
  return { vv, win, doc, entorno, llamadas, pintar }
}

describe('abreTeclado', () => {
  it('los campos de texto sí, con o sin `type`', () => {
    expect(abreTeclado({ tagName: 'INPUT', type: 'text' })).toBe(true)
    expect(abreTeclado({ tagName: 'INPUT' })).toBe(true)
    expect(abreTeclado({ tagName: 'input', type: 'Number' })).toBe(true)
    expect(abreTeclado({ tagName: 'INPUT', type: 'search' })).toBe(true)
    expect(abreTeclado({ tagName: 'TEXTAREA' })).toBe(true)
  })

  it('el desplegable también: en el iPhone saca su rueda y encoge lo visual', () => {
    expect(abreTeclado({ tagName: 'SELECT' })).toBe(true)
  })

  it('lo editable a mano también', () => {
    expect(abreTeclado({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it('botones, casillas y demás no', () => {
    for (const type of ['checkbox', 'radio', 'button', 'submit', 'file', 'range']) {
      expect(abreTeclado({ tagName: 'INPUT', type })).toBe(false)
    }
    expect(abreTeclado({ tagName: 'BUTTON' })).toBe(false)
    expect(abreTeclado({ tagName: 'BODY' })).toBe(false)
    expect(abreTeclado(null)).toBe(false)
  })
})

describe('decidir', () => {
  it('separados sin teclado y sin ampliar: hay que juntarlos', () => {
    expect(decidir({ desfase: 180, escala: 1, teclado: false })).toBe('juntar')
    expect(decidir({ desfase: -40, escala: 1, teclado: false })).toBe('juntar')
  })

  it('con el teclado arriba la separación es lo normal: no se toca', () => {
    expect(decidir({ desfase: 180, escala: 1, teclado: true })).toBe('nada')
  })

  it('ampliada a propósito, tampoco', () => {
    expect(decidir({ desfase: 180, escala: 1.6, teclado: false })).toBe('nada')
  })

  it('medio píxel es redondeo, no desencaje', () => {
    expect(decidir({ desfase: 0.5, escala: 1, teclado: false })).toBe('nada')
    expect(decidir({ desfase: 0, escala: 1, teclado: false })).toBe('nada')
  })
})

describe('congelarFondo', () => {
  beforeEach(() => _reiniciarFondo())

  it('congela, y al soltar deja la página donde estaba y el foco sin desplazar', () => {
    const { entorno, doc, win, llamadas } = navegador({ scrollY: 640 })
    const origen = { focus: vi.fn() }

    const soltar = congelarFondo(origen, entorno)
    expect(doc.documentElement.style.overflow).toBe('hidden')

    // iOS desplaza la página para enseñar un campo aunque tenga `overflow: hidden`.
    win.scrollY = 910
    soltar()

    expect(doc.documentElement.style.overflow).toBe('')
    expect(llamadas).toEqual([[0, 640]])
    expect(origen.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('dos capas cerradas fuera de orden no dejan la página bloqueada para siempre', () => {
    const { entorno, doc, llamadas } = navegador({ scrollY: 120 })
    doc.documentElement.style.overflow = 'auto'

    const soltarA = congelarFondo(null, entorno)
    const soltarB = congelarFondo(null, entorno)
    soltarA()
    // Con «restaura lo que viste al abrir», B dejaría aquí `hidden` para siempre.
    expect(doc.documentElement.style.overflow).toBe('hidden')
    soltarB()

    expect(doc.documentElement.style.overflow).toBe('auto')
    expect(llamadas).toEqual([[0, 120]])
  })

  it('soltar dos veces es soltar una', () => {
    const { entorno, doc } = navegador()
    const soltarA = congelarFondo(null, entorno)
    const soltarB = congelarFondo(null, entorno)
    soltarA()
    soltarA()
    // B sigue abierta: el fondo tiene que seguir congelado.
    expect(doc.documentElement.style.overflow).toBe('hidden')
    soltarB()
    expect(doc.documentElement.style.overflow).toBe('')
  })
})

describe('vigilarElTeclado', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('al bajar el teclado con la barra desplazada, junta los viewports', () => {
    const n = navegador({ desfase: 180, pageTop: 1180, scrollY: 1000 })
    vigilarElTeclado(n.entorno)

    n.doc.activeElement = { tagName: 'BODY' }
    n.doc.dispatchEvent(new Event('focusout'))

    // Antes de que el teclado termine de bajar no se toca nada.
    vi.advanceTimersByTime(MS_TECLADO - 1)
    n.pintar()
    expect(n.llamadas).toEqual([])

    vi.advanceTimersByTime(1)
    // Lo que haría iOS al obedecer: el de maquetación se va a donde está lo visual.
    n.win.scrollTo.mockImplementation((x: number, y: number) => {
      n.llamadas.push([x, y])
      n.vv.offsetTop = 0
    })
    n.pintar()
    expect(n.llamadas).toEqual([[0, 1180]])
  })

  it('si el foco salta a otro campo, el teclado sigue arriba y no se toca', () => {
    const n = navegador({ desfase: 180, pageTop: 1180 })
    vigilarElTeclado(n.entorno)

    n.doc.activeElement = { tagName: 'INPUT', type: 'text' }
    n.doc.dispatchEvent(new Event('focusout'))
    vi.advanceTimersByTime(MS_TECLADO)
    n.pintar()

    expect(n.llamadas).toEqual([])
  })

  it('si están juntos no hace nada: ni un scroll de más', () => {
    const n = navegador({ desfase: 0 })
    vigilarElTeclado(n.entorno)

    n.doc.dispatchEvent(new Event('focusout'))
    vi.advanceTimersByTime(MS_TECLADO)
    n.vv.dispatchEvent(new Event('resize'))
    n.pintar()

    expect(n.llamadas).toEqual([])
  })

  it('el `resize` de lo visual también dispara la comprobación', () => {
    const n = navegador({ desfase: 90, pageTop: 300 })
    vigilarElTeclado(n.entorno)

    n.vv.dispatchEvent(new Event('resize'))
    n.win.scrollTo.mockImplementation((x: number, y: number) => {
      n.llamadas.push([x, y])
      n.vv.offsetTop = 0
    })
    n.pintar()

    expect(n.llamadas).toEqual([[0, 300]])
  })

  it('si la página ya dice estar ahí, se mueve un píxel y vuelve: un scrollTo a lo mismo no recalcula nada', () => {
    const n = navegador({ desfase: 180, pageTop: 1180, scrollY: 1180 })
    vigilarElTeclado(n.entorno)
    n.win.scrollTo.mockImplementation((x: number, y: number) => {
      n.llamadas.push([x, y])
      n.win.scrollY = y
      // WebKit recalcula al moverse de verdad.
      n.vv.offsetTop = 0
    })

    n.vv.dispatchEvent(new Event('resize'))
    n.pintar()

    expect(n.llamadas).toEqual([
      [0, 1181],
      [0, 1180],
    ])
  })

  it('al final del todo el píxel va hacia arriba', () => {
    const n = navegador({ desfase: 180, pageTop: 1180, scrollY: 1180 })
    vigilarElTeclado(n.entorno)
    n.win.scrollTo.mockImplementation((x: number, y: number) => {
      n.llamadas.push([x, y])
      // No hay más página por abajo: bajar un píxel no mueve nada.
      n.win.scrollY = Math.min(y, 1180)
      if (y !== 1181) n.vv.offsetTop = 0
    })

    n.vv.dispatchEvent(new Event('resize'))
    n.pintar()

    expect(n.llamadas).toEqual([
      [0, 1181],
      [0, 1179],
      [0, 1180],
    ])
  })

  it('si iOS no se deja, se rinde a los pocos intentos en vez de mover la página en bucle', () => {
    const n = navegador({ desfase: 180, pageTop: 1180 })
    vigilarElTeclado(n.entorno)

    n.vv.dispatchEvent(new Event('resize'))
    n.pintar()

    expect(n.llamadas).toHaveLength(MAX_INTENTOS)
  })

  it('sin `visualViewport` no hace nada y no rompe', () => {
    const n = navegador({ conVisual: false })
    const quitar = vigilarElTeclado(n.entorno)
    n.doc.dispatchEvent(new Event('focusout'))
    vi.advanceTimersByTime(MS_TECLADO)
    n.pintar()
    expect(n.llamadas).toEqual([])
    quitar()
  })

  it('al quitarlo deja de escuchar', () => {
    const n = navegador({ desfase: 180, pageTop: 1180 })
    const quitar = vigilarElTeclado(n.entorno)
    quitar()

    n.doc.dispatchEvent(new Event('focusout'))
    vi.advanceTimersByTime(MS_TECLADO)
    n.vv.dispatchEvent(new Event('resize'))
    n.pintar()

    expect(n.llamadas).toEqual([])
  })
})
