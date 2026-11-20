/**
 * Las casillas y las instrucciones vuelven, y vuelven bien.
 *
 * Lo que se vigila es que reciclar no cuele nada que hoy no se pueda pedir —una
 * sección retirada, una vetada para dirección—, que la nota de la portada no
 * vuelva sola, y que un informe al que la IA le falló no se recicle como un
 * informe que se quiso sin IA.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  esLaDeSiempre,
  instruccionesAnteriores,
  olvidarEleccion,
  reciclar,
  recordarEleccion,
  ultimaEleccion,
} from './recicladas'
import { porDefectoDe } from './secciones'
import { TOPE_ENFOQUE } from './informe/opciones'
import type { Eleccion } from './peticion'

/** Un `localStorage` de mentira: las pruebas corren en Node, que no tiene. */
function conAlmacen(inicial: Record<string, string> = {}): Map<string, string> {
  const m = new Map(Object.entries(inicial))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  })
  return m
}

afterEach(() => vi.unstubAllGlobals())

const eleccion = (extra: Partial<Eleccion> = {}): Eleccion => ({
  kind: 'semanal',
  rango: { start: '2026-11-16', end: '2026-11-20' },
  secciones: ['resumen', 'analisis', 'materiales'],
  comparar: false,
  ia: true,
  audiencia: 'direccion',
  enfoque: '  Céntrate en el edificio H.  ',
  nota: 'Para la reunión del lunes 16',
  ...extra,
})

describe('reciclar unas opciones', () => {
  it('devuelve las casillas, la audiencia y las instrucciones tal como estaban', () => {
    expect(
      reciclar({
        audiencia: 'equipo',
        secciones: ['resumen', 'estancadas', 'salas'],
        comparar: false,
        ia: false,
        enfoque: 'Mira el CRAI',
        nota: 'Para Luis',
      }),
    ).toEqual({
      audiencia: 'equipo',
      secciones: ['resumen', 'estancadas', 'salas'],
      comparar: false,
      ia: false,
      enfoque: 'Mira el CRAI',
      nota: 'Para Luis',
    })
  })

  it('lo que hoy no se puede pedir para dirección no vuelve por haber estado marcado', () => {
    const r = reciclar({ audiencia: 'direccion', secciones: ['resumen', 'estancadas', 'salas', 'tiempos'] })
    expect(r?.secciones).toEqual(['resumen', 'tiempos'])
  })

  it('una sección que ya no existe se cae, y sin ninguna quedan las de siempre', () => {
    expect(reciclar({ secciones: ['resumen', 'cobertura-de-la-ronda'] })?.secciones).toEqual(['resumen'])
    expect(reciclar({ secciones: ['cobertura-de-la-ronda'] })?.secciones).toEqual(porDefectoDe('direccion'))
    expect(reciclar({})?.secciones).toEqual(porDefectoDe('direccion'))
  })

  it('no repite una casilla aunque venga dos veces', () => {
    expect(reciclar({ secciones: ['resumen', 'resumen', 'analisis'] })?.secciones).toEqual(['resumen', 'analisis'])
  })

  it('lo que se recicla es si la IA se PIDIÓ, no si salió', () => {
    // El archivo guarda las dos cosas. Aquel día la IA falló: `ia` es falso,
    // pero el informe se quería con IA, y así tiene que volver.
    expect(reciclar({ ia: false, ia_pedida: true })?.ia).toBe(true)
    expect(reciclar({ ia: true, ia_pedida: false })?.ia).toBe(false)
    // Los informes antiguos no traen `ia_pedida`: manda `ia`.
    expect(reciclar({ ia: false })?.ia).toBe(false)
    expect(reciclar({})?.ia).toBe(true)
  })

  it('recorta lo que no cabe y no se fía de los tipos', () => {
    const r = reciclar({ enfoque: 'x'.repeat(TOPE_ENFOQUE + 50), nota: 'y'.repeat(400), comparar: 'no', audiencia: 7 })
    expect(r?.enfoque).toHaveLength(TOPE_ENFOQUE)
    expect(r?.nota).toHaveLength(300)
    expect(r?.comparar).toBe(true)
    expect(r?.audiencia).toBe('direccion')
  })

  it('de algo que no es un objeto no saca nada', () => {
    expect(reciclar(null)).toBeNull()
    expect(reciclar('semanal')).toBeNull()
    expect(reciclar(undefined)).toBeNull()
  })
})

describe('lo de la última vez, en este dispositivo', () => {
  it('se guarda al pedir y vuelve al abrir', () => {
    conAlmacen()
    recordarEleccion(eleccion())
    expect(ultimaEleccion()).toEqual({
      audiencia: 'direccion',
      secciones: ['resumen', 'analisis', 'materiales'],
      comparar: false,
      ia: true,
      enfoque: 'Céntrate en el edificio H.',
      nota: '',
    })
  })

  it('la nota de la portada NO se recuerda sola, ni el periodo', () => {
    const almacen = conAlmacen()
    recordarEleccion(eleccion())
    const guardado = [...almacen.values()].join(' ')
    expect(guardado).not.toContain('reunión del lunes')
    expect(guardado).not.toContain('2026-11-16')
    // Y aunque alguien la dejara ahí a mano, no vuelve.
    conAlmacen({ 'informes.ultima-eleccion': JSON.stringify({ secciones: ['resumen'], nota: 'colada' }) })
    expect(ultimaEleccion()?.nota).toBe('')
  })

  it('sin nada guardado, con el almacenamiento roto o con basura dentro, se arranca de cero', () => {
    conAlmacen()
    expect(ultimaEleccion()).toBeNull()
    conAlmacen({ 'informes.ultima-eleccion': '{a medias' })
    expect(ultimaEleccion()).toBeNull()
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('bloqueado')
      },
      setItem: () => {
        throw new Error('bloqueado')
      },
      removeItem: () => {
        throw new Error('bloqueado')
      },
    })
    expect(ultimaEleccion()).toBeNull()
    // Y guardar u olvidar con el almacenamiento roto no tumba el informe.
    expect(() => recordarEleccion(eleccion())).not.toThrow()
    expect(() => olvidarEleccion()).not.toThrow()
  })

  it('«empezar de cero» lo olvida', () => {
    conAlmacen()
    recordarEleccion(eleccion())
    olvidarEleccion()
    expect(ultimaEleccion()).toBeNull()
  })
})

describe('las instrucciones anteriores', () => {
  const fila = (generated_at: string, enfoque?: unknown) => ({
    period_start: generated_at.slice(0, 10),
    period_end: generated_at.slice(0, 10),
    generated_at,
    params: enfoque === undefined ? {} : { enfoque },
  })

  it('salen de la más reciente a la más antigua, sin repetir', () => {
    const out = instruccionesAnteriores([
      fila('2026-11-20T10:00:00Z', 'Céntrate en el edificio H.'),
      fila('2026-11-13T10:00:00Z', 'Este lo lee el vicerrector.'),
      // La misma de arriba, pegada otro lunes con otras mayúsculas y un salto.
      fila('2026-11-06T10:00:00Z', '  céntrate en el  edificio h.\n'),
      fila('2026-10-30T10:00:00Z'),
      fila('2026-10-23T10:00:00Z', '   '),
      fila('2026-10-16T10:00:00Z', 42),
    ])
    expect(out.map((x) => x.texto)).toEqual(['Céntrate en el edificio H.', 'Este lo lee el vicerrector.'])
    // Cada una dice de qué informe es: el más reciente que la llevó.
    expect(out[0]?.periodo.start).toBe('2026-11-20')
  })

  it('tiene tope, y un archivo sin instrucciones no ofrece ninguna', () => {
    const muchas = Array.from({ length: 9 }, (_, i) => fila(`2026-11-${String(20 - i).padStart(2, '0')}T10:00:00Z`, `Instrucción ${i}`))
    expect(instruccionesAnteriores(muchas)).toHaveLength(5)
    expect(instruccionesAnteriores(muchas, 2).map((x) => x.texto)).toEqual(['Instrucción 0', 'Instrucción 1'])
    expect(instruccionesAnteriores([fila('2026-11-20T10:00:00Z'), { ...fila('2026-11-19T10:00:00Z'), params: null }])).toEqual([])
  })
})

describe('saber si hay algo que deshacer', () => {
  const deFabrica = { audiencia: 'direccion' as const, secciones: porDefectoDe('direccion'), comparar: true, ia: true, enfoque: '' }

  it('lo de fábrica es lo de fábrica, en cualquier orden', () => {
    expect(esLaDeSiempre(deFabrica)).toBe(true)
    expect(esLaDeSiempre({ ...deFabrica, secciones: [...deFabrica.secciones].reverse() })).toBe(true)
  })

  it('una sola cosa distinta ya no lo es', () => {
    expect(esLaDeSiempre({ ...deFabrica, enfoque: 'Mira el CRAI' })).toBe(false)
    expect(esLaDeSiempre({ ...deFabrica, ia: false })).toBe(false)
    expect(esLaDeSiempre({ ...deFabrica, comparar: false })).toBe(false)
    expect(esLaDeSiempre({ ...deFabrica, secciones: deFabrica.secciones.slice(1) })).toBe(false)
    expect(esLaDeSiempre({ ...deFabrica, audiencia: 'equipo', secciones: porDefectoDe('equipo') })).toBe(false)
    expect(esLaDeSiempre({ ...deFabrica, nota: 'Para el lunes' })).toBe(false)
  })
})
