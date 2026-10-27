import { describe, expect, it } from 'vitest'
import {
  claseAlMeter,
  cuentaDe,
  cuentaDelReparto,
  estadoParaSacar,
  hayEstadoQueContar,
  resumenDeLasAltas,
  seriesDeUnaLista,
  textoDelMovimiento,
  type NivelPorEstado,
} from './estados'
import { cuantasEnEstado, resumenDeCuentas } from './unidades'

function nivel(n: Partial<NivelPorEstado> = {}): NivelPorEstado {
  return {
    stock_item_id: 'i1',
    seguimiento: 'cantidad',
    on_hand: 0,
    nuevo: 0,
    usado: 0,
    reacondicionado: 0,
    averiado: 0,
    sin_indicar: 0,
    disponibles: 0,
    ...n,
  }
}

describe('cómo se dice cuántas hay de cada estado', () => {
  it('en femenino, con su plural, en el orden de los botones y sin los ceros', () => {
    expect(resumenDeCuentas({ usado: 3, nuevo: 5, averiado: 0 })).toBe('5 nuevas · 3 usadas')
    expect(resumenDeCuentas({ sin_indicar: 2, reacondicionado: 1, averiado: 1 })).toBe(
      '1 reacondicionada · 1 averiada · 2 sin estado',
    )
    expect(resumenDeCuentas({})).toBe('')
  })

  it('«1 nueva», «2 sin estado»', () => {
    expect(cuantasEnEstado('nuevo', 1)).toBe('1 nueva')
    expect(cuantasEnEstado('sin_indicar', 2)).toBe('2 sin estado')
  })

  it('la lista no lo dice mientras todo está sin estado', () => {
    expect(hayEstadoQueContar(cuentaDe(nivel({ on_hand: 8, sin_indicar: 8 })))).toBe(false)
    expect(hayEstadoQueContar(cuentaDe(nivel({ on_hand: 8, sin_indicar: 7, usado: 1 })))).toBe(true)
  })
})

describe('de cuál se saca cuando no se dice', () => {
  it('primero lo usado, luego lo reacondicionado, lo que no tiene estado y lo nuevo', () => {
    expect(estadoParaSacar({ nuevo: 2, usado: 1 })).toBe('usado')
    expect(estadoParaSacar({ nuevo: 2, reacondicionado: 1, sin_indicar: 4 })).toBe('reacondicionado')
    expect(estadoParaSacar({ nuevo: 2, sin_indicar: 4 })).toBe('sin_indicar')
    expect(estadoParaSacar({ nuevo: 2 })).toBe('nuevo')
  })

  it('nunca una averiada: si solo quedan averiadas, ninguna', () => {
    expect(estadoParaSacar({ averiado: 3 })).toBeNull()
    expect(estadoParaSacar({})).toBeNull()
  })
})

describe('qué movimiento es meter una', () => {
  it('una nueva es una compra; lo demás, algo que vuelve', () => {
    expect(claseAlMeter('nuevo')).toBe('compra')
    expect(claseAlMeter('usado')).toBe('devolucion')
    expect(claseAlMeter('reacondicionado')).toBe('devolucion')
    expect(claseAlMeter('averiado')).toBe('devolucion')
  })
})

describe('la barra de «Deshacer»', () => {
  it('dice el estado, si lo hay', () => {
    expect(textoDelMovimiento(-1, 'Teclado', 'usado')).toBe('Sacada 1 usada de Teclado.')
    expect(textoDelMovimiento(3, 'Ratón', 'nuevo')).toBe('Metidas 3 nuevas de Ratón.')
  })

  it('sin estado, como antes', () => {
    expect(textoDelMovimiento(-1, 'Cable HDMI')).toBe('Sacada 1 unidad de Cable HDMI.')
    expect(textoDelMovimiento(-2, 'Cable HDMI', 'sin_indicar')).toBe('Sacadas 2 unidades de Cable HDMI.')
  })
})

describe('repartir las que no tienen estado', () => {
  it('cuenta las repartidas y las que quedan', () => {
    expect(cuentaDelReparto(8, { nuevo: 5, usado: 2 })).toEqual({ repartidas: 7, quedan: 1, pasado: false })
    expect(cuentaDelReparto(8, {})).toEqual({ repartidas: 0, quedan: 8, pasado: false })
  })

  it('más de las que hay no es un reparto', () => {
    expect(cuentaDelReparto(3, { nuevo: 2, usado: 2 })).toEqual({ repartidas: 4, quedan: 0, pasado: true })
  })
})

describe('una lista de números de serie pegada de golpe', () => {
  it('uno por línea, como sale de una columna del Excel o del lector', () => {
    expect(seriesDeUnaLista('S4GM18\r\nS4GM19\n\nS4GM20\n')).toEqual({ series: ['S4GM18', 'S4GM19', 'S4GM20'], repetidas: 0 })
  })

  it('separados por comas, puntos y comas o tabuladores, como en un albarán', () => {
    expect(seriesDeUnaLista('A1, A2;A3\tA4').series).toEqual(['A1', 'A2', 'A3', 'A4'])
  })

  it('no corta por espacios: hay números de serie que los llevan', () => {
    expect(seriesDeUnaLista('S4G M18\nPF 3XK9').series).toEqual(['S4G M18', 'PF 3XK9'])
  })

  it('los repetidos —también con otros guiones o mayúsculas— se apuntan una vez', () => {
    expect(seriesDeUnaLista('s4g-m18\nS4GM18\nS4G.M18\nB2')).toEqual({ series: ['s4g-m18', 'B2'], repetidas: 2 })
  })

  it('lo que no tiene ni una letra ni un número no es un número de serie', () => {
    expect(seriesDeUnaLista(' - \n . \n')).toEqual({ series: [], repetidas: 0 })
  })
})

describe('lo que contesta la base al apuntar varias', () => {
  it('cuenta cada resultado', () => {
    expect(
      resumenDeLasAltas([
        { serial: 'A', id: '1', resultado: 'nueva' },
        { serial: 'B', id: '2', resultado: 'nueva' },
        { serial: 'C', id: '3', resultado: 'ya_estaba' },
        { serial: 'D', id: null, resultado: 'error', mensaje: 'x' },
      ]),
    ).toBe('2 apuntadas · 1 ya estaba · 1 con error')
    expect(resumenDeLasAltas([])).toBe('Nada que apuntar.')
  })
})
