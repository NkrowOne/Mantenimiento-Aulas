/**
 * Lo que se le pide al servidor de informes, leído sin fiarse.
 *
 * Quien llama es un navegador con la sesión de un administrador, así que lo
 * normal es que la petición venga bien. Lo que se comprueba es lo otro: que una
 * petición rara no llegue a la base como una fecha imposible, un informe de
 * diez años o un texto de un megabyte en la instrucción de la IA.
 */
import { describe, expect, it } from 'vitest'
import { leerPeticion } from './informe-generar'

const BUENA = {
  kind: 'semanal',
  start: '2026-11-16',
  end: '2026-11-20',
  params: {
    secciones: ['resumen', 'analisis'],
    comparar: false,
    ia: true,
    audiencia: 'equipo',
    enfoque: 'Céntrate en el edificio H',
    nota: 'Para el lunes',
  },
}

describe('la petición de un informe en segundo plano', () => {
  it('una petición buena sale como la elección que arma la pantalla', () => {
    expect(leerPeticion(BUENA)).toEqual({
      ok: true,
      clave: '',
      eleccion: {
        kind: 'semanal',
        rango: { start: '2026-11-16', end: '2026-11-20' },
        secciones: ['resumen', 'analisis'],
        comparar: false,
        ia: true,
        audiencia: 'equipo',
        enfoque: 'Céntrate en el edificio H',
        nota: 'Para el lunes',
      },
    })
  })

  it('lo que no viene vale lo de siempre: con IA, comparando, para dirección', () => {
    const r = leerPeticion({ ...BUENA, params: { secciones: ['resumen'] } })
    expect(r.ok && r.eleccion).toMatchObject({ comparar: true, ia: true, audiencia: 'direccion', enfoque: '', nota: '' })
  })

  it('un tipo de informe inventado no pasa', () => {
    expect(leerPeticion({ ...BUENA, kind: 'anual' })).toEqual({ ok: false, error: 'Tipo de informe no válido.' })
    expect(leerPeticion({ ...BUENA, kind: undefined }).ok).toBe(false)
  })

  it('las fechas tienen que ser días que existen', () => {
    for (const mala of ['20/11/2026', '2026-11-20T00:00:00Z', "2026-11-20'; drop table rooms; --", '2026-02-30', '2026-13-01', '', null, 20261120]) {
      expect(leerPeticion({ ...BUENA, start: mala }).ok, String(mala)).toBe(false)
      expect(leerPeticion({ ...BUENA, end: mala }).ok, String(mala)).toBe(false)
    }
    // Un día suelto sí: es el parte diario.
    expect(leerPeticion({ ...BUENA, kind: 'diario', start: '2026-11-19', end: '2026-11-19' }).ok).toBe(true)
  })

  it('ni al revés, ni de más de un año', () => {
    expect(leerPeticion({ ...BUENA, start: '2026-11-20', end: '2026-11-16' })).toEqual({
      ok: false,
      error: 'La fecha final es anterior a la inicial.',
    })
    expect(leerPeticion({ ...BUENA, start: '2025-01-01', end: '2026-11-20' })).toEqual({
      ok: false,
      error: 'El periodo no puede superar un año.',
    })
    // Un año justo, sí.
    expect(leerPeticion({ ...BUENA, start: '2025-11-21', end: '2026-11-20' }).ok).toBe(true)
  })

  it('sin ninguna sección no hay informe que hacer', () => {
    for (const secciones of [[], undefined, 'resumen', [1, 2], [null]]) {
      expect(leerPeticion({ ...BUENA, params: { ...BUENA.params, secciones } })).toEqual({
        ok: false,
        error: 'Marca al menos una sección.',
      })
    }
  })

  it('los textos se recortan a lo que cabe, y lo que no es texto no entra', () => {
    const r = leerPeticion({
      ...BUENA,
      params: { ...BUENA.params, enfoque: 'x'.repeat(5000), nota: 'y'.repeat(5000) },
      clave: `  ${'k'.repeat(500)}  `,
    })
    expect(r.ok && r.eleccion.enfoque).toHaveLength(1500)
    expect(r.ok && r.eleccion.nota).toHaveLength(300)
    expect(r.ok && r.clave.length).toBeLessThanOrEqual(200)

    const raro = leerPeticion({ ...BUENA, params: { ...BUENA.params, enfoque: { $ne: null }, nota: 7 }, clave: ['a'] })
    expect(raro.ok && raro.eleccion).toMatchObject({ enfoque: '', nota: '' })
    expect(raro.ok && raro.clave).toBe('')
  })

  it('una lista de secciones desmedida se queda en las que caben', () => {
    const muchas = Array.from({ length: 500 }, (_, i) => `s${i}`)
    const r = leerPeticion({ ...BUENA, params: { ...BUENA.params, secciones: [...muchas, 'x'.repeat(100)] } })
    expect(r.ok && r.eleccion.secciones).toHaveLength(40)
  })

  it('la clave de Gemini del dispositivo llega limpia', () => {
    const r = leerPeticion({ ...BUENA, clave: '  AIza-de-mentira  ' })
    expect(r.ok && r.clave).toBe('AIza-de-mentira')
  })

  it('lo que no es un objeto no revienta', () => {
    for (const cosa of [null, undefined, 'semanal', 42, []]) {
      expect(leerPeticion(cosa).ok).toBe(false)
    }
  })
})
