import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  _reiniciarHistorial,
  entrar,
  nivelar,
  profundidad,
  vigilarElHistorial,
  type Entorno,
} from './historial'

/**
 * Un historial de navegador de mentira: una lista de entradas con su estado,
 * un índice, los saltos pedidos con `go()` —que se procesan a mano, porque en
 * el navegador de verdad son asíncronos— y las microtareas, también a mano.
 */
function navegador(entradas: unknown[] = [null], indice = entradas.length - 1) {
  const oyentes = new Set<(estado: unknown) => void>()
  const saltos: number[] = []
  const micro: Array<() => void> = []
  /** Veces que un salto se ha ido más atrás de la primera entrada: fuera de la app. */
  let salidas = 0
  const pushState = vi.fn((estado: unknown) => {
    entradas.splice(indice + 1)
    entradas.push(estado)
    indice++
  })
  const avisar = (): void => {
    for (const o of oyentes) o(entradas[indice])
  }
  const entorno: Entorno = {
    historia: {
      get state() {
        return entradas[indice]
      },
      pushState,
      go: (delta) => void saltos.push(delta),
    },
    alVolver(oyente) {
      oyentes.add(oyente)
      return () => oyentes.delete(oyente)
    },
    enMicrotarea: (fn) => void micro.push(fn),
  }
  const vaciar = (): void => {
    while (micro.length > 0) micro.shift()!()
  }
  const viajar = (): void => {
    while (saltos.length > 0) {
      const destino = indice + saltos.shift()!
      if (destino < 0) {
        salidas++
        continue
      }
      if (destino >= entradas.length || destino === indice) continue
      indice = destino
      avisar()
    }
  }
  /** Microtareas y luego los saltos que hayan pedido: una vuelta del navegador. */
  const ciclo = (): void => {
    vaciar()
    viajar()
  }
  /** Hacia delante: el menú de Chrome lo tiene, aunque nadie lo use. */
  const adelante = (): void => {
    if (indice >= entradas.length - 1) return
    indice++
    avisar()
  }
  /** El botón atrás del móvil. */
  const atras = (): void => {
    if (indice === 0) {
      salidas++
      return
    }
    indice--
    avisar()
  }
  return {
    entorno,
    pushState,
    saltos,
    entradas,
    ciclo,
    vaciar,
    viajar,
    atras,
    adelante,
    get indice() {
      return indice
    },
    get salidas() {
      return salidas
    },
    get estado() {
      return entradas[indice]
    },
  }
}

beforeEach(() => _reiniciarHistorial())
afterEach(() => vi.restoreAllMocks())

describe('profundidad', () => {
  it('lee la nuestra y nada más', () => {
    expect(profundidad(null)).toBe(0)
    expect(profundidad(undefined)).toBe(0)
    expect(profundidad({})).toBe(0)
    expect(profundidad({ aulas: 3 })).toBe(3)
    expect(profundidad({ aulas: -1 })).toBe(0)
    expect(profundidad({ aulas: 1.5 })).toBe(0)
    expect(profundidad({ aulas: '2' })).toBe(0)
  })
})

describe('una capa', () => {
  it('deja una entrada con su profundidad, y atrás la cierra', () => {
    const nav = navegador()
    vigilarElHistorial(nav.entorno)
    const cerrar = vi.fn()
    const salir = entrar(cerrar)
    expect(nav.estado).toEqual({ aulas: 1 })

    nav.atras()
    expect(cerrar).toHaveBeenCalledOnce()
    expect(nav.indice).toBe(0)

    // Al desmontarse llama a su `salir`: ya no queda nada que saltar.
    salir()
    nav.ciclo()
    expect(nav.saltos).toEqual([])
    expect(nav.indice).toBe(0)
    expect(nav.salidas).toBe(0)
  })

  it('cerrada con su botón, se va del historial sin cerrarse dos veces', () => {
    const nav = navegador()
    vigilarElHistorial(nav.entorno)
    const cerrar = vi.fn()
    const salir = entrar(cerrar)
    salir()
    nav.ciclo()
    expect(nav.indice).toBe(0)
    expect(cerrar).not.toHaveBeenCalled()
    expect(nav.salidas).toBe(0)
  })

  it('si el navegador rechaza la entrada, la capa no entra en la pila', () => {
    const nav = navegador()
    vigilarElHistorial(nav.entorno)
    nav.pushState.mockImplementationOnce(() => {
      throw new Error('SecurityError')
    })
    const cerrar = vi.fn()
    const salir = entrar(cerrar)
    expect(nav.indice).toBe(0)
    expect(() => salir()).not.toThrow()
    nav.ciclo()
    expect(nav.saltos).toEqual([])
    // Y la siguiente entra con la profundidad que toca.
    entrar(vi.fn())
    expect(nav.estado).toEqual({ aulas: 1 })
  })
})

describe('varias capas', () => {
  it('atrás cierra solo la de arriba, y otra vez atrás la siguiente', () => {
    const nav = navegador()
    vigilarElHistorial(nav.entorno)
    const a = vi.fn()
    const b = vi.fn()
    entrar(a)
    entrar(b)
    expect(nav.estado).toEqual({ aulas: 2 })

    nav.atras()
    expect(b).toHaveBeenCalledOnce()
    expect(a).not.toHaveBeenCalled()

    nav.atras()
    expect(a).toHaveBeenCalledOnce()
    expect(nav.salidas).toBe(0)
  })

  it('dos cierres en el mismo instante son un solo salto', () => {
    const nav = navegador()
    vigilarElHistorial(nav.entorno)
    const salirA = entrar(vi.fn())
    const salirB = entrar(vi.fn())
    salirB()
    salirA()
    expect(nav.saltos).toEqual([])
    nav.vaciar()
    expect(nav.saltos).toEqual([-2])
    nav.viajar()
    expect(nav.indice).toBe(0)
    expect(nav.salidas).toBe(0)
  })

  it('un salto de varias entradas cierra todas las de arriba, de arriba abajo', () => {
    const nav = navegador()
    vigilarElHistorial(nav.entorno)
    const orden: string[] = []
    entrar(() => orden.push('a'))
    entrar(() => orden.push('b'))
    entrar(() => orden.push('c'))
    // El navegador puede saltar tres de golpe (mantener pulsado atrás).
    nav.atras()
    nav.atras()
    nav.atras()
    expect(orden).toEqual(['c', 'b', 'a'])
    expect(nav.salidas).toBe(0)
  })

  it('si un cerrar falla, las demás se cierran igual', () => {
    const nav = navegador()
    vigilarElHistorial(nav.entorno)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = vi.fn()
    entrar(a)
    entrar(() => {
      throw new Error('rota')
    })
    nav.atras()
    nav.atras()
    expect(a).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledOnce()
  })

  it('cambiar una hoja por otra en el mismo instante deja el historial cuadrado', () => {
    const nav = navegador()
    vigilarElHistorial(nav.entorno)
    const a = vi.fn()
    const b = vi.fn()
    const salirA = entrar(a)
    // Lo que hace React al sustituir un componente por otro: primero la
    // limpieza del que se va, luego el efecto del que llega.
    salirA()
    entrar(b)
    nav.ciclo()
    expect(profundidad(nav.estado)).toBe(1)

    nav.atras()
    expect(b).toHaveBeenCalledOnce()
    expect(a).not.toHaveBeenCalled()
    expect(nav.salidas).toBe(0)
  })

  it('StrictMode: entrar, salir y volver a entrar dejan una sola capa', () => {
    const nav = navegador()
    vigilarElHistorial(nav.entorno)
    const primera = vi.fn()
    const segunda = vi.fn()
    const salir = entrar(primera)
    salir()
    entrar(segunda)
    nav.ciclo()
    expect(profundidad(nav.estado)).toBe(1)
    nav.atras()
    expect(segunda).toHaveBeenCalledOnce()
    expect(primera).not.toHaveBeenCalled()
    expect(nav.salidas).toBe(0)
  })

  it('cerrar una capa que no es la de arriba no descuadra a la de arriba', () => {
    const nav = navegador()
    vigilarElHistorial(nav.entorno)
    const a = vi.fn()
    const b = vi.fn()
    const salirA = entrar(a)
    entrar(b)
    salirA()
    nav.ciclo()
    expect(profundidad(nav.estado)).toBe(1)
    nav.atras()
    expect(b).toHaveBeenCalledOnce()
    expect(nav.indice).toBe(0)
  })

  it('nunca salta más atrás de lo que es nuestro', () => {
    const nav = navegador()
    vigilarElHistorial(nav.entorno)
    const salirA = entrar(vi.fn())
    entrar(vi.fn())
    // Atrás ya ha quitado una entrada; el `salir` que queda solo puede quitar la otra.
    nav.atras()
    salirA()
    nav.ciclo()
    expect(nav.indice).toBe(0)
    expect(nav.salidas).toBe(0)
  })
})

describe('el historial que ya estaba', () => {
  it('al arrancar con profundidad guardada se vuelve a la raíz', () => {
    const nav = navegador([null, { aulas: 1 }, { aulas: 2 }])
    vigilarElHistorial(nav.entorno)
    expect(nav.saltos).toEqual([-2])
    nav.viajar()
    expect(nav.indice).toBe(0)
    expect(nav.salidas).toBe(0)
  })

  it('una entrada de más adelante, con más profundidad que capas, se deshace', () => {
    // Tras recargar y volver a la raíz quedan dos entradas «hacia delante».
    const nav = navegador([null, { aulas: 1 }, { aulas: 2 }], 0)
    vigilarElHistorial(nav.entorno)
    expect(nav.saltos).toEqual([])

    nav.adelante()
    expect(nav.saltos).toEqual([-1])
    nav.viajar()
    expect(nav.indice).toBe(0)
    expect(nav.salidas).toBe(0)
  })
})

describe('las pantallas de App', () => {
  it('nivelar pone y quita entradas hasta cuadrar, y es idempotente', () => {
    const nav = navegador()
    vigilarElHistorial(nav.entorno)
    const volver = vi.fn()
    nivelar(2, volver)
    expect(nav.estado).toEqual({ aulas: 2 })
    nivelar(2, volver)
    expect(nav.pushState).toHaveBeenCalledTimes(2)

    nivelar(1, volver)
    nav.ciclo()
    expect(nav.estado).toEqual({ aulas: 1 })
    nivelar(0, volver)
    nav.ciclo()
    expect(nav.indice).toBe(0)
    expect(volver).not.toHaveBeenCalled()
  })

  it('atrás llama a volver, y si App sigue a la misma profundidad, nivelar recompone', () => {
    const nav = navegador()
    vigilarElHistorial(nav.entorno)
    const volver = vi.fn()
    nivelar(1, volver)
    nav.atras()
    expect(volver).toHaveBeenCalledOnce()
    expect(nav.indice).toBe(0)

    // Volver ha cambiado de pestaña sin cambiar la profundidad: la entrada se
    // vuelve a poner, sin saltos.
    nivelar(1, volver)
    nav.ciclo()
    expect(nav.estado).toEqual({ aulas: 1 })
    expect(nav.saltos).toEqual([])
    nav.atras()
    expect(volver).toHaveBeenCalledTimes(2)
    expect(nav.salidas).toBe(0)
  })

  it('las capas montadas van por encima de las pantallas', () => {
    const nav = navegador()
    vigilarElHistorial(nav.entorno)
    const volver = vi.fn()
    const capa = vi.fn()
    nivelar(1, volver)
    entrar(capa)
    expect(nav.estado).toEqual({ aulas: 2 })

    nav.atras()
    expect(capa).toHaveBeenCalledOnce()
    expect(volver).not.toHaveBeenCalled()
    nav.atras()
    expect(volver).toHaveBeenCalledOnce()
  })

  it('al quitar pantallas con una capa encima, se quitan las pantallas', () => {
    const nav = navegador()
    vigilarElHistorial(nav.entorno)
    const volver = vi.fn()
    const capa = vi.fn()
    nivelar(2, volver)
    entrar(capa)
    nivelar(0, volver)
    nav.ciclo()
    expect(profundidad(nav.estado)).toBe(1)
    nav.atras()
    expect(capa).toHaveBeenCalledOnce()
    expect(volver).not.toHaveBeenCalled()
  })
})
